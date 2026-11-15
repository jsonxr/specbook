#!/usr/bin/env node
// Smoke test for the reader: notes in review.json, the Claude group and the busy state, the build banner, the review
// of a build's calls, the review stacks of Changes mode (Accept, Change), adding a requirement and its history.
//
//   GLOBAL_ROOT=$(npm root -g)/playwright node plugins/specbook/test/reader.smoke.mjs
//
// Copies starter/ to a temp folder, serves it on port 4299 and drives the page in Playwright's Chromium.
// Exits 1 when any check fails.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.GLOBAL_ROOT) {
  console.error('Set GLOBAL_ROOT to the global Playwright install, e.g. GLOBAL_ROOT=$(npm root -g)/playwright');
  process.exit(2);
}
const { chromium } = createRequire(join(process.env.GLOBAL_ROOT, 'index.js'))('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const PORT = 4299;
const URL = `http://localhost:${PORT}/`;

const data = mkdtempSync(join(tmpdir(), 'specbook-smoke-'));
cpSync(join(PLUGIN, 'starter'), data, { recursive: true });
// The book does not share itself here: no tab may reach a real share server from a test.
{
  const bookFile = join(data, 'book.json');
  const b = JSON.parse(readFileSync(bookFile, 'utf8'));
  b.settings = { ...(b.settings ?? {}), share: false };
  // A long path among the sources, as real books have: it must wrap on a phone.
  b.sources = [...(b.sources ?? []), { label: 'SMS program (planned)', path: 'docs/specs/notifications/design-sms-program-and-other-long-names.md' }];
  writeFileSync(bookFile, JSON.stringify(b, null, 2));
}

// The server hosts through a fake host (SPECBOOK_TEST_HOST, a test-only seam in serve.mjs): no WebRTC and no share
// server. Started, it opens a made-up room and a reader, Ana, says hello; it logs what the owner's tab sends to
// live.log in the book folder. SPECBOOK_DEPS is an empty folder, so the real ~/.claude/specbook/deps is never read.
const fixtures = mkdtempSync(join(tmpdir(), 'specbook-smoke-fixtures-'));
const fakeHost = join(fixtures, 'fake-host.cjs');
writeFileSync(fakeHost, `
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomInt } = require('node:crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const newId = () => Array.from({ length: 22 }, () => A[randomInt(62)]).join('');
const dir = process.argv[process.argv.indexOf('--data') + 1];
exports.createHost = ({ broker, saved, onState }) => {
  let pin = saved && saved.pin ? saved.pin : newId();
  let kept = saved && saved.room ? { room: saved.room, hostToken: saved.hostToken, expiresAt: saved.expiresAt || null } : null;
  let state = 'off';
  const listeners = [];
  const guests = () => (state === 'live' ? ['Ana'] : []);
  const view = () => ({ state, room: kept ? kept.room : null, hostToken: kept ? kept.hostToken : null, pin, expiresAt: kept ? kept.expiresAt : null, guests: guests(), error: null });
  const report = () => onState(view());
  return {
    async start() {
      if (state !== 'live') {
        kept = kept || { room: newId(), hostToken: newId(), expiresAt: '2099-01-01T00:00:00.000Z' };
        state = 'live';
        report();
        for (const fn of listeners) { fn({ t: 'live', kind: 'hello', from: 'ana-device', name: 'Ana', color: '#f27aa0', role: 'guest' }); }
      }
      report();
    },
    async stop({ end = false } = {}) {
      if (end) { kept = null; }
      state = 'off';
      report();
    },
    newPin() { pin = newId(); report(); },
    state: () => state,
    links: () => (state === 'live' ? { url: broker + '/s/' + kept.room, pinUrl: broker + '/s/' + kept.room + '#pin=' + pin } : null),
    people: () => [],
    sendLive(msg) { if (state === 'live') { appendFileSync(join(dir, 'live.log'), JSON.stringify(msg) + '\\n'); } },
    changed() {},
    onLive(fn) { listeners.push(fn); },
  };
};
`);
const server = spawn(process.execPath, [join(PLUGIN, 'server', 'serve.mjs'), '--data', data, '--port', String(PORT)], {
  stdio: 'ignore',
  env: { ...process.env, SPECBOOK_TEST_HOST: fakeHost, SPECBOOK_DEPS: join(fixtures, 'no-deps') },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() > until) {
      throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    }
    await sleep(100);
  }
}

