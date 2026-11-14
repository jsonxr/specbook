#!/usr/bin/env node
// Smoke test for sharing a book: the share server (wrangler dev), the owner's book tab as host, and a guest page,
// talking over WebRTC.
//
//   GLOBAL_ROOT=$(npm root -g)/playwright node plugins/specbook/test/share.smoke.mjs
//
// Needs wrangler on the PATH and the share server's code (SHARE_SERVER, by default server/ in this
// repository). Copies starter/ to a temp folder, serves it on port 4296, runs the share server on 8798, and drives an
// owner page and a guest page in Chromium.
// Exits 1 when any check fails.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const PORT = 4296;
const OWNER = `http://localhost:${PORT}/`;
const BROKER = 'http://127.0.0.1:8798';
const SHARE_SERVER = process.env.SHARE_SERVER ?? resolve(PLUGIN, '..', 'server');
if (!existsSync(join(SHARE_SERVER, 'wrangler.jsonc'))) {
  console.error(`No share server at ${SHARE_SERVER}; set SHARE_SERVER.`);
  process.exit(2);
}

const data = mkdtempSync(join(tmpdir(), 'specbook-share-'));
cpSync(join(PLUGIN, 'starter'), data, { recursive: true });
// An image inside a mockup (a shadow root), as a book's logo is: guests load it over the channel.
mkdirSync(join(data, 'mockups', 'assets'), { recursive: true });
writeFileSync(join(data, 'mockups', 'assets', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
appendFileSync(join(data, 'mockups', 'todos-list-1.html'), '<img class="probe" src="/data/mockups/assets/dot.png" alt="">');
// The book shares through the local share server.
const bookFile = join(data, 'book.json');
const bookJson = JSON.parse(readFileSync(bookFile, 'utf8'));
bookJson.settings = { ...(bookJson.settings ?? {}), shareBroker: BROKER };
writeFileSync(bookFile, JSON.stringify(bookJson, null, 2));

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
const up = url => fetch(url).then(r => r.status < 500, () => false);
function review() {
  const file = join(data, 'review.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { notes: {} };
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

const children = [];
function run(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  children.push(p);
  return p;
}

// Detached, so it records its port in .server.json the way share.mjs looks for it; stopped at the end.
const serve = (...args) => new Promise(done => spawn(process.execPath, [join(PLUGIN, 'server', 'serve.mjs'), '--data', data, ...args], { stdio: 'ignore' }).on('exit', done));
await serve('--port', String(PORT), '--detach');
// Its own state each run, so earlier runs' rooms do not count against the rate limit.
const brokerState = mkdtempSync(join(tmpdir(), 'specbook-share-state-'));
const broker = run('wrangler', ['dev', '--port', '8798', '--ip', '127.0.0.1', '--show-interactive-dev-session=false', '--persist-to', brokerState], { cwd: SHARE_SERVER });
let brokerLog = '';
broker.stdout.on('data', d => { brokerLog += d; });
broker.stderr.on('data', d => { brokerLog += d; });
let host;
let browser;
const errors = [];
try {
  await waitFor(() => up(`${OWNER}api/health`), 5000, 'the book server');
  await waitFor(() => up(`${BROKER}/`), 60000, 'the broker (wrangler dev)').catch(e => {
    throw new Error(`${e.message}\n${brokerLog}`);
  });
  // Both pages run in one headless browser, which cannot resolve the mDNS names Chrome hides local addresses behind.
  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guest = await guestCtx.newPage();
  guest.on('pageerror', e => errors.push(`guest: ${e.message}`));
  guest.on('console', m => { if (m.type() === 'error') { errors.push(`guest: ${m.text()}`); } });
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  owner.on('pageerror', e => errors.push(`owner: ${e.message}`));
  owner.on('console', m => { if (m.type() === 'error') { errors.push(`owner: ${m.text()}`); } });
  // The owner's open tab hosts the share.
  await owner.goto(OWNER);
  await owner.waitForSelector('#todos-list');
  await waitFor(async () => (await (await fetch(`${OWNER}api/share`)).json()).tabs > 0, 5000, 'the owner tab to listen');
  host = run(process.execPath, [join(PLUGIN, 'server', 'share.mjs'), '--data', data, '--hours', '1']);
  let hostLog = '';
  host.stdout.on('data', d => { hostLog += d; });
  host.stderr.on('data', d => { hostLog += d; });
  const link = await waitFor(() => /Sharing at (\S+)/.exec(hostLog)?.[1], 15000, 'the share link').catch(e => {
    throw new Error(`${e.message}\n${hostLog}`);
  });
  await owner.waitForFunction(() => /^Sharing · 0 guests$/.test(document.querySelector('.share-count')?.textContent ?? ''), null, { timeout: 5000 });

  await check('a guest names themself, connects, and reads the live book', async () => {
    await guest.goto(link);
    await guest.waitForSelector('.share-join input', { timeout: 5000 });
    await guest.fill('.share-join input', 'Ann');
    await guest.click('.share-join button');
    await guest.waitForSelector('#todos-list', { timeout: 20000 }).catch(async e => {
      throw new Error(`${e.message}\nchip: ${await guest.evaluate(() => document.querySelector('.share-chip')?.textContent)}\nbody: ${(await guest.evaluate(() => document.body.innerHTML)).slice(0, 400)}`);
    });
    await guest.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 5000 });
    if (await guest.evaluate(() => location.hash) !== '') {
      throw new Error('the link key stayed in the address');
    }
  });

  await check('a guest sees images from the book, in the page and inside mockups', async () => {
    await guest.waitForFunction(() => [...document.querySelectorAll('.mock')].some(m => {
      const img = m.shadowRoot && m.shadowRoot.querySelector('img.probe');
      return img && img.complete && img.naturalWidth === 1;
    }), null, { timeout: 8000 });
    await guest.evaluate(() => {
      const img = document.createElement('img');
      img.id = 'page-probe';
      img.src = '/data/mockups/assets/dot.png';
      document.body.appendChild(img);
    });
    await guest.waitForFunction(() => document.getElementById('page-probe').naturalWidth === 1, null, { timeout: 5000 });
  });

  await check('a guest sees no Claude controls, and the host refuses Revise and Accept', async () => {
    const shown = await guest.evaluate(() => [...document.querySelectorAll('.bar-group.claude, .rv-acts, .stage-btn')].some(e => e.offsetParent !== null));
    if (shown) {
      throw new Error('an owner-only control is showing');
    }
    const statuses = await guest.evaluate(async () => Promise.all([
      fetch('/api/revise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"items":[{"note":"x"}]}' }).then(r => r.status),
      fetch('/api/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"x"}' }).then(r => r.status),
      fetch('/api/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status),
    ]));
    if (statuses.some(s => s !== 403)) {
      throw new Error(`expected 403s, got ${statuses}`);
    }
    if (existsSync(join(data, 'requests'))) {
      throw new Error('a guest wrote a request');
    }
    // A path that would turn into another host in the host tab's fetch is refused there.
    const tricks = await guest.evaluate(async () => Promise.all(['/\\127.0.0.1:9/app/x', '/\t/127.0.0.1:9/app/x', '//127.0.0.1:9/app/x', '/\n/127.0.0.1:9/data/x']
      .map(p => window.SpecShare.request('GET', p).then(r => r.status))));
    if (tricks.some(s => s !== 403)) {
      throw new Error(`a host-changing path was not refused: ${tricks}`);
    }
  });

  const spot = page => page.evaluate(() => {
    const h = document.querySelector('#todos-list > h3');
    h.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = h.getBoundingClientRect();
    return { x: r.left + Math.min(200, r.width / 2), y: r.top + r.height / 2 };
  });
  const comment = async (page, text) => {
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    const at = await spot(page);
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('.note-pop.composer textarea');
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
  };

  await check('a guest\'s note is saved as theirs, and the owner sees it with their name', async () => {
    await comment(guest, 'From Ann over WebRTC');
    const saved = await waitFor(() => Object.values(review().notes).find(n => n.text === 'From Ann over WebRTC'), 5000, 'review.json to hold the guest note');
    if (saved.author !== 'Ann' || !saved.authorKey) {
      throw new Error(`the note is not Ann's: ${JSON.stringify(saved)}`);
    }
    const seen = await guest.evaluate(async () => Object.values((await (await fetch('/api/book')).json()).review.notes));
    if (seen.some(n => 'authorKey' in n) || !seen.some(n => n.mine && n.author === 'Ann')) {
      throw new Error(`a guest sees note keys, or not their own: ${JSON.stringify(seen)}`);
    }
    await owner.waitForFunction(() => /^Sharing · 1 guest$/.test(document.querySelector('.share-count')?.textContent ?? ''), null, { timeout: 5000 }).catch(async e => {
      throw new Error(`${e.message}: ${await owner.evaluate(() => document.querySelector('.share-host')?.outerHTML)}`);
    });
    await owner.waitForFunction(() => [...document.querySelectorAll('.sticky .st-by')].some(e => e.textContent === 'Ann'), null, { timeout: 8000 });
  });

  await check('the owner\'s note reaches the guest at once, marked Host, and the guest cannot change it', async () => {
    await comment(owner, 'From the owner');
    await waitFor(() => Object.values(review().notes).some(n => n.text === 'From the owner'), 5000, 'review.json to hold the owner note');
    await guest.waitForFunction(() => [...document.querySelectorAll('.sticky')].some(s => s.querySelector('textarea')?.value === 'From the owner' && s.classList.contains('not-mine') && s.querySelector('.st-by')?.textContent === 'Host'), null, { timeout: 4000 });
    // A forged save of the owner's note (as a modified page would send) is ignored by the server.
    const changed = await guest.evaluate(async () => {
      const b = await (await fetch('/api/book')).json();
      const notes = {};
      for (const [id, n] of Object.entries(b.review.notes)) {
        if (n.status === 'draft') {
          notes[id] = { ...n, text: n.author ? n.text : 'hijacked' };
        }
      }
      return (await fetch('/api/notes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: b.review.rev, notes }) })).status;
    });
    if (changed !== 200) {
      throw new Error(`the save answered ${changed}`);
    }
    if (Object.values(review().notes).some(n => n.text === 'hijacked')) {
      throw new Error('a guest changed the owner\'s note');
    }
  });

  await check('a link with the wrong key does not connect', async () => {
    const bad = await (await browser.newContext()).newPage();
    await bad.addInitScript(() => localStorage.setItem('specbook-guest-name', 'Eve'));
    await bad.goto(link.replace(/#.*/, `#${'A'.repeat(43)}`));
    await bad.waitForFunction(() => /not valid/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 15000 });
    if (await bad.locator('#todos-list').count()) {
      throw new Error('the book loaded with a forged key');
    }
  });

  await check('status names the guests; closing the owner\'s tab ends the share', async () => {
    const status = await new Promise(done => {
      let out = '';
      const p = spawn(process.execPath, [join(PLUGIN, 'server', 'share.mjs'), '--data', data, '--status']);
      p.stdout.on('data', d => { out += d; });
      p.on('exit', () => done(out));
    });
    if (!/guests: Ann/.test(status)) {
      throw new Error(`status: ${status}`);
    }
    await owner.close();
    await guest.waitForFunction(() => document.querySelector('.share-chip')?.classList.contains('bad'), null, { timeout: 10000 });
    await waitFor(async () => (await (await fetch(`${OWNER}api/share`)).json()).state === 'idle', 5000, 'the share to end on the server');
  });

  await check('no page errors', async () => {
    if (errors.length) {
      throw new Error(errors.join('\n'));
    }
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e && e.message ? e.message : e}`);
} finally {
  await browser?.close();
  for (const p of children) {
    p.kill();
  }
  await serve('--stop');
  await sleep(300);
  rmSync(data, { recursive: true, force: true });
  rmSync(brokerState, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
