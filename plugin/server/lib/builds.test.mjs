import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { startBuild, latestBuild, stopBuild, recordTask, recordRequirement, recordCall, beat, finishBuild, reviewCall } from './builds.mjs';
import { createRequire } from 'node:module';
import { currentSnapshot, readHistory, readReview } from './review.mjs';
import { acceptAll, startAccepted, startKeepingReview } from './accept-all.testkit.mjs';
import { findRequirement } from './book-model.mjs';
import { fileBuildRequests, fileRequest, listPending, writeRequest } from './requests.mjs';

let data;
const readBook = () => readJson(join(data, 'book.json'), null);

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'specbook-builds-'));
  writeJsonAtomic(join(data, 'book.json'), {
    chapters: [
      {
        id: 'c',
        sections: [
          { id: 'r', stage: 'ready', requirements: [{ id: 'R0', text: 'a' }, { id: 'R1', text: 'b', change: 'add' }] },
          { id: 'd', stage: 'drafting', requirements: [{ id: 'R2', text: 'c', change: 'add' }] },
        ],
      },
    ],
    usedIds: [],
  });
});


test('startBuild refuses a Ready section with a change not accepted yet, and moves nothing', () => {
  acceptAll(data);
  const book = readBook();
  book.chapters[0].sections[0].requirements.push({ id: 'R9', text: 'new, unaccepted', change: 'add' });
  writeJsonAtomic(join(data, 'book.json'), book);
  assert.throws(() => startBuild(data), { code: 'unreviewed', message: /c-r/ });
  assert.equal(readBook().chapters[0].sections[0].stage, 'ready');
  assert.equal(latestBuild(data), null);
  acceptAll(data);
  assert.deepEqual(Object.keys(startBuild(data).requirements).sort(), ['R1', 'R9']);
});

test('startBuild moves ready sections to building and queues their changes', () => {
  const p = startAccepted(data, Date.parse('2026-11-12T10:00:00Z'));
  assert.equal(p.id, '2026-11-12T10-00-00-000Z');
  assert.deepEqual(p.sections, ['c-r']);
  assert.deepEqual(p.requirements, { R1: { status: 'queued', section: 'c-r' } });
  assert.equal(readBook().chapters[0].sections.find(s => s.id === 'r').stage, 'building');
  assert.throws(() => startBuild(data), { code: 'busy' });
});

test('startBuild with no ready section throws nothing-ready', () => {
  const book = readBook();
  book.chapters[0].sections[0].stage = 'drafting';
  writeJsonAtomic(join(data, 'book.json'), book);
  assert.throws(() => startBuild(data), { code: 'nothing-ready' });
});

test('stopBuild returns building sections to drafting and keeps changes', () => {
  const p = startAccepted(data);
  stopBuild(data, p.id, 'Marked as stopped');
  const s = readBook().chapters[0].sections.find(x => x.id === 'r');
  assert.equal(s.stage, 'drafting');
  assert.equal(s.requirements[1].change, 'add');
  assert.equal(latestBuild(data).progress.state, 'failed');
  assert.equal(latestBuild(data).progress.reason, 'Marked as stopped');
  assert.throws(() => stopBuild(data, p.id, 'again'), { code: 'not-running' });
});

test('record functions set the heartbeat and need a running build', () => {
  const p = startAccepted(data, 0);
  const task = { index: 1, of: 2, title: 't', section: 'c-r', req: 'R1' };
  recordTask(data, p.id, task, 1000);
  recordRequirement(data, p.id, 'R1', 'in_progress', 2000);
  let got = latestBuild(data).progress;
  assert.deepEqual(got.task, task);
  assert.equal(got.requirements.R1.status, 'in_progress');
  assert.equal(got.heartbeat, new Date(2000).toISOString());
  beat(data, p.id, 3000);
  assert.equal(latestBuild(data).progress.heartbeat, new Date(3000).toISOString());
  stopBuild(data, p.id, 'r', 4000);
  assert.throws(() => beat(data, p.id, 5000), { code: 'not-running' });
  assert.throws(() => recordTask(data, p.id, task, 5000), { code: 'not-running' });
  assert.throws(() => recordRequirement(data, p.id, 'R1', 'proven', 5000), { code: 'not-running' });
});

