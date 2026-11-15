import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { startBuild, stopBuild, recordCall } from './builds.mjs';
import { writeRequest, listPending, fileBuildRequests } from './requests.mjs';
import { claudeState } from './claude-state.mjs';

let data;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'specbook-state-'));
  writeJsonAtomic(join(data, 'book.json'), {
    chapters: [
      {
        id: 'c',
        sections: [
          { id: 'r', stage: 'ready', requirements: [{ id: 'R0', text: 'a' }, { id: 'R1', text: 'b', change: 'add' }] },
          { id: 'd', stage: 'drafting', requirements: [] },
        ],
      },
    ],
    usedIds: [],
  });
});

function markHandled(dir) {
  for (const { file, request } of listPending(dir)) {
    writeJsonAtomic(join(dir, 'requests', file), { ...request, status: 'handled' });
  }
}

test('claudeState: revising, building, stale, review', () => {
  writeRequest(data, { kind: 'revise', status: 'pending', items: [], noteIds: [] });
  assert.equal(claudeState(data).state, 'revising');
  markHandled(data);
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  const p = startBuild(data, t0);
  assert.equal(claudeState(data, t0 + 9 * 60e3).stale, false);
  assert.equal(claudeState(data, t0 + 11 * 60e3).stale, true);
  assert.equal(claudeState(data, t0).state, 'building');
  recordCall(data, p.id, { about: ['R1'], section: 'c-r', title: 't', body: 'b', before: 'x', after: 'y' });
  stopBuild(data, p.id, 'r');
  assert.deepEqual(claudeState(data).review, { builds: [{ build: p.id, pending: 1 }], pending: 1 });
  assert.equal(claudeState(data).state, 'idle');
  assert.equal(claudeState(data).stale, false);
});

test('a pending build request means building, with no progress yet', () => {
  writeRequest(data, { kind: 'build', status: 'pending', sections: ['c-r'] });
  const s = claudeState(data);
  assert.equal(s.state, 'building');
  assert.equal(s.build, null);
  assert.match(s.request, /\.json$/);
});

test('a request without kind is a revise', () => {
  writeRequest(data, { status: 'pending', items: [] });
  assert.equal(claudeState(data).state, 'revising');
});

test('corrupt progress.json reads as no running build', () => {
  mkdirSync(join(data, 'builds', 'x'), { recursive: true });
  writeFileSync(join(data, 'builds', 'x', 'progress.json'), '{');
  assert.equal(claudeState(data).state, 'idle');
  assert.equal(readJson(join(data, 'nope.json'), null), null);
});

test('a running build with a missing or unparseable heartbeat is stale', () => {
  const p = startBuild(data, 0);
  const file = join(data, 'builds', p.id, 'progress.json');
  const progress = readJson(file, null);
  writeJsonAtomic(file, { ...progress, heartbeat: 'nonsense' });
  assert.equal(claudeState(data, 1000).stale, true);
  delete progress.heartbeat;
  writeJsonAtomic(file, progress);
  assert.equal(claudeState(data, 1000).stale, true);
});

test('a pending build request with no progress for 10 minutes is stale; filing it unlocks the book', () => {
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: new Date(t0).toISOString(), sections: ['c-r'] });
  assert.equal(claudeState(data, t0 + 9 * 60e3).stale, false);
  const s = claudeState(data, t0 + 11 * 60e3);
  assert.deepEqual([s.state, s.stale, s.build], ['building', true, null]);
  assert.equal(fileBuildRequests(data).length, 1);
  assert.equal(claudeState(data, t0 + 11 * 60e3).state, 'idle');
});

test('a build from before the request does not keep the request fresh', () => {
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  const p = startBuild(data, t0);
  stopBuild(data, p.id, 'r', t0 + 30 * 60e3);
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: new Date(t0 + 20 * 60e3).toISOString(), sections: ['c-r'] });
  assert.equal(claudeState(data, t0 + 31 * 60e3).stale, true);
});

test('a build that wrote progress after its request is not stale until that progress is 10 minutes old', () => {
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: new Date(t0).toISOString(), sections: ['c-r'] });
  const p = startBuild(data, t0 + 8 * 60e3);
  stopBuild(data, p.id, 'r', t0 + 9 * 60e3);
  assert.equal(claudeState(data, t0 + 15 * 60e3).stale, false);
  assert.equal(claudeState(data, t0 + 20 * 60e3).stale, true);
});

test('after a stop, filing the build requests leaves Claude idle', () => {
  writeRequest(data, { kind: 'revise', status: 'pending', items: [], noteIds: [] });
  markHandled(data);
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: new Date().toISOString(), sections: ['c-r'] });
  const p = startBuild(data);
  stopBuild(data, p.id, 'r');
  assert.equal(claudeState(data).state, 'building');
  fileBuildRequests(data);
  assert.equal(claudeState(data).state, 'idle');
  assert.deepEqual(listPending(data), []);
});

test('claudeState: sent says what is running, and whether a build has started', () => {
  writeRequest(data, { kind: 'build', status: 'pending', createdAt: '2026-11-15T18:00:00.000Z', sections: ['c-r'] });
  assert.deepEqual(claudeState(data).sent, { kind: 'build', at: '2026-11-15T18:00:00.000Z', count: 1, started: false });
  const p = startBuild(data, Date.parse('2026-11-15T18:01:00Z'));
  assert.deepEqual(claudeState(data).sent, { kind: 'build', at: '2026-11-15T18:01:00.000Z', count: 1, started: true });
  fileBuildRequests(data);
  // A build running with no request left still says what it is building.
  assert.deepEqual(claudeState(data).sent, { kind: 'build', at: '2026-11-15T18:01:00.000Z', count: 1, started: true });
  stopBuild(data, p.id, 'x');
  assert.equal(claudeState(data).sent, null);
});
