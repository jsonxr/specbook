import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { setNotesStatus, unsendNotes } from './review.mjs';
import { latestBuild, stopBuild } from './builds.mjs';

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
  if (request.status === 'stopped') {
    return false;
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

// Moves a request to requests/done/ as withdrawn by the reader's Stop.
function withdraw(data, file, now) {
  const dir = join(data, 'requests');
  const src = join(dir, file);
  const request = readJson(src, null);
  if (!request) {
    return;
  }
  request.status = 'stopped';
  request.stoppedAt = new Date(now).toISOString();
  writeJsonAtomic(src, request);
  mkdirSync(join(dir, 'done'), { recursive: true });
  renameSync(src, join(dir, 'done', file));
}

// The reader's Stop: withdraws what Claude is working on, the oldest pending request. A Revise's notes go back to
// drafts (what Claude already changed stays, for review); a Build's running build is stopped (its sections go back to
// Drafting) and every pending build request is withdrawn. Returns { stopped, count }, or null when nothing is pending.
export function stopRequest(data, now = Date.now()) {
  const pending = listPending(data);
  const oldest = pending[0];
  if (!oldest) {
    return null;
  }
  if ((oldest.request.kind ?? 'revise') === 'revise') {
    const count = unsendNotes(data, oldest.request.noteIds ?? []);
    withdraw(data, oldest.file, now);
    return { stopped: 'revise', count };
  }
  const running = latestBuild(data);
  if (running?.progress?.state === 'running') {
    stopBuild(data, running.id, 'Stopped in the reader', now);
  }
  let count = 0;
  for (const { file, request } of pending) {
    if (request.kind === 'build') {
      count = Math.max(count, (request.sections ?? []).length);
      withdraw(data, file, now);
    }
  }
  return { stopped: 'build', count };
}
