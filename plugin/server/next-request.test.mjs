import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readReview, writeReviewNotes } from './lib/review.mjs';
import { writeRequest } from './lib/requests.mjs';

const NEXT = fileURLToPath(new URL('./next-request.mjs', import.meta.url));
const note = { target: 'R1', section: 'c-r', rx: 0, ry: 0.5, text: 'x', created: '2026-11-12T00:00:00Z' };

function setup() {
  const data = mkdtempSync(join(tmpdir(), 'specbook-next-'));
  writeReviewNotes(data, { a: { ...note, status: 'sent' }, b: { ...note, status: 'draft' } }, 0);
  return data;
}

const statuses = (data) => Object.fromEntries(Object.entries(readReview(data).notes).map(([id, n]) => [id, n.status]));

test('next-request --done sets the notes a revise was sent to answered and keeps them', () => {
  const data = setup();
  const f = writeRequest(data, { kind: 'revise', status: 'pending', items: [], noteIds: ['a'] });
  execFileSync('node', [NEXT, '--data', data, '--done', f]);
  assert.deepEqual(statuses(data), { a: 'answered', b: 'draft' });
  assert.ok(existsSync(join(data, 'requests', 'done', basename(f))));
});

test('next-request --done leaves notes alone for a build request', () => {
  const data = setup();
  const f = writeRequest(data, { kind: 'build', status: 'pending', sections: [], noteIds: ['a'] });
  execFileSync('node', [NEXT, '--data', data, '--done', f]);
  assert.deepEqual(statuses(data), { a: 'sent', b: 'draft' });
});

test('next-request --done on a legacy request with no kind changes no notes', () => {
  const data = setup();
  const f = writeRequest(data, { status: 'pending', items: [] });
  execFileSync('node', [NEXT, '--data', data, '--done', f]);
  assert.deepEqual(statuses(data), { a: 'sent', b: 'draft' });
  assert.ok(existsSync(join(data, 'requests', 'done', basename(f))));
});

test('next-request --done on a request the reader already filed says so and succeeds', () => {
  const data = setup();
  const f = writeRequest(data, { kind: 'build', status: 'pending', sections: [] });
  execFileSync('node', [NEXT, '--data', data, '--done', f]);
  const out = execFileSync('node', [NEXT, '--data', data, '--done', f], { encoding: 'utf8' });
  assert.match(out, /already filed/);
});
