import { createRequire } from 'node:module';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptItem, currentItems, readReview, writeReviewNotes } from './lib/review.mjs';
import { recordCall, startBuild } from './lib/builds.mjs';

const SERVE = join(dirname(fileURLToPath(import.meta.url)), 'serve.mjs');
const port = 4300 + Math.floor(Math.random() * 700);
const base = `http://127.0.0.1:${port}`;
let data;
let child;

const note = { item: 'R1', text: 'hi', created: '2026-01-01T00:00:00.000Z', pin: { rx: 0, ry: 0.5, dx: 0, dy: 0 } };
const item = { text: 'hi' };

// Every item as it stands is accepted, so nothing is under review.
function acceptAll() {
  for (const key of Object.keys(currentItems(data))) {
    acceptItem(data, key, '2026-11-01T00:00:00.000Z');
  }
}

function freshBook() {
  return {
    title: 'T',
    chapters: [
      {
        id: 'c',
        title: 'C',
        sections: [
          { id: 'd', title: 'D', stage: 'drafting', frames: [{ id: 'c-d-1', mockup: 'mockups/d.html' }], requirements: [{ id: 'R1', text: 'x', change: 'add' }] },
        ],
      },
    ],
  };
}

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: method === 'POST' || method === 'PUT' ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// A request with exactly these headers (fetch will not send another Host).
function raw(method, path, headers, body) {
  return new Promise((resolveRaw, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let text = '';
      res.on('data', c => {
        text += c;
      });
      res.on('end', () => {
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolveRaw({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  data = mkdtempSync(join(tmpdir(), 'specbook-serve-'));
  child = spawn(process.execPath, [SERVE, '--data', data, '--port', String(port)], { stdio: 'ignore' });
  writeFileSync(join(data, 'book.json'), JSON.stringify(freshBook()));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('server did not start');
});

after(() => {
  child.kill();
  rmSync(data, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of ['requests', 'builds', 'revise', 'notes.json', 'review.json', 'history.json', 'mockups']) {
    rmSync(join(data, name), { recursive: true, force: true });
  }
  mkdirSync(join(data, 'mockups'));
  writeFileSync(join(data, 'mockups', 'd.html'), '<p>d</p>');
  writeFileSync(join(data, 'book.json'), JSON.stringify(freshBook()));
});

test('Revise twice writes one request, marks its notes sent; notes lock while revising', async () => {
  const put = await api('PUT', '/api/notes', { rev: 0, notes: { a: note, b: note } });
  assert.equal(put.status, 200);
  const first = await api('POST', '/api/revise', { items: [item], noteIds: ['a'] });
  assert.equal(first.status, 201);
  assert.equal(first.body.count, 1);
  assert.equal((await api('POST', '/api/revise', { items: [item], noteIds: ['a'] })).status, 409);
  assert.equal(readdirSync(join(data, 'requests')).filter(f => f.endsWith('.json')).length, 1);
  assert.equal((await api('PUT', '/api/notes', { rev: 2, notes: {} })).status, 409);
  const notes = readReview(data).notes;
  assert.deepEqual([notes.a.status, notes.b.status], ['sent', 'draft']);
  assert.equal(existsSync(join(data, 'revise')), false);
});

test('/api/claude says when the book or a mockup last changed on disk', async () => {
  const first = (await api('GET', '/api/claude')).body.bookAt;
  assert.ok(first > 0);
  const later = new Date(first + 5000);
  utimesSync(join(data, 'mockups', 'd.html'), later, later);
  assert.equal((await api('GET', '/api/claude')).body.bookAt, later.getTime());
});

test('PUT /api/notes needs a notes object and a numeric rev', async () => {
  for (const body of [{ rev: 0 }, { rev: 0, notes: [] }, { rev: 0, notes: null }, { rev: '0', notes: {} }, { notes: {} }]) {
    assert.deepEqual(await api('PUT', '/api/notes', body), { status: 400, body: { error: 'bad-notes' } }, JSON.stringify(body));
  }
  assert.equal((await api('PUT', '/api/notes', { rev: 0, notes: {} })).status, 200);
});

test('Revise with no items is a 400', async () => {
  const r = await api('POST', '/api/revise', { items: [], noteIds: [] });
  assert.equal(r.status, 400);
});

test('malformed JSON is a 400 bad-json', async () => {
  const r = await api('PUT', '/api/notes', '{');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad-json');
});

test('a stale tab cannot bring back removed notes', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note } });
  writeReviewNotes(data, {}, 1);
  const r = await api('PUT', '/api/notes', { rev: 1, notes: { a: note } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'stale');
});

test('Build needs a ready section and locks stages; notes stay writable', async () => {
  acceptAll();
  assert.equal((await api('POST', '/api/build')).status, 400);
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' })).status, 200);
  assert.equal((await api('POST', '/api/build')).status, 201);
  assert.equal((await api('POST', '/api/build')).status, 409);
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'drafting' })).status, 409);
  assert.equal((await api('PUT', '/api/notes', { rev: readReview(data).rev, notes: { a: note } })).status, 200);
});

test('stage errors map to statuses', async () => {
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'built' })).status, 400);
  assert.equal((await api('POST', '/api/stage', { section: 'nope', stage: 'ready' })).status, 404);
});

test('a corrupt review.json still serves the book', async () => {
  writeFileSync(join(data, 'review.json'), '{');
  writeFileSync(join(data, 'history.json'), '[');
  const r = await api('GET', '/api/book');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.review.notes, {});
  assert.deepEqual(r.body.changelog, []);
  assert.deepEqual(r.body.historyCounts, {});
  assert.equal(r.body.claude.state, 'idle');
  assert.equal('notes' in r.body, false);
  assert.equal('revise' in r.body, false);
});

