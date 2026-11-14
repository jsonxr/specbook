#!/usr/bin/env node
// Collects the evidence behind the book: which tests name which requirement, and whether they passed.
//   node collect-evidence.mjs --data <dir> --unit <glob>... [--unit-results <json>...]
//                             [--e2e-tests <glob>...] [--e2e <dir of e2e result json>]
// Writes <data>/evidence/evidence.json from scratch on every run; nothing is merged from the previous file.
//
// Unit tests name a requirement by starting the title with its id in brackets: it('[ONB-S5U2] ...'), several
// in a row allowed. --unit-results takes Jest `--json` or Vitest json-reporter files (same shape); a test is
// matched to its result by file path + title, and is "unknown" when there is no result.
// E2E blocks are linked by the result files (--e2e): one JSON per chapter, written by the e2e run.
// --e2e-tests scans e2e test files for requirement('<ID>' calls so unknown ids there are reported too.
// Globs are relative to the current working directory.
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = '[A-Z]+-[0-9A-Z]{4}';
const STRING_BODY = String.raw`((?:\\.|(?!\1)[^\\\n])*)`;
const IT_TITLE = new RegExp(String.raw`\b(?:it|test)(?:\.\w+)*\(\s*(['"` + '`' + String.raw`])((?:\[${ID}\])+)` + STRING_BODY + String.raw`\1`, 'g');
const REQUIREMENT_CALL = new RegExp(String.raw`\brequirement\(\s*(['"])(${ID})\1(?:\s*,\s*(['"` + '`' + String.raw`])((?:\\.|(?!\3)[^\\\n])*)\3)?`, 'g');
const ID_IN_ROW = new RegExp(`\\[(${ID})\\]`, 'g');

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

// A title as the test runner sees it: the source spells \' or \" (and \\, \n, \u2019 ...)
// where the string holds one character. Without this a title reads with its
// backslashes and never matches the runner's result for it.
export function unescapeTitle(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e.length > 1 && (e[0] === 'u' || e[0] === 'x')) {
      return String.fromCodePoint(parseInt(e.replace(/[ux{}]/g, ''), 16));
    }
    return SIMPLE_ESCAPES[e] ?? e;
  });
}

function bookIds(book) {
  const ids = new Set();
  for (const ch of book.chapters ?? []) {
    for (const s of ch.sections ?? []) {
      for (const r of s.requirements ?? []) {
        if (r && r.id) {
          ids.add(r.id);
        }
      }
    }
  }
  for (const item of [...(book.calls ?? []), ...(book.decisions ?? [])]) {
    if (item && item.id) {
      ids.add(item.id);
    }
  }
  return ids;
}

function expand(patterns) {
  const files = new Set();
  for (const p of patterns) {
    for (const f of globSync(p)) {
      files.add(f);
    }
  }
  return [...files].sort();
}

// -> [{ id, file, title }], one per id named by a test title.
export function scanUnitTests(files) {
  const found = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IT_TITLE)) {
      const title = m[2] + unescapeTitle(m[3]);
      for (const idMatch of m[2].matchAll(ID_IN_ROW)) {
        found.push({ id: idMatch[1], file, title });
      }
    }
  }
  return found;
}

// -> [{ id, file, title }], one per requirement('<ID>', '<what it proves>' ...) call.
export function scanE2eTests(files) {
  const found = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(REQUIREMENT_CALL)) {
      found.push({ id: m[2], file, title: unescapeTitle(m[4] ?? '') });
    }
  }
  return found;
}

function canonical(file) {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}

// Jest `--json` and Vitest's json reporter share a shape. -> Map "<abs file>\0<title>" -> status.
export function readUnitResults(files) {
  const results = new Map();
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue; // not produced yet: those tests stay "unknown"
      }
      throw error;
    }
    for (const suite of json.testResults ?? []) {
      const name = canonical(suite.name);
      for (const a of suite.assertionResults ?? []) {
        const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'unknown';
        for (const title of [a.title, a.fullName]) {
          if (title) {
            results.set(`${name}\0${title}`, status);
          }
        }
      }
    }
  }
  return results;
}

function readE2eResults(dir) {
  if (!existsSync(dir)) {
    return []; // no e2e run yet
  }
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ file: join(dir, f), data: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

export function collectEvidence({ book, unitTests = [], unitResults = [], e2eTests = [], e2eDir = null, now = new Date() }) {
  const known = bookIds(book);
  const results = readUnitResults(unitResults);
  const byId = {};
  const unknownIds = [];
  const entry = id => (byId[id] ??= { unit: [], e2e: [] });

  for (const t of scanUnitTests(expand(unitTests))) {
    if (!known.has(t.id)) {
      unknownIds.push(t);
      continue;
    }
    const abs = canonical(t.file);
    const status = results.get(`${abs}\0${t.title}`) ?? 'unknown';
    entry(t.id).unit.push({ file: t.file, title: t.title, status });
  }

  for (const t of scanE2eTests(expand(e2eTests))) {
    if (!known.has(t.id)) {
      unknownIds.push(t);
    }
  }

  if (e2eDir) {
    for (const { file, data } of readE2eResults(e2eDir)) {
      for (const b of data.blocks ?? []) {
        if (!known.has(b.id)) {
          const shown = relative(process.cwd(), file);
          if (!unknownIds.some(u => u.id === b.id && u.file === shown)) {
            unknownIds.push({ id: b.id, file: shown, title: b.title ?? '' });
          }
          continue;
        }
        entry(b.id).e2e.push({
          chapter: data.chapter,
          title: b.title,
          video: data.video,
          start: b.start,
          end: b.end,
          status: b.status,
          screenshot: b.screenshot ?? null,
          error: b.error ?? null
        });
      }
    }
  }

  return { generatedAt: now.toISOString(), unknownIds, byId };
}

function parseArgs(argv) {
  const opts = {};
  let key = null;
  for (const a of argv) {
    if (a.startsWith('--')) {
      key = a.slice(2);
      opts[key] ??= [];
    } else if (key) {
      opts[key].push(a);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.data?.[0] || !opts.unit?.length) {
    console.error(
      'Usage: collect-evidence.mjs --data <dir> --unit <glob>... [--unit-results <json>...] [--e2e-tests <glob>...] [--e2e <dir>]'
    );
    process.exit(2);
  }
  const data = resolve(opts.data[0]);
  const book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
  const evidence = collectEvidence({
    book,
    unitTests: opts.unit,
    unitResults: opts['unit-results'] ?? [],
    e2eTests: opts['e2e-tests'] ?? [],
    e2eDir: opts.e2e?.[0] ? resolve(opts.e2e[0]) : null
  });
  mkdirSync(join(data, 'evidence'), { recursive: true });
  writeFileSync(join(data, 'evidence', 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  const ids = Object.keys(evidence.byId).length;
  console.log(`Evidence for ${ids} requirement${ids === 1 ? '' : 's'}; ${evidence.unknownIds.length} unknown id${evidence.unknownIds.length === 1 ? '' : 's'}.`);
  for (const u of evidence.unknownIds) {
    console.log(`  unknown ${u.id} in ${u.file}: ${u.title}`);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
