#!/usr/bin/env node
// Smoke test for sharing a book: the share server (wrangler dev), the owner's book tab as host, and a guest page,
// talking over WebRTC: always-on sharing, live typing, following, a lasting link, and New link.
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
// More mockups than the host answers for one guest at once, as a real book has.
const due = bookJson.chapters.flatMap(c => c.sections).find(s => s.id === 'due');
due.frames = Array.from({ length: 30 }, (_, i) => ({ id: `later-due-${i + 1}`, caption: `Extra ${i + 1}`, mockup: `mockups/extra-${i + 1}.html` }));
due.frames.forEach((f, i) => writeFileSync(join(data, f.mockup), `<div class="phone"><p>Extra ${i + 1}</p></div>`));
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

// Detached, the way /specbook:open starts it; stopped at the end.
const serve = (...args) => new Promise(done => spawn(process.execPath, [join(PLUGIN, 'server', 'serve.mjs'), '--data', data, ...args], { stdio: 'ignore' }).on('exit', done));
await serve('--port', String(PORT), '--detach');
// Its own state each run, so earlier runs' rooms do not count against the rate limit.
const brokerState = mkdtempSync(join(tmpdir(), 'specbook-share-state-'));
const broker = run('wrangler', ['dev', '--port', '8798', '--ip', '127.0.0.1', '--show-interactive-dev-session=false', '--persist-to', brokerState], { cwd: SHARE_SERVER });
let brokerLog = '';
broker.stdout.on('data', d => { brokerLog += d; });
broker.stderr.on('data', d => { brokerLog += d; });
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
  // The tab shares by itself, with nothing run in the terminal.
  const link = await waitFor(async () => {
    const v = await (await fetch(`${OWNER}api/share`)).json();
    return v.state === 'live' && v.url;
  }, 15000, 'the share link').catch(async e => {
    throw new Error(`${e.message}\nshare: ${JSON.stringify(await (await fetch(`${OWNER}api/share`)).json())}\nerrors: ${errors.join('\n')}`);
  });
  await owner.waitForFunction(() => document.querySelector('.share-pill .share-solo')?.textContent === 'Only you', null, { timeout: 5000 });
  const ownerName = await owner.evaluate(() => window.SpecBook.me().name);

  await check('a guest names themself, connects, and reads the live book', async () => {
    await guest.goto(link);
    await guest.waitForSelector('.share-join input', { timeout: 5000 });
    await guest.fill('.share-join input', 'Ann');
    await guest.click('.share-join button');
    await guest.waitForSelector('#todos-list', { timeout: 20000 }).catch(async e => {
      throw new Error(`${e.message}\nchip: ${await guest.evaluate(() => document.querySelector('.share-chip')?.textContent)}\nbody: ${(await guest.evaluate(() => document.body.innerHTML)).slice(0, 400)}`);
    });
    await guest.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 5000 });
    if (await guest.locator('.share-chip').isVisible()) {
      throw new Error('the status chip still shows once the guest is live');
    }
    if (await guest.evaluate(() => location.hash) !== '') {
      throw new Error('the link key stayed in the address');
    }
  });

  await check('a guest sees every mockup with the book\'s stylesheet, however many the book has', async () => {
    const seen = page => page.evaluate(() => [...document.querySelectorAll('[data-mockup]')].map(h => ({
      path: h.dataset.mockup,
      css: h.shadowRoot.querySelector('style').textContent.length,
      missing: !!h.shadowRoot.querySelector('.phone') === false,
    })));
    const mine = await seen(owner);
    const theirs = await seen(guest);
    const bad = theirs.filter(m => m.missing || m.css !== mine[0].css);
    if (theirs.length !== mine.length || mine.length < 30 || bad.length) {
      throw new Error(`owner ${mine.length} mockups (css ${mine[0]?.css}), guest ${theirs.length}; wrong: ${JSON.stringify(bad.slice(0, 3))}`);
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
  // `dx` moves the click along the heading, off a pin already there.
  const comment = async (page, text, dx = 0) => {
    await page.keyboard.press('c');
    await page.waitForSelector('body.commenting');
    const at = await spot(page);
    await page.mouse.click(at.x + dx, at.y);
    await page.waitForSelector('.sticky.editing textarea');
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
  };

  await check('a guest\'s note is saved as theirs, and the owner sees it, with no name on it', async () => {
    await comment(guest, 'From Ann over WebRTC');
    const saved = await waitFor(() => Object.values(review().notes).find(n => n.text === 'From Ann over WebRTC'), 5000, 'review.json to hold the guest note');
    if (saved.author !== 'Ann' || !saved.authorKey) {
      throw new Error(`the note is not Ann's: ${JSON.stringify(saved)}`);
    }
    const seen = await guest.evaluate(async () => Object.values((await (await fetch('/api/book')).json()).review.notes));
    if (seen.some(n => 'authorKey' in n) || !seen.some(n => n.mine && n.author === 'Ann')) {
      throw new Error(`a guest sees note keys, or not their own: ${JSON.stringify(seen)}`);
    }
    await owner.waitForFunction(() => document.querySelectorAll('.share-pill .face').length === 2, null, { timeout: 5000 }).catch(async e => {
      throw new Error(`${e.message}: ${await owner.evaluate(() => document.querySelector('.share-pill')?.outerHTML)}`);
    });
    await owner.waitForFunction(() => [...document.querySelectorAll('.sticky:not([hidden]) textarea')].some(t => t.value === 'From Ann over WebRTC'), null, { timeout: 8000 });
    if (await owner.locator('.sticky .st-by').count()) {
      throw new Error('a sticky names who wrote it');
    }
  });

  // The sticky with this text on a page: where it is, whether it shows, and whether its pin is turned by its arrow.
  const stickyOf = (page, text) => page.evaluate(t => {
    const st = [...document.querySelectorAll('.sticky')].find(x => x.querySelector('textarea').value === t);
    if (!st) {
      return null;
    }
    const k = /^Note (\d+) /.exec(st.getAttribute('aria-label') ?? '')?.[1];
    const pin = k && [...document.querySelectorAll('.pin')].find(p => (p.getAttribute('aria-label') || '').startsWith(`Note ${k} on`));
    return { left: parseFloat(st.style.left), top: parseFloat(st.style.top), hidden: st.hidden, turned: !!pin?.dataset.rot, ghosts: document.querySelectorAll('.sticky.ghost').length };
  }, text);
  // The middle of a sticky's left edge, scrolled into view.
  const stickySpot = (page, text) => page.evaluate(t => {
    const x = [...document.querySelectorAll('.sticky')].find(e => e.querySelector('textarea').value === t);
    x.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = x.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2 };
  }, text);

  await check('a guest\'s typing and moving show on the owner\'s sticky as they happen, arrow and all', async () => {
    // Ann edits her note (a click selects it, a second edits it): the owner sees each word on the note's own sticky.
    const box = await stickySpot(guest, 'From Ann over WebRTC');
    await guest.mouse.click(box.x, box.y);
    await guest.mouse.click(box.x, box.y);
    await guest.waitForSelector('.sticky.editing textarea');
    await guest.keyboard.type(' live', { delay: 30 });
    await owner.waitForFunction(() => [...document.querySelectorAll('.sticky:not([hidden]) textarea')].some(t => t.value === 'From Ann over WebRTC live'), null, { timeout: 3000 });
    const typed = await stickyOf(owner, 'From Ann over WebRTC live');
    if (typed.hidden || !typed.turned || typed.ghosts) {
      throw new Error(`the owner's sticky while Ann types: ${JSON.stringify(typed)}`);
    }
    await guest.keyboard.press('Enter');
    // Ann drags it 120 pixels right: the owner's sticky follows before she lets go.
    const before = await stickyOf(owner, 'From Ann over WebRTC live');
    const at = await stickySpot(guest, 'From Ann over WebRTC live');
    await guest.mouse.move(at.x, at.y);
    await guest.mouse.down();
    await guest.mouse.move(at.x + 60, at.y, { steps: 4 });
    await guest.mouse.move(at.x + 120, at.y, { steps: 4 });
    await owner.waitForFunction(([t, left]) => {
      const x = [...document.querySelectorAll('.sticky')].find(e => e.querySelector('textarea').value === t);
      return x && parseFloat(x.style.left) > left + 100;
    }, ['From Ann over WebRTC live', before.left], { timeout: 3000 }).catch(async e => {
      throw new Error(`${e.message}: before ${JSON.stringify(before)}, now ${JSON.stringify(await stickyOf(owner, 'From Ann over WebRTC live'))}, Ann's ${JSON.stringify(await stickyOf(guest, 'From Ann over WebRTC live'))}`);
    });
    const moving = await stickyOf(owner, 'From Ann over WebRTC live');
    await guest.mouse.up();
    if (moving.hidden || !moving.turned || moving.ghosts) {
      throw new Error(`the owner's sticky while Ann moves it: ${JSON.stringify(moving)}`);
    }
  });

  await check('the owner\'s note reaches the guest within a second, and the guest can change it', async () => {
    await comment(owner, 'From the owner', 80);
    const t0 = Date.now();
    await guest.waitForFunction(() => [...document.querySelectorAll('.sticky:not([hidden])')].some(s => s.querySelector('textarea')?.value === 'From the owner'), null, { timeout: 4000 });
    if (Date.now() - t0 > 1000) {
      throw new Error(`the owner's note took ${Date.now() - t0} ms to reach the guest`);
    }
    // Everyone collaborates on every note: Ann edits the owner's.
    const at = await stickySpot(guest, 'From the owner');
    await guest.mouse.click(at.x, at.y);
    await guest.mouse.click(at.x, at.y);
    await guest.waitForSelector('.sticky.editing textarea', { timeout: 3000 }).catch(async e => {
      throw new Error(`${e.message}\nat the click: ${await guest.evaluate(p => document.elementFromPoint(p.x, p.y)?.outerHTML.slice(0, 300), at)}\nlocked: ${await guest.evaluate(() => document.body.classList.contains('locked-notes'))}`);
    });
    await guest.keyboard.type(', and Ann');
    await guest.keyboard.press('Enter');
    await waitFor(() => Object.values(review().notes).some(n => n.text === 'From the owner, and Ann'), 5000, 'review.json to hold Ann\'s change to the owner\'s note');
    await owner.waitForFunction(() => [...document.querySelectorAll('.sticky textarea')].some(t => t.value === 'From the owner, and Ann'), null, { timeout: 5000 });
  });

  await check('a note\'s pin points at the same words for the owner and a guest, whatever their window width', async () => {
    // The owner's heading has Mark ready beside it and the guest's does not: the pins still sit on the same letters.
    const offsets = page => page.evaluate(() => [...document.querySelectorAll('#todos-list > h3 .pin')].map(x => [x.offsetLeft, x.offsetTop, x.getAttribute('aria-label')]).sort((p, q) => p[0] - q[0] || p[1] - q[1]));
    const mine = await offsets(owner), theirs = await offsets(guest);
    if (!mine.length || JSON.stringify(mine) !== JSON.stringify(theirs)) {
      throw new Error(`pins on the heading: owner ${JSON.stringify(mine)}, guest ${JSON.stringify(theirs)}; stored ${JSON.stringify(Object.values(review().notes).filter(n => n.status === 'draft').map(n => [n.text, n.pin]))}; heading text owner ${JSON.stringify(await owner.evaluate(() => document.querySelector('#todos-list > h3').textContent))} guest ${JSON.stringify(await guest.evaluate(() => document.querySelector('#todos-list > h3').textContent))}`);
    }
    // A note on a word in a requirement, read in a narrower window where the line wraps elsewhere.
    await owner.keyboard.press('c');
    await owner.waitForSelector('body.commenting');
    const at = await owner.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf('keeps that place');
        if (i >= 0) {
          n.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = document.createRange();
          r.setStart(n, i + 6);
          r.setEnd(n, i + 10);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
      }
      return null;
    });
    if (!at) {
      throw new Error('no requirement says "keeps that place"');
    }
    await owner.mouse.click(at.x, at.y);
    await owner.waitForSelector('.sticky.editing textarea');
    await owner.keyboard.type('On that word');
    await owner.keyboard.press('Enter');
    await owner.keyboard.press('Escape');
    await guest.setViewportSize({ width: 700, height: 900 });
    await guest.waitForFunction(() => [...document.querySelectorAll('.sticky:not(.ghost):not([hidden]) textarea')].some(t => t.value === 'On that word'), null, { timeout: 15000 });
    // The word under the pin's point of the note with this text.
    const wordUnder = page => page.evaluate(text => {
      const st = [...document.querySelectorAll('.sticky:not(.ghost)')].find(s => s.querySelector('textarea').value === text);
      const label = /^Note (\d+) /.exec(st?.getAttribute('aria-label') ?? '');
      if (!label) {
        return `no shown sticky (${st ? `hidden ${st.hidden}, label ${st.getAttribute('aria-label')}` : 'none'})`;
      }
      const k = label[1];
      const pin = [...document.querySelectorAll('.pin')].find(p => (p.getAttribute('aria-label') || '').startsWith(`Note ${k} on`));
      pin.scrollIntoView({ block: 'center', behavior: 'instant' });
      // The pin's point: its box's bottom-left corner (bottom-right when flipped), whatever way it is turned.
      const t = pin.parentElement.getBoundingClientRect();
      const x = t.left + pin.parentElement.clientLeft + pin.offsetLeft + (pin.classList.contains('flip') ? pin.offsetWidth : 0);
      const y = t.top + pin.parentElement.clientTop + pin.offsetTop + pin.offsetHeight;
      document.body.classList.add('probe-hide');
      const style = document.createElement('style');
      style.textContent = '.probe-hide .pin, .probe-hide .note-layer { visibility: hidden !important; }';
      document.head.appendChild(style);
      const c = document.caretRangeFromPoint(x, y);
      style.remove();
      document.body.classList.remove('probe-hide');
      if (!c || c.startContainer.nodeType !== 3) {
        return null;
      }
      const s = c.startContainer.data;
      let a = c.startOffset, b = c.startOffset;
      while (a > 0 && /\w/.test(s[a - 1])) { a--; }
      while (b < s.length && /\w/.test(s[b])) { b++; }
      return s.slice(a, b);
    }, 'On that word');
    const words = [await wordUnder(owner), await wordUnder(guest)];
    await guest.setViewportSize({ width: 1280, height: 900 });
    if (words[0] !== 'that' || words[1] !== 'that') {
      throw new Error(`the pin points at "${words[0]}" for the owner and "${words[1]}" for a guest 700 pixels wide`);
    }
  });

  await check('following scrolls to the leader\'s place, and the follower\'s own scroll stops it', async () => {
    await guest.locator('.share-pill .face:not(.me)').first().click();
    await guest.waitForFunction(() => /^Following /.test(document.querySelector('.follow-chip')?.textContent ?? '') && !document.querySelector('.follow-chip').hidden, null, { timeout: 3000 });
    await owner.waitForFunction(() => document.body.classList.contains('followed'), null, { timeout: 3000 });
    await owner.evaluate(() => {
      const e = document.querySelector('#filters-bar > h3');
      const bar = document.querySelector('.bar').offsetHeight + 8;
      window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - bar, behavior: 'instant' });
    });
    await guest.waitForFunction(() => {
      const e = document.querySelector('#filters-bar > h3');
      const bar = document.querySelector('.bar').offsetHeight + 8;
      return Math.abs(e.getBoundingClientRect().top - bar) < 40;
    }, null, { timeout: 4000 });
    await guest.mouse.move(600, 500);
    await guest.mouse.wheel(0, 300);
    await guest.waitForFunction(() => document.querySelector('.follow-chip').hidden, null, { timeout: 3000 });
    await owner.waitForFunction(() => !document.body.classList.contains('followed'), null, { timeout: 3000 });
  });

  await check('a follower on a phone-width screen lands on the leader\'s place too', async () => {
    await guest.setViewportSize({ width: 390, height: 844 });
    try {
      await owner.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await guest.locator('.share-pill .face:not(.me)').first().click();
      await guest.waitForFunction(() => !document.querySelector('.follow-chip').hidden, null, { timeout: 3000 });
      await owner.evaluate(() => {
        const e = document.querySelector('#filters-bar > h3');
        const bar = document.querySelector('.bar').offsetHeight + 8;
        window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - bar, behavior: 'instant' });
      });
      await guest.waitForFunction(() => {
        const r = document.querySelector('#filters-bar > h3').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }, null, { timeout: 4000 });
      await guest.mouse.move(200, 400);
      await guest.mouse.wheel(0, 300);
      await guest.waitForFunction(() => document.querySelector('.follow-chip').hidden, null, { timeout: 3000 });
    } finally {
      await guest.setViewportSize({ width: 1280, height: 900 });
    }
  });

  await check('reloading the owner\'s tab keeps the link, and the guest reconnects', async () => {
    await owner.reload();
    await owner.waitForSelector('#todos-list');
    await waitFor(async () => (await (await fetch(`${OWNER}api/share`)).json()).state === 'live', 8000, 'the share to be live again');
    const now = (await (await fetch(`${OWNER}api/share`)).json()).url;
    if (now !== link) {
      throw new Error(`the link changed on reload: ${link} -> ${now}`);
    }
    await guest.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 20000 });
    await owner.waitForFunction(() => document.querySelectorAll('.share-pill .face').length === 2, null, { timeout: 8000 });
  });

  await check('the same guest in a second tab is not asked their name, both tabs stay live, and they are one face', async () => {
    const second = await guestCtx.newPage();
    second.on('pageerror', e => errors.push(`guest2: ${e.message}`));
    try {
      await second.goto(link);
      await second.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 20000 });
      if (await second.locator('.share-join input').count()) {
        throw new Error('the second tab asked for a name again');
      }
      await sleep(1500);
      const first = await guest.evaluate(() => ({ live: /Live/.test(document.querySelector('.share-chip')?.textContent ?? ''), kicked: !!document.querySelector('.share-kicked') }));
      if (!first.live || first.kicked) {
        throw new Error(`the first tab was let go: ${JSON.stringify(first)}`);
      }
      const people = await owner.evaluate(() => window.SpecHost.people().length);
      const faces = await owner.evaluate(() => document.querySelectorAll('.share-pill .face').length);
      if (people !== 2 || faces !== 2) {
        throw new Error(`two tabs of Ann made ${people} people and ${faces} faces`);
      }
    } finally {
      await second.close({ runBeforeUnload: true });
    }
    // Closing one tab leaves Ann here, live in the other.
    await sleep(1500);
    const still = await owner.evaluate(() => window.SpecHost.people().map(p => p.name));
    if (!still.includes('Ann')) {
      throw new Error(`closing one of Ann's tabs took her out: ${JSON.stringify(still)}`);
    }
    if (!(await guest.evaluate(() => /Live/.test(document.querySelector('.share-chip')?.textContent ?? '')))) {
      throw new Error('the first tab is not live after the second closed');
    }
  });

  await check('another guest cannot clear what someone else is typing in a note', async () => {
    const bob = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    bob.on('pageerror', e => errors.push(`bob: ${e.message}`));
    try {
      await bob.addInitScript(() => localStorage.setItem('specbook-guest-name', 'Bob'));
      await bob.goto(link);
      await bob.waitForFunction(() => /Live · Bob/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 20000 });
      await owner.waitForFunction(() => window.SpecHost.people().length === 3, null, { timeout: 5000 });
      const [id, n] = Object.entries(review().notes).find(([, x]) => x.text.startsWith('From Ann over WebRTC'));
      await guest.evaluate(([nid, x]) => window.SpecShare.send({ kind: 'draft', note: nid, item: x.item, target: x.target, rx: x.pin.rx, ry: x.pin.ry, text: 'Ann is writing' }), [id, n]);
      const shows = () => owner.evaluate(() => [...document.querySelectorAll('.sticky:not([hidden]) textarea')].some(t => t.value === 'Ann is writing'));
      await owner.waitForFunction(() => [...document.querySelectorAll('.sticky:not([hidden]) textarea')].some(t => t.value === 'Ann is writing'), null, { timeout: 3000 });
      await bob.evaluate(nid => window.SpecShare.send({ kind: 'typing', note: nid, on: false }), id);
      await sleep(2000);
      if (!(await shows())) {
        throw new Error('Bob cleared what Ann is typing');
      }
    } finally {
      // Closed as a person closes a tab, so it says goodbye.
      await bob.close({ runBeforeUnload: true });
      await bob.context().close();
    }
    await owner.waitForFunction(() => window.SpecHost.people().length === 2, null, { timeout: 8000 });
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

  await check('the book\'s server hears who the guests are', async () => {
    const guests = (await (await fetch(`${OWNER}api/share`)).json()).guests;
    if (!guests?.includes('Ann')) {
      throw new Error(`guests: ${JSON.stringify(guests)}`);
    }
  });

  let owner2;
  await check('closing the owner\'s tab pauses the share (a follower hears the owner left); reopening reconnects the guest without a reload', async () => {
    await guest.locator('.share-pill .face:not(.me)').first().click();
    await guest.waitForFunction(() => !document.querySelector('.follow-chip').hidden, null, { timeout: 3000 });
    await owner.close();
    await guest.waitForFunction(name => (document.querySelector('.follow-chip')?.textContent ?? '') === `${name} left`, ownerName, { timeout: 3000 });
    await guest.waitForFunction(() => /isn.t open right now/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 10000 });
    await waitFor(async () => (await (await fetch(`${OWNER}api/share`)).json()).state === 'idle', 5000, 'the server to hear the tab go');
    owner2 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    owner2.on('pageerror', e => errors.push(`owner: ${e.message}`));
    await guest.evaluate(() => { window.__noReload = true; });
    await owner2.goto(OWNER);
    await owner2.waitForSelector('#todos-list');
    await guest.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 20000 });
    if (!(await guest.evaluate(() => window.__noReload))) {
      throw new Error('the guest page reloaded');
    }
    if ((await (await fetch(`${OWNER}api/share`)).json()).url !== link) {
      throw new Error('the link changed when the tab was reopened');
    }
  });

  await check('restarting the book\'s server keeps the link, and the guest reconnects', async () => {
    await serve('--stop');
    await serve('--port', String(PORT), '--detach');
    await waitFor(async () => {
      const v = await fetch(`${OWNER}api/share`).then(r => r.json(), () => null);
      return v && v.state === 'live';
    }, 20000, 'the share to be live again');
    if ((await (await fetch(`${OWNER}api/share`)).json()).url !== link) {
      throw new Error('the link changed when the server restarted');
    }
    await guest.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 20000 });
  });

  await check('a room\'s token renews it; another token cannot take it; once ended it stays ended', async () => {
    const open = body => fetch(`${BROKER}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = await (await open({ hours: 1, protocol: 2 })).json();
    const renewed = await open({ hours: 2, protocol: 2, room: first.room, hostToken: first.hostToken });
    const r = await renewed.json();
    if (renewed.status !== 200 || r.room !== first.room || r.hostToken !== first.hostToken || !(Date.parse(r.expiresAt) > Date.parse(first.expiresAt))) {
      throw new Error(`renew: ${renewed.status} ${JSON.stringify(r)} after ${JSON.stringify(first)}`);
    }
    const taken = await open({ hours: 2, room: first.room, hostToken: 'x'.repeat(32) });
    if (taken.status !== 409) {
      throw new Error(`another token got ${taken.status}`);
    }
    await fetch(`${BROKER}/api/rooms/${first.room}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: first.hostToken }) });
    const back = await open({ hours: 1, protocol: 2, room: first.room, hostToken: first.hostToken });
    if (back.status !== 409) {
      throw new Error(`an ended room was opened again: ${back.status}`);
    }
    const asked = await fetch(`${BROKER}/api/rooms/${first.room}`);
    if (asked.status !== 410) {
      throw new Error(`an ended room answers ${asked.status}, not 410`);
    }
    // A room nobody ended (expired, or never there) is opened under the id its host asks for.
    const fresh = { room: 'kept-room-' + Date.now().toString(36).padStart(12, '0'), hostToken: 'h'.repeat(32) };
    const made = await open({ hours: 1, protocol: 2, ...fresh });
    const m = await made.json();
    if (made.status !== 201 || m.room !== fresh.room || m.hostToken !== fresh.hostToken) {
      throw new Error(`reopen: ${made.status} ${JSON.stringify(m)}`);
    }
  });

  await check('New link ends the old link', async () => {
    const before = errors.length;
    await owner2.evaluate(() => window.SpecHost.newLink());
    await guest.waitForFunction(() => /This share has ended/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 15000 });
    await waitFor(async () => {
      const v = await (await fetch(`${OWNER}api/share`)).json();
      return v.state === 'live' && v.url && v.url !== link;
    }, 10000, 'a new link');
    // The guest asking for its ended room is answered 410, as it should be: not a page error.
    for (let i = errors.length - 1; i >= before; i--) {
      if (/^guest: Failed to load resource: .*(404|410)/.test(errors[i])) { errors.splice(i, 1); }
    }
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
