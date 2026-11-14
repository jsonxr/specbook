#!/usr/bin/env node
// Claude's side of the review: answer a note or link it to the items it changed. Prints one JSON line.
//   node review.mjs --data <dir> reply --note <id> --text "<t>"
//   node review.mjs --data <dir> link --note <id> --item <key> [--item <key>...]
// On an error it prints { error, message } to stderr and exits 1.
import { resolve } from 'node:path';
import { knownItem, linkNote, replyNote } from './lib/review.mjs';

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Every value given for a flag; a flag with no value is skipped.
function values(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    const v = process.argv[i + 1];
    if (a === `--${name}` && v !== undefined && !v.startsWith('--')) {
      out.push(v);
    }
  });
  return out;
}

function required(name) {
  const v = values(name)[0];
  if (v === undefined) {
    throw fail('missing-flag', `--${name} is required`);
  }
  return v;
}

function run(data, command) {
  switch (command) {
    case 'reply':
      return replyNote(data, required('note'), required('text'));
    case 'link': {
      const note = required('note');
      const keys = values('item');
      if (keys.length === 0) {
        throw fail('missing-flag', '--item is required');
      }
      for (const key of keys) {
        if (!knownItem(data, key)) {
          throw fail('unknown-item', `no item ${key} in the book or the accepted copy`);
        }
      }
      return linkNote(data, note, keys);
    }
    default:
      throw fail('unknown-command', `Unknown command: ${command ?? ''}`);
  }
}

const data = values('data')[0];
if (!data) {
  console.error('Usage: review.mjs --data <dir> <reply|link> [flags]');
  process.exit(2);
}
const command = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && (i === 0 || !all[i - 1].startsWith('--')));
try {
  console.log(JSON.stringify(run(resolve(data), command)));
} catch (err) {
  console.error(JSON.stringify({ error: err.code ?? 'error', message: err.message }));
  process.exit(1);
}
