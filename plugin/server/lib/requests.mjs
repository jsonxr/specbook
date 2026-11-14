import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { setNotesStatus } from './review.mjs';

// Pending requests, oldest first, as { file: <name inside requests/>, request }. Unreadable files are skipped.
export function listPending(data) {
  const dir = join(data, 'requests');
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const request = readJson(join(dir, file), null);
    if (request && request.status === 'pending') {
      out.push({ file, request });
    }
  }
  return out;
}

// Writes the request to requests/<stamp>.json and returns that data-relative path.
export function writeRequest(data, request) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rel = `requests/${stamp}.json`;
  writeJsonAtomic(join(data, rel), request);
  return rel;
}

// Files a request: marks it handled and moves it to requests/done/. A revise marks the notes it was sent as answered.
// Returns false when the request is already in requests/done/ (the reader filed it), and throws when it is in neither.
export function fileRequest(data, file, now = Date.now()) {
  const dir = join(data, 'requests');
  const name = basename(file);
  const src = join(dir, name);
  if (!existsSync(src) && existsSync(join(dir, 'done', name))) {
    return false;
  }
  const request = readJson(src, null);
  if (!request) {
    throw new Error(`Cannot read ${src}`);
  }
  if (request.kind === undefined || request.kind === 'revise') {
    setNotesStatus(data, request.noteIds ?? [], 'answered');
  }
  request.status = 'handled';
  request.handledAt = new Date(now).toISOString();
  writeJsonAtomic(src, request);
  mkdirSync(join(dir, 'done'), { recursive: true });
  renameSync(src, join(dir, 'done', name));
  return true;
}

// Files every pending build request, which unlocks the book; returns their file names.
export function fileBuildRequests(data, now = Date.now()) {
  const filed = [];
  for (const { file, request } of listPending(data)) {
    if (request.kind === 'build') {
      fileRequest(data, file, now);
      filed.push(file);
    }
  }
  return filed;
}