test('/data refuses internal folders', async () => {
  writeFileSync(join(data, 'notes.json'), '{}');
  writeFileSync(join(data, 'review.json'), '{}');
  writeFileSync(join(data, 'history.json'), '{}');
  for (const p of ['requests/x.json', 'builds/x.json', 'revise/before.json', 'notes.json', 'review.json', 'history.json', 'REVIEW.json']) {
    assert.equal((await api('GET', `/data/${p}`)).status, 403, p);
  }
  assert.equal((await api('GET', '/data/book.json')).status, 200);
});

test('/data refuses internal folders whatever their case or encoding, and dot files', async () => {
  writeFileSync(join(data, 'notes.json'), '{}');
  mkdirSync(join(data, 'requests'), { recursive: true });
  writeFileSync(join(data, 'requests', 'a.json'), '{}');
  writeFileSync(join(data, 'mockups', '.hidden.html'), 'x');
  for (const p of ['NOTES.json', 'Requests/a.json', 'mockups%2F..%2Fnotes.json', 'mockups%2F..%2Frequests%2Fa.json', 'mockups/.hidden.html', '.server.json']) {
    assert.equal((await api('GET', `/data/${p}`)).status, 403, p);
  }
  assert.equal((await api('GET', '/data/mockups/d.html')).status, 200);
  // A malformed escape is a 400, not a crash.
  assert.equal((await api('GET', '/data/%E0')).status, 400);
  assert.equal((await api('GET', '/api/health')).status, 200);
});

test('/data refuses internal files reached through Unicode case folding', async () => {
  writeFileSync(join(data, 'notes.json'), '{}');
  mkdirSync(join(data, 'requests'), { recursive: true });
  writeFileSync(join(data, 'requests', 'a.json'), '{}');
  // U+017F (long s) folds to "s" on a case-insensitive disk such as APFS.
  for (const p of ['note%C5%BF.json', 'reque%C5%BFt%C5%BF/a.json']) {
    assert.equal((await api('GET', `/data/${p}`)).status, 403, p);
  }
  assert.equal((await api('GET', '/data/mockups/d.html')).status, 200);
  assert.equal((await api('GET', '/data/book.json')).status, 200);
  assert.equal((await api('GET', '/data/mockups/missing.html')).status, 404);
});

test('stop and review endpoints', async () => {
  acceptAll();
  await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' });
  await api('POST', '/api/build');
  const id = startBuild(data).id;
  const claude = await api('GET', '/api/claude');
  assert.equal(claude.status, 200);
  assert.deepEqual(claude.body.calls, []);
  assert.equal(claude.body.build.id, id);
  // The running build's calls are listed as it makes them, so the reader can count them.
  const call = recordCall(data, id, { about: ['R1'], section: 'c-d', title: 't', body: 'b', before: 'x', after: 'y' });
  assert.deepEqual((await api('GET', '/api/claude')).body.calls.map(c => [c.id, c.build]), [[call.id, id]]);
  // The book is locked while the build runs, so its calls cannot be reviewed yet.
  assert.deepEqual(await api('POST', `/api/builds/${id}/calls/${call.id}`, { decision: 'accept' }), { status: 409, body: { error: 'locked' } });
  assert.equal((await api('POST', `/api/builds/${id}/stop`)).status, 200);
  assert.equal((await api('POST', `/api/builds/${id}/calls/nope`, { decision: 'accept' })).status, 404);
  const accepted = await api('POST', `/api/builds/${id}/calls/${call.id}`, { decision: 'accept' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, 'accepted');
  assert.equal(accepted.body.id, call.id);
  assert.equal(JSON.parse(readFileSync(join(data, 'builds', id, 'calls.json'), 'utf8')).calls[0].status, 'accepted');
  assert.equal((await api('POST', `/api/builds/${id}/stop`)).status, 409);
  // Marking the build stopped also files its request, so the book unlocks.
  assert.equal((await api('GET', '/api/claude')).body.state, 'idle');
});

test('a stale build request that never started can be cancelled', async () => {
  acceptAll();
  await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' });
  await api('POST', '/api/build');
  const [file] = readdirSync(join(data, 'requests')).filter(f => f.endsWith('.json'));
  const path = join(data, 'requests', file);
  const request = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...request, createdAt: new Date(Date.now() - 11 * 60e3).toISOString() }));
  const claude = (await api('GET', '/api/claude')).body;
  assert.deepEqual([claude.state, claude.stale, claude.build], ['building', true, null]);
  const r = await api('POST', '/api/builds/pending/cancel');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.filed, [file]);
  assert.equal((await api('GET', '/api/claude')).body.state, 'idle');
  assert.ok(existsSync(join(data, 'requests', 'done', file)));
});

test('a pending build request that is not stale cannot be cancelled', async () => {
  acceptAll();
  await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' });
  await api('POST', '/api/build');
  assert.equal((await api('GET', '/api/claude')).body.stale, false);
  assert.deepEqual(await api('POST', '/api/builds/pending/cancel'), { status: 409, body: { error: 'not-stale' } });
  assert.equal((await api('GET', '/api/claude')).body.state, 'building');
});

test('a pending build cannot be cancelled while its build runs', async () => {
  acceptAll();
  await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' });
  await api('POST', '/api/build');
  startBuild(data);
  assert.equal((await api('POST', '/api/builds/pending/cancel')).status, 409);
});

