#!/usr/bin/env node
// Creates a spec book in a project.
//   node init.mjs --project <repo root> [--data docs/specbook] [--title "App name"]
// Copies the starter (a todo-app book.json, the mockup kit and its mockups), creates media folders, adds the
// git-ignore lines, installs the project-side tools (tools/collect-evidence.mjs), and mints stable ids. Refuses to overwrite an existing book.json.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ensureIgnores } from './lib/gitignore.mjs';
import { installTools } from './lib/install-tools.mjs';
import { migrateReview } from './lib/migrate-review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}
const project = arg('project');
if (!project) {
  console.error('Usage: init.mjs --project <repo root> [--data docs/specbook] [--title "App name"]');
  process.exit(2);
}
const root = resolve(project);
const data = resolve(root, arg('data', 'docs/specbook'));
if (existsSync(join(data, 'book.json'))) {
  console.error(`${join(data, 'book.json')} already exists; not overwriting.`);
  process.exit(1);
}
mkdirSync(data, { recursive: true });
cpSync(join(HERE, '..', 'starter'), data, { recursive: true });
for (const d of ['media/screens', 'media/videos']) {
  mkdirSync(join(data, d), { recursive: true });
  writeFileSync(join(data, d, '.gitkeep'), '');
}
const title = arg('title');
if (title) {
  const book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
  book.title = title;
  writeFileSync(join(data, 'book.json'), JSON.stringify(book, null, 2) + '\n');
}

ensureIgnores(root, relative(root, data));
for (const line of installTools(data)) {
  console.log(line);
}
execFileSync(process.execPath, [join(HERE, 'assign-ids.mjs'), '--data', data], { stdio: 'inherit' });
// Everything starts accepted: an empty review, and an empty history.
migrateReview(data);
console.log(`Spec book created in ${data}`);
console.log(`Serve it: node ${join(HERE, 'serve.mjs')} --data ${data} --detach --open`);