// The notes live in review.json, beside the accepted copies and the tries.
function readReviewFile() {
  const file = join(data, 'review.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rev: 0, accepted: {}, notes: {}, tries: {} };
}
const readNotesFile = readReviewFile;
// Writes review.json with these notes in place of the stored ones, as another writer would, bumping its revision.
function writeNotes(notes) {
  const review = readReviewFile();
  writeFileSync(join(data, 'review.json'), JSON.stringify({ ...review, rev: review.rev + 1, notes }));
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e && e.message ? e.message : e}`);
  }
}

const errors = [];
let browser;
try {
  await waitFor(async () => {
    try {
      return (await fetch(`${URL}api/health`)).ok;
    } catch {
      return false;
    }
  }, 5000, 'the server to start');

  browser = await chromium.launch();
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => {
    // The web fonts come from Google; an offline run must not count as a reader error.
    if (m.type() === 'error' && !(m.location().url || '').includes('fonts.g')) {
      errors.push(m.text());
    }
  });
  page.on('pageerror', e => errors.push(String(e)));

  const open = async () => {
    await page.goto(URL);
    await page.waitForSelector('#todos-list > h3');
  };
  // The middle of the section heading, scrolled into view, in window coordinates.
  const headingSpot = () => page.evaluate(() => {
    const h = document.querySelector('#todos-list > h3');
    h.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = h.getBoundingClientRect();
    return { x: r.left + Math.min(200, r.width / 2), y: r.top + r.height / 2 };
  });
  const buttonSpot = sel => page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);

  await open();

  await check('notes persist on the server', async () => {
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    const at = await headingSpot();
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('.sticky.editing textarea');
    if (await page.locator('.note-pop').count()) {
      throw new Error('a separate form opened for the new note; the sticky itself should take the text');
    }
    await page.keyboard.type('Make the list denser');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await waitFor(() => Object.keys(readNotesFile().notes).length === 1, 3000, 'review.json to hold the note');
    await open();
    await page.waitForSelector('.sticky:not([hidden])', { timeout: 3000 });
    const stickies = await page.locator('.sticky:not([hidden])').count();
    if (stickies !== 1) {
      throw new Error(`expected 1 sticky after reload, saw ${stickies}`);
    }
    const notes = Object.values(readNotesFile().notes);
    if (notes.length !== 1 || notes[0].section !== 'todos-list' || notes[0].item !== 'todos-list' || notes[0].status !== 'draft' || typeof notes[0].pin?.rx !== 'number') {
      throw new Error(`expected 1 draft note on todos-list with a pin, got ${JSON.stringify(notes)}`);
    }
  });

  await check('revise locks notes', async () => {
    await page.waitForFunction(() => !document.getElementById('revise').disabled, null, { timeout: 3000 });
    await page.locator('#claude-btn').click();
    const at = await buttonSpot('#revise');
    await page.mouse.click(at.x, at.y);
    await page.waitForFunction(() => document.getElementById('revise').disabled &&
      document.getElementById('build').disabled &&
      document.getElementById('claude-status').textContent === 'Revising…', null, { timeout: 3000 });
    await page.keyboard.press('c');
    await sleep(200);
    const state = await page.evaluate(() => ({
      commenting: document.body.classList.contains('commenting'),
      pressed: document.getElementById('mode').getAttribute('aria-pressed'),
      locked: document.body.classList.contains('locked-notes'),
    }));
    if (state.commenting || state.pressed !== 'false') {
      throw new Error('C entered comment mode while revising');
    }
    if (!state.locked) {
      throw new Error('body.locked-notes is not set while revising');
    }
  });

  await check('filing answers notes: no sticky, shown in the review stack', async () => {
    const pending = readdirSync(join(data, 'requests')).filter(f => f.endsWith('.json'));
    if (pending.length !== 1) {
      throw new Error(`expected 1 request file, saw ${pending.length}`);
    }
    execFileSync(process.execPath, [join(PLUGIN, 'server', 'next-request.mjs'), '--data', data, '--done', pending[0]], { stdio: 'ignore' });
    await page.waitForFunction(() => document.querySelectorAll('.sticky').length === 0 &&
      !document.body.classList.contains('locked-notes') &&
      document.getElementById('revise').disabled, null, { timeout: 5000 });
    const notes = Object.values(readNotesFile().notes);
    if (notes.length !== 1 || notes[0].status !== 'answered') {
      throw new Error(`expected the note answered, got ${JSON.stringify(notes)}`);
    }
    // The book is drawn again once Claude is idle; the stack then says the note was answered.
    await page.waitForFunction(() => {
      const stack = document.querySelector('.rv-stack[data-key="todos-list"]')?.textContent || '';
      return stack.includes('Answered') && stack.includes('Make the list denser');
    }, null, { timeout: 5000 });
  });

  await check('orphan note', async () => {
    writeNotes({ norphan: { item: 'todos-list', text: 'About a requirement that is gone', status: 'draft', target: 'ZZZ-0000', section: 'todos-list', pin: { rx: 0.3, ry: 0.5 } } });
    await open();
    await page.waitForSelector('#todos-list > h3 .pin', { timeout: 3000 });
    const inside = await page.evaluate(() => {
      const h = document.querySelector('#todos-list > h3');
      const pin = h.querySelector('.pin');
      // The pin's point is its bottom-left corner before it is turned; its box is lifted by its own height.
      const x = pin.offsetLeft, y = pin.offsetTop + pin.offsetHeight;
      return x >= 0 && x <= h.clientWidth && y >= 0 && y <= h.clientHeight;
    });
    if (!inside) {
      throw new Error("the orphan's pin is not inside the section heading");
    }
  });

  // In its own page, so the failed save it forces is not counted as a reader error.
  await check('import keeps notes on failure', async () => {
    // Let the main page's save of the orphan's sticky position land first, so it can't conflict with what follows.
    await waitFor(() => typeof readNotesFile().notes.norphan?.pin?.dx === 'number', 3000, "the orphan's sticky position to be saved");
    writeNotes({});
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1400, height: 900 } });
    try {
      const p = await ctx.newPage();
      const key = 'spec-book-notes:Todos';
      await p.goto(URL);
      await p.waitForSelector('#todos-list > h3');
      await p.evaluate(k => localStorage.setItem(k, JSON.stringify({ nold: { text: 'Drafted before the server', target: 'todos-list', rx: 0.2, ry: 0.5 } })), key);
      let failed = 0;
      await p.route('**/api/notes', route => {
        if (route.request().method() !== 'PUT') {
          return route.continue();
        }
        failed++;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
      });
      await p.reload();
      await p.waitForSelector('#todos-list > h3');
      await waitFor(() => failed > 0, 3000, 'the import to try a save');
      await sleep(300);
      if (await p.evaluate(k => localStorage.getItem(k), key) === null) {
        throw new Error('the localStorage notes were removed although the save failed');
      }
      await p.unroute('**/api/notes');
      await p.reload();
      await p.waitForSelector('#todos-list > h3');
      await waitFor(() => Object.keys(readNotesFile().notes).length === 1, 3000, 'review.json to hold the imported note');
      await waitFor(() => p.evaluate(k => localStorage.getItem(k) === null, key), 3000, 'the localStorage key to be removed');
      const note = readNotesFile().notes.nold;
      if (!note || note.text !== 'Drafted before the server' || note.section !== 'todos-list' || note.item !== 'todos-list') {
        throw new Error(`unexpected review.json notes: ${JSON.stringify(readNotesFile().notes)}`);
      }
    } finally {
      await ctx.close();
    }
  });

  await check('stage pills', async () => {
    await open();
    const pills = await page.evaluate(() => ({
      filters: document.querySelector('#filters-bar h3 .pill')?.textContent,
      todos: document.querySelector('#todos-list h3 .pill')?.textContent,
    }));
    if (pills.filters !== 'Drafting') {
      throw new Error(`#filters-bar pill reads ${JSON.stringify(pills.filters)}, expected "Drafting"`);
    }
    // The starter's todos-list has two drafted changes: a change and a removal.
    if (pills.todos !== 'Built · 2 changes drafting') {
      throw new Error(`#todos-list pill reads ${JSON.stringify(pills.todos)}, expected "Built · 2 changes drafting"`);
    }
  });

  await check('mark ready', async () => {
    const at = await page.evaluate(() => {
      const b = Array.prototype.find.call(document.querySelectorAll('#filters-bar button'), x => x.textContent === 'Mark ready' && !x.hidden);
      if (!b) {
        return null;
      }
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!at) {
      throw new Error('#filters-bar has no visible Mark ready button');
    }
    // In comment mode too: the button is a control, not something to comment on.
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    await page.mouse.click(at.x, at.y);
    await page.waitForFunction(() => document.querySelector('#filters-bar h3 .pill')?.textContent === 'Ready', null, { timeout: 3000 });
    if (await page.locator('.sticky.editing').count() !== 0) {
      throw new Error('a click on Mark ready in comment mode started a note');
    }
    await page.keyboard.press('Escape');
    const book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
    const bar = book.chapters.find(c => c.id === 'filters').sections.find(s => s.id === 'bar');
    if (bar.stage !== 'ready') {
      throw new Error(`book.json has stage ${JSON.stringify(bar.stage)} for filters-bar`);
    }
    await page.waitForFunction(() => !document.getElementById('build').disabled, null, { timeout: 3000 });
  });

  await check('removed requirement', async () => {
    const removed = await page.evaluate(() => {
      const li = document.getElementById('TOD-LAX6');
      return li ? { struck: !!li.querySelector('.req-removed'), why: li.textContent.includes('Why:') } : null;
    });
    if (!removed || !removed.struck || !removed.why) {
      throw new Error(`the starter's removal does not show struck through with Why: ${JSON.stringify(removed)}`);
    }
  });

  await check('decisions', async () => {
    const text = await page.evaluate(() => document.querySelector('#decisions')?.textContent || '');
    if (!text.includes('One screen, no tabs') || !text.includes('DEC-2DWF')) {
      throw new Error('the migrated decision DEC-2DWF is not in the end list');
    }
    // A decision about one of a section's requirements is listed in that section too.
    const file = join(data, 'book.json');
    const book = JSON.parse(readFileSync(file, 'utf8'));
    book.decisions.push({ id: 'DEC-SMOK', date: '2026-11-12', about: ['FLT-36VG'], by: 'build', title: 'Filters sit under the field', body: 'Chosen while building.', kind: 'decision' });
    // "bar" is only the section's short id, which any chapter could have: it does not place a decision.
    book.decisions.push({ id: 'DEC-SHRT', date: '2026-11-12', about: ['bar'], by: 'user', title: 'About some bar', body: 'Not this one.', kind: 'decision' });
    writeFileSync(file, JSON.stringify(book, null, 2));
    await open();
    const inSection = await page.evaluate(() => document.querySelector('#filters-bar .sec-decisions')?.textContent || '');
    if (!inSection.includes('Filters sit under the field') || !inSection.includes('by build')) {
      throw new Error(`#filters-bar does not list its decision with a by build tag: ${JSON.stringify(inSection)}`);
    }
    if (inSection.includes('About some bar')) {
      throw new Error('#filters-bar lists a decision that only names its short id');
    }
  });

  // The build is driven through build.mjs, as Claude drives it.
  const buildCli = (...args) => JSON.parse(execFileSync(process.execPath, [join(PLUGIN, 'server', 'build.mjs'), '--data', data, ...args], { encoding: 'utf8' }));
  const bannerText = () => page.evaluate(() => {
    const b = document.getElementById('build-banner');
    return b && !b.hidden ? b.textContent : '';
  });
  let firstBuild = null;

  await check('banner while building', async () => {
    // mark ready left filters-bar Ready
    firstBuild = buildCli('start').id;
    buildCli('task', '--build', firstBuild, '--index', '2', '--of', '5', '--title', 'T', '--section', 'filters-bar', '--req', 'FLT-36VG');
    await open();
    await waitFor(async () => (await bannerText()).includes('task 2 of 5'), 5000, 'the banner to show task 2 of 5');
    const text = await bannerText();
    if (!text.includes('Now: The filter bar (FLT-36VG)')) {
      throw new Error(`the banner does not name the current section and requirement: ${JSON.stringify(text)}`);
    }
    if (!text.includes('Proven 0/3 requirements · Calls so far: 0')) {
      throw new Error(`the banner does not count proven requirements and calls: ${JSON.stringify(text)}`);
    }
    const live = await page.evaluate(() => {
      const li = document.getElementById('FLT-36VG');
      return li ? { queued: li.classList.contains('live-queued'), mark: li.querySelector('.live-mark')?.textContent } : null;
    });
    if (!live || !live.queued || live.mark !== '○ queued') {
      throw new Error(`FLT-36VG is not marked queued: ${JSON.stringify(live)}`);
    }
  });

  await check('stale build', async () => {
    if (!firstBuild) {
      throw new Error('no build was started');
    }
    const file = join(data, 'builds', firstBuild, 'progress.json');
    const progress = JSON.parse(readFileSync(file, 'utf8'));
    progress.heartbeat = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    writeFileSync(file, JSON.stringify(progress, null, 2));
    await waitFor(async () => (await bannerText()).includes('Build may have stopped'), 5000, 'the banner to say the build may have stopped');
    await page.locator('#build-banner button', { hasText: 'Mark as stopped' }).click();
    await page.waitForFunction(() => document.querySelector('#filters-bar h3 .pill')?.textContent === 'Drafting', null, { timeout: 5000 });
  });

  await check('stale build request', async () => {
    const staged = await fetch(`${URL}api/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: 'filters-bar', stage: 'ready' }) });
    const sent = await fetch(`${URL}api/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!staged.ok || sent.status !== 201) {
      throw new Error(`could not request a build: ${staged.status} ${sent.status}`);
    }
    // The build was asked for 11 minutes ago and never started; the stopped build is from before that.
    const ago = min => new Date(Date.now() - min * 60 * 1000).toISOString();
    const [file] = readdirSync(join(data, 'requests')).filter(f => f.endsWith('.json'));
    const path = join(data, 'requests', file);
    const request = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...request, createdAt: ago(11) }));
    const progressFile = join(data, 'builds', firstBuild, 'progress.json');
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'));
    writeFileSync(progressFile, JSON.stringify({ ...progress, startedAt: ago(30), heartbeat: ago(20), finishedAt: ago(20) }));
    await waitFor(async () => (await bannerText()).includes('Build may have stopped'), 20000, 'the banner to say the build request may have stopped');
    await page.locator('#build-banner button', { hasText: 'Mark as stopped' }).click();
    await page.waitForFunction(() => document.getElementById('claude-status').textContent === '' && !document.getElementById('build').disabled, null, { timeout: 5000 });
    if (!existsSync(join(data, 'requests', 'done', file))) {
      throw new Error('the stale build request was not filed');
    }
  });

  await check('a note typed during a build survives its end', async () => {
    const staged = await fetch(`${URL}api/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: 'filters-bar', stage: 'ready' }) });
    if (!staged.ok) {
      throw new Error(`could not mark filters-bar ready: ${staged.status}`);
    }
    const id = buildCli('start').id;
    await open();
    await waitFor(async () => (await bannerText()).includes('Building'), 5000, 'the banner to show the build');
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    const at = await headingSpot();
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('.sticky.editing textarea');
    await page.keyboard.type('Typed while building');
    buildCli('finish', '--build', id);
    // The reader sees the build end on its next poll, and must not draw the book again under the note being written.
    await waitFor(async () => (await fetch(`${URL}api/claude`).then(r => r.json())).state === 'idle', 5000, 'the build to be over');
    await sleep(4000);
    const typed = await page.evaluate(() => document.querySelector('.sticky.editing textarea')?.value);
    if (typed !== 'Typed while building') {
      throw new Error(`the note's text was lost when the build ended: ${JSON.stringify(typed)}`);
    }
    await page.keyboard.press(' ');
    await page.keyboard.type('and after');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    // Once the note is posted the book is drawn again, with what the build did.
    await page.waitForFunction(() => document.querySelector('#filters-bar h3 .pill')?.textContent === 'Drafting', null, { timeout: 5000 });
    await waitFor(() => Object.values(readNotesFile().notes).some(n => n.text === 'Typed while building and after'), 3000, 'review.json to hold the note');
    const sticky = await page.evaluate(() => Array.prototype.some.call(document.querySelectorAll('.sticky textarea'), t => t.value === 'Typed while building and after'));
    if (!sticky) {
      throw new Error('the posted note has no sticky after the book was drawn again');
    }
  });

  await check('review calls', async () => {
    const staged = await fetch(`${URL}api/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: 'filters-bar', stage: 'ready' }) });
    if (!staged.ok) {
      throw new Error(`could not mark filters-bar ready: ${staged.status}`);
    }
    const id = buildCli('start').id;
    buildCli('call', '--build', id, '--about', 'FLT-36VG', '--section', 'filters-bar', '--title', 'Filters show as a banner',
      '--body', 'A banner reads better than a toast here.', '--before', 'A toast confirms the filter.', '--after', 'A banner confirms the filter.');
    buildCli('finish', '--build', id);
    await open();
    await waitFor(async () => (await bannerText()).includes('Review calls (1)'), 5000, 'the banner to read Review calls (1)');
    await page.locator('#build-banner button', { hasText: 'Review calls (1)' }).click();
    await page.waitForSelector('#review-panel:not([hidden]) .rp-call');
    const about = await page.locator('#review-panel .rp-call a[href="#FLT-36VG"]').count();
    if (about !== 1) {
      throw new Error('the call does not link to the requirement it is about');
    }
    const reject = page.locator('#review-panel .rp-call button', { hasText: 'Reject' });
    if (!(await reject.isDisabled())) {
      throw new Error('Reject is enabled before the note has text');
    }
    await page.locator('#review-panel .rp-call textarea').fill('Use a toast');
    await reject.click();
    await page.waitForFunction(() => document.querySelector('#review-panel .rp-call')?.textContent.includes('Rejected'), null, { timeout: 5000 });
    await page.waitForFunction(() => Array.prototype.some.call(document.querySelectorAll('.sticky textarea'), t => t.value.includes('Rejected call')) &&
      (document.getElementById('FLT-36VG')?.textContent || '').includes('Today:'), null, { timeout: 5000 });
  });

  await check('review stacks: Accept, or a note instead', async () => {
    // Settle the earlier checks: no build running, and a note to revise with.
    await waitFor(async () => (await fetch(`${URL}api/book`).then(r => r.json())).claude.state === 'idle', 5000, 'the build to be over');
    await open();
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    // Beside the first note's pin: a click on a pin does not start a note.
    const at = await headingSpot();
    await page.mouse.click(at.x + 60, at.y);
    await page.waitForSelector('.sticky.editing textarea');
    await page.keyboard.type('Reword the first requirement');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await waitFor(() => Object.values(readNotesFile().notes).some(n => n.text === 'Reword the first requirement'), 3000, 'review.json to hold the note');
    await page.waitForFunction(() => !document.getElementById('revise').disabled, null, { timeout: 3000 });
    await page.locator('#claude-btn').click();
    const press = await buttonSpot('#revise');
    await page.mouse.click(press.x, press.y);
    await page.waitForFunction(() => document.getElementById('claude-status').textContent === 'Revising…', null, { timeout: 3000 });
    // Claude's edits: one requirement's text, what happens today on a drafted change, one character in a mockup.
    const file = join(data, 'book.json');
    const book = JSON.parse(readFileSync(file, 'utf8'));
    const list = book.chapters.find(c => c.id === 'todos').sections.find(s => s.id === 'list');
    const req = list.requirements.find(r => r.id && !r.change);
    const before = req.text;
    req.text = before + ' (reworded)';
    const changed = list.requirements.find(r => r.change === 'change');
    changed.today = changed.today + ' (reworded)';
    writeFileSync(file, JSON.stringify(book, null, 2));
    const mock = join(data, 'mockups', 'todos-list-1.html');
    writeFileSync(mock, readFileSync(mock, 'utf8') + 'x');
    const pending = readdirSync(join(data, 'requests')).filter(f => f.endsWith('.json'));
    execFileSync(process.execPath, [join(PLUGIN, 'server', 'next-request.mjs'), '--data', data, '--done', pending[0]], { stdio: 'ignore' });
    await page.waitForSelector(`.rv-stack[data-key="${req.id}"] .rv-accepted`, { state: 'attached', timeout: 5000 });
    if (!(await page.evaluate(() => document.body.classList.contains('diff-on')))) {
      await page.locator('#changes-btn').click();
    }
    const seen = await page.evaluate(({ a, b }) => ({
      was: document.querySelector(`.rv-stack[data-key="${a}"] .rv-accepted .rv-text`)?.textContent,
      bullet: document.getElementById(b)?.textContent || '',
      today: document.querySelector(`.rv-stack[data-key="${b}"]`)?.textContent || '',
      frame: document.querySelector('.rv-stack[data-key="todos-list-1"]')?.textContent || '',
      frames: document.querySelectorAll('figure.frame.has-rv').length,
      count: document.getElementById('np-tab-changes').textContent,
      stacks: document.querySelectorAll('.rv-stack').length,
    }), { a: req.id, b: changed.id });
    if (seen.was !== before) {
      throw new Error(`the requirement's stack does not show its accepted text: ${JSON.stringify(seen)}`);
    }
    if (!seen.bullet.includes('(reworded)') || !seen.frame.includes('Mockup changed') || seen.frames !== 1) {
      throw new Error(`expected a stack for the reworded today and only todos-list-1 changed: ${JSON.stringify(seen)}`);
    }
    if (seen.count !== `Changes ${seen.stacks}`) {
      throw new Error(`Changes (n) does not count the review stacks: ${JSON.stringify(seen)}`);
    }
    // Accept: the review closes, the count drops by one, and it stays closed after a reload.
    await page.locator(`.rv-acts[data-key="${req.id}"] .rv-accept`).click();
    await page.waitForFunction(id => !document.querySelector(`.rv-stack[data-key="${id}"]`), req.id, { timeout: 5000 });
    const after = await page.evaluate(() => document.getElementById('np-tab-changes').textContent);
    if (after !== `Changes ${seen.stacks - 1}`) {
      throw new Error(`Accept did not take exactly one review off: ${seen.count} -> ${after}`);
    }
    if (readReviewFile().accepted[req.id]?.text !== req.text) {
      throw new Error('review.json does not hold the accepted text');
    }
    await open();
    if (await page.locator(`.rv-stack[data-key="${req.id}"]`).count() !== 0) {
      throw new Error('the accepted review came back after a reload');
    }
    // A note on the item (Comment mode) is how to ask for something else: the stack offers no Accept until the note
    // is sent or deleted.
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    await page.locator(`li#${changed.id}`).scrollIntoViewIfNeeded();
    const box = await page.locator(`li#${changed.id}`).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 10);
    await page.waitForSelector('.sticky.editing textarea');
    await page.keyboard.type('Say what happens offline');
    await page.keyboard.press('Enter');
    await waitFor(() => Object.values(readNotesFile().notes).some(n => n.text === 'Say what happens offline' && n.item === changed.id), 3000, 'review.json to hold the Change note on its item');
    await page.waitForFunction(id => !document.querySelector(`.rv-acts[data-key="${id}"]`), changed.id, { timeout: 5000 });
    // The draft shows once, as its sticky; the stack only says a note is waiting.
    const stack = await page.evaluate(id => document.querySelector(`.rv-stack[data-key="${id}"]`).textContent, changed.id);
    if (stack.includes('Say what happens offline')) {
      throw new Error(`the draft is repeated in the stack: ${JSON.stringify(stack)}`);
    }
    if (await page.locator(`.rv-acts[data-key="${changed.id}"] .rv-accept`).count() !== 0) {
      throw new Error('Accept is offered while a note on the item is unsent');
    }
    // A click selects the sticky (it shows so), and Delete removes it; Accept comes back. There is no ×.
    if (await page.locator('.st-del').count()) {
      throw new Error('stickies still carry a × to delete them');
    }
    const on = await page.evaluate(() => {
      const x = [...document.querySelectorAll('.sticky')].find(e => e.querySelector('textarea').value === 'Say what happens offline');
      const r = x.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(on.x, on.y);
    await page.waitForSelector('.sticky.selected:not(.editing)', { timeout: 3000 });
    await page.keyboard.press('Backspace');
    await waitFor(() => !Object.values(readNotesFile().notes).some(n => n.text === 'Say what happens offline'), 3000, 'the deleted note to leave review.json');
    await page.waitForSelector(`.rv-acts[data-key="${changed.id}"] .rv-accept`, { timeout: 5000 });
  });

  await check('add a requirement, accept it, expand its history', async () => {
    await open();
    await page.locator('#todos-list .add-req-btn').click();
    await page.locator('#todos-list .req-form [name="text"]').fill('Each todo shows when it was added.');
    if (await page.locator('#todos-list .req-form [name="change"]').inputValue() !== 'add') {
      throw new Error('a new requirement does not default to change: add');
    }
    await page.locator('#todos-list .req-form .rf-save').click();
    await page.waitForFunction(() => !document.querySelector('#todos-list .req-form'), null, { timeout: 5000 });
    const book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
    const list = book.chapters.find(c => c.id === 'todos').sections.find(s => s.id === 'list');
    const added = list.requirements.find(r => r.text === 'Each todo shows when it was added.');
    if (!added || !added.id || added.change !== 'add') {
      throw new Error(`book.json does not hold the new requirement with change add: ${JSON.stringify(added)}`);
    }
    await page.waitForSelector(`#${added.id}.has-rv.rv-is-new`, { state: 'attached', timeout: 5000 });
    await page.waitForSelector(`.rv-stack[data-key="${added.id}"]`, { state: 'attached', timeout: 5000 });
    if (!(await page.evaluate(() => document.body.classList.contains('diff-on')))) {
      await page.locator('#changes-btn').click();
    }
    await page.locator(`.rv-acts[data-key="${added.id}"] .rv-accept`).click();
    await page.waitForFunction(id => !document.querySelector(`.rv-stack[data-key="${id}"]`), added.id, { timeout: 5000 });
    const toggle = page.locator(`.item-tools[data-key="${added.id}"] .hi-toggle`);
    await toggle.waitFor({ timeout: 5000 });
    if ((await toggle.textContent()) !== 'History (1) ▸') {
      throw new Error(`the history toggle reads ${JSON.stringify(await toggle.textContent())}`);
    }
    await toggle.click();
    await page.waitForSelector(`.item-tools[data-key="${added.id}"] .hi-entry`, { timeout: 5000 });
    const entry = await page.locator(`.item-tools[data-key="${added.id}"] .hi-entry`).first().textContent();
    if (!entry.includes('Edited') || !entry.includes('details')) {
      throw new Error(`the history entry does not show its line and details: ${JSON.stringify(entry)}`);
    }
  });

  await check('the bar: View, the review keys, Requests and Claude', async () => {
    await open();
    // View: Screenshots on as well as Mockups is "both"; the last one checked cannot be unchecked.
    await page.locator('#view-btn').click();
    await page.locator('#view-shot').check();
    if ((await page.evaluate(() => localStorage.getItem('spec-book-view'))) !== 'both') {
      throw new Error('checking Screenshots did not show both');
    }
    await page.locator('#view-mock').uncheck();
    await page.locator('#view-shot').click();
    const view = await page.evaluate(() => [document.getElementById('view-mock').checked, document.getElementById('view-shot').checked, localStorage.getItem('spec-book-view')]);
    if (JSON.stringify(view) !== JSON.stringify([false, true, 'shot'])) {
      throw new Error(`View let both go, or did not keep Screenshots: ${JSON.stringify(view)}`);
    }
    await page.locator('#view-mock').check();
    await page.keyboard.press('Escape');
    // F shows only changes, J goes to the next, R opens Requests with its Changes tab.
    const diff = await page.evaluate(() => document.body.classList.contains('diff-on'));
    await page.keyboard.press('f');
    if ((await page.evaluate(() => document.body.classList.contains('diff-on'))) === diff) {
      throw new Error('F did not toggle Show only changes');
    }
    await page.keyboard.press('f');
    const y0 = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('j');
    await page.waitForFunction(y => window.scrollY !== y, y0, { timeout: 3000 });
    if (!/^\d+ \/ \d+$/.test(await page.locator('#chg-pos').textContent())) {
      throw new Error('the change position is not "n / N"');
    }
    await page.keyboard.press('r');
    await page.waitForSelector('#notes-panel:not([hidden])');
    await page.locator('#np-tab-changes').click();
    const items = await page.locator('#np-changes .np-chg').count();
    if (!items) {
      throw new Error('the Requests pane lists no changes');
    }
    await page.keyboard.press('Escape');
    // Claude ▾ holds Revise and Build, each saying what it does.
    await page.locator('#claude-btn').click();
    const acts = await page.evaluate(() => ['revise', 'build'].map(id => document.getElementById(id).offsetParent !== null && document.getElementById(id).querySelector('small').textContent.length > 10));
    if (acts.join() !== 'true,true') {
      throw new Error('Claude ▾ does not show Revise and Build with what they do');
    }
    await page.keyboard.press('Escape');
  });

  await check('the share pill follows the server\'s share: Share, the link without its pin, Copy pin link, New pin, Stop', async () => {
    await open();
    // The book does not share itself (settings.share: false): the pill offers to.
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
    if (await page.evaluate(() => window.SpecHost.link() !== null || window.SpecHost.pinLink() !== null)) {
      throw new Error('an unshared book has a link');
    }
    await page.locator('.share-pill .share-start').click();
    await page.waitForSelector('.share-pill .share-copy', { timeout: 3000 });
    // Ana, reading on the link, has a face beside the owner's.
    await page.waitForFunction(() => document.querySelectorAll('.share-pill .face').length === 2, null, { timeout: 3000 });
    const links = await page.evaluate(() => ({ link: window.SpecHost.link(), pin: window.SpecHost.pinLink() }));
    if (!/\/s\/[A-Za-z0-9]{22}$/.test(links.link || '') || links.pin !== null && !links.pin.startsWith(links.link + '#pin=')) {
      throw new Error(`the links are wrong: ${JSON.stringify(links)}`);
    }
    // The owner's tab said hello, as the owner, through the server.
    await waitFor(() => existsSync(join(data, 'live.log')) && readFileSync(join(data, 'live.log'), 'utf8').split('\n').some(l => l && JSON.parse(l).kind === 'hello' && JSON.parse(l).role === 'owner'), 3000, 'the owner\'s hello to reach the host');
    await page.locator('.share-pill .share-more').click();
    const menu = await page.evaluate(() => ({
      input: document.querySelector('.share-menu .share-link')?.value,
      pin: !!document.querySelector('.share-menu .share-pin-copy'),
      newPin: document.querySelector('.share-menu .share-new-pin')?.textContent,
      people: [...document.querySelectorAll('.share-menu .share-people li')].map(li => li.textContent),
    }));
    if (menu.input !== links.link || !menu.pin || menu.newPin !== 'New pin' || !menu.people.some(t => t.startsWith('Ana'))) {
      throw new Error(`the share menu is wrong: ${JSON.stringify(menu)}`);
    }
    if ((await page.locator('.share-menu .share-pin-copy').textContent()) !== 'Copy pin link') {
      throw new Error('the pin link button does not read "Copy pin link"');
    }
    await page.locator('.share-menu .share-new-pin').click();
    await page.waitForFunction(was => window.SpecHost.pinLink() && window.SpecHost.pinLink() !== was, links.pin, { timeout: 3000 });
    if ((await page.evaluate(() => window.SpecHost.link())) !== links.link) {
      throw new Error('New pin changed the link');
    }
    await page.locator('.share-menu .share-stop').click();
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
    if (await page.evaluate(() => window.SpecHost.link() !== null || document.querySelectorAll('.share-pill .face').length)) {
      throw new Error('Stop sharing left a link or faces');
    }
  });

  await check('the down arrow goes on to the next change each time it is pressed', async () => {
    await open();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    // Where the page comes to rest after a smooth scroll.
    const settled = () => page.evaluate(() => new Promise(done => {
      let last = window.scrollY, still = 0;
      const tick = () => {
        still = window.scrollY === last ? still + 1 : 0;
        last = window.scrollY;
        if (still >= 6) { done(last); } else { setTimeout(tick, 50); }
      };
      setTimeout(tick, 50);
    }));
    const ys = [];
    for (let i = 0; i < 3; i++) {
      await page.locator('#next-chg').click();
      ys.push(await settled());
    }
    if (!(ys[0] < ys[1] && ys[1] < ys[2])) {
      throw new Error(`pressing down three times stopped at ${ys.join(', ')}`);
    }
  });

  await check('a save that fails (the connection dropped) is tried again', async () => {
    let failed = 0;
    await page.route('**/api/notes', route => {
      if (route.request().method() === 'PUT' && failed === 0) {
        failed++;
        return route.abort('failed');
      }
      return route.continue();
    });
    try {
      await page.keyboard.press('c');
      await page.waitForSelector('body.commenting');
      const at = await headingSpot();
      await page.mouse.click(at.x + 110, at.y);
      await page.waitForSelector('.sticky.editing textarea');
      await page.keyboard.type('Saved after a failure');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await waitFor(() => failed === 1, 3000, 'the first save to fail');
      await waitFor(() => Object.values(readNotesFile().notes).some(n => n.text === 'Saved after a failure'), 8000, 'the note to be saved on a later try');
    } finally {
      await page.unroute('**/api/notes');
      // The aborted request is logged by the browser; it is the point of this check.
      for (let i = errors.length - 1; i >= 0; i--) {
        if (/ERR_FAILED/.test(errors[i])) { errors.splice(i, 1); }
      }
    }
  });

  // How wide the book is laid out (main, whose overflow the page clips) against the screen.
  const bookWidth = () => page.evaluate(() => [Math.ceil(document.querySelector('main').getBoundingClientRect().right), document.documentElement.clientWidth]);

  await check('on a phone-width screen nothing scrolls sideways', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      await page.waitForTimeout(300);
      const w = await bookWidth();
      if (w[0] > w[1]) {
        throw new Error(`the book is ${w[0]} pixels wide on a ${w[1]}-pixel screen`);
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  });

  await check('on a narrow screen notes are cards under their item, with a dot on the spot, and never move', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      // A note dropped on a word of a requirement.
      await page.keyboard.press('c');
      await page.waitForSelector('body.commenting');
      const at = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.data.indexOf('keeps that place');
          if (i >= 0) {
            n.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = document.createRange();
            r.setStart(n, i + 6);
            r.setEnd(n, i + 10);
            const b = r.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2, id: n.parentElement.closest('li').id };
          }
        }
        return null;
      });
      await page.mouse.click(at.x, at.y);
      await page.waitForSelector('.note-list .sticky.editing textarea', { timeout: 3000 });
      // A long line: it must wrap in its card, not widen the book.
      await page.keyboard.type('On a phone, this note runs long enough that on one line it would be far wider than the screen');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      const seen = await page.evaluate(id => {
        const st = [...document.querySelectorAll('.sticky')].find(x => x.querySelector('textarea').value.startsWith('On a phone'));
        const list = st && st.closest('.note-list');
        const pin = document.getElementById(id).querySelector('.pin');
        const r = pin && pin.getBoundingClientRect();
        return { inList: !!list, after: list ? list.previousElementSibling && list.previousElementSibling.id : null, dot: r ? [Math.round(r.width), Math.round(r.height)] : null, line: [...document.querySelectorAll('.note-arrows path')].some(p => p.getAttribute('d')) };
      }, at.id);
      if (!seen.inList || seen.after !== at.id || JSON.stringify(seen.dot) !== '[3,3]' || !seen.line) {
        throw new Error(`on a phone: ${JSON.stringify(seen)}`);
      }
      const w = await bookWidth();
      if (w[0] > w[1]) {
        throw new Error(`with a long note the book is ${w[0]} pixels wide on a ${w[1]}-pixel screen`);
      }
      const saved = await waitFor(() => Object.values(readNotesFile().notes).find(n => n.text.startsWith('On a phone')), 3000, 'review.json to hold the note');
      if ('dx' in saved.pin || 'dy' in saved.pin) {
        throw new Error(`a narrow screen saved a sticky position: ${JSON.stringify(saved.pin)}`);
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
    // Wide again: the same note is a floating sticky with its arrow.
    await page.waitForFunction(() => {
      const st = [...document.querySelectorAll('.sticky')].find(x => x.querySelector('textarea').value.startsWith('On a phone'));
      return st && !st.closest('.note-list') && !st.hidden;
    }, null, { timeout: 3000 });
  });

  await check('on a phone a long press on a note deletes it', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      const ok = await page.evaluate(async () => {
        const st = [...document.querySelectorAll('.note-list .sticky')].find(x => x.querySelector('textarea').value.startsWith('On a phone'));
        if (!st) { return 'no card'; }
        st.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = st.getBoundingClientRect();
        const at = { clientX: r.left + 20, clientY: r.top + r.height / 2, pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, button: 0 };
        st.dispatchEvent(new PointerEvent('pointerdown', at));
        await new Promise(done => setTimeout(done, 800));
        st.dispatchEvent(new PointerEvent('pointerup', at));
        return 'pressed';
      });
      if (ok !== 'pressed') {
        throw new Error(ok);
      }
      await waitFor(() => !Object.values(readNotesFile().notes).some(n => n.text.startsWith('On a phone')), 3000, 'the long-pressed note to leave review.json');
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  });

  await check('on a phone the bar says where you are, and it opens the contents as a sheet that jumps and closes', async () => {
    if (await page.locator('#where').isVisible()) {
      throw new Error('the "where am I" label shows on a desktop');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      // Earlier checks leave "show only changes" on, which hides the unchanged sections.
      if ((await page.locator('#changes-btn').getAttribute('aria-pressed')) === 'true') {
        await page.locator('#changes-btn').click();
      }
      await page.waitForSelector('#todos-add', { state: 'visible', timeout: 3000 });
      await page.evaluate(() => document.getElementById('todos-add').scrollIntoView({ behavior: 'instant' }));
      await page.waitForFunction(() => /Adding a todo/.test(document.getElementById('where')?.textContent ?? ''), null, { timeout: 3000 }).catch(async e => {
        throw new Error(`${e.message}: the label says ${JSON.stringify(await page.evaluate(() => document.getElementById('where')?.textContent))}}`);
      });
      await page.locator('#where').click();
      await page.waitForSelector('body.toc-open .side', { state: 'visible', timeout: 3000 });
      const here = await page.evaluate(() => document.querySelector('.side .sb-here')?.getAttribute('href'));
      if (here !== '#todos-add') {
        throw new Error(`the contents mark ${here} as where you are`);
      }
      await page.locator('.side a[href="#filters-bar"]').click();
      await page.waitForFunction(() => !document.body.classList.contains('toc-open'), null, { timeout: 3000 });
      await page.waitForFunction(() => /The filter bar/.test(document.getElementById('where').textContent), null, { timeout: 3000 });
      // The strip's Contents button opens it too, and Esc closes it.
      await page.locator('#toc-btn').click();
      await page.waitForSelector('body.toc-open', { timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('toc-open'), null, { timeout: 3000 });
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
    if (await page.locator('#toc-btn').isVisible()) {
      throw new Error('the Contents button shows on a desktop');
    }
  });

  await check('on a phone every button in the bottom strip is at least 44 by 44 points, and the strip fits the screen', async () => {
    try {
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 700 });
        await open();
        const bad = await page.evaluate(() => {
          const out = [];
          const strip = document.querySelector('.tools').getBoundingClientRect();
          if (strip.left < 0 || strip.right > innerWidth) { out.push(`the strip runs ${strip.left}..${strip.right} on a ${innerWidth} screen`); }
          const boxes = [...document.querySelectorAll('.tools button')].filter(b => b.offsetParent).map(b => [b.id, b.getBoundingClientRect()]);
          for (const [id, r] of boxes) {
            if (r.width < 44 || r.height < 44) { out.push(`${id} is ${r.width}x${r.height}`); }
          }
          for (let i = 1; i < boxes.length; i++) {
            if (boxes[i][1].left < boxes[i - 1][1].right - 0.5) { out.push(`${boxes[i][0]} overlaps ${boxes[i - 1][0]}`); }
          }
          return out;
        });
        if (bad.length) { throw new Error(`at ${width}: ${bad.join('; ')}`); }
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  });

  await check('no console errors', async () => {
    if (errors.length) {
      throw new Error(errors.join('\n     '));
    }
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e && e.stack ? e.stack : e}`);
} finally {
  if (browser) {
    await browser.close();
  }
  server.kill();
  rmSync(data, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
