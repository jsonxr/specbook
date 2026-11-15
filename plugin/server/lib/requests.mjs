import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { readReview, setNotesStatus, unsendNotes } from './review.mjs';
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

// The flag a Stop leaves for the plugin's hook (server/stop-hook.mjs), which refuses Claude's edits to the book and
// its commits while it is up: { request, kind, at }, or null. A new request, or the skill's --check, takes it down.
const flagFile = data => join(data, 'requests', 'stop.flag');
export function stopFlag(data) {
  return readJson(flagFile(data), null);
}
export function clearStopFlag(data) {
  rmSync(flagFile(data), { force: true });
}

// Writes the request to requests/<stamp>.json and returns that data-relative path.
export function writeRequest(data, request) {
  clearStopFlag(data);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rel = `requests/${stamp}.json`;
  writeJsonAtomic(join(data, rel), request);
  return rel;
}

// Files a request: marks it handled and moves it to requests/done/. A revise marks the notes it was sent (those still
// `sent`) as answered. Moving the file comes first and is the claim: when Stop got there first, or the reader filed it
// already, it returns false and changes nothing. It throws when the request is in neither place.
export function fileRequest(data, file, now = Date.now()) {
  const dir = join(data, 'requests');
  const name = basename(file);
  const src = join(dir, name);
  const dest = join(dir, 'done', name);
  if (!existsSync(src) && existsSync(dest)) {
    return false;
  }
  if (!readJson(src, null)) {
    throw new Error(`Cannot read ${src}`);
  }
  if (!claim(src, dest)) {
    return false;
  }
  const request = readJson(dest, null);
  if (request.status === 'stopped') {
    return false;
  }
  if (request.kind === undefined || request.kind === 'revise') {
    const review = readReview(data);
    setNotesStatus(data, (request.noteIds ?? []).filter(id => review.notes[id]?.status === 'sent'), 'answered');
  }
  request.status = 'handled';
  request.handledAt = new Date(now).toISOString();
  writeJsonAtomic(dest, request);
  return true;
}

// Moves a pending request into requests/done/; false when something else moved it first.
function claim(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
    return true;
  } catch {
    return false;
  }
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

// Withdraws a request for the reader's Stop: moved to requests/done/ (the claim), then marked stopped. False when
// Claude filed it first.
function withdraw(data, file, now) {
  const dir = join(data, 'requests');
  const dest = join(dir, 'done', file);
  if (!claim(join(dir, file), dest)) {
    return false;
  }
  const request = readJson(dest, null) ?? {};
  writeJsonAtomic(dest, { ...request, status: 'stopped', stoppedAt: new Date(now).toISOString() });
  return true;
}

function raiseFlag(data, file, kind, now) {
  writeJsonAtomic(flagFile(data), { request: file, kind, at: new Date(now).toISOString() });
}

// The reader's Stop: withdraws what Claude is working on, the oldest pending request. A Revise's notes go back to
// drafts (what Claude already changed stays, for review); a Build's running build is stopped (its sections go back to
// Drafting) and every pending build request is withdrawn. Returns { stopped, count }, or null when nothing is pending.
export function stopRequest(data, now = Date.now()) {
  const pending = listPending(data);
  const oldest = pending[0];
  if (!oldest) {
    // A build can run with no request left (started from the terminal, or after its request was withdrawn): the
    // reader shows it as building, so Stop stops it too.
    const running = latestBuild(data);
    if (running?.progress?.state === 'running') {
      stopBuild(data, running.id, 'Stopped in the reader', now);
      raiseFlag(data, null, 'build', now);
      return { stopped: 'build', count: (running.progress.sections ?? []).length };
    }
    return null;
  }
  if ((oldest.request.kind ?? 'revise') === 'revise') {
    if (!withdraw(data, oldest.file, now)) {
      return null;
    }
    raiseFlag(data, oldest.file, 'revise', now);
    return { stopped: 'revise', count: unsendNotes(data, oldest.request.noteIds ?? []) };
  }
  let count = 0;
  let any = false;
  for (const { file, request } of pending) {
    if (request.kind === 'build' && withdraw(data, file, now)) {
      count = Math.max(count, (request.sections ?? []).length);
      any = true;
      raiseFlag(data, file, 'build', now);
    }
  }
  const running = latestBuild(data);
  if (running?.progress?.state === 'running') {
    stopBuild(data, running.id, 'Stopped in the reader', now);
    count = count || (running.progress.sections ?? []).length;
    any = true;
  }
  return any ? { stopped: 'build', count } : null;
}
