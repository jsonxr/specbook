import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { fileRequest, listPending, stopFlag, stopRequest, writeRequest } from './requests.mjs';
import { readReview, sendNotes, setNotesStatus } from './review.mjs';
import { latestBuild, startBuild } from './builds.mjs';
import { startAccepted } from './accept-all.testkit.mjs';

const NEXT = fileURLToPath(new URL('../next-request.mjs', import.meta.url));
let data;
const note = (item, text) => ({ item, target: item, text, status: 'draft', created: '2026-11-01T00:00:00.000Z', pin: { rx: 0, ry: 0.5 } });

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'specbook-requests-'));
  writeJsonAtomic(join(data, 'book.json'), {
    chapters: [{ id: 'c', title: 'C', sections: [
      { id: 'r', title: 'R', stage: 'ready', requirements: [{ id: 'R0', text: 'a' }, { id: 'R1', text: 'b', change: 'add' }] },
      { id: 'd', title: 'D', stage: 'drafting', requirements: [{ id: 'R2', text: 'c' }] },
    ] }],
    usedIds: [],
  });
  writeJsonAtomic(join(data, 'review.json'), { rev: 1, accepted: {}, notes: { a: note('R0', 'one'), b: note('R2', 'two'), c: note('R2', 'three') }, tries: {} });
});

// What the server does on Revise: write the request, then mark the notes sent.
function revise(ids) {
  const file = writeRequest(data, { kind: 'revise', status: 'pending', createdAt: '2026-11-15T17:15:49.984Z', items: ids.map(id => ({ noteId: id })), noteIds: ids });
  sendNotes(data, ids, '2026-11-15T17:15:50.000Z');
  return file;
}

test('stopRequest puts a revise\'s sent notes back to drafts and drops their tries', () => {
  const file = revise(['a', 'b']);
  assert.ok(readReview(data).tries.R0?.length);
  assert.deepEqual(stopRequest(data), { stopped: 'revise', count: 2 });
  const review = readReview(data);
  assert.deepEqual(['a', 'b', 'c'].map(id => review.notes[id].status), ['draft', 'draft', 'draft']);
  assert.deepEqual([review.tries.R0 ?? [], review.tries.R2 ?? []], [[], []]);
  assert.deepEqual(listPending(data), []);
  const moved = readJson(join(data, 'requests', 'done', file.replace('requests/', '')), null);
  assert.equal(moved.status, 'stopped');
  assert.ok(moved.stoppedAt);
});

test('stopRequest leaves answered notes alone', () => {
  revise(['a', 'b']);
  setNotesStatus(data, ['a'], 'answered');
  assert.deepEqual(stopRequest(data), { stopped: 'revise', count: 1 });
  const notes = readReview(data).notes;
  assert.deepEqual([notes.a.status, notes.b.status], ['answered', 'draft']);
});

test('a stopped revise filed with --done keeps its notes drafts, and --check says it was stopped', () => {
  const file = revise(['a']);
  const path = join(data, file);
  assert.equal(execFileSync(process.execPath, [NEXT, '--data', data, '--check', path], { encoding: 'utf8' }).trim(), 'pending');
  stopRequest(data);
  assert.equal(execFileSync(process.execPath, [NEXT, '--data', data, '--check', path], { encoding: 'utf8' }).trim(), 'stopped');
  assert.equal(fileRequest(data, file), false);
  assert.match(execFileSync(process.execPath, [NEXT, '--data', data, '--done', path], { encoding: 'utf8' }), /stopped/);
  assert.equal(readReview(data).notes.a.status, 'draft');
});

test('stopRequest stops a running build and files its request', () => {
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: new Date().toISOString(), sections: ['c-r'] });
  const id = startAccepted(data).id;
  assert.deepEqual(stopRequest(data), { stopped: 'build', count: 1 });
  assert.equal(latestBuild(data).progress.state, 'failed');
  assert.equal(readJson(join(data, 'book.json'), null).chapters[0].sections[0].stage, 'drafting');
  assert.deepEqual(listPending(data), []);
  const done = readdirSync(join(data, 'requests', 'done'));
  assert.equal(readJson(join(data, 'requests', 'done', done[0]), null).status, 'stopped');
  assert.equal(latestBuild(data).id, id);
});

test('stopRequest withdraws a build request with no build', () => {
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: new Date().toISOString(), sections: ['c-r'] });
  assert.deepEqual(stopRequest(data), { stopped: 'build', count: 1 });
  assert.deepEqual(listPending(data), []);
  assert.equal(readJson(join(data, 'book.json'), null).chapters[0].sections[0].stage, 'ready');
});

test('stopRequest returns null when nothing is pending', () => {
  assert.equal(stopRequest(data), null);
  assert.equal(existsSync(join(data, 'requests', 'done')), false);
});

test('stopRequest stops a running build that has no pending request', () => {
  const id = startAccepted(data).id;
  assert.deepEqual(stopRequest(data), { stopped: 'build', count: 1 });
  assert.equal(latestBuild(data).progress.state, 'failed');
  assert.equal(latestBuild(data).id, id);
});

test('--check says missing for a path that is not a request, and handled for one filed', () => {
  const run = path => {
    try {
      return { out: execFileSync(process.execPath, [NEXT, '--data', data, '--check', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), code: 0 };
    } catch (e) {
      return { out: String(e.stdout).trim(), code: e.status };
    }
  };
  assert.deepEqual(run(join(data, 'requests', 'nope.json')), { out: 'missing', code: 1 });
  const file = revise(['a']);
  fileRequest(data, file);
  assert.deepEqual(run(join(data, file)), { out: 'handled', code: 0 });
});

test('a Stop leaves a flag for the hook; a new request or --check clears it', () => {
  const file = revise(['a']);
  stopRequest(data, Date.parse('2026-11-15T18:00:00Z'));
  assert.deepEqual(stopFlag(data), { request: file.replace('requests/', ''), kind: 'revise', at: '2026-11-15T18:00:00.000Z' });
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: new Date().toISOString(), sections: [] });
  assert.equal(stopFlag(data), null);
  stopRequest(data);
  assert.ok(stopFlag(data));
  execFileSync(process.execPath, [NEXT, '--data', data, '--check', join(data, file)], { encoding: 'utf8' });
  assert.equal(stopFlag(data), null);
});

test('notes back to drafts lose the replies and links Claude wrote before the Stop', () => {
  revise(['a']);
  const review = readReview(data);
  review.notes.a = { ...review.notes.a, reply: 'half an answer', causes: ['R1'] };
  writeJsonAtomic(join(data, 'review.json'), { ...review, rev: review.rev + 1 });
  stopRequest(data);
  const a = readReview(data).notes.a;
  assert.deepEqual([a.status, 'reply' in a, 'causes' in a], ['draft', false, false]);
});

test('Stop and filing race: whichever moves the request first wins, and the other changes nothing', () => {
  const file = revise(['a', 'b']);
  assert.equal(fileRequest(data, file), true);
  assert.equal(stopRequest(data), null);
  assert.deepEqual(['a', 'b'].map(id => readReview(data).notes[id].status), ['answered', 'answered']);
  const second = writeRequest(data, { kind: 'revise', status: 'pending', createdAt: new Date().toISOString(), items: [{}], noteIds: ['c'] });
  sendNotes(data, ['c'], new Date().toISOString());
  stopRequest(data);
  assert.equal(fileRequest(data, second), false);
  assert.equal(readReview(data).notes.c.status, 'draft');
});

