#!/usr/bin/env node
// Smoke test for sharing a book: the share server (wrangler dev), the book server as the share's host
// (lib/host.mjs, over WebRTC with node-datachannel), the owner's localhost tab, and readers on the website's link
// (the reader the share server publishes under /r/<version>/): one link for everyone, the pin for the owner's powers,
// book HTML that never runs, live typing and following, a link that comes back with a Start after a restart, and Stop sharing.
//
//   GLOBAL_ROOT=$(npm root -g)/playwright node plugin/test/share.smoke.mjs
//
// Needs wrangler on the PATH and the share server's code (SHARE_SERVER, by default server/ in this repository). The
// share server is copied to a temp folder and this plugin's reader published into the copy (so server/public/r/ is
// never touched), then run there with wrangler dev on 8798. The share library (node-datachannel) is installed once
// into SPECBOOK_DEPS (by default ~/.cache/specbook-test-deps), never ~/.claude/specbook. Copies starter/ to a temp
// folder, serves it on port 4296 with serve.mjs --detach, reads the two links it prints, and drives the owner's tab
// and the readers in Chromium. Exits 1 when any check fails.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP } from '../../server/src/rules.mjs';

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
// The share library goes into a cache outside the repository, kept between runs; never the real ~/.claude/specbook.
const DEPS = process.env.SPECBOOK_DEPS || join(homedir(), '.cache', 'specbook-test-deps');
if (resolve(DEPS).startsWith(resolve(homedir(), '.claude'))) {
  console.error(`SPECBOOK_DEPS must not be under ~/.claude: ${DEPS}`);
  process.exit(2);
}
mkdirSync(DEPS, { recursive: true });
const VERSION = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;

// The share server, copied, with this plugin's reader published into the copy.
const site = mkdtempSync(join(tmpdir(), 'specbook-share-site-'));
cpSync(SHARE_SERVER, site, { recursive: true, filter: p => !/[\\/](\.wrangler|node_modules|\.env)$/.test(p) });
{
  const pub = spawnSync(process.execPath, [join(SHARE_SERVER, 'publish-reader.mjs'), '--app', join(PLUGIN, 'app'), '--out', join(site, 'public', 'r'), '--version', VERSION, '--force'], { encoding: 'utf8' });
  if (pub.status !== 0) {
    console.error(`publish-reader failed: ${pub.stderr || pub.stdout}`);
    rmSync(site, { recursive: true, force: true });
    process.exit(2);
  }
}

const data = mkdtempSync(join(tmpdir(), 'specbook-share-'));
cpSync(join(PLUGIN, 'starter'), data, { recursive: true });
// An image inside a mockup (a shadow root), as a book's logo is: readers load it over the channel.
mkdirSync(join(data, 'mockups', 'assets'), { recursive: true });
writeFileSync(join(data, 'mockups', 'assets', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
appendFileSync(join(data, 'mockups', 'screens', 'SCR-3WRX', 'list.html'), '<img class="probe" src="/data/mockups/assets/dot.png" alt="">');
// The book shares through the local share server.
const bookFile = join(data, 'book.json');
const bookJson = JSON.parse(readFileSync(bookFile, 'utf8'));
bookJson.settings = { ...(bookJson.settings ?? {}), shareBroker: BROKER };
// More mockups than the host answers for one reader at once, as a real book has; and one whose HTML tries to run.
// They are the states of one screen, all shown by the later-due section.
const EXTRA = 'SCR-XTR4';
const extraDir = join(data, 'mockups', 'screens', EXTRA);
mkdirSync(extraDir, { recursive: true });
const extra = { id: EXTRA, name: 'ExtrasScreen', kind: 'screen', states: [] };
for (let i = 1; i <= 30; i++) {
  extra.states.push({ id: `extra${i}`, name: `Extra ${i}`, when: { role: 'anyone' }, mockup: `mockups/screens/${EXTRA}/extra${i}.html` });
  writeFileSync(join(extraDir, `extra${i}.html`), `<div class="phone"><p>Extra ${i}</p></div>`);
}
extra.states.push({ id: 'pwn', name: 'Hostile', when: { role: 'anyone' }, mockup: `mockups/screens/${EXTRA}/pwn.html` });
writeFileSync(join(extraDir, 'pwn.html'), '<div class="phone"><p>Hostile</p><script>window.__pwned=1</script><img src=x onerror="window.__pwned=2"></div>');
bookJson.screens.push(extra);
bookJson.usedIds = [...(bookJson.usedIds ?? []), EXTRA];
const due = bookJson.chapters.find(c => c.id === 'later').sections.find(s => s.id === 'due');
due.shows = [...(due.shows ?? []), ...extra.states.map(st => ({ state: `${EXTRA}.${st.id}` }))];
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
const shareOf = () => fetch(`${OWNER}api/share`).then(r => r.json());
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
function skip(name, why) {
  console.log(`skip ${name} (${why})`);
}

const children = [];
function run(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  children.push(p);
  return p;
}

// serve.mjs, as /specbook:start runs it (detached), with the share library from DEPS. Resolves with what it printed.
const serve = (...args) => new Promise(done => {
  const p = spawn(process.execPath, [join(PLUGIN, 'server', 'serve.mjs'), '--data', data, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPECBOOK_DEPS: DEPS } });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { out += d; });
  p.on('exit', () => done(out));
});
// The pin the owner chooses when they press Share and Start.
const PIN = '135790';

