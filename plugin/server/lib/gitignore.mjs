import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HEADER = '# spec book (served by the specbook plugin): requests and captured media stay local';
// Any spec book header already in the file, in today's wording or an older one.
const HEADERS = [HEADER, '# spec book (served by the specbook plugin): requests, notes, revise snapshots and captured media stay local'];

// What stays out of git, under the data folder `<rel>`. builds/ is kept: a build's record is committed with it.
export const IGNORED = [
  '<rel>/requests/',
  '<rel>/.server.json',
  '<rel>/.share.json',
  '<rel>/media/*/*',
  '!<rel>/media/*/.gitkeep',
  '<rel>/**/*.tmp',
];

// Lines older versions added that are now committed or gone: removed when found.
export const REMOVED = ['<rel>/revise/', '<rel>/notes.json'];

// Appends to <projectRoot>/.gitignore each ignore line it does not already have, deletes the REMOVED lines, and returns
// the lines added.
// `rel` is the data folder relative to the project root.
export function ensureIgnores(projectRoot, rel) {
  const clean = rel.split('\\').join('/').replace(/^\/+|\/+$/g, '');
  // An empty `rel` (the data folder is the project root) gives `/requests/` and so on, not `//requests/`.
  const base = clean === '' ? '' : `/${clean}`;
  const file = join(projectRoot, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/).map(l => l.trim()));
  const stale = new Set(REMOVED.map(l => l.replace('<rel>', base)));
  if (existsSync(file) && current.split(/\r?\n/).some(l => stale.has(l.trim()))) {
    writeFileSync(file, current.split('\n').filter(l => !stale.has(l.trim())).join('\n'));
    return ensureIgnores(projectRoot, rel);
  }
  const missing = IGNORED.map(l => l.replace('<rel>', base)).filter(l => !have.has(l));
  if (missing.length === 0) {
    return [];
  }
  const lead = current === '' || current.endsWith('\n') ? '' : '\n';
  const header = HEADERS.some(h => have.has(h)) ? [] : ['', HEADER];
  appendFileSync(file, lead + [...header, ...missing].join('\n') + '\n');
  return missing;
}

// The nearest folder at or above `dir` holding .git (a folder, or a file in a worktree), or null.
export function findProjectRoot(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) {
      return d;
    }
    if (dirname(d) === d) {
      return null;
    }
  }
}
