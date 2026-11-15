import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { listPending } from './requests.mjs';
import { listSections } from './book-model.mjs';

const SpecModel = createRequire(import.meta.url)('../../app/model.js');

// A Revise edits a working copy of the book (book.json and mockups/, under requests/work/<request>/, which git
// ignores) and lands each section on the real book in one step, only while its request is still pending. A Stop
// therefore never leaves half a section in the book: what landed is whole and reviewed, the rest never arrives.

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const nameOf = file => basename(file).replace(/\.json$/, '');
const workDir = (data, file) => join(data, 'requests', 'work', nameOf(file));

// Copies the book to the request's working folder (kept if it is already there) and returns the folder.
export function startWork(data, file) {
  const work = workDir(data, file);
  if (!existsSync(join(work, 'book.json'))) {
    mkdirSync(work, { recursive: true });
    cpSync(join(data, 'book.json'), join(work, 'book.json'));
    if (existsSync(join(data, 'mockups'))) {
      cpSync(join(data, 'mockups'), join(work, 'mockups'), { recursive: true });
    }
  }
  return work;
}

// Why the working book cannot land, or null: it must parse, ids must be unique, and the screens must be valid (screenProblem).
function problem(work) {
  let book;
  try {
    book = JSON.parse(readFileSync(join(work, 'book.json'), 'utf8'));
  } catch (e) {
    return `book.json does not parse: ${e.message}`;
  }
  if (!book || !Array.isArray(book.chapters)) {
    return 'book.json has no chapters';
  }
  const seen = new Set();
  for (const { section } of listSections(book)) {
    for (const req of section.requirements ?? []) {
      if (req && typeof req === 'object' && req.id) {
        if (seen.has(req.id)) {
          return `requirement id ${req.id} is used twice`;
        }
        seen.add(req.id);
      }
    }
  }
  const mockups = {};
  const exists = (rel) => {
    const file = resolve(work, rel);
    return file.startsWith(resolve(work) + sep) && existsSync(file) && statSync(file).isFile();
  };
  for (const rel of SpecModel.mockupPaths(book)) {
    if (exists(rel)) {
      mockups[rel] = readFileSync(resolve(work, rel), 'utf8');
    }
  }
  return SpecModel.screenProblem(book, exists, mockups);
}

// Lands the working copy on the book: mockups first (new and changed ones written, removed ones deleted), then
// book.json in one atomic write. Throws `stopped` when the request is no longer pending, `invalid` when the working
// book is not valid; either way the book is untouched.
export function landWork(data, file) {
  const name = basename(file);
  if (!listPending(data).some(p => p.file === name)) {
    throw fail('stopped', `${name} is no longer pending (stopped in the reader, or filed): nothing landed`);
  }
  const work = workDir(data, file);
  if (!existsSync(join(work, 'book.json'))) {
    throw fail('no-work', `no working copy for ${name}: run work first`);
  }
  const why = problem(work);
  if (why) {
    throw fail('invalid', `${why}: nothing landed`);
  }
  const from = join(work, 'mockups');
  const to = join(data, 'mockups');
  const keep = new Set();
  for (const rel of existsSync(from) ? readdirSync(from, { recursive: true, withFileTypes: true }) : []) {
    if (!rel.isFile()) {
      continue;
    }
    const sub = join(rel.parentPath ?? rel.path, rel.name).slice(from.length + 1);
    keep.add(sub);
    const next = readFileSync(join(from, sub));
    const dest = join(to, sub);
    if (!existsSync(dest) || !readFileSync(dest).equals(next)) {
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(`${dest}.tmp`, next);
      renameSync(`${dest}.tmp`, dest);
    }
  }
  for (const rel of existsSync(to) ? readdirSync(to, { recursive: true, withFileTypes: true }) : []) {
    const sub = join(rel.parentPath ?? rel.path, rel.name).slice(to.length + 1);
    if (rel.isFile() && !keep.has(sub)) {
      rmSync(join(to, sub));
    }
  }
  writeJsonAtomic(join(data, 'book.json'), readJson(join(work, 'book.json'), null));
  return { landed: true };
}