// Its own state each run, so earlier runs' rooms do not count against the rate limit.
const brokerState = mkdtempSync(join(tmpdir(), 'specbook-share-state-'));
let brokerLog = '';
let browser;
const errors = [];
// A reader's page, with its errors collected.
async function pageIn(ctx, who) {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
  page.on('console', m => {
    // The hostile mockup's broken image, on localhost (where book HTML is the owner's own and is not cleaned).
    if (m.type() === 'error' && !(/Failed to load resource/.test(m.text()) && /\/x$/.test(m.location()?.url ?? ''))) {
      errors.push(`${who}: ${m.text()}`);
    }
  });
  return page;
}
const newCtx = (opts = {}) => browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
const chipOf = page => page.evaluate(() => document.querySelector('.share-chip')?.textContent ?? '');
const isOwnerPage = page => page.evaluate(() => !!window.SpecShare && window.SpecShare.role === 'owner' && !document.body.classList.contains('guest') && getComputedStyle(document.getElementById('claude-menu')).display !== 'none');
const isGuestPage = page => page.evaluate(() => !!window.SpecShare && window.SpecShare.role === 'guest' && document.body.classList.contains('guest') && getComputedStyle(document.getElementById('claude-menu')).display === 'none');
const pinKeyOf = url => `specbook-pin:${new URL(url).pathname.split('/')[2]}`;
try {
  const broker = run('wrangler', ['dev', '--port', '8798', '--ip', '127.0.0.1', '--show-interactive-dev-session=false', '--persist-to', brokerState], { cwd: site });
  broker.stdout.on('data', d => { brokerLog += d; });
  broker.stderr.on('data', d => { brokerLog += d; });
  await waitFor(() => up(`${BROKER}/`), 60000, 'the broker (wrangler dev)').catch(e => {
    throw new Error(`${e.message}\n${brokerLog}`);
  });
  // The book server starts unshared: it prints no link.
  const started = await serve('--port', String(PORT), '--detach');
  if (/Share link|pin link/.test(started)) {
    throw new Error(`serve.mjs --detach printed a link for a book that is not shared:\n${started}`);
  }
  await waitFor(() => up(`${OWNER}api/health`), 5000, 'the book server');
  if ((await shareOf()).state !== 'off') {
    throw new Error('the book shared itself');
  }

  // Both pages run in one headless browser, which cannot resolve the mDNS names Chrome hides local addresses behind.
  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const guestCtx = await newCtx();
  const guest = await pageIn(guestCtx, 'guest');
  let owner = await pageIn(await newCtx(), 'owner');
  // The owner's localhost tab: Share, a pin, Start. The server hosts the share; the tab follows it.
  await owner.goto(OWNER);
  await owner.waitForSelector('#todos-list');
  await owner.click('.share-pill .share-start');
  await owner.fill('.share-menu .share-start-pin', PIN);
  await owner.click('.share-menu .share-start-go');
  await owner.waitForFunction(() => document.querySelector('.share-pill .share-solo')?.textContent === 'Only you', null, { timeout: 15000 });
  await owner.keyboard.press('Escape');
  await owner.mouse.click(5, 300);
  const ownerName = await owner.evaluate(() => window.SpecBook.me().name);
  const link = await owner.evaluate(() => window.SpecHost.link());
  const pinUrl = `${link}#pin=${PIN}`;
  if (!link?.startsWith(`${BROKER}/s/`) || (await shareOf()).pinUrl !== pinUrl) {
    throw new Error(`unexpected links: ${link} ${(await shareOf()).pinUrl}`);
  }

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

  await check('a guest on the plain link reads the book and saves a note', async () => {
    await guest.goto(link);
    await guest.waitForSelector('.share-join input', { timeout: 8000 });
    await guest.fill('.share-join input', 'Ann');
    await guest.click('.share-join button');
    await guest.waitForSelector('#todos-list', { timeout: 20000 }).catch(async e => {
      throw new Error(`${e.message}\nchip: ${await chipOf(guest)}\nbody: ${(await guest.evaluate(() => document.body.innerHTML)).slice(0, 400)}`);
    });
    await guest.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 5000 });
    if (await guest.locator('.share-chip').isVisible()) {
      throw new Error('the status chip still shows once the guest is live');
    }
    // The page is the website's reader, not anything the host sent.
    const reader = await guest.evaluate(() => [...document.scripts].map(s => s.getAttribute('src')));
    if (!reader.length || reader.some(s => !s || !s.startsWith(`/r/`))) {
      throw new Error(`scripts not from /r/: ${JSON.stringify(reader)}`);
    }
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

  await check('a guest cannot Revise', async () => {
    if (!(await isGuestPage(guest))) {
      throw new Error('the guest page shows the Claude group (Revise)');
    }
    const shown = await guest.evaluate(() => [...document.querySelectorAll('#revise, .bar-group.claude, .rv-acts, .stage-btn')].some(e => e.offsetParent !== null));
    if (shown) {
      throw new Error('an owner-only control is showing');
    }
    const statuses = await guest.evaluate(async () => Promise.all([
      fetch('/api/requests', { method: 'POST' }).then(r => r.status),
      fetch('/api/revise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"items":[{"note":"x"}]}' }).then(r => r.status),
      fetch('/api/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"x"}' }).then(r => r.status),
      fetch('/api/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status),
      fetch('/api/share/new-pin', { method: 'POST' }).then(r => r.status),
    ]));
    if (statuses.some(s => s !== 403)) {
      throw new Error(`expected 403s, got ${statuses}`);
    }
    if (existsSync(join(data, 'requests'))) {
      throw new Error('a guest wrote a request');
    }
    // A path that would turn into another host in the host's fetch is refused there.
    const tricks = await guest.evaluate(async () => Promise.all(['/\\127.0.0.1:9/app/x', '/\t/127.0.0.1:9/app/x', '//127.0.0.1:9/app/x', '/\n/127.0.0.1:9/data/x']
      .map(p => window.SpecShare.request('GET', p).then(r => r.status))));
    if (tricks.some(s => s !== 403)) {
      throw new Error(`a host-changing path was not refused: ${tricks}`);
    }
  });

  await check('a guest has the bottom toolbar and no Claude', async () => {
    const seen = await guest.evaluate(() => {
      const t = document.getElementById('review-tools');
      const r = t ? t.getBoundingClientRect() : null;
      const shows = id => { const e = document.getElementById(id); return !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); };
      return {
        tools: !!r && shows('review-tools') && innerHeight - r.bottom >= 0 && innerHeight - r.bottom <= 40,
        buttons: ['mode', 'prev-chg', 'next-chg', 'changes-btn', 'toc-btn'].filter(id => !shows(id)),
        claude: ['claude-btn', 'claude-count', 'claude-confirm'].filter(shows),
      };
    });
    if (!seen.tools || seen.buttons.length || seen.claude.length) {
      throw new Error(`the guest's toolbar or Claude is wrong: ${JSON.stringify(seen)}`);
    }
    // The toolbar works for a guest: the filter toggles.
    await guest.locator('#changes-btn').click();
    const on = await guest.evaluate(() => document.body.classList.contains('diff-on'));
    await guest.locator('#changes-btn').click();
    if (!on) {
      throw new Error('the filter does nothing for a guest');
    }
  });

  await check('a mockup\'s script and onerror never run on the link', async () => {
    // The hostile mockup is drawn (cleaned) on the link, and nothing in it ran.
    await guest.waitForFunction(() => [...document.querySelectorAll('[data-mockup]')].some(h => h.dataset.mockup.endsWith('pwn.html') && h.shadowRoot?.querySelector('.phone')), null, { timeout: 8000 });
    await sleep(500);
    const got = await guest.evaluate(() => {
      const h = [...document.querySelectorAll('[data-mockup]')].find(x => x.dataset.mockup.endsWith('pwn.html'));
      return { pwned: window.__pwned, scripts: h.shadowRoot.querySelectorAll('script').length, handlers: [...h.shadowRoot.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length };
    });
    if (got.pwned !== undefined || got.scripts || got.handlers) {
      throw new Error(`the mockup's code got through: ${JSON.stringify(got)}`);
    }
  });

  await check('the page has the CSP header', async () => {
    for (const u of [link, `${BROKER}/r/${VERSION}/share.html`, `${BROKER}/r/${VERSION}/book.js`]) {
      const r = await fetch(u);
      if (r.status !== 200 || r.headers.get('content-security-policy') !== CSP) {
        throw new Error(`${u}: ${r.status}, CSP ${r.headers.get('content-security-policy')}`);
      }
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

  await check('the book\'s server hears who the guests are', async () => {
    const guests = (await shareOf()).guests;
    if (!guests?.includes('Ann')) {
      throw new Error(`guests: ${JSON.stringify(guests)}`);
    }
  });

  // The owner's other device: opens the pin link.
  const phoneCtx = await newCtx();
  const phone = await pageIn(phoneCtx, 'phone');
  await check('the pin leaves the address and is remembered', async () => {
    await phone.goto(pinUrl);
    await phone.waitForSelector('#todos-list', { timeout: 20000 });
    await phone.waitForFunction(() => window.SpecShare.role === 'owner', null, { timeout: 5000 });
    const where = await phone.evaluate(() => ({ hash: location.hash, href: location.href, asked: !!document.querySelector('.share-join') }));
    if (/pin/.test(where.hash) || /pin=/.test(where.href) || where.href !== link) {
      throw new Error(`the address after the pin link: ${JSON.stringify(where)}`);
    }
    if (where.asked) {
      throw new Error('the pin link asked for a name');
    }
    if (!(await isOwnerPage(phone))) {
      throw new Error('the pin link did not open the book with the owner\'s powers');
    }
    if (await phone.evaluate(k => localStorage.getItem(k), pinKeyOf(link)) !== pinUrl.split('#pin=')[1]) {
      throw new Error('the pin was not saved for this room');
    }
    await phone.reload();
    await phone.waitForSelector('#todos-list', { timeout: 20000 });
    await phone.waitForFunction(() => window.SpecShare.role === 'owner', null, { timeout: 5000 });
    if (!(await isOwnerPage(phone))) {
      throw new Error('after a reload the plain link lost the owner\'s powers (Revise is missing)');
    }
    // A pinned reader is the owner, in the host's people too.
    const roles = await owner.evaluate(() => window.SpecHost.people().map(p => `${p.name}:${p.role}`));
    if (!roles.includes(`${ownerName}:owner`) || roles.filter(r => r.endsWith(':owner')).length < 2) {
      throw new Error(`people: ${JSON.stringify(roles)}`);
    }
  });

  await check('the pin holder\'s menu on the link, and without the saved pin the page is a guest', async () => {
    await phone.click('.share-pill .share-more');
    await phone.waitForSelector('.share-menu .share-stop', { timeout: 3000 });
    // The pin holder's menu on the link: Stop sharing, and no other button.
    const acts = await phone.evaluate(() => [...document.querySelectorAll('.share-menu .share-acts button')].map(b => b.textContent));
    if (acts.join() !== 'Stop sharing') {
      throw new Error(`the pin holder's menu on the link has ${JSON.stringify(acts)}`);
    }
    // The menu has no Forget pin, and no localhost address.
    if (await phone.locator('.share-menu .share-forget-pin, .share-menu .share-local').count()) {
      throw new Error('the menu on the link offers Forget pin or a localhost address');
    }
    // The browser's saved pin cleared: reloaded as a guest, asked for a name, then the book with a guest's rights.
    await phone.evaluate(k => localStorage.removeItem(k), pinKeyOf(link));
    await phone.reload();
    await phone.waitForSelector('.share-join input', { timeout: 8000 });
    await phone.fill('.share-join input', 'Phone');
    await phone.click('.share-join button');
    await phone.waitForSelector('#todos-list', { timeout: 20000 });
    await phone.waitForFunction(() => window.SpecShare.role === 'guest', null, { timeout: 5000 });
    if (!(await isGuestPage(phone))) {
      throw new Error('without its pin the page still has the owner\'s powers');
    }
    if (await phone.evaluate(k => localStorage.getItem(k), pinKeyOf(link)) !== null) {
      throw new Error('the pin is still saved');
    }
    if (await phone.evaluate(() => fetch('/api/requests', { method: 'POST' }).then(r => r.status)) !== 403) {
      throw new Error('a reader without the pin may still call owner routes');
    }
  });

  await check('a guest who types the pin in the menu gets the owner\'s powers', async () => {
    await phone.click('.share-pill .share-more');
    await phone.waitForSelector('.share-menu .share-pin-entry input', { timeout: 3000 });
    await phone.fill('.share-menu .share-pin-entry input', '12345');
    await phone.click('.share-menu .share-pin-entry button');
    if (await phone.locator('.share-menu .share-pin-error').isHidden()) {
      throw new Error('a 5-digit pin was not refused');
    }
    await phone.fill('.share-menu .share-pin-entry input', pinUrl.split('#pin=')[1]);
    await Promise.all([phone.waitForNavigation(), phone.click('.share-menu .share-pin-entry button')]);
    await phone.waitForSelector('#todos-list', { timeout: 20000 });
    await phone.waitForFunction(() => window.SpecShare.role === 'owner', null, { timeout: 8000 });
    if (!(await isOwnerPage(phone))) {
      throw new Error('the typed pin did not give the owner\'s powers');
    }
  });

  // The owner's phone with the pin, for the restart.
  const pinned = await pageIn(await newCtx(), 'pinned');
  await pinned.goto(pinUrl);
  await pinned.waitForFunction(() => window.SpecShare && window.SpecShare.role === 'owner', null, { timeout: 20000 });

  await check('the owner tab can close and the guest stays connected', async () => {
    await guest.locator('.share-pill .face:not(.me)').first().click();
    await guest.waitForFunction(() => !document.querySelector('.follow-chip').hidden, null, { timeout: 3000 });
    await guest.evaluate(() => { window.__noReload = true; });
    await owner.close({ runBeforeUnload: true });
    await sleep(3000);
    const after = await guest.evaluate(async () => ({
      chip: document.querySelector('.share-chip')?.textContent ?? '',
      book: await fetch('/api/book').then(r => r.status, () => 0),
      stayed: !!window.__noReload,
    }));
    if (!/Live · Ann/.test(after.chip) || after.book !== 200 || !after.stayed) {
      throw new Error(`the guest after the owner's tab closed: ${JSON.stringify(after)}`);
    }
    if ((await shareOf()).state !== 'live') {
      throw new Error('the share stopped with the owner\'s tab');
    }
    // A note still reaches the book.
    await comment(guest, 'With the tab closed', 160);
    await waitFor(() => Object.values(review().notes).some(n => n.text === 'With the tab closed'), 5000, 'the note to be saved');
    // The owner opens the book again.
    owner = await pageIn(await newCtx(), 'owner');
    await owner.goto(OWNER);
    await owner.waitForSelector('#todos-list');
    await owner.waitForFunction(() => window.SpecHost.state() === 'live', null, { timeout: 8000 });
    await owner.waitForFunction(() => window.SpecHost.people().some(p => p.name === 'Ann'), null, { timeout: 8000 });
  });

  await check('a restart does not share; Start with the same pin takes up the same link, and readers come back', async () => {
    await guest.evaluate(() => { window.__noReload = true; });
    await pinned.evaluate(() => { window.__noReload = true; });
    const before = errors.length;
    await serve('--stop');
    // The owner tab's event stream is cut by the stop, as it should be: not a page error.
    await sleep(500);
    for (let i = errors.length - 1; i >= before; i--) {
      if (/^owner: Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING/.test(errors[i])) { errors.splice(i, 1); }
    }
    await serve('--port', String(PORT), '--detach');
    await owner.waitForFunction(() => window.SpecHost.state() === 'off', null, { timeout: 15000 });
    if ((await shareOf()).state !== 'off') {
      throw new Error('the restarted server shared the book by itself');
    }
    await owner.evaluate(pin => window.SpecHost.startSharing(pin), PIN);
    const again = await waitFor(async () => {
      const v = await shareOf();
      return v.state === 'live' && v;
    }, 15000, 'the share to be live again');
    if (again.url !== link || again.pinUrl !== pinUrl) {
      throw new Error(`the links changed: ${link} ${pinUrl} -> ${again.url} ${again.pinUrl}`);
    }
    await guest.waitForFunction(() => /Live · Ann/.test(document.querySelector('.share-chip')?.textContent ?? '') && window.SpecShare.role === 'guest', null, { timeout: 30000 }).catch(async e => {
      throw new Error(`${e.message}: guest chip ${await chipOf(guest)}`);
    });
    await pinned.waitForFunction(() => /^Live/.test(document.querySelector('.share-chip')?.textContent ?? '') && window.SpecShare.role === 'owner', null, { timeout: 30000 }).catch(async e => {
      throw new Error(`${e.message}: pinned chip ${await chipOf(pinned)}`);
    });
    // Connected again, not reloaded, and with the same rights.
    await waitFor(async () => (await guest.evaluate(() => fetch('/api/book').then(r => r.status, () => 0))) === 200, 10000, 'the guest to read again');
    if (!(await guest.evaluate(() => window.__noReload)) || !(await pinned.evaluate(() => window.__noReload))) {
      throw new Error('a reader page reloaded');
    }
    if (!(await isOwnerPage(pinned)) || !(await isGuestPage(guest))) {
      throw new Error('a reader came back with other rights');
    }
    if (await guest.evaluate(() => fetch('/api/requests', { method: 'POST' }).then(r => r.status)) !== 403) {
      throw new Error('the guest may call owner routes after the restart');
    }
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

  await check('a room whose host names a reader not published here says the share server needs deploying', async () => {
    const res = await fetch(`${BROKER}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hours: 1, protocol: 3, reader: '9.9.9' }) });
    const room = await res.json();
    if (res.status !== 201 || !room.room) {
      throw new Error(`open: ${res.status} ${JSON.stringify(room)}`);
    }
    const page = await fetch(`${BROKER}/s/${room.room}`);
    const text = await page.text();
    await fetch(`${BROKER}/api/rooms/${room.room}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: room.hostToken }) });
    if (page.status !== 503 || !text.includes('This book needs a newer share server. Ask its owner to deploy it.')) {
      throw new Error(`/s/<room> answered ${page.status}: ${text.slice(0, 200)}`);
    }
    if (!page.headers.get('content-security-policy')?.includes("script-src 'self'")) {
      throw new Error('the notice has no CSP');
    }
  });

  await check('Stop sharing ends the link (This share has ended); the next Start opens a new link with the new pin', async () => {
    const before = errors.length;
    await owner.waitForFunction(() => window.SpecHost.state() === 'live', null, { timeout: 15000 });
    await owner.evaluate(() => window.SpecHost.stopSharing());
    await guest.waitForFunction(() => /This share has ended/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 15000 });
    await pinned.waitForFunction(() => /This share has ended/.test(document.querySelector('.share-chip')?.textContent ?? ''), null, { timeout: 15000 });
    await owner.waitForFunction(() => window.SpecHost.state() === 'off', null, { timeout: 15000 });
    await owner.evaluate(() => window.SpecHost.startSharing('975310'));
    const now = await waitFor(async () => {
      const v = await shareOf();
      return v.state === 'live' && v.url && v.url !== link && v;
    }, 10000, 'a new link');
    if (now.pinUrl !== `${now.url}#pin=975310`) {
      throw new Error(`the new share does not have the new pin: ${now.pinUrl}`);
    }
    // A reader asking for its ended room is answered 410, as it should be: not a page error.
    for (let i = errors.length - 1; i >= before; i--) {
      if (/^(guest|pinned|phone): Failed to load resource: .*(404|410)/.test(errors[i])) { errors.splice(i, 1); }
    }
  });

  // Tab-hosted (protocol 2) rooms keep today's guest page: checked by the rules unit tests (pageFor). Driving a 1.3.0
  // host tab here would need that plugin's whole app from git history, which this smoke does not set up.
  skip('a protocol 2 host still works', 'needs the 1.3.0 host tab from git history; pageFor({ protocol: 2 }) is covered by server/src/rules.test.mjs');

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
  await serve('--stop');
  for (const p of children) {
    p.kill();
  }
  await sleep(300);
  rmSync(data, { recursive: true, force: true });
  rmSync(brokerState, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