test('another origin or host is refused', async () => {
  acceptAll();
  const host = `127.0.0.1:${port}`;
  const json = { 'content-type': 'application/json' };
  const evil = await raw('POST', '/api/stage', { host, ...json, origin: 'https://evil.example' }, JSON.stringify({ section: 'c-d', stage: 'ready' }));
  assert.deepEqual(evil, { status: 403, body: { error: 'forbidden' } });
  assert.equal(JSON.parse(readFileSync(join(data, 'book.json'), 'utf8')).chapters[0].sections[0].stage, 'drafting');
  assert.equal((await raw('GET', '/api/book', { host, origin: 'http://localhost:1' })).status, 403);
  // DNS rebinding: the page's own origin, but under another name.
  assert.deepEqual(await raw('GET', '/api/book', { host: `evil.example:${port}` }), { status: 403, body: { error: 'forbidden' } });
  assert.equal((await raw('GET', '/data/book.json', { host: 'localhost' })).status, 403);
  for (const ok of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    assert.equal((await raw('POST', '/api/stage', { host, ...json, origin: ok }, JSON.stringify({ section: 'c-d', stage: 'ready' }))).status, 200, ok);
  }
  assert.equal((await raw('GET', '/api/health', { host: `localhost:${port}` })).status, 200);
});

test('a POST or PUT body must be JSON', async () => {
  acceptAll();
  const host = `127.0.0.1:${port}`;
  const form = await raw('POST', '/api/stage', { host, 'content-type': 'text/plain' }, JSON.stringify({ section: 'c-d', stage: 'ready' }));
  assert.deepEqual(form, { status: 415, body: { error: 'json-required' } });
  assert.equal((await raw('PUT', '/api/notes', { host }, JSON.stringify({ rev: 0, notes: {} }))).status, 415);
  assert.equal((await raw('POST', '/api/build', { host })).status, 415);
  assert.equal((await raw('POST', '/api/stage', { host, 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ section: 'c-d', stage: 'ready' }))).status, 200);
});