test('recordCall mints a CALL id into usedIds and appends a pending call', () => {
  const p = startAccepted(data);
  const call = recordCall(data, p.id, { about: ['R1'], section: 'c-r', title: 't', body: 'b', before: 'x', after: 'y' });
  assert.match(call.id, /^CALL-[0-9A-Z]{4}$/);
  assert.equal(call.status, 'pending');
  assert.equal(call.note, '');
  assert.deepEqual(readBook().usedIds, [call.id]);
  assert.deepEqual(latestBuild(data).calls, [call]);
});

test('recordCall rejects a blank or missing title, before or after', () => {
  const p = startAccepted(data);
  const ok = { about: ['R1'], section: 'c-r', title: 't', body: 'b', before: 'x', after: 'y' };
  for (const field of ['title', 'before', 'after']) {
    assert.throws(() => recordCall(data, p.id, { ...ok, [field]: '  ' }), { code: 'missing-field' });
    const { [field]: _, ...without } = ok;
    assert.throws(() => recordCall(data, p.id, without), { code: 'missing-field' });
  }
  assert.deepEqual(latestBuild(data).calls, []);
});

test('latestBuild is null with no builds and reads corrupt files as null and []', () => {
  assert.equal(latestBuild(data), null);
  mkdirSync(join(data, 'builds', 'x'), { recursive: true });
  writeFileSync(join(data, 'builds', 'x', 'progress.json'), '{');
  assert.deepEqual(latestBuild(data), { id: 'x', progress: null, calls: [] });
});

test('requests: listPending is oldest first, skips unreadable and handled files', () => {
  assert.deepEqual(listPending(data), []);
  const rel = writeRequest(data, { kind: 'build', status: 'pending', sections: [] });
  assert.match(rel, /^requests\/.+\.json$/);
  writeFileSync(join(data, 'requests', '0000.json'), '{');
  writeFileSync(join(data, 'requests', '0001.json'), JSON.stringify({ status: 'handled' }));
  writeFileSync(join(data, 'requests', '0002.json'), JSON.stringify({ status: 'pending', items: [] }));
  const list = listPending(data);
  assert.deepEqual(list.map(l => l.file), ['0002.json', rel.replace('requests/', '')]);
  assert.equal(list[0].request.status, 'pending');
  assert.equal(readdirSync(join(data, 'requests')).length, 4);
});

test('requests: fileRequest moves a request to done/; fileBuildRequests files only pending builds', () => {
  const revise = writeRequest(data, { kind: 'revise', status: 'pending', items: [], noteIds: [] });
  writeFileSync(join(data, 'requests', '0001.json'), JSON.stringify({ kind: 'build', status: 'pending', sections: [] }));
  writeFileSync(join(data, 'requests', '0002.json'), JSON.stringify({ kind: 'build', status: 'pending', sections: [] }));
  assert.deepEqual(fileBuildRequests(data), ['0001.json', '0002.json']);
  assert.deepEqual(listPending(data).map(p => p.file), [revise.replace('requests/', '')]);
  const done = readJson(join(data, 'requests', 'done', '0001.json'), null);
  assert.equal(done.status, 'handled');
  assert.ok(done.handledAt);
  fileRequest(data, revise);
  assert.deepEqual(listPending(data), []);
});

const section = fullId => readBook().chapters[0].sections.find(s => `c-${s.id}` === fullId);

function writeEvidence(byId) {
  mkdirSync(join(data, 'evidence'), { recursive: true });
  writeJsonAtomic(join(data, 'evidence', 'evidence.json'), { byId });
}

function seedFinishBook() {
  writeJsonAtomic(join(data, 'book.json'), {
    chapters: [
      {
        id: 'c',
        sections: [
          {
            id: 'r',
            stage: 'ready',
            requirements: [
              { id: 'R0', text: 'a' },
              { id: 'R1', text: 'b', change: 'add' },
              { id: 'R2', text: 'c', change: 'change', today: 'old c' },
              { id: 'R3', text: '<p>d</p>', change: 'remove', reason: 'gone' },
            ],
          },
        ],
      },
    ],
    usedIds: ['R0', 'R1', 'R2', 'R3'],
  });
}

