#!/usr/bin/env node
// Moves book.json to the current format (section stages, requirement changes, decision log), builds review.json and
// history.json from the old revise/ snapshot and notes.json, and adds any missing
// git-ignore lines to the project that holds the book (the nearest folder above it with .git), if there is one.
//   node migrate-book.mjs --data <dir>
import { join, relative, resolve } from 'node:path';
import { ensureIgnores, findProjectRoot } from './lib/gitignore.mjs';
import { readJson, writeJsonAtomic } from './lib/json-file.mjs';
import { migrateBook } from './lib/migrate.mjs';
import { migrateReview } from './lib/migrate-review.mjs';

const i = process.argv.indexOf('--data');
if (i < 0 || !process.argv[i + 1]) {
  console.error('Usage: migrate-book.mjs --data <dir>');
  process.exit(2);
}
const data = resolve(process.argv[i + 1]);
const file = join(data, 'book.json');
const book = readJson(file, null);
if (!book) {
  console.error(`Cannot read ${file}`);
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);
const { changed } = migrateBook(book, today);
if (changed) {
  writeJsonAtomic(file, book);
  console.log('Migrated book.json');
} else {
  console.log('Already in the new format');
}
console.log(`Review: ${migrateReview(data)}`);
const root = findProjectRoot(data);
if (root) {
  const added = ensureIgnores(root, relative(root, data));
  if (added.length > 0) {
    console.log(`Added to .gitignore: ${added.join(' ')}`);
  }
}