test('without --port, --detach reuses the server already running for the folder on its recorded port', async () => {
  writeFileSync(join(data, '.server.json'), JSON.stringify({ pid: child.pid, port }));
  const out = await new Promise(done => {
    let text = '';
    const p = spawn(process.execPath, [SERVE, '--data', data, '--detach'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', d => { text += d; });
    p.on('exit', () => done(text));
  });
  assert.match(out, new RegExp(`already served at http://localhost:${port}/`));
  rmSync(join(data, '.server.json'), { force: true });
});

const ISO = /^\d{4}-\d\d-\d\dT/;

test('GET /api/book returns review, changelog and history counts, and stamps opened', async () => {
  const r = (await api('GET', '/api/book')).body;
  assert.deepEqual(Object.keys(r).sort(), ['book', 'changelog', 'claude', 'evidence', 'historyCounts', 'media', 'owner', 'review', 'viewer']);
  assert.ok(ISO.test(r.review.opened.R1));
  assert.deepEqual(r.review.where.R1, { kind: 'req', section: 'c-d', chapter: 'c' });
  assert.deepEqual(r.historyCounts, {});
  assert.equal((await api('POST', '/api/accept', { key: 'R1' })).status, 200);
  const after = (await api('GET', '/api/book')).body;
  assert.deepEqual(after.historyCounts, { R1: 1 });
  assert.equal(after.review.accepted.R1.text, 'x');
});

test('the server migrates an old notes.json and baseline on start', async () => {
  // Another server on its own folder and port, with the old files.
  const dir = mkdtempSync(join(tmpdir(), 'specbook-serve-mig-'));
  const p = port + 1000;
  mkdirSync(join(dir, 'revise'));
  writeFileSync(join(dir, 'book.json'), JSON.stringify(freshBook()));
  writeFileSync(join(dir, 'revise', 'before.json'), JSON.stringify({ book: freshBook(), mockups: {}, dismissed: [], accepted: {} }));
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ rev: 2, notes: { a: { target: 'c-d-1', section: 'c-d', rx: 0, ry: 0.5, text: 'hi', created: '2026-01-01T00:00:00.000Z' } } }));
  const proc = spawn(process.execPath, [SERVE, '--data', dir, '--port', String(p)], { stdio: 'ignore' });
  try {
    let body = null;
    for (let i = 0; i < 100 && !body; i++) {
      try {
        body = await (await fetch(`http://127.0.0.1:${p}/api/book`)).json();
      } catch {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    assert.equal(body.review.notes.a.status, 'draft');
    assert.equal(body.review.notes.a.item, 'c-d-1');
    assert.ok(body.review.accepted.R1);
    assert.equal(existsSync(join(dir, 'notes.json')), false);
    assert.equal(existsSync(join(dir, 'revise', 'before.json')), false);
    assert.ok(existsSync(join(dir, 'history.json')));
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /api/notes keeps non-draft notes as stored and ignores page edits to them', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note, b: note } });
  await api('POST', '/api/revise', { items: [item], noteIds: ['a'] });
  rmSync(join(data, 'requests'), { recursive: true, force: true });
  const rev = readReview(data).rev;
  // The page edits a (sent), deletes nothing else, and adds c; status claims are not trusted.
  const sent = { ...note, text: 'edited', status: 'draft' };
  const r = await api('PUT', '/api/notes', { rev, notes: { a: sent, b: { ...note, text: 'b2' }, c: { ...note, status: 'answered' } } });
  assert.equal(r.status, 200);
  const notes = readReview(data).notes;
  assert.deepEqual([notes.a.text, notes.a.status], ['hi', 'sent']);
  assert.deepEqual([notes.b.text, notes.b.status], ['b2', 'draft']);
  assert.equal(notes.c.status, 'draft');
  // Dropping a sent note from the page's list does not delete it; dropping a draft does.
  const again = await api('PUT', '/api/notes', { rev: r.body.rev, notes: {} });
  assert.equal(again.status, 200);
  assert.deepEqual(Object.keys(readReview(data).notes), ['a']);
});

test('POST /api/accept accepts the current value and writes history; unknown key is 404', async () => {
  assert.equal((await api('POST', '/api/accept', {})).status, 400);
  assert.equal((await api('POST', '/api/accept', { key: 'ZZZ' })).status, 404);
  const r = await api('POST', '/api/accept', { key: 'R1' });
  assert.equal(r.status, 200);
  assert.deepEqual(readReview(data).accepted.R1, { text: 'x', change: 'add' });
  const h = await api('GET', '/api/history/R1');
  assert.equal(h.status, 200);
  assert.equal(h.body.entries.length, 1);
  assert.equal(h.body.entries[0].before, null);
  assert.deepEqual((await api('GET', '/api/history/nothing')).body, { entries: [] });
  // Already accepted and unchanged: nothing to accept.
  assert.equal((await api('POST', '/api/accept', { key: 'R1' })).status, 404);
});

test('the old accept body (key and value) no longer writes a baseline', async () => {
  const r = await api('POST', '/api/accept', { key: 'R1', value: { id: 'R1', text: 'forged' } });
  assert.equal(r.status, 200);
  assert.equal(readReview(data).accepted.R1.text, 'x');
  assert.equal(existsSync(join(data, 'revise')), false);
});

test('a stale PUT /api/notes after an accept is refused and leaves the accepted copy alone', async () => {
  const { rev } = (await api('GET', '/api/book')).body.review;
  await api('POST', '/api/accept', { key: 'R1' });
  const r = await api('PUT', '/api/notes', { rev, notes: { a: note } });
  assert.deepEqual(r, { status: 409, body: { error: 'stale' } });
  assert.equal(readReview(data).accepted.R1.text, 'x');
  assert.deepEqual(readReview(data).notes, {});
});

test('POST /api/change freezes a try and adds a draft note; an empty note is 400', async () => {
  acceptAll();
  const book = freshBook();
  book.chapters[0].sections[0].requirements[0].text = 'y';
  writeFileSync(join(data, 'book.json'), JSON.stringify(book));
  assert.deepEqual(await api('POST', '/api/change', { key: 'R1', note: '  ' }), { status: 400, body: { error: 'note-required' } });
  assert.equal((await api('POST', '/api/change', { key: 'NOPE', note: 'n' })).status, 404);
  const r = await api('POST', '/api/change', { key: 'R1', note: 'not yet' });
  assert.equal(r.status, 200);
  const review = readReview(data);
  assert.equal(review.notes[r.body.noteId].status, 'draft');
  assert.equal(review.notes[r.body.noteId].text, 'not yet');
  assert.equal(review.tries.R1.length, 1);
  assert.equal(review.tries.R1[0].value.text, 'y');
});

test('accept, change and requirement writes are locked while Claude is revising or building', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note } });
  await api('POST', '/api/revise', { items: [item], noteIds: ['a'] });
  const locked = { status: 409, body: { error: 'locked' } };
  assert.deepEqual(await api('POST', '/api/accept', { key: 'R1' }), locked);
  assert.deepEqual(await api('POST', '/api/change', { key: 'R1', note: 'n' }), locked);
  assert.deepEqual(await api('POST', '/api/requirements', { section: 'c-d', text: 't' }), locked);
  assert.deepEqual(await api('PUT', '/api/requirements/R1', { text: 't' }), locked);
  assert.deepEqual(await api('DELETE', '/api/requirements/R1'), locked);
  rmSync(join(data, 'requests'), { recursive: true, force: true });
  acceptAll();
  await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' });
  await api('POST', '/api/build');
  assert.deepEqual(await api('POST', '/api/accept', { key: 'R1' }), locked);
  assert.deepEqual(await api('POST', '/api/requirements', { section: 'c-d', text: 't' }), locked);
});

const book = () => JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
const reqs = () => book().chapters[0].sections[0].requirements;

test('POST /api/requirements mints a chapter-prefixed id, appends and opens a review', async () => {
  assert.equal((await api('POST', '/api/requirements', { section: 'nope', text: 't' })).status, 404);
  assert.equal((await api('POST', '/api/requirements', { section: 'c-d', text: ' ' })).status, 400);
  const r = await api('POST', '/api/requirements', { section: 'c-d', text: 'New thing', change: 'add', note: 'because' });
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^C-[2-9A-HJ-NP-Z]{4}$/);
  const added = reqs().at(-1);
  assert.deepEqual(added, { id: r.body.id, text: 'New thing', change: 'add' });
  assert.ok(book().usedIds.includes(r.body.id));
  const notes = Object.values(readReview(data).notes);
  assert.deepEqual(notes.map(n => [n.item, n.text, n.status]), [[r.body.id, 'because', 'answered']]);
  const view = (await api('GET', '/api/book')).body;
  assert.ok(view.review.opened[r.body.id]);
});

