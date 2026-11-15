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
{
  const bookFile = join(data, 'book.json');
  const b = JSON.parse(readFileSync(bookFile, 'utf8'));
  // A long path among the sources, as real books have: it must wrap on a phone.
  b.sources = [...(b.sources ?? []), { label: 'SMS program (planned)', path: 'docs/specs/notifications/design-sms-program-and-other-long-names.md' }];
  // Requirements that point at a screen state and at a component, for the chips under them.
  const reqOf = id => b.chapters.flatMap(c => c.sections).flatMap(s => s.requirements || []).find(r => r.id === id);
  reqOf('TOD-LGXT').screens = [{ screen: 'SCR-3WRX', state: 'empty' }];
  reqOf('FLT-36VG').screens = [{ screen: 'SCR-Y6S2' }];
  writeFileSync(bookFile, JSON.stringify(b, null, 2));
}

// The server hosts through a fake host (SPECBOOK_TEST_HOST, a test-only seam in serve.mjs): no WebRTC and no share
// server. Started, it opens a made-up room and a reader, Ana, says hello (and is in its people from then on); it logs what the owner's tab sends to
// live.log in the book folder. SPECBOOK_DEPS is an empty folder, so the real ~/.claude/specbook/deps is never read.
const fixtures = mkdtempSync(join(tmpdir(), 'specbook-smoke-fixtures-'));
const fakeHost = join(fixtures, 'fake-host.cjs');
writeFileSync(fakeHost, `
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomInt } = require('node:crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const newId = () => Array.from({ length: 22 }, () => A[randomInt(62)]).join('');
const newPin = () => String(randomInt(1000000)).padStart(6, '0');
const dir = process.argv[process.argv.indexOf('--data') + 1];
exports.createHost = ({ broker, saved, onState }) => {
  let pin = saved && saved.pin ? saved.pin : newPin();
  let kept = saved && saved.room ? { room: saved.room, hostToken: saved.hostToken, expiresAt: saved.expiresAt || null } : null;
  let state = 'off';
  const listeners = [];
  const guests = () => (state === 'live' ? ['Ana'] : []);
  const view = () => ({ state, room: kept ? kept.room : null, hostToken: kept ? kept.hostToken : null, pin, expiresAt: kept ? kept.expiresAt : null, guests: guests(), error: null });
  const report = () => onState(view());
  return {
    async start({ pin: chosen } = {}) {
      if (/^\\d{6}$/.test(chosen || '')) { pin = chosen; }
      if (state !== 'live') {
        // A moment to connect, as the real host takes: the owner sees "connecting" meanwhile.
        state = 'starting';
        report();
        await new Promise(r => setTimeout(r, 800));
        if (state !== 'starting') { return; }
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
    newPin() { pin = newPin(); report(); },
    state: () => state,
    links: () => (state === 'live' ? { url: broker + '/s/' + kept.room, pinUrl: broker + '/s/' + kept.room + '#pin=' + pin } : null),
    people: () => [{ id: 'host', name: 'Owner', color: '#3ecf8e', role: 'owner' }].concat(state === 'live' ? [{ id: 'ana-device', name: 'Ana', color: '#f27aa0', role: 'guest' }] : []),
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
    await page.locator('#claude-confirm .cc-send').click();
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
    await page.locator('#claude-confirm .cc-send').click();
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
    const mock = join(data, 'mockups', 'screens', 'SCR-3WRX', 'typing.html');
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
      frame: document.querySelector('.rv-stack[data-key="SCR-3WRX.typing"]')?.textContent || '',
      frames: document.querySelectorAll('figure.state.has-rv').length,
      count: document.getElementById('chg-pos').textContent.split(' / ')[1],
      stacks: document.querySelectorAll('.rv-stack').length,
    }), { a: req.id, b: changed.id });
    if (seen.was !== before) {
      throw new Error(`the requirement's stack does not show its accepted text: ${JSON.stringify(seen)}`);
    }
    if (!seen.bullet.includes('(reworded)') || !seen.frame.includes('Mockup changed') || seen.frames !== 1) {
      throw new Error(`expected a stack for the reworded today and only SCR-3WRX.typing changed: ${JSON.stringify(seen)}`);
    }
    if (seen.count !== String(seen.stacks)) {
      throw new Error(`the toolbar's n / N does not count the review stacks: ${JSON.stringify(seen)}`);
    }
    // Accept: the review closes, the count drops by one, and it stays closed after a reload.
    await page.locator(`.rv-acts[data-key="${req.id}"] .rv-accept`).click();
    await page.waitForFunction(id => !document.querySelector(`.rv-stack[data-key="${id}"]`), req.id, { timeout: 5000 });
    const after = await page.waitForFunction(n => document.getElementById('chg-pos').textContent.split(' / ')[1] === String(n), seen.stacks - 1, { timeout: 3000 })
      .then(() => String(seen.stacks - 1), async () => page.evaluate(() => document.getElementById('chg-pos').textContent));
    if (after !== String(seen.stacks - 1)) {
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

  await check('the bar: View, the review keys and Claude', async () => {
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
    // F shows only what needs you, J goes to the next.
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
    // Claude ▾ holds Revise and Build, each saying what it does.
    await page.locator('#claude-btn').click();
    const acts = await page.evaluate(() => ['revise', 'build'].map(id => document.getElementById(id).offsetParent !== null && document.getElementById(id).querySelector('small').textContent.length > 10));
    if (acts.join() !== 'true,true') {
      throw new Error('Claude ▾ does not show Revise and Build with what they do');
    }
    await page.keyboard.press('Escape');
  });

  await check('every dropdown in the header ends in the toolbar\'s chevron', async () => {
    await open();
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
    const bad = await page.evaluate(() => ['#view-btn', '#claude-btn', '.share-pill .share-start'].map(s => {
      const b = document.querySelector(s);
      if (!b) { return `${s} is missing`; }
      const chevs = b.querySelectorAll('svg path[d="M6 9l6 6 6-6"]');
      const r = chevs.length === 1 ? chevs[0].closest('svg').getBoundingClientRect() : null;
      if (!r || Math.round(r.width) !== 18 || Math.round(r.height) !== 18) { return `${s} has ${chevs.length} chevrons${r ? ` of ${r.width}x${r.height}` : ''}`; }
      return b.textContent.includes('▾') ? `${s} still says ▾` : null;
    }).filter(Boolean));
    if (bad.length) {
      throw new Error(bad.join('; '));
    }
  });

  // Drops a note on an element of the book through Comment mode and waits for review.json to hold it.
  const dropNoteOn = async (sel, text) => {
    await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    const box = await page.locator(sel).boundingBox();
    await page.mouse.click(box.x + Math.min(box.width / 2, 200), box.y + Math.min(box.height / 2, 10));
    await page.waitForSelector('.sticky.editing textarea');
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await waitFor(() => Object.values(readNotesFile().notes).some(n => n.text === text), 3000, `review.json to hold "${text}"`);
  };
  const filterOff = async () => {
    if ((await page.locator('#changes-btn').getAttribute('aria-pressed')) === 'true') {
      await page.locator('#changes-btn').click();
    }
  };

  await check('the filter shows only what still needs you: changes not accepted and lines with a note', async () => {
    const keep = readNotesFile().notes;
    try {
      await open();
      await filterOff();
      const t = await page.evaluate(() => {
        const quiet = [...document.querySelectorAll('#main .bk-sec')].filter(s => !s.querySelector('.has-rv') && s.querySelector('.reqs li.same[id]'));
        return quiet.length < 2 ? null : { li: quiet[0].querySelector('.reqs li.same[id]').id, sec: quiet[0].id, other: quiet[1].id };
      });
      if (!t) {
        throw new Error('the starter book has no two sections without changes to test with');
      }
      await dropNoteOn(`li#${t.li}`, 'A note on an accepted line');
      await page.locator('#changes-btn').click();
      await page.waitForFunction(() => document.body.classList.contains('diff-on'), null, { timeout: 3000 });
      await page.waitForTimeout(200);
      const seen = await page.evaluate(({ li, sec, other }) => {
        const l = document.getElementById(li);
        const dim = [l, ...l.children].filter(c => !c.classList.contains('pin')).map(c => getComputedStyle(c).opacity).filter(o => o !== '1');
        return {
          shown: !!document.getElementById(sec).getClientRects().length, dim, other: !!document.getElementById(other).getClientRects().length,
          total: document.getElementById('chg-pos').textContent.split(' / ')[1], rv: String(document.querySelectorAll('#main .has-rv').length),
          title: document.getElementById('changes-btn').title,
        };
      }, t);
      if (!seen.shown || seen.dim.length || seen.other || seen.total !== seen.rv || seen.title !== 'Only what needs you · F') {
        throw new Error(`the filter does not show exactly what needs you: ${JSON.stringify({ ...t, ...seen })}`);
      }
    } finally {
      writeNotes(keep);
      await open();
      await filterOff();
    }
  });

  await check('there is no Requests panel; the notes count is on Claude', async () => {
    const keep = readNotesFile().notes;
    try {
      writeNotes({});
      await open();
      if (await page.locator('#notes-btn, #notes-panel').count()) {
        throw new Error('the Requests button or panel is still there');
      }
      if (await page.locator('#claude-count').isVisible()) {
        throw new Error('the notes count shows with no notes');
      }
      const look = () => page.evaluate(() => [document.body.className, [...document.querySelectorAll('aside, [role="dialog"]')].filter(e => e.getClientRects().length).length].join('|'));
      const before = await look();
      await page.keyboard.press('r');
      await page.waitForTimeout(200);
      if ((await look()) !== before) {
        throw new Error(`R still does something: ${before} -> ${await look()}`);
      }
      await dropNoteOn('#todos-list > h3', 'First of two');
      await dropNoteOn('#todos-add > h3', 'Second of two');
      await page.waitForFunction(() => {
        const c = document.getElementById('claude-count');
        return c && !c.hidden && c.textContent === '2' && document.querySelector('#revise small').textContent.startsWith('Review your 2 notes');
      }, null, { timeout: 3000 }).catch(async () => {
        throw new Error(`the Claude button and Revise do not count 2 notes: ${await page.evaluate(() => [document.getElementById('claude-count')?.textContent, document.querySelector('#revise small').textContent].join(' | '))}`);
      });
    } finally {
      writeNotes(keep);
      await open();
    }
  });

  // The screen before Revise and Build: Claude ▸ Revise (or Build) opens it.
  const requestFiles = () => readdirSync(join(data, 'requests')).filter(f => f.endsWith('.json'));
  const openConfirm = async kind => {
    await page.waitForFunction(k => !document.getElementById(k).disabled, kind, { timeout: 5000 });
    await page.locator('#claude-btn').click();
    const at = await buttonSpot(`#${kind}`);
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('#claude-confirm:not([hidden])', { timeout: 3000 });
  };
  const confirmShut = () => page.waitForFunction(() => document.getElementById('claude-confirm').hidden && !document.body.classList.contains('confirm-open'), null, { timeout: 3000 });
  const idle = () => waitFor(async () => (await fetch(`${URL}api/book`).then(r => r.json())).claude.state === 'idle', 5000, 'Claude to be idle');
  // Two draft notes in two sections: one on a section's heading, one on a requirement in the next section.
  const twoNotes = async () => {
    writeNotes({});
    await open();
    await dropNoteOn('#todos-list > h3', 'Say what the list is for');
    const req = await page.evaluate(() => document.querySelector('#todos-add .reqs li.tgt[id]').id);
    await dropNoteOn(`li#${req}`, 'Name the button');
    return req;
  };

  await check('Revise opens a screen with every note under its requirement, and sends only on Send', async () => {
    const keep = readNotesFile().notes;
    let sent = false;
    try {
      await idle();
      const req = await twoNotes();
      const before = requestFiles().length;
      await openConfirm('revise');
      const seen = await page.evaluate(() => {
        const d = document.getElementById('claude-confirm');
        return {
          title: d.querySelector('#cc-title').textContent,
          focus: document.activeElement && document.activeElement.classList.contains('cc-send'),
          groups: [...d.querySelectorAll('.cc-group')].map(g => ({
            head: g.querySelector('.cc-sec').textContent.replace(/\s+/g, ' ').trim(),
            go: g.querySelector('.cc-go')?.textContent,
            items: [...g.querySelectorAll('.cc-item')].map(i => ({
              id: i.querySelector('.cc-id').textContent, about: i.querySelector('.cc-about')?.textContent || '',
              tag: i.querySelector('.cc-tag')?.textContent || '', note: i.querySelector('.cc-note-text').textContent,
            })),
          })),
          expect: ['todos-list', 'todos-add'].map(id => {
            const s = document.getElementById(id);
            return s.querySelector('h3 .bk-num').textContent + ' ' + s.querySelector('h3').childNodes[1].textContent.trim();
          }),
        };
      });
      const want = await page.evaluate(id => ({ about: document.getElementById(id).dataset.quote ? document.createRange().createContextualFragment(document.getElementById(id).dataset.quote).textContent.trim() : '', changed: document.getElementById(id).classList.contains('rv-is-changed') }), req);
      const g = seen.groups;
      if (seen.title !== 'Revise: 2 notes to send' || !seen.focus || g.length !== 2 || g.some(x => x.go !== 'Go to ›')) {
        throw new Error(`the Revise screen is wrong: ${JSON.stringify(seen)}`);
      }
      if (!g[0].head.startsWith(seen.expect[0]) || !g[1].head.startsWith(seen.expect[1])) {
        throw new Error(`the groups are not headed by their sections' number and title: ${JSON.stringify(seen)}`);
      }
      const it = g[1].items[0];
      if (g[0].items[0]?.note !== 'Say what the list is for' || it?.id !== req || it.note !== 'Name the button' || it.about !== want.about || (it.tag === 'changed') !== want.changed) {
        throw new Error(`the notes are not listed under their requirements: ${JSON.stringify({ seen, want })}`);
      }
      if (requestFiles().length !== before) {
        throw new Error('opening the screen sent the notes');
      }
      await page.locator('#claude-confirm .cc-cancel').click();
      await confirmShut();
      await page.waitForTimeout(300);
      if (requestFiles().length !== before) {
        throw new Error('Cancel sent the notes');
      }
      // Go to › closes the screen and goes to the note, flashing its pin.
      await openConfirm('revise');
      await page.locator('#claude-confirm .cc-group:nth-child(2) .cc-go').click();
      await confirmShut();
      await page.waitForSelector('.pin.flash', { state: 'attached', timeout: 3000 });
      // Esc closes it.
      await openConfirm('revise');
      await page.keyboard.press('Escape');
      await confirmShut();
      // Send sends both.
      await openConfirm('revise');
      await page.locator('#claude-confirm .cc-send').click();
      await confirmShut();
      await page.waitForFunction(() => document.getElementById('claude-status').textContent === 'Revising…', null, { timeout: 3000 });
      sent = true;
      const files = requestFiles();
      const body = files.length === before + 1 ? readFileSync(join(data, 'requests', files.find(f => !f.includes('build')) || files[0]), 'utf8') : '';
      if (!body.includes('Say what the list is for') || !body.includes('Name the button')) {
        throw new Error(`Send did not write one request with both notes: ${files.join(', ')}`);
      }
    } finally {
      if (sent) {
        for (const f of requestFiles()) {
          execFileSync(process.execPath, [join(PLUGIN, 'server', 'next-request.mjs'), '--data', data, '--done', f], { stdio: 'ignore' });
        }
        await idle();
      }
      writeNotes(keep);
      await open();
    }
  });

  await check('the Revise screen follows the notes while it is open', async () => {
    const keep = readNotesFile().notes;
    try {
      writeNotes({});
      await open();
      // With no notes Revise is off, and the screen does not open.
      await page.evaluate(() => document.getElementById('revise').click());
      await page.waitForTimeout(200);
      if (!(await page.evaluate(() => document.getElementById('revise').disabled && document.getElementById('claude-confirm').hidden))) {
        throw new Error('Revise with no notes opened the screen');
      }
      await twoNotes();
      await openConfirm('revise');
      // Another tab saves a third note.
      const [id, note] = Object.entries(readNotesFile().notes)[0];
      const third = { ...note, text: 'A third, from another tab' };
      delete third.status;
      const res = await fetch(`${URL}api/notes`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { [`${id}x3`]: third } }) });
      if (!res.ok) {
        throw new Error(`the other tab's save failed: ${res.status} ${await res.text()}`);
      }
      await page.waitForFunction(() => document.getElementById('cc-title').textContent === 'Revise: 3 notes to send' &&
        [...document.querySelectorAll('#claude-confirm .cc-note-text')].some(n => n.textContent === 'A third, from another tab'), null, { timeout: 3000 })
        .catch(async () => { throw new Error(`the screen did not follow: ${await page.evaluate(() => document.getElementById('cc-title').textContent)}`); });
      await page.locator('#claude-confirm .cc-cancel').click();
      await confirmShut();
    } finally {
      writeNotes(keep);
      await open();
    }
  });

  await check('a refused Send says why', async () => {
    const keep = readNotesFile().notes;
    await page.route('**/api/revise', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy' }) }));
    try {
      await twoNotes();
      await openConfirm('revise');
      await page.locator('#claude-confirm .cc-send').click();
      await confirmShut();
      await page.waitForFunction(() => document.getElementById('make-msg').textContent === 'Claude is busy; try again when it is done.', null, { timeout: 3000 })
        .catch(async () => { throw new Error(`the message says ${JSON.stringify(await page.locator('#make-msg').textContent())}`); });
    } finally {
      await page.unroute('**/api/revise');
      // The refused send is logged by the browser; it is the point of this check.
      for (let i = errors.length - 1; i >= 0; i--) {
        if (/409/.test(errors[i])) { errors.splice(i, 1); }
      }
      writeNotes(keep);
      await open();
    }
  });

  await check('the Revise screen fits a phone', async () => {
    const keep = readNotesFile().notes;
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await twoNotes();
      await openConfirm('revise');
      const fit = await page.evaluate(() => {
        const d = document.getElementById('claude-confirm').getBoundingClientRect();
        const list = getComputedStyle(document.querySelector('#claude-confirm .cc-list')).overflowY;
        const btn = s => Math.round(document.querySelector(s).getBoundingClientRect().height);
        return { d: [d.left, d.top, d.right, d.bottom].map(Math.round), w: innerWidth, h: innerHeight, list, cancel: btn('#claude-confirm .cc-cancel'), send: btn('#claude-confirm .cc-send'), page: document.documentElement.scrollWidth };
      });
      if (fit.d[0] < 0 || fit.d[1] < 0 || fit.d[2] > fit.w || fit.d[3] > fit.h || !/auto|scroll/.test(fit.list) || fit.cancel < 44 || fit.send < 44 || fit.page > fit.w) {
        throw new Error(`the Revise screen does not fit a phone: ${JSON.stringify(fit)}`);
      }
      await page.keyboard.press('Escape');
      await confirmShut();
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
      writeNotes(keep);
      await open();
    }
  });

  await check('Build opens a screen with the sections marked Ready', async () => {
    const file = join(data, 'book.json');
    const original = readFileSync(file, 'utf8');
    const posts = [];
    await page.route('**/api/build', route => {
      posts.push(route.request().method());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, file: 'build-test.json' }) });
    });
    try {
      await idle();
      const book = JSON.parse(original);
      let title = '';
      for (const ch of book.chapters) {
        for (const s of ch.sections || []) {
          if (s.stage === 'ready') { s.stage = 'drafting'; }
          if (!title && ch.id === 'filters' && s.id === 'bar') { s.stage = 'ready'; title = s.title; }
        }
      }
      writeFileSync(file, JSON.stringify(book, null, 2));
      await open();
      await openConfirm('build');
      const seen = await page.evaluate(() => ({
        title: document.getElementById('cc-title').textContent,
        list: document.querySelector('#claude-confirm .cc-list').textContent,
        send: document.querySelector('#claude-confirm .cc-send').textContent,
      }));
      if (seen.title !== 'Build: 1 section marked Ready' || !seen.list.includes(title) || !seen.send.includes('Build')) {
        throw new Error(`the Build screen is wrong: ${JSON.stringify(seen)}`);
      }
      await page.locator('#claude-confirm .cc-cancel').click();
      await confirmShut();
      await page.waitForTimeout(200);
      if (posts.length) {
        throw new Error('Cancel started the build');
      }
      await openConfirm('build');
      await page.locator('#claude-confirm .cc-send').click();
      await confirmShut();
      await page.waitForFunction(() => document.getElementById('make-msg').textContent === 'Build sent to Claude (build-test.json).', null, { timeout: 3000 });
      if (posts.join() !== 'POST') {
        throw new Error(`Build posted ${JSON.stringify(posts)}`);
      }
    } finally {
      await page.unroute('**/api/build');
      writeFileSync(file, original);
      await open();
    }
  });

  await check('the screen before Claude keeps focus inside it, and Go to › finds a section the filter hides', async () => {
    const file = join(data, 'book.json');
    const original = readFileSync(file, 'utf8');
    try {
      await idle();
      const book = JSON.parse(original);
      for (const ch of book.chapters) {
        for (const s of ch.sections || []) {
          if (s.stage === 'ready') { s.stage = 'drafting'; }
          if (ch.id === 'later' && s.id === 'due') { s.stage = 'ready'; }
        }
      }
      writeFileSync(file, JSON.stringify(book, null, 2));
      await open();
      // The filter on: a Ready section with nothing to look at is hidden.
      if ((await page.locator('#changes-btn').getAttribute('aria-pressed')) !== 'true') {
        await page.locator('#changes-btn').click();
      }
      const sec = await page.evaluate(() => [...document.querySelectorAll('#main .bk-sec')].find(s => !s.getClientRects().length && /Ready/.test(s.querySelector('h3')?.textContent || ''))?.id);
      if (!sec) {
        throw new Error('no Ready section is hidden by the filter to test with');
      }
      await openConfirm('build');
      // Tab and Shift+Tab stay in the screen.
      const out = [];
      for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        if (!(await page.evaluate(() => document.getElementById('claude-confirm').contains(document.activeElement)))) {
          out.push(`${key} -> ${await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName)}`);
        }
      }
      if (out.length) {
        throw new Error(`focus left the screen: ${out.join(', ')}`);
      }
      await page.locator('#claude-confirm .cc-go').first().click();
      await confirmShut();
      await page.waitForFunction(id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && r.top < innerHeight;
      }, sec, { timeout: 3000 }).catch(async () => {
        throw new Error(`Go to › did not land on ${sec}: ${JSON.stringify(await page.evaluate(id => [document.body.classList.contains('diff-on'), document.getElementById(id).getBoundingClientRect().top], sec))}`);
      });
      if (await page.evaluate(() => [...document.querySelectorAll('[inert]')].length)) {
        throw new Error('the book is still inert after the screen closed');
      }
    } finally {
      writeFileSync(file, original);
      await open();
      if ((await page.locator('#changes-btn').getAttribute('aria-pressed')) === 'true') {
        await page.locator('#changes-btn').click();
      }
    }
  });

  await check('the toolbar covers neither the toast on a phone nor the review panel on a desktop', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      const toast = await page.evaluate(() => {
        const msg = document.getElementById('make-msg');
        msg.textContent = 'Claude is busy; try again when it is done.';
        const a = msg.getBoundingClientRect(), b = document.getElementById('review-tools').getBoundingClientRect();
        msg.textContent = '';
        return a.bottom > b.top + 0.5 ? `toast ${Math.round(a.top)}..${Math.round(a.bottom)}, toolbar from ${Math.round(b.top)}` : null;
      });
      if (toast) {
        throw new Error(`on a phone the toast covers the toolbar: ${toast}`);
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    try {
      await open();
      const panel = await page.evaluate(() => {
        const p = document.getElementById('review-panel');
        p.hidden = false;
        const pr = p.getBoundingClientRect(), t = document.getElementById('review-tools').getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(p).paddingBottom);
        p.hidden = true;
        const overlaps = t.right > pr.left && t.left < pr.right;
        return overlaps && pad < innerHeight - t.top + 8 ? `the toolbar (${Math.round(t.left)}..${Math.round(t.right)}) overlaps the panel (${Math.round(pr.left)}..) with only ${pad}px of padding under its last call` : null;
      });
      if (panel) {
        throw new Error(panel);
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  });

  // Stop in the Claude menu: the running action has Stop, which asks once, then withdraws the request.
  const openClaudeMenu = async () => {
    if (await page.locator('#claude-pop').isHidden()) {
      await page.locator('#claude-btn').click();
    }
    await page.waitForSelector('#claude-pop:not([hidden])', { timeout: 3000 });
  };
  const tall = sel => page.evaluate(s => Math.round(document.querySelector(s).getBoundingClientRect().height), sel);

  await check('while Claude revises, the menu shows Revise running with Stop, and Stop asks before it stops', async () => {
    const keep = readNotesFile().notes;
    let sent = false;
    try {
      await idle();
      await twoNotes();
      await openConfirm('revise');
      await page.locator('#claude-confirm .cc-send').click();
      await page.waitForFunction(() => document.getElementById('claude-status').textContent === 'Revising…', null, { timeout: 3000 });
      sent = true;
      await openClaudeMenu();
      const row = await page.evaluate(() => ({
        running: document.getElementById('revise-row').classList.contains('running'),
        text: document.getElementById('revise').textContent,
        stop: !!document.querySelector('#revise-row .claude-stop')?.getClientRects().length,
        buildStop: !!document.querySelector('#build-row .claude-stop')?.getClientRects().length,
        build: document.querySelector('#build small').textContent,
      }));
      if (!row.running || !row.text.includes('Revising') || !row.text.includes('2 notes') || !row.stop || row.buildStop || row.build !== 'Waiting for Claude to finish.') {
        throw new Error(`the running row is wrong: ${JSON.stringify(row)}`);
      }
      // Stop asks; Keep going leaves everything as it was.
      await page.locator('#revise-row .claude-stop').click();
      await page.waitForSelector('#claude-ask:not([hidden])', { timeout: 3000 });
      const ask = await page.locator('#claude-ask').textContent();
      if (!ask.includes('Stop revising?') || !ask.includes('Keep going') || !ask.includes('Stop revising')) {
        throw new Error(`the question says ${JSON.stringify(ask)}`);
      }
      await page.locator('#claude-ask .ca-keep').click();
      await page.waitForSelector('#claude-ask', { state: 'hidden', timeout: 3000 });
      if (requestFiles().length !== 1) {
        throw new Error('Keep going withdrew the request');
      }
      // A question left open when the menu closes (a click on the book) does not take the next Esc.
      await page.locator('#revise-row .claude-stop').click();
      await page.waitForSelector('#claude-ask:not([hidden])', { timeout: 3000 });
      await page.mouse.click(700, 600);
      await page.waitForSelector('#claude-pop', { state: 'hidden', timeout: 3000 });
      await page.locator('#view-btn').click();
      await page.waitForSelector('#view-menu:not([hidden])', { timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.waitForSelector('#view-menu', { state: 'hidden', timeout: 2000 }).catch(() => {
        throw new Error('a Stop question closed with the menu still took the next Esc');
      });
      // On a phone Stop and its answers are thumb-sized.
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        await openClaudeMenu();
        const sizes = [await tall('#revise-row .claude-stop')];
        await page.locator('#revise-row .claude-stop').click();
        await page.waitForSelector('#claude-ask:not([hidden])', { timeout: 3000 });
        sizes.push(await tall('#claude-ask .ca-keep'), await tall('#claude-ask .ca-stop'));
        if (sizes.some(h => h < 44)) {
          throw new Error(`on a phone Stop and its answers are ${sizes.join(', ')} px tall`);
        }
        await page.keyboard.press('Escape');
        await page.waitForSelector('#claude-ask', { state: 'hidden', timeout: 3000 });
        if (!(await page.evaluate(() => document.activeElement?.classList.contains('claude-stop')))) {
          throw new Error(`Esc on the question left focus on ${await page.evaluate(() => document.activeElement?.tagName)}`);
        }
      } finally {
        await page.setViewportSize({ width: 1400, height: 900 });
      }
      // A stop the server refuses (Claude got there first) says so.
      await page.route('**/api/claude/stop', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'idle' }) }));
      try {
        await openClaudeMenu();
        await page.locator('#revise-row .claude-stop').click();
        await page.locator('#claude-ask .ca-stop').click();
        await page.waitForFunction(() => document.getElementById('make-msg').textContent === 'Claude had already finished.', null, { timeout: 3000 });
      } finally {
        await page.unroute('**/api/claude/stop');
        for (let i = errors.length - 1; i >= 0; i--) {
          if (/409/.test(errors[i])) { errors.splice(i, 1); }
        }
      }
      // Stop revising: the request is withdrawn, the notes are drafts again and the book unlocks.
      await openClaudeMenu();
      await page.locator('#revise-row .claude-stop').click();
      await page.locator('#claude-ask .ca-stop').click();
      await page.waitForFunction(() => document.getElementById('make-msg').textContent === 'Stopped. Your 2 notes are drafts again.', null, { timeout: 3000 })
        .catch(async () => { throw new Error(`the toast says ${JSON.stringify(await page.locator('#make-msg').textContent())}`); });
      sent = false;
      await page.waitForFunction(() => !document.getElementById('revise').disabled && !document.body.classList.contains('locked-notes') && document.getElementById('claude-pop').hidden, null, { timeout: 5000 });
      const statuses = Object.values(readNotesFile().notes).map(n => n.status);
      if (requestFiles().length || statuses.length !== 2 || statuses.some(s => s !== 'draft')) {
        throw new Error(`after Stop: ${requestFiles().length} pending, notes ${statuses.join(', ')}`);
      }
    } finally {
      if (sent) {
        for (const f of requestFiles()) {
          execFileSync(process.execPath, [join(PLUGIN, 'server', 'next-request.mjs'), '--data', data, '--done', f], { stdio: 'ignore' });
        }
      }
      await idle();
      writeNotes(keep);
      await open();
    }
  });

  await check('Stop the build stops a build', async () => {
    const file = join(data, 'book.json');
    const original = readFileSync(file, 'utf8');
    try {
      await idle();
      const book = JSON.parse(original);
      for (const ch of book.chapters) {
        for (const s of ch.sections || []) {
          if (s.stage === 'ready') { s.stage = 'drafting'; }
          if (ch.id === 'later' && s.id === 'due') { s.stage = 'ready'; }
        }
      }
      writeFileSync(file, JSON.stringify(book, null, 2));
      await open();
      await openConfirm('build');
      await page.locator('#claude-confirm .cc-send').click();
      await page.waitForFunction(() => document.getElementById('claude-btn').classList.contains('busy'), null, { timeout: 5000 });
      // Before the build starts, the row and the question say so: the sections would stay Ready.
      await openClaudeMenu();
      await page.locator('#build-row .claude-stop').click();
      await page.waitForSelector('#claude-ask:not([hidden])', { timeout: 3000 });
      const early = await page.evaluate(() => [document.querySelector('#build small').textContent, document.getElementById('claude-ask').textContent]);
      if (!early[0].includes('requested at') || !early[1].includes('stay Ready')) {
        throw new Error(`before the build starts the menu says ${JSON.stringify(early)}`);
      }
      await page.locator('#claude-ask .ca-keep').click();
      const id = buildCli('start').id;
      await page.waitForFunction(() => document.querySelector('#build small').textContent.includes('started at'), null, { timeout: 8000 })
        .catch(async () => { throw new Error(`once started the row says ${JSON.stringify(await page.locator('#build small').textContent())}`); });
      await openClaudeMenu();
      if (!(await page.evaluate(() => document.getElementById('build-row').classList.contains('running') && document.querySelector('#revise small').textContent === 'Waiting for Claude to finish.'))) {
        throw new Error('Build is not the running row');
      }
      await page.locator('#build-row .claude-stop').click();
      await page.waitForSelector('#claude-ask:not([hidden])', { timeout: 3000 });
      if (!/Stop the build\?.*back to Drafting/.test(await page.locator('#claude-ask').textContent())) {
        throw new Error('the question does not ask to stop the build');
      }
      await page.locator('#claude-ask .ca-stop').click();
      await page.waitForFunction(() => document.getElementById('make-msg').textContent === 'Stopped the build.', null, { timeout: 3000 });
      const progress = JSON.parse(readFileSync(join(data, 'builds', id, 'progress.json'), 'utf8'));
      if (progress.state !== 'failed' || requestFiles().length) {
        throw new Error(`the build was not stopped: ${progress.state}, ${requestFiles().length} pending`);
      }
      await idle();
    } finally {
      writeFileSync(file, original);
      await open();
    }
  });

  await check('Share asks for a pin, Start shares, and the menu then has the link, this computer\'s address, who is here and only Stop sharing', async () => {
    await open();
    // The book does not share itself: the pill offers to.
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
    if (await page.evaluate(() => window.SpecHost.link() !== null)) {
      throw new Error('an unshared book has a link');
    }
    await page.locator('.share-pill .share-start').click();
    await page.waitForSelector('.share-menu .share-start-pin', { timeout: 3000 });
    await page.fill('.share-menu .share-start-pin', '123');
    await page.locator('.share-menu .share-start-go').click();
    if (await page.locator('.share-menu .share-pin-error').isHidden()) {
      throw new Error('a 3-digit pin was not refused');
    }
    if (await page.evaluate(() => window.SpecHost.state()) !== 'off') {
      throw new Error('a refused pin started the share');
    }
    await page.fill('.share-menu .share-start-pin', '135790');
    await page.locator('.share-menu .share-start-go').click();
    // The same menu turns into the shared one at once, with You connecting, before the share is live.
    const early = await page.evaluate(() => ({
      stop: !!document.querySelector('.share-menu .share-stop'),
      you: [...document.querySelectorAll('.share-menu .share-people li')].map(li => li.textContent).find(t => t.startsWith('You')),
      solo: document.querySelector('.share-pill .share-solo')?.textContent,
      state: window.SpecHost.state(),
    }));
    if (!early.stop || early.you !== 'Youconnecting' || early.solo !== 'Connecting…' || early.state === 'live') {
      throw new Error(`right after Start the menu is not the connecting one: ${JSON.stringify(early)}`);
    }
    await page.waitForSelector('.share-pill .share-more', { timeout: 3000 });
    await page.waitForSelector('.share-menu .share-stop', { timeout: 3000 });
    // Ana, reading on the link, has a face beside the owner's.
    await page.waitForFunction(() => document.querySelectorAll('.share-pill .face').length === 2, null, { timeout: 3000 });
    const link = await page.evaluate(() => window.SpecHost.link());
    if (!/\/s\/[A-Za-z0-9]{22}$/.test(link || '')) {
      throw new Error(`the link is wrong: ${link}`);
    }
    const view = await page.evaluate(() => fetch('/api/share').then(r => r.json()));
    if (view.pinUrl !== `${link}#pin=135790`) {
      throw new Error(`the share does not have the chosen pin: ${view.pinUrl}`);
    }
    // The owner's tab said hello, as the owner, through the server.
    await waitFor(() => existsSync(join(data, 'live.log')) && readFileSync(join(data, 'live.log'), 'utf8').split('\n').some(l => l && JSON.parse(l).kind === 'hello' && JSON.parse(l).role === 'owner'), 3000, 'the owner\'s hello to reach the host');
    const menu = await page.evaluate(() => ({
      input: document.querySelector('.share-menu .share-url')?.textContent,
      copy: !!document.querySelector('.share-menu .share-copy-link'),
      local: !!document.querySelector('.share-menu .share-local'),
      oneLine: (() => { const u = document.querySelector('.share-menu .share-url'); return u && u.getBoundingClientRect().height < parseFloat(getComputedStyle(u).fontSize) * 2.2; })(),
      fields: document.querySelectorAll('.share-menu input').length,
      label: document.querySelector('.share-pill .share-more')?.textContent.trim(),
      chev: document.querySelectorAll('.share-pill .share-more svg path[d="M6 9l6 6 6-6"]').length,
      acts: [...document.querySelectorAll('.share-menu .share-acts button')].map(b => b.textContent),
      people: [...document.querySelectorAll('.share-menu .share-people li')].map(li => li.textContent),
    }));
    if (menu.input !== link || !menu.copy || menu.fields !== 0 || menu.local || !menu.oneLine || menu.label !== 'Share' || menu.chev !== 1 || menu.acts.join() !== 'Stop sharing' || !menu.people.some(t => t.startsWith('Ana'))) {
      throw new Error(`the share menu is wrong: ${JSON.stringify(menu)}`);
    }
    // A reloaded tab hears who is reading already (Ana says no new hello): her face is back.
    await open();
    await page.waitForFunction(() => document.querySelectorAll('.share-pill .face').length === 2, null, { timeout: 3000 });
    await page.locator('.share-pill .share-more').click();
    await page.locator('.share-menu .share-stop').click();
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
    if (await page.evaluate(() => window.SpecHost.link() !== null || document.querySelectorAll('.share-pill .face').length)) {
      throw new Error('Stop sharing left a link or faces');
    }
    // A reload does not share it again.
    await open();
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
  });

  await check('a second tab has the whole Share menu too, shared or not (who is reading included), and no tab flashes "Sharing…" on load', async () => {
    await open();
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
    const second = await context.newPage();
    try {
      // Every text the pill shows from the first moment.
      await second.addInitScript(() => {
        window.__pillTexts = [];
        new MutationObserver(() => {
          const t = document.querySelector('.share-pill')?.textContent;
          if (t && window.__pillTexts.at(-1) !== t) { window.__pillTexts.push(t); }
        }).observe(document, { subtree: true, childList: true, characterData: true });
      });
      await second.goto(URL);
      await second.waitForSelector('.share-pill .share-start', { timeout: 6000 });
      await page.evaluate(() => window.SpecHost.startSharing('135790'));
      // Each tab hears the server on its own stream: no polling.
      await page.waitForFunction(() => document.querySelectorAll('.share-pill .face').length === 2, null, { timeout: 8000 });
      await second.waitForFunction(() => document.querySelectorAll('.share-pill .face').length === 2, null, { timeout: 300 });
      await second.click('.share-pill .share-more');
      const menu = await second.evaluate(() => ({
        url: document.querySelector('.share-menu .share-url')?.textContent,
        people: [...document.querySelectorAll('.share-menu .share-people li')].map(li => li.textContent),
      }));
      if (menu.url !== await page.evaluate(() => window.SpecHost.link()) || !menu.people.some(t => t.startsWith('Ana'))) {
        throw new Error(`the second tab's menu: ${JSON.stringify(menu)}`);
      }
      // Each of the owner's open tabs is a line of its own, this one first.
      const you = menu.people.filter(t => t.startsWith('You'));
      if (you.join() !== 'Youthis tab,Youanother tab') {
        throw new Error(`the owner's tabs in the second tab's menu: ${JSON.stringify(you)}`);
      }
      // Stop sharing from the second tab.
      await second.click('.share-menu .share-stop');
      await page.waitForSelector('.share-pill .share-start', { timeout: 8000 });
      await second.waitForSelector('.share-pill .share-start', { timeout: 8000 });
      const texts = await second.evaluate(() => window.__pillTexts);
      if (texts.some(t => /Sharing…|Live sharing runs|in your other tab/.test(t))) {
        throw new Error(`the second tab's pill showed ${JSON.stringify(texts)}`);
      }
    } finally {
      await second.close();
    }
    await page.waitForSelector('.share-pill .share-start', { timeout: 3000 });
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

  await check('on a phone every menu in the bar fits on the screen: Contents, View, Claude, and Share before and while sharing', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const inside = sel => page.evaluate(s => {
      const e = document.querySelector(s);
      if (!e || !e.getClientRects().length) { return `${s} is not showing`; }
      const r = e.getBoundingClientRect();
      const w = document.documentElement.clientWidth;
      return r.left >= 0 && r.right <= w && r.top >= 0 ? null : `${s} is at ${Math.round(r.left)}..${Math.round(r.right)} on a ${w}-pixel screen`;
    }, sel);
    const close = async () => { await page.keyboard.press('Escape'); await page.mouse.click(200, 600); };
    const bad = [];
    try {
      await open();
      for (const [btn, menu] of [['#toc-btn', '#toc-nav'], ['#view-btn', '#view-menu'], ['#claude-btn', '#claude-pop']]) {
        await page.click(btn);
        await page.waitForTimeout(200);
        const why = await inside(menu);
        if (why) { bad.push(why); }
        await close();
      }
      await page.click('.share-pill .share-start');
      await page.waitForSelector('.share-menu .share-start-pin', { timeout: 3000 });
      const before = await inside('.share-menu');
      if (before) { bad.push(`before sharing: ${before}`); }
      await page.fill('.share-menu .share-start-pin', '135790');
      await page.click('.share-menu .share-start-go');
      await page.waitForSelector('.share-menu .share-copy-link:not([disabled])', { timeout: 5000 });
      const live = await inside('.share-menu');
      if (live) { bad.push(`while sharing: ${live}`); }
      await page.click('.share-menu .share-stop');
      await page.waitForSelector('.share-pill .share-start', { timeout: 5000 });
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
    if (bad.length) {
      throw new Error(bad.join('; '));
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

  await check('the review toolbar sits at the bottom on a desktop, and its Contents button hides and shows the contents', async () => {
    await page.evaluate(() => localStorage.removeItem('spec-book-toc'));
    await open();
    const seen = await page.evaluate(() => {
      const t = document.getElementById('review-tools');
      const bar = document.querySelector('header.bar');
      const r = t.getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect();
      return {
        inBar: bar.contains(t), bottom: Math.round(innerHeight - r.bottom), off: Math.round(Math.abs((r.left + r.right) / 2 - (m.left + m.right) / 2)),
        where: !!document.getElementById('where'), head: ['#book-title', '#view-btn', '#share-slot', '#claude-btn'].filter(s => !bar.querySelector(s)),
        tools: bar.querySelectorAll('.tool').length,
      };
    });
    if (seen.inBar || seen.bottom < 0 || seen.bottom > 40 || seen.off > 2 || seen.where || seen.head.length || seen.tools) {
      throw new Error(`the toolbar is not at the bottom under the book, or the header holds more than its four: ${JSON.stringify(seen)}`);
    }
    // The toast sits above the floating toolbar, not under it.
    const toast = await page.evaluate(() => {
      const msg = document.getElementById('make-msg');
      msg.textContent = 'A toast long enough to reach toward the middle of the window, where the toolbar floats';
      const a = msg.getBoundingClientRect(), b = document.getElementById('review-tools').getBoundingClientRect();
      msg.textContent = '';
      return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom ? `${JSON.stringify(a)} over ${JSON.stringify(b)}` : null;
    });
    if (toast) {
      throw new Error(`the toast overlaps the toolbar: ${toast}`);
    }
    const contents = () => page.evaluate(() => ({
      hidden: document.body.classList.contains('toc-hidden'),
      side: !!document.querySelector('.side').getClientRects().length,
      left: Math.round(document.querySelector('main').getBoundingClientRect().left),
      pressed: document.getElementById('toc-btn').getAttribute('aria-pressed'),
    }));
    let c = await contents();
    if (c.hidden || !c.side || c.pressed !== 'true') {
      throw new Error(`the contents do not show by default: ${JSON.stringify(c)}`);
    }
    await page.locator('#toc-btn').click();
    c = await contents();
    if (!c.hidden || c.side || c.left >= 40 || c.pressed !== 'false') {
      throw new Error(`Contents did not hide the sidebar and widen the book: ${JSON.stringify(c)}`);
    }
    const centered = await page.evaluate(() => {
      const r = document.getElementById('review-tools').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect();
      return Math.round(Math.abs((r.left + r.right) / 2 - (m.left + m.right) / 2));
    });
    if (centered > 2) {
      throw new Error(`with the contents hidden the toolbar is ${centered} px off the book's center`);
    }
    await open();
    c = await contents();
    if (!c.hidden || c.side) {
      throw new Error(`a reload showed the hidden contents again: ${JSON.stringify(c)}`);
    }
    // On a phone the hidden sidebar means nothing: the button still opens the sheet. Wide again, it is still hidden.
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.locator('#toc-btn').click();
      await page.waitForSelector('body.toc-open .side', { state: 'visible', timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('toc-open'), null, { timeout: 3000 });
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
    c = await contents();
    if (!c.hidden || c.side) {
      throw new Error(`back on a desktop the contents came back: ${JSON.stringify(c)}`);
    }
    await page.locator('#toc-btn').click();
    c = await contents();
    if (c.hidden || !c.side || c.pressed !== 'true') {
      throw new Error(`Contents did not show the sidebar again: ${JSON.stringify(c)}`);
    }
  });

  await check('on a phone the Contents button opens the contents as a tall sheet that jumps and closes', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      if (!(await page.locator('#book-title').isVisible())) {
        throw new Error('the header does not show the book\'s title on a phone');
      }
      // Earlier checks leave "show only changes" on, which hides the unchanged sections.
      if ((await page.locator('#changes-btn').getAttribute('aria-pressed')) === 'true') {
        await page.locator('#changes-btn').click();
      }
      await page.waitForSelector('#todos-add', { state: 'visible', timeout: 3000 });
      await page.evaluate(() => document.getElementById('todos-add').scrollIntoView({ behavior: 'instant' }));
      await page.waitForTimeout(200);
      await page.locator('#toc-btn').click();
      await page.waitForSelector('body.toc-open .side', { state: 'visible', timeout: 3000 });
      const sheet = await page.evaluate(() => {
        const s = document.querySelector('.side');
        const r = s.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), scrolls: s.scrollHeight > s.clientHeight, here: document.querySelector('.side .sb-here')?.getAttribute('href') };
      });
      if (sheet.scrolls && sheet.top > 70) {
        throw new Error(`the sheet scrolls but starts ${sheet.top} px down; it should be as tall as the screen allows`);
      }
      if (sheet.top < 40 || sheet.bottom > 844) {
        throw new Error(`the sheet runs ${sheet.top}..${sheet.bottom}: it must leave a strip of the book and fit the screen`);
      }
      if (sheet.here !== '#todos-add') {
        throw new Error(`the contents mark ${sheet.here} as where you are`);
      }
      await page.locator('.side a[href="#filters-bar"]').click();
      await page.waitForFunction(() => !document.body.classList.contains('toc-open'), null, { timeout: 3000 });
      await page.locator('#toc-btn').click();
      await page.waitForSelector('body.toc-open', { timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('toc-open'), null, { timeout: 3000 });
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
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

  // Sections draw the states they show, from the book's one catalog of screens; a component placed in a picture is
  // drawn from its own state, never copied.
  const LIST = 'SCR-3WRX.list';
  const BAR = 'SCR-Y6S2';
  await check('a section draws the states it shows, with components placed by name', async () => {
    await open();
    const seen = await page.evaluate(({ list, bar }) => {
      const fig = document.querySelector(`#todos-list figure.state[data-key="${list}"]`);
      if (!fig) { return null; }
      const hosts = [...fig.querySelectorAll('.mock')];
      const proposed = hosts.find(h => h.dataset.mockup.endsWith('/list.html'));
      const today = hosts.find(h => h.dataset.mockup.endsWith('/list.today.html'));
      const placed = [...document.querySelectorAll('.mock')].flatMap(h => [...h.shadowRoot.querySelectorAll(`.sb-component[data-key^="${bar}."]`)].map(c => c.dataset.key));
      const added = document.querySelector('#filters-bar figure.state[data-key="SCR-3WRX.activeonly"] figcaption');
      return {
        caption: fig.querySelector('figcaption').textContent,
        role: fig.querySelector('figcaption .role')?.textContent,
        labels: [...fig.querySelectorAll('.state-pane-label')].map(e => e.textContent),
        inProposed: proposed ? !!proposed.shadowRoot.querySelector(`.sb-component[data-key="${bar}.all"]`) : false,
        inToday: today ? !!today.shadowRoot.querySelector('.sb-component') : null,
        display: proposed ? getComputedStyle(proposed.shadowRoot.querySelector('.sb-component')).display : '',
        placed,
        newTag: added ? !!added.querySelector('.tag.new') : false,
      };
    }, { list: LIST, bar: BAR });
    if (!seen || !seen.caption.includes('TodosScreen · List') || seen.role !== 'User' || seen.labels.join() !== 'Today,Proposed' ||
      !seen.inProposed || seen.inToday !== false || seen.display !== 'contents' || !seen.newTag) {
      throw new Error(`the list state is not drawn as expected: ${JSON.stringify(seen)}`);
    }
    // Once per showing: the proposed list places All, Active only places Active. Its markup lives in one file only.
    if (seen.placed.sort().join() !== `${BAR}.active,${BAR}.all`) {
      throw new Error(`the filter bar is drawn ${JSON.stringify(seen.placed)}`);
    }
    const barHtml = readFileSync(join(data, 'mockups', 'screens', BAR, 'all.html'), 'utf8').trim();
    const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const copies = walk(join(data, 'mockups')).filter(f => f.endsWith('.html') && readFileSync(f, 'utf8').includes(barHtml));
    if (copies.length !== 1) {
      throw new Error(`the filter bar's markup is in ${copies.length} files: ${copies.join(', ')}`);
    }
  });

  await check('a note dropped on a placed component goes on that component\'s state, in the section it was dropped in', async () => {
    await waitFor(async () => (await fetch(`${URL}api/book`).then(r => r.json())).claude.state === 'idle', 5000, 'Claude to be idle');
    await open();
    const at = await page.evaluate(({ list, bar }) => {
      const host = [...document.querySelectorAll(`#todos-list figure.state[data-key="${list}"] .mock`)].find(h => h.dataset.mockup.endsWith('/list.html'));
      // The wrapper is display: contents (no box of its own): its first child is the bar.
      const comp = host.shadowRoot.querySelector(`.sb-component[data-key="${bar}.all"]`);
      comp.firstElementChild.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = comp.firstElementChild.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { list: LIST, bar: BAR });
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('.sticky.editing textarea');
    await page.keyboard.type('Make the filters bigger');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const note = await waitFor(() => Object.values(readNotesFile().notes).find(n => n.text === 'Make the filters bigger'), 3000, 'review.json to hold the note');
    if (note.item !== `${BAR}.all` || note.section !== 'todos-list' || note.target !== LIST) {
      throw new Error(`the note is not on the filter bar's state: ${JSON.stringify(note)}`);
    }
    // Deleted again, so the checks that count notes are not changed.
    const on = await page.evaluate(() => {
      const x = [...document.querySelectorAll('.sticky')].find(e => e.querySelector('textarea').value === 'Make the filters bigger');
      const r = x.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(on.x, on.y);
    await page.waitForSelector('.sticky.selected:not(.editing)', { timeout: 3000 });
    await page.keyboard.press('Backspace');
    await waitFor(() => !Object.values(readNotesFile().notes).some(n => n.text === 'Make the filters bigger'), 3000, 'the note to leave review.json');
  });

  await check('a requirement about a screen shows a chip linking to it', async () => {
    await open();
    const chips = await page.evaluate(() => ['TOD-LGXT', 'FLT-36VG'].map(id => [...document.querySelectorAll(`li#${id} a.screen-chip`)].map(a => [a.textContent, a.getAttribute('href')])));
    if (JSON.stringify(chips) !== JSON.stringify([[['TodosScreen · Empty', '#screen/SCR-3WRX.empty']], [['FiltersBar', '#screen/SCR-Y6S2']]])) {
      throw new Error(`the chips are ${JSON.stringify(chips)}`);
    }
  });

  // In its own page, with the book changed on the way in: a state drawn as another, one a role never sees, a screenshot,
  // and chips naming a screen and a state that are not in the book.
  await check('same-as, absent, screenshots by state key, and a chip to something missing', async () => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    try {
      const p = await ctx.newPage();
      p.on('pageerror', e => pageErrors.push(String(e)));
      await p.route('**/api/book', async route => {
        const r = await route.fetch();
        const j = await r.json();
        const todos = j.book.screens.find(s => s.id === 'SCR-3WRX');
        todos.states.push({ id: 'mirror', name: 'Mirror', when: { role: 'user' }, sameAs: 'empty' }, { id: 'gone', name: 'Gone', when: { role: 'user' }, absent: 'Never seen by anyone.' });
        const add = j.book.chapters.find(c => c.id === 'todos').sections.find(s => s.id === 'add');
        add.shows = [...add.shows, { state: 'SCR-3WRX.mirror' }, { state: 'SCR-3WRX.gone' }, { state: 'SCR-ZZZZ.none' }];
        add.requirements[0].screens = [{ screen: 'SCR-ZZZZ' }, { screen: 'SCR-3WRX', state: 'nope' }];
        j.media = [...(j.media || []), 'media/screens/SCR-3WRX.typing.png'];
        await route.fulfill({ response: r, json: j });
      });
      await p.route('**/data/media/screens/SCR-3WRX.typing.png*', route => route.fulfill({ status: 200, contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') }));
      await p.addInitScript(() => localStorage.setItem('spec-book-view', 'both'));
      await p.goto(URL);
      await p.waitForSelector('#todos-add figure.state[data-key="SCR-3WRX.gone"]');
      const seen = await p.evaluate(() => {
        const fig = k => document.querySelector(`#todos-add figure.state[data-key="${k}"]`);
        const mirror = fig('SCR-3WRX.mirror');
        return {
          mirror: mirror.querySelector('figcaption').textContent,
          mirrorDraws: mirror.querySelector('.mock')?.dataset.mockup,
          gone: fig('SCR-3WRX.gone').textContent,
          goneMock: !!fig('SCR-3WRX.gone').querySelector('.mock'),
          missing: fig('SCR-ZZZZ.none')?.textContent || '',
          shot: fig('SCR-3WRX.typing').querySelector('img.shot')?.getAttribute('src'),
          chips: [...document.querySelectorAll('#todos-add .reqs li a.screen-chip')].map(a => [a.textContent, a.classList.contains('missing')]),
        };
      });
      const bad = [];
      if (!seen.mirror.includes('TodosScreen · Mirror') || !seen.mirror.includes('Same as Empty') || seen.mirrorDraws !== 'mockups/screens/SCR-3WRX/empty.html') { bad.push(`sameAs: ${seen.mirror} drawing ${seen.mirrorDraws}`); }
      if (!seen.gone.includes('Never seen by anyone.') || seen.goneMock) { bad.push(`absent: ${seen.gone}`); }
      if (!seen.missing.includes('Missing')) { bad.push(`a missing state: ${JSON.stringify(seen.missing)}`); }
      if (seen.shot !== '/data/media/screens/SCR-3WRX.typing.png') { bad.push(`screenshot: ${seen.shot}`); }
      if (JSON.stringify(seen.chips) !== JSON.stringify([['SCR-ZZZZ · missing', true], ['TodosScreen · nope · missing', true]])) { bad.push(`chips: ${JSON.stringify(seen.chips)}`); }
      if (pageErrors.length) { bad.push(`page errors: ${pageErrors.join('; ')}`); }
      if (bad.length) { throw new Error(bad.join('; ')); }
    } finally {
      await ctx.close();
    }
  });

  await check('on a phone every drawn state fits the screen, today and proposed one above the other', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      await page.waitForTimeout(300);
      const seen = await page.evaluate(list => {
        const w = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('figure.state')].filter(f => f.getClientRects().length)
          .map(f => [f.dataset.key, Math.ceil(f.getBoundingClientRect().right)]).filter(x => x[1] > w);
        const panes = [...document.querySelectorAll(`#todos-list figure.state[data-key="${list}"] .state-pane`)].map(e => e.getBoundingClientRect());
        return { w, wide, stacked: panes.length === 2 && panes[1].top >= panes[0].bottom };
      }, LIST);
      if (seen.wide.length || !seen.stacked) {
        throw new Error(`on a ${seen.w}-pixel screen: ${JSON.stringify(seen)}`);
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  });

  // On the website (window.SpecShare set by share.js) the book's HTML is someone else's: book.js cleans it before it is
  // drawn. Here a stand-in SpecShare is set before the reader runs, the book's lede and one mockup carry every trick,
  // and nothing may run or survive. A localhost page, without SpecShare, draws the same HTML as it is.
  await check('clean() strips scripts, handlers and javascript: URLs when shared', async () => {
    const LEDE = 'Lede <img id="x-img" src="/no-such.png" onerror="window.__pwned=1">' +
      '<a id="x-js" href=" java\tscript:window.__pwned=2">a</a><a id="x-ctl" href="java&#x0A;script:window.__pwned=3">b</a>' +
      '<a id="x-ok" href="#top">ok</a><form id="x-form" action="javascript:window.__pwned=4"><button id="x-fa" formaction="javascript:1">f</button></form>';
    const MOCK = '<p id="m-kept" style="color:red">kept</p><script>window.__pwned=5</script><iframe id="m-ifr" srcdoc="x"></iframe>' +
      '<object id="m-obj"></object><embed id="m-emb"><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">' +
      '<link rel="import" href="/x.html"><frame id="m-frame">' +
      '<svg><a id="m-svga" xlink:href="javascript:window.__pwned=6"><text>t</text>' +
      '<set id="m-set" attributeName="href" to="javascript:window.__pwned=7"/>' +
      '<animate id="m-anim" attributeName="xlink:href" values="#;javascript:window.__pwned=8"/></a>' +
      '<rect><animate id="m-fill" attributeName="fill" values="red; javascript:window.__pwned=9" dur="1s"/></rect></svg>' +
      '<button id="m-btn" onclick="window.__pwned=10" formaction="javascript:window.__pwned=11">b</button>' +
      '<template><img id="m-tpl" src="/no-such.png" onerror="window.__pwned=12"></template>';
    const MOCK_PATH = 'mockups/screens/SCR-3WRX/empty.html';
    const draw = async shared => {
      const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1400, height: 900 } });
      const p = await ctx.newPage();
      if (shared) {
        await p.addInitScript(() => {
          const no = () => {};
          window.SpecShare = { protocol: 3, me: { name: 'Owner' }, role: 'owner', ownerName: 'Owner', ready: Promise.resolve(),
            request: () => new Promise(no), send: () => false, onLive: no, onPeerState: no, onChanged: no, status: no, showError: no };
        });
      }
      await p.route('**/api/book', async route => {
        const r = await route.fetch();
        const j = await r.json();
        j.book.lede = LEDE;
        await route.fulfill({ response: r, json: j });
      });
      await p.route(`**/data/${MOCK_PATH}*`, route => route.fulfill({ status: 200, contentType: 'text/html', body: MOCK }));
      await p.goto(URL);
      await p.waitForSelector('#todos-list > h3');
      await p.waitForFunction(m => { const h = document.querySelector(`[data-mockup="${m}"]`); return h && h.shadowRoot && h.shadowRoot.getElementById('m-kept'); }, MOCK_PATH, { timeout: 5000 });
      await sleep(300);
      const got = await p.evaluate(m => {
        const sr = document.querySelector(`[data-mockup="${m}"]`).shadowRoot;
        const at = (root, id, a) => { const e = root.getElementById ? root.getElementById(id) : root.querySelector('#' + id); return e ? e.getAttribute(a) : 'gone'; };
        const has = s => !!sr.querySelector(s);
        const tpl = sr.querySelector('template');
        return {
          pwned: window.__pwned,
          imgOnerror: at(document, 'x-img', 'onerror'), js: at(document, 'x-js', 'href'), ctl: at(document, 'x-ctl', 'href'), ok: at(document, 'x-ok', 'href'),
          action: at(document, 'x-form', 'action'), fa: at(document, 'x-fa', 'formaction'),
          kept: !!sr.getElementById('m-kept'), style: has('style'),
          dropped: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link[rel=import]', 'frame', '#m-set', '#m-anim'].filter(has),
          svga: at(sr, 'm-svga', 'xlink:href'), fill: at(sr, 'm-fill', 'values'), fillKept: has('#m-fill'),
          btn: at(sr, 'm-btn', 'onclick'), btnFa: at(sr, 'm-btn', 'formaction'),
          tpl: tpl && tpl.content.querySelector('#m-tpl') ? tpl.content.querySelector('#m-tpl').getAttribute('onerror') : 'gone',
        };
      }, MOCK_PATH);
      await ctx.close();
      return got;
    };
    const s = await draw(true);
    const bad = [];
    if (s.pwned !== undefined) { bad.push(`book HTML ran (__pwned=${s.pwned})`); }
    for (const [k, v] of Object.entries({ imgOnerror: s.imgOnerror, js: s.js, ctl: s.ctl, action: s.action, fa: s.fa, svga: s.svga, fill: s.fill, btn: s.btn, btnFa: s.btnFa, tpl: s.tpl })) {
      if (v !== null) { bad.push(`${k} kept ${JSON.stringify(v)}`); }
    }
    if (s.ok !== '#top') { bad.push(`a # link lost its href (${s.ok})`); }
    if (s.dropped.length) { bad.push(`still there: ${s.dropped.join(', ')}`); }
    if (!s.kept || !s.style || !s.fillKept) { bad.push('cleaning removed what it should keep (styled text, the mockup <style>, a harmless <animate>)'); }
    // On localhost the owner's own book is drawn as it is.
    const l = await draw(false);
    if (l.imgOnerror !== 'window.__pwned=1' || !l.dropped.includes('#m-set')) { bad.push(`localhost changed the book's HTML: ${JSON.stringify(l)}`); }
    if (bad.length) { throw new Error(bad.join('; ')); }
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