test('finishBuild applies proven changes, removes removals, and marks built', () => {
  seedFinishBook();
  const p = startAccepted(data);
  writeEvidence({ R0: { unit: [{ status: 'passed' }] }, R1: { unit: [{ status: 'passed' }] }, R2: { e2e: [{ status: 'passed' }] } });
  const out = finishBuild(data, p.id, Date.parse('2026-11-12T23:30:00Z'));
  assert.deepEqual(out, { built: ['c-r'], drafting: [] });
  const s = section('c-r');
  assert.equal(s.stage, 'built');
  assert.deepEqual(s.requirements.map(r => [r.id, r.change, r.today]), [['R0', undefined, undefined], ['R1', undefined, undefined], ['R2', undefined, undefined]]);
  const book = readBook();
  const dec = book.decisions.find(d => d.id === 'R3');
  assert.deepEqual(dec, { id: 'R3', date: '2026-11-12', about: ['R3'], by: 'build', title: 'd', body: 'gone', kind: 'removed' });
  assert.ok(book.usedIds.includes('R3'));
  assert.ok(existsSync(join(data, 'builds', p.id, 'summary.md')));
  const latest = latestBuild(data).progress;
  assert.equal(latest.state, 'done');
  assert.ok(latest.finishedAt);
  assert.equal(latest.requirements.R1.status, 'proven');
  assert.equal(latest.requirements.R3.status, 'proven');
  assert.throws(() => finishBuild(data, p.id), { code: 'not-running' });
});

test('finishBuild keeps unproven changes and removals, back to drafting', () => {
  seedFinishBook();
  const p = startAccepted(data);
  writeEvidence({ R1: { unit: [{ status: 'passed' }] }, R2: { unit: [{ status: 'failed' }] } });
  assert.deepEqual(finishBuild(data, p.id), { built: [], drafting: [{ section: 'c-r', unproven: ['R0', 'R2'] }] });
  const s = section('c-r');
  assert.equal(s.stage, 'drafting');
  assert.equal(s.requirements.find(r => r.id === 'R1').change, undefined);
  assert.equal(s.requirements.find(r => r.id === 'R2').change, 'change');
  assert.equal(s.requirements.find(r => r.id === 'R3').change, 'remove');
  assert.equal(latestBuild(data).progress.requirements.R2.status, 'failed');
});

test('finishBuild with no evidence file proves nothing', () => {
  seedFinishBook();
  const p = startAccepted(data);
  assert.deepEqual(finishBuild(data, p.id).drafting, [{ section: 'c-r', unproven: ['R0', 'R1', 'R2'] }]);
});

test('finishBuild holds removals back while a requirement that stays is unproven', () => {
  seedFinishBook();
  const p = startAccepted(data);
  writeEvidence({ R1: { unit: [{ status: 'passed' }] }, R2: { e2e: [{ status: 'passed' }] } });
  assert.deepEqual(finishBuild(data, p.id), { built: [], drafting: [{ section: 'c-r', unproven: ['R0'] }] });
  const s = section('c-r');
  assert.equal(s.stage, 'drafting');
  assert.equal(s.requirements.find(r => r.id === 'R3').change, 'remove');
  assert.equal(s.requirements.find(r => r.id === 'R1').change, undefined);
  assert.equal((readBook().decisions ?? []).length, 0);
  assert.equal(latestBuild(data).progress.requirements.R3.status, 'failed');
  assert.match(readFileSync(join(data, 'builds', p.id, 'summary.md'), 'utf8'), /c-r: unproven R0/);
});

test('finishBuild with no removals needs only its changes proven', () => {
  const p = startAccepted(data);
  writeEvidence({ R1: { unit: [{ status: 'passed' }] } });
  assert.deepEqual(finishBuild(data, p.id), { built: ['c-r'], drafting: [] });
});

test('recordRequirement rejects an unknown status', () => {
  const p = startAccepted(data);
  assert.throws(() => recordRequirement(data, p.id, 'R1', 'done'), { code: 'bad-status' });
  assert.equal(latestBuild(data).progress.requirements.R1.status, 'queued');
});

const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