test('PUT /api/requirements/:id edits the text and marker', async () => {
  assert.equal((await api('PUT', '/api/requirements/NOPE', { text: 't' })).status, 404);
  assert.equal((await api('PUT', '/api/requirements/R1', { text: '' })).status, 400);
  const r = await api('PUT', '/api/requirements/R1', { text: 'y', change: 'change', today: 'x', note: 'why' });
  assert.equal(r.status, 200);
  assert.deepEqual(reqs()[0], { id: 'R1', text: 'y', change: 'change', today: 'x' });
  const cleared = await api('PUT', '/api/requirements/R1', { text: 'z', change: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(reqs()[0], { id: 'R1', text: 'z' });
  const removed = await api('PUT', '/api/requirements/R1', { text: 'z', change: 'remove', reason: 'obsolete' });
  assert.deepEqual(reqs()[0], { id: 'R1', text: 'z', change: 'remove', reason: 'obsolete' });
  assert.equal(removed.status, 200);
  assert.deepEqual(Object.values(readReview(data).notes).map(n => [n.item, n.text, n.status]), [['R1', 'why', 'answered']]);
});

test('DELETE /api/requirements/:id removes a never-accepted requirement; an accepted one is 409', async () => {
  const added = (await api('POST', '/api/requirements', { section: 'c-d', text: 'temp', note: 'n' })).body.id;
  assert.equal((await api('DELETE', `/api/requirements/${added}`)).status, 200);
  assert.deepEqual(reqs().map(r => r.id), ['R1']);
  assert.deepEqual(readReview(data).notes, {});
  assert.equal((await api('DELETE', `/api/requirements/${added}`)).status, 404);
  await api('POST', '/api/accept', { key: 'R1' });
  assert.deepEqual(await api('DELETE', '/api/requirements/R1'), { status: 409, body: { error: 'accepted' } });
  assert.equal(reqs().length, 1);
});

test('Revise only sends draft notes to sent; finishing the request answers them', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note } });
  await api('POST', '/api/revise', { items: [item], noteIds: ['a'] });
  assert.equal(readReview(data).notes.a.status, 'sent');
});

test('Mark ready is refused with 409 unreviewed while the section, a requirement or a frame is under review', async () => {
  acceptAll();
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' })).status, 200);
  await api('POST', '/api/stage', { section: 'c-d', stage: 'drafting' });
  // A requirement under review.
  assert.equal((await api('PUT', '/api/requirements/R1', { text: 'changed', change: 'add' })).status, 200);
  assert.deepEqual(await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' }), { status: 409, body: { error: 'unreviewed' } });
  await api('POST', '/api/accept', { key: 'R1' });
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' })).status, 200);
  await api('POST', '/api/stage', { section: 'c-d', stage: 'drafting' });
  // A frame under review.
  writeFileSync(join(data, 'mockups', 'd.html'), '<p>new</p>');
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' })).status, 409);
  await api('POST', '/api/accept', { key: 'c-d-1' });
  // The section heading under review.
  const b = book();
  b.chapters[0].sections[0].title = 'Renamed';
  writeFileSync(join(data, 'book.json'), JSON.stringify(b));
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' })).status, 409);
  await api('POST', '/api/accept', { key: 'c-d' });
  assert.equal((await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' })).status, 200);
});

test('page-sent draft notes are whitelisted: stray fields stripped, bad shapes 400, accept still works', async () => {
  const forged = { ...note, causes: 5, closedFor: 'x', reply: 'r', status: 'answered', from: 'y' };
  const r = await api('PUT', '/api/notes', { rev: 0, notes: { a: forged } });
  assert.equal(r.status, 200);
  assert.deepEqual(readReview(data).notes.a, { item: 'R1', text: 'hi', created: note.created, status: 'draft', pin: note.pin });
  assert.equal((await api('POST', '/api/accept', { key: 'R1' })).status, 200);
  const rev = readReview(data).rev;
  for (const bad of [{ ...note, item: 'NOPE' }, { ...note, item: 5 }, { ...note, text: 5 }, { ...note, pin: { rx: 'a', ry: 0, dx: 0, dy: 0 } }, { ...note, pin: [] }, 'x']) {
    assert.deepEqual(await api('PUT', '/api/notes', { rev, notes: { b: bad } }), { status: 400, body: { error: 'bad-note' } }, JSON.stringify(bad));
  }
  assert.equal((await api('PUT', '/api/notes', { rev, notes: { b: { ...note, pin: { ...note.pin, element: 'el' } } } })).status, 200);
});

test('a draft note keeps its page target and section, and its pin may come without a sticky offset', async () => {
  const placed = { ...note, target: 'c-d-v1', section: 'c-d', pin: { rx: 0.1, ry: 0.2 } };
  assert.equal((await api('PUT', '/api/notes', { rev: 0, notes: { a: placed } })).status, 200);
  assert.deepEqual(readReview(data).notes.a, { item: 'R1', text: 'hi', created: note.created, status: 'draft', target: 'c-d-v1', section: 'c-d', pin: { rx: 0.1, ry: 0.2 } });
  const rev = readReview(data).rev;
  for (const bad of [{ ...note, target: 5 }, { ...note, section: {} }, { ...note, pin: { rx: 0, ry: 0, dx: 1 } }]) {
    assert.deepEqual(await api('PUT', '/api/notes', { rev, notes: { b: bad } }), { status: 400, body: { error: 'bad-note' } }, JSON.stringify(bad));
  }
});

test('a stored draft keeps its server-written causes, closedFor and reply when the page saves it again', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note } });
  const review = readReview(data);
  writeFileSync(join(data, 'review.json'), JSON.stringify({ ...review, notes: { a: { ...review.notes.a, causes: ['c-d'], closedFor: ['x'], reply: 'r' } } }));
  const rev = readReview(data).rev;
  assert.equal((await api('PUT', '/api/notes', { rev, notes: { a: { ...note, text: 'edited', causes: ['forged'] } } })).status, 200);
  const a = readReview(data).notes.a;
  assert.equal(a.text, 'edited');
  assert.deepEqual([a.causes, a.closedFor, a.reply], [['c-d'], ['x'], 'r']);
});

