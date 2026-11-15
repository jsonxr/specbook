#!/usr/bin/env node
// Gives every requirement, call and decision in book.json a stable id, once.
//   node assign-ids.mjs --data <dir>
// An item that is still a plain string becomes { "id": "...", "text": "..." }. Items that already have an id
// are never touched, so ids survive reordering, inserting and deleting. Ids are <prefix>-<4 chars>: the
// chapter's "prefix" (or its id's first three letters, upper-cased) for requirements, SCR for screens, CALL for calls, DEC for
// decisions. An id is never reused: every id ever minted is kept in book.json's "usedIds".
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectIds, createMinter } from './lib/ids.mjs';

const i = process.argv.indexOf('--data');
if (i < 0 || !process.argv[i + 1]) {
  console.error('Usage: assign-ids.mjs --data <dir>');
  process.exit(2);
}
const file = join(resolve(process.argv[i + 1]), 'book.json');
const book = JSON.parse(readFileSync(file, 'utf8'));
book.usedIds = [...collectIds(book)].sort();
const { mint } = createMinter(book);

let minted = 0;
function ensure(item, prefix, textKey = 'text') {
  if (typeof item === 'string') {
    minted++;
    return { id: mint(prefix), [textKey]: item };
  }
  if (!item.id) {
    minted++;
    return { id: mint(prefix), ...item };
  }
  return item;
}

for (const ch of book.chapters ?? []) {
  const prefix = (ch.prefix ?? ch.id.slice(0, 3)).toUpperCase();
  for (const s of ch.sections ?? []) {
    s.requirements = (s.requirements ?? []).map(r => ensure(r, prefix));
  }
}
if (book.screens) {
  book.screens = book.screens.map(sc => ensure(sc, 'SCR'));
}
if (book.calls) {
  book.calls = book.calls.map(c => ensure(c, 'CALL'));
}
book.decisions = (book.decisions ?? []).map(d => ensure(d, 'DEC'));
writeFileSync(file, JSON.stringify(book, null, 2) + '\n');
console.log(`Minted ${minted} id${minted === 1 ? '' : 's'}; ${book.usedIds.length} ids in use or retired.`);