// A finished build with one call about R1 (still in the book) and one about R3 (removed by finishBuild).
function seedReview() {
  seedFinishBook();
  const p = startAccepted(data);
  const call = recordCall(data, p.id, { about: ['R1'], section: 'c-r', title: 't', body: 'b', before: 'before text', after: 'after text' });
  const removed = recordCall(data, p.id, { about: ['R3'], section: 'c-r', title: 'gone', body: 'rb', before: 'x', after: 'y' });
  writeEvidence({ R0: { unit: [{ status: 'passed' }] }, R1: { unit: [{ status: 'passed' }] }, R2: { e2e: [{ status: 'passed' }] } });
  finishBuild(data, p.id);
  return { id: p.id, callId: call.id, removedCallId: removed.id };
}

test('accept records a build decision', () => {
  const { id, callId } = seedReview();
  const c = reviewCall(data, id, callId, { decision: 'accept' });
  assert.equal(c.status, 'accepted');
  assert.deepEqual(pick(readBook().decisions.at(-1), ['by', 'kind', 'about']), { by: 'build', kind: 'decision', about: ['R1'] });
  assert.throws(() => reviewCall(data, id, callId, { decision: 'accept' }), { code: 'decided' });
  assert.throws(() => reviewCall(data, id, 'nope', { decision: 'accept' }), { code: 'not-found' });
});

test('reject reopens the requirement, adds a note and a rejected decision', () => {
  const { id, callId } = seedReview();
  assert.throws(() => reviewCall(data, id, callId, { decision: 'reject', note: ' ' }), { code: 'note-required' });
  reviewCall(data, id, callId, { decision: 'reject', note: 'Use a toast' }, Date.parse('2026-11-13T01:00:00Z'));
  const r = findRequirement(readBook(), 'R1');
  assert.deepEqual([r.req.change, r.req.text, r.req.today, r.section.stage], ['change', 'before text', 'after text', 'drafting']);
  const n = Object.values(readReview(data).notes)[0];
  assert.equal(n.target, 'R1');
  assert.deepEqual([n.item, n.status], ['R1', 'draft']);
  assert.equal(n.text, 'Rejected call "t": Use a toast');
  assert.deepEqual(n.pin, { rx: 0, ry: 0.5 });
  assert.equal(n.rx, undefined);
  assert.equal(n.created, '2026-11-13T01:00:00.000Z');
  const dec = readBook().decisions.at(-1);
  assert.equal(dec.kind, 'rejected');
  assert.equal(dec.date, '2026-11-13');
  assert.equal(dec.title, 'Rejected: t');
  assert.equal(dec.body, 'b\n\nInstead: Use a toast');
  const saved = latestBuild(data).calls.find(c => c.id === callId);
  assert.deepEqual([saved.status, saved.note], ['rejected', 'Use a toast']);
});

test('a rejection note is escaped in the decision and kept plain in the note and the call', () => {
  const { id, callId } = seedReview();
  const note = `Use <b>bold</b> & "quotes" it's`;
  reviewCall(data, id, callId, { decision: 'reject', note });
  assert.equal(readBook().decisions.at(-1).body, 'b\n\nInstead: Use &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot; it&#39;s');
  assert.equal(Object.values(readReview(data).notes)[0].text, `Rejected call "t": ${note}`);
  assert.equal(latestBuild(data).calls.find(c => c.id === callId).note, note);
});

test('reject when the requirement was removed puts the note on the section', () => {
  const { id, removedCallId } = seedReview();
  reviewCall(data, id, removedCallId, { decision: 'reject', note: 'Keep it' });
  const n = Object.values(readReview(data).notes)[0];
  assert.equal(n.target, 'c-r');
  assert.equal(n.item, 'c-r');
  assert.equal(n.section, 'c-r');
  assert.equal(readBook().decisions.at(-1).kind, 'rejected');
  assert.equal(section('c-r').stage, 'drafting');
});

// ---- review.json and history.json after a finished build --------------------------------------------------------

const Model = createRequire(import.meta.url)('../../app/model.js');
const reviewsNow = () => {
  const { book, mockups } = currentSnapshot(data);
  return Model.reviews(book, mockups, readReview(data), readHistory(data));
};
const allProven = () => writeEvidence({ R0: { unit: [{ status: 'passed' }] }, R1: { unit: [{ status: 'passed' }] }, R2: { e2e: [{ status: 'passed' }] } });