test('requirement change must be add, change, remove or absent', async () => {
  for (const change of ['bogus', 'Remove', 5]) {
    assert.deepEqual(await api('POST', '/api/requirements', { section: 'c-d', text: 't', change }), { status: 400, body: { error: 'bad-change' } });
    assert.deepEqual(await api('PUT', '/api/requirements/R1', { text: 't', change }), { status: 400, body: { error: 'bad-change' } });
  }
  assert.equal(reqs()[0].change, 'add');
  assert.equal((await api('POST', '/api/requirements', { section: 'c-d', text: 't' })).status, 200);
});

test('history lookups use own properties only', async () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual((await api('GET', `/api/history/${key}`)).body, { entries: [] }, key);
  }
});

test('reading the book twice does not bump the revision, so a PUT /api/notes with it succeeds', async () => {
  const first = (await api('GET', '/api/book')).body.review.rev;
  const second = (await api('GET', '/api/book')).body.review.rev;
  assert.equal(second, first);
  assert.equal((await api('PUT', '/api/notes', { rev: second, notes: { a: note } })).status, 200);
});

test('PUT /api/notes is allowed while a build is in progress', async () => {
  acceptAll();
  await api('POST', '/api/stage', { section: 'c-d', stage: 'ready' });
  assert.equal((await api('POST', '/api/build')).status, 201);
  assert.equal((await api('GET', '/api/claude')).body.state, 'building');
  assert.equal((await api('PUT', '/api/notes', { rev: readReview(data).rev, notes: { a: note } })).status, 200);
});

test('a page edit moves a Ready or Built section back to drafting, and a build then cannot land an unaccepted item', async () => {
  acceptAll();
  for (const stage of ['ready', 'built']) {
    const set = s => {
      const b = book();
      b.chapters[0].sections[0].stage = s;
      writeFileSync(join(data, 'book.json'), JSON.stringify(b));
    };
    set(stage);
    const added = await api('POST', '/api/requirements', { section: 'c-d', text: 'page added', change: 'add' });
    assert.equal(added.body.demoted, true);
    assert.equal(book().chapters[0].sections[0].stage, 'drafting');
    set(stage);
    assert.equal((await api('PUT', '/api/requirements/R1', { text: 'reworded', change: 'change', today: 'x' })).body.demoted, true);
    assert.equal(book().chapters[0].sections[0].stage, 'drafting');
    set(stage);
    assert.equal((await api('DELETE', `/api/requirements/${added.body.id}`)).body.demoted, true);
    assert.equal(book().chapters[0].sections[0].stage, 'drafting');
    assert.equal((await api('PUT', '/api/requirements/R1', { text: 'again', change: 'change' })).body.demoted, false);
  }
  // Nothing is ready, so Build refuses.
  assert.deepEqual(await api('POST', '/api/build'), { status: 400, body: { error: 'nothing-ready' } });
});

test('Revise items carry the noteId of their note, filled from noteIds when an older page omits it', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note, b: note } });
  await api('POST', '/api/revise', { items: [{ ...item, noteId: 'b' }, item], noteIds: ['b', 'a'] });
  const file = readdirSync(join(data, 'requests')).find(f => f.endsWith('.json'));
  const filed = JSON.parse(readFileSync(join(data, 'requests', file), 'utf8'));
  assert.deepEqual(filed.items.map(i => i.noteId), ['b', 'a']);
});

test('GET /api/book does not stamp while Claude is revising', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note } });
  await api('POST', '/api/revise', { items: [item], noteIds: ['a'] });
  const before = JSON.parse(readFileSync(join(data, 'review.json'), 'utf8'));
  const r = (await api('GET', '/api/book')).body;
  assert.equal(r.review.rev, before.rev);
  assert.deepEqual(r.review.opened, before.opened);
});

test('Revise keeps the version each sent note was about as a try, and the note shows there, not as open', async () => {
  await api('PUT', '/api/notes', { rev: 0, notes: { a: note } });
  await api('POST', '/api/revise', { items: [item], noteIds: ['a'] });
  const review = JSON.parse(readFileSync(join(data, 'review.json'), 'utf8'));
  assert.equal(review.notes.a.status, 'sent');
  assert.equal(review.tries[note.item].length, 1);
  assert.deepEqual(review.tries[note.item][0].notes, ['a']);
  const r = (await api('GET', '/api/book')).body;
  const M = createRequire(import.meta.url)('../app/model.js');
  const book = r.book;
  const rv = M.reviews(book, r.mockups || {}, r.review, { items: {} });
  const own = rv.byKey[note.item];
  assert.ok(own);
  assert.deepEqual(own.notes.map(n => n.id), []);
  assert.deepEqual(own.tries[0].notes.map(n => n.id), ['a']);
});

