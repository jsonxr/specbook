#!/usr/bin/env node
// Prints the oldest pending change request in <data>/requests and exits.
//   node next-request.mjs --data <project>/docs/specbook          print and exit (nothing printed if none)
//   node next-request.mjs --data <project>/docs/specbook --wait   block until one arrives, then print it
//   node next-request.mjs --data <project>/docs/specbook --done <file>   mark a request handled (moves it to requests/done/)
import { basename, join, resolve } from 'node:path';
import { fileRequest, listPending } from './lib/requests.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) {
    return undefined;
  }
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const data = arg('data');
if (!data || data === true) {
  console.error('Usage: next-request.mjs --data <dir> [--wait | --done <file>]');
  process.exit(2);
}
const dir = join(resolve(data), 'requests');

const done = arg('done');
if (done && done !== true) {
  const name = basename(done);
  console.log(fileRequest(resolve(data), name) ? `Moved ${name} to requests/done/` : `${name} was already filed (marked as stopped in the reader)`);
  process.exit(0);
}

function pending() {
  return listPending(resolve(data)).map(p => p.file);
}

let list = pending();
if (arg('wait')) {
  while (list.length === 0) {
    await new Promise(r => setTimeout(r, 1500));
    list = pending();
  }
}
if (list.length > 0) {
  console.log(join(dir, list[0]));
}