test('finishBuild drops the markers into the accepted copy, records built history and a changelog entry', () => {
  seedFinishBook();
  writeJsonAtomic(join(data, 'review.json'), {
    rev: 4,
    accepted: { R0: { text: 'a' }, R2: { text: 'c', change: 'change', today: 'old c' }, R3: { text: '<p>d</p>', change: 'remove', reason: 'gone' } },
    notes: {}, tries: {}, opened: {}, where: {},
  });
  const p = startKeepingReview(data);
  allProven();
  finishBuild(data, p.id, Date.parse('2026-11-14T10:00:00Z'), { summary: 'People can filter.' });
  const review = readReview(data);
  assert.deepEqual(review.accepted.R1, { text: 'b' });
  assert.deepEqual(review.accepted.R2, { text: 'c' });
  assert.equal(review.accepted.R3, undefined);
  assert.equal(review.rev, 5);
  const r = reviewsNow();
  for (const key of ['R0', 'R1', 'R2', 'R3']) {
    assert.equal(r.byKey[key], undefined, key);
  }
  const history = readHistory(data);
  assert.deepEqual(history.items.R1.map(e => [e.kind, e.before, e.after]), [['built', null, { text: 'b' }]]);
  assert.deepEqual(history.items.R3.map(e => [e.kind, e.before, e.after]), [['built', { text: '<p>d</p>', change: 'remove', reason: 'gone' }, null]]);
  assert.equal(history.items.R1[0].acceptedAt, '2026-11-14T10:00:00.000Z');
  assert.equal(history.changelog.length, 1);
  assert.deepEqual(history.changelog[0], {
    build: p.id,
    date: '2026-11-14',
    summary: 'People can filter.',
    sections: ['c-r'],
    landed: [
      { id: 'R1', kind: 'added', text: 'b' },
      { id: 'R2', kind: 'changed', text: 'c' },
      { id: 'R3', kind: 'removed', text: '<p>d</p>' },
    ],
    commits: [],
  });
});

test('a build that also reworded text leaves the item under review against the old accepted text', () => {
  seedFinishBook();
  writeJsonAtomic(join(data, 'review.json'), {
    rev: 1, accepted: { R2: { text: 'old c', change: 'change', today: 'older' } }, notes: {}, tries: {}, opened: {}, where: {},
  });
  const p = startKeepingReview(data);
  allProven();
  finishBuild(data, p.id);
  assert.deepEqual(readReview(data).accepted.R2, { text: 'old c' });
  const r = reviewsNow().byKey.R2;
  assert.ok(r);
  assert.equal(r.accepted.text, 'old c');
  assert.equal(readHistory(data).changelog[0].summary, '');
});

test('finishBuild lists the build commits and does not add a second changelog entry for the same build', () => {
  seedFinishBook();
  const p = startKeepingReview(data);
  const progress = readJson(join(data, 'builds', p.id, 'progress.json'), null);
  writeJsonAtomic(join(data, 'builds', p.id, 'progress.json'), { ...progress, commits: ['abc1234'] });
  allProven();
  finishBuild(data, p.id, Date.now(), { summary: 's' });
  assert.deepEqual(readHistory(data).changelog[0].commits, ['abc1234']);
  // Crash-then-retry: the build is running again, the book still carries its markers.
  const done = readJson(join(data, 'builds', p.id, 'progress.json'), null);
  writeJsonAtomic(join(data, 'builds', p.id, 'progress.json'), { ...done, state: 'running' });
  seedFinishBook();
  finishBuild(data, p.id, Date.now(), { summary: 's' });
  const history = readHistory(data);
  assert.equal(history.changelog.length, 1);
  assert.equal(history.items.R1.length, 1);
});

test('a build with nothing proven adds a changelog entry with no landed items and leaves review.json alone', () => {
  seedFinishBook();
  const p = startKeepingReview(data);
  finishBuild(data, p.id);
  assert.deepEqual(readHistory(data).changelog[0].landed, []);
  assert.equal(readReview(data).rev, 0);
});