test('the server cleans the project .gitignore on start, as migrate-book does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-serve-ign-'));
  const dir = join(root, 'docs', 'specbook');
  mkdirSync(join(root, '.git'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'book.json'), JSON.stringify(freshBook()));
  writeFileSync(join(root, '.gitignore'), '/docs/specbook/revise/\n/docs/specbook/notes.json\n');
  const proc = spawn(process.execPath, [SERVE, '--data', dir, '--port', String(port + 1100)], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port + 1100}/api/health`)).ok) { break; }
      } catch {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    assert.equal(lines.includes('/docs/specbook/notes.json'), false);
    assert.equal(lines.includes('/docs/specbook/revise/'), false);
    assert.ok(lines.includes('/docs/specbook/review.json') || lines.some(l => l.startsWith('/docs/specbook/')));
  } finally {
    proc.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// A call made as a guest of a shared book (share.mjs sends this header).
async function asGuest(method, path, body, who = { name: 'Ann', key: 'ann-key-0001' }) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'x-specbook-guest': encodeURIComponent(JSON.stringify(who)),
      ...(method === 'POST' || method === 'PUT' ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
}

test('a guest may read the book, its data and history, and says who is reading', async () => {
  const book = await asGuest('GET', '/api/book');
  assert.equal(book.status, 200);
  assert.deepEqual(book.body.viewer, { guest: true, name: 'Ann', key: 'ann-key-0001' });
  assert.deepEqual((await api('GET', '/api/book')).body.viewer.guest, false);
  assert.equal((await asGuest('GET', '/data/mockups/d.html')).status, 200);
  assert.equal((await asGuest('GET', '/api/health')).body.data, undefined);
  assert.equal((await asGuest('GET', '/api/history/R1')).status, 200);
  const claude = await asGuest('GET', '/api/claude');
  assert.equal(claude.status, 200);
  assert.deepEqual(claude.body.calls, []);
  assert.equal(typeof claude.body.notesRev, 'number');
});

test('a guest cannot revise, build, accept, change stages or edit requirements', async () => {
  const calls = [
    ['POST', '/api/revise', { items: [item], noteIds: [] }],
    ['POST', '/api/build', {}],
    ['POST', '/api/accept', { key: 'R1' }],
    ['POST', '/api/stage', { section: 'c/d', stage: 'ready' }],
    ['POST', '/api/change', { key: 'R1', note: 'x' }],
    ['POST', '/api/requirements', { section: 'c/d', text: 'new' }],
    ['PUT', '/api/requirements/R1', { text: 'edited' }],
    ['DELETE', '/api/requirements/R1', undefined],
    ['POST', '/api/builds/pending/cancel', {}],
    ['POST', '/api/builds/b1/stop', {}],
  ];
  for (const [method, path, body] of calls) {
    assert.deepEqual(await asGuest(method, path, body), { status: 403, body: { error: 'guest' } }, `${method} ${path}`);
  }
  assert.equal(existsSync(join(data, 'requests')), false);
  assert.equal(JSON.parse(readFileSync(join(data, 'book.json'), 'utf8')).chapters[0].sections[0].requirements[0].text, 'x');
});

test('an unreadable guest header gets nothing', async () => {
  const res = await raw('GET', '/api/book', { host: `127.0.0.1:${port}`, 'x-specbook-guest': '%E0%A4%A' });
  assert.equal(res.status, 403);
  const bad = await asGuest('GET', '/api/book', undefined, { name: 'x', key: 'short' });
  assert.equal(bad.status, 403);
});

test('a guest saves only their own drafts, named as them; the owner keeps the author and may delete any', async () => {
  assert.equal((await api('PUT', '/api/notes', { rev: 0, notes: { own: note } })).status, 200);
  // Ann sends her note, plus an edit of the owner's note and its deletion attempt is ignored.
  const ann = await asGuest('PUT', '/api/notes', { rev: 1, notes: { a1: { ...note, text: 'from Ann' }, own: { ...note, text: 'hijacked' } } });
  assert.equal(ann.status, 200);
  let notes = readReview(data).notes;
  assert.equal(notes.own.text, 'hi');
  assert.equal(notes.own.author, undefined);
  assert.equal(notes.a1.author, 'Ann');
  assert.equal(notes.a1.authorKey, 'ann-key-0001');
  // Bob cannot touch Ann's note, and his save without it does not delete it.
  const bob = { name: 'Bob', key: 'bob-key-0001' };
  assert.equal((await asGuest('PUT', '/api/notes', { rev: 2, notes: { a1: { ...note, text: 'bob edit' }, b1: note } }, bob)).status, 200);
  notes = readReview(data).notes;
  assert.equal(notes.a1.text, 'from Ann');
  assert.equal(notes.b1.author, 'Bob');
  // Ann deletes her own note by leaving it out.
  assert.equal((await asGuest('PUT', '/api/notes', { rev: 3, notes: {} })).status, 200);
  notes = readReview(data).notes;
  assert.equal(notes.a1, undefined);
  assert.ok(notes.own && notes.b1);
  // The owner's save keeps Bob's authorship, and a stale one is refused as before.
  assert.equal((await api('PUT', '/api/notes', { rev: 3, notes: { own: note } })).status, 409);
  assert.equal((await api('PUT', '/api/notes', { rev: 4, notes: { own: note, b1: { ...note, text: 'tidied' } } })).status, 200);
  notes = readReview(data).notes;
  assert.equal(notes.b1.text, 'tidied');
  assert.equal(notes.b1.author, 'Bob');
  // The owner deletes Bob's note.
  assert.equal((await api('PUT', '/api/notes', { rev: 5, notes: { own: note } })).status, 200);
  assert.equal(readReview(data).notes.b1, undefined);
});

test('a guest cannot write a note on an item that does not exist', async () => {
  assert.equal((await asGuest('PUT', '/api/notes', { rev: 0, notes: { a: { ...note, item: 'NOPE' } } })).status, 400);
});

// One owner tab's events stream: hear(text) waits until the stream has said it.
async function listenAs(tab) {
  const ctl = new AbortController();
  const stream = await fetch(`${base}/api/share/events?tab=${tab}`, { signal: ctl.signal });
  const reader = stream.body.getReader();
  let heard = '';
  return {
    get heard() { return heard; },
    async hear(want) {
      const deadline = Date.now() + 3000;
      while (!heard.includes(want)) {
        if (Date.now() > deadline) { throw new Error(`did not hear ${want}; heard ${heard}`); }
        heard += new TextDecoder().decode((await reader.read()).value);
      }
    },
    close() { ctl.abort(); },
  };
}
async function idle() {
  for (let i = 0; i < 50 && (await api('GET', '/api/share')).body.tabs !== 0; i++) {
    await new Promise(r => setTimeout(r, 20));
  }
}
function sharedBook(settings) {
  const book = freshBook();
  book.settings = { shareBroker: 'https://share.example', ...settings };
  writeFileSync(join(data, 'book.json'), JSON.stringify(book));
}
const ROOM = { room: 'room-0000000000001', hostToken: 'token-0000000000000000001', secret: 'k'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' };
const liveBody = (tab, room = ROOM) => ({ tab, ...room, url: `https://share.example/s/${room.room}#${room.secret}` });

test('an owner tab shares as soon as it listens, and a reopened tab gets the same room back', async () => {
  sharedBook();
  const one = await listenAs('tab-one-0001');
  await one.hear('event: start');
  assert.match(one.heard, /"broker":"https:\/\/share.example"/);
  assert.match(one.heard, /"room":null/);
  assert.equal((await api('POST', '/api/share/live', liveBody('someone-else'))).status, 409);
  assert.equal((await api('POST', '/api/share/live', { ...liveBody('tab-one-0001'), url: 'https://evil.example/s/r#k' })).status, 400);
  assert.equal((await api('POST', '/api/share/live', liveBody('tab-one-0001'))).status, 200);
  assert.equal((await api('POST', '/api/share/guests', { tab: 'tab-one-0001', guests: ['Ann'] })).status, 200);
  const live = (await api('GET', '/api/share')).body;
  assert.deepEqual([live.state, live.url, live.guests, live.room], ['live', `https://share.example/s/${ROOM.room}#${ROOM.secret}`, ['Ann'], true]);
  // A guest can neither see nor change the share.
  assert.equal((await asGuest('GET', '/api/share')).status, 403);
  assert.equal((await asGuest('POST', '/api/share/new-link', {})).status, 403);
  // Another site's <script src> cannot pose as a tab.
  assert.equal((await raw('GET', '/api/share/events?tab=evil-tab-001', { host: `127.0.0.1:${port}`, 'sec-fetch-dest': 'script' })).status, 403);
  one.close();
  await idle();
  const two = await listenAs('tab-two-0002');
  await two.hear('event: start');
  assert.match(two.heard, new RegExp(`"room":\\{"room":"${ROOM.room}","hostToken":"${ROOM.hostToken}","secret":"${ROOM.secret}"`));
  assert.equal((await api('GET', '/api/share')).body.url, `https://share.example/s/${ROOM.room}#${ROOM.secret}`);
  await api('POST', '/api/share/stop', {});
  two.close();
  await idle();
});

test('New link ends the room and starts a new one', async () => {
  sharedBook();
  const tab = await listenAs('tab-new-0001');
  await tab.hear('event: start');
  await api('POST', '/api/share/live', liveBody('tab-new-0001'));
  assert.equal((await api('POST', '/api/share/new-link', {})).status, 202);
  await tab.hear('event: end-room');
  await tab.hear('"room":null}');
  assert.equal((await api('GET', '/api/share')).body.room, false);
  await api('POST', '/api/share/stop', {});
  tab.close();
  await idle();
});

test('Stop sharing lasts until the book is reopened', async () => {
  sharedBook();
  const tab = await listenAs('tab-stop-0001');
  await tab.hear('event: start');
  await api('POST', '/api/share/live', liveBody('tab-stop-0001'));
  await api('POST', '/api/share/stop', {});
  await tab.hear('event: stop');
  const view = (await api('GET', '/api/share')).body;
  assert.deepEqual([view.state, view.stopped, view.room], ['idle', true, false]);
  tab.close();
  await idle();
  const again = await listenAs('tab-stop-0002');
  await again.hear('event: start');
  assert.equal((await api('GET', '/api/share')).body.stopped, false);
  await api('POST', '/api/share/stop', {});
  again.close();
  await idle();
});

test('settings.share false keeps a book from sharing until asked', async () => {
  sharedBook({ share: false });
  const tab = await listenAs('tab-off-0001');
  await tab.hear(': listening');
  await new Promise(r => setTimeout(r, 150));
  assert.doesNotMatch(tab.heard, /event: start/);
  assert.equal((await api('POST', '/api/share', {})).status, 202);
  await tab.hear('event: start');
  await api('POST', '/api/share/stop', {});
  tab.close();
  await idle();
});

test('per-note saves never drop another\'s change, and say who changed a note last', async () => {
  const a = await api('PUT', '/api/notes', { changes: { own: note } });
  assert.equal(a.status, 200);
  const b = await asGuest('PUT', '/api/notes', { changes: { hers: { ...note, text: 'from Ann' } } });
  assert.equal(b.status, 200);
  const c = await api('PUT', '/api/notes', { changes: { hers: { ...note, text: 'tidied' } } });
  assert.equal(c.status, 200);
  const notes = readReview(data).notes;
  assert.equal(notes.own.text, 'hi');
  assert.equal(notes.hers.text, 'tidied');
  assert.equal(notes.hers.author, 'Ann');
  assert.equal(typeof notes.hers.lastBy, 'string');
  assert.ok(c.body.rev > a.body.rev);
  assert.equal((await api('PUT', '/api/notes', { changes: [] })).status, 400);
  assert.equal((await asGuest('PUT', '/api/notes', { changes: { own: null } })).status, 200);
  assert.ok(readReview(data).notes.own);
});

test('the book names its owner for guests', async () => {
  const book = (await api('GET', '/api/book')).body;
  assert.equal(typeof book.owner.name, 'string');
  assert.ok(book.owner.name.length > 0);
  assert.equal((await asGuest('GET', '/api/book')).body.owner.name, book.owner.name);
});
