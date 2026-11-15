#!/usr/bin/env node
// Spec book server. Serves the reader app from this skill and the book's data from a project folder,
// and accepts change requests from the page, writing them into the project folder for Claude to pick up.
//
//   node serve.mjs --data <project>/docs/specbook [--port 4180] [--detach] [--open]
//
// Without --port it reuses the port this folder's server last ran on, or a running server for this folder on
// 4180-4199, or the first free port there, so each project's book gets its own port. --detach --open on a folder
// that is already served only opens the browser.
//   node serve.mjs --data <project>/docs/specbook --stop
//
// No dependencies. Data never leaves the project folder: the book (book.json, mockups/), the media
// (media/) the requests (requests/), review.json, history.json and builds/ all live under --data.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptItem, addNote, changeItem, currentSnapshot, forgetItem, readHistory, readReview, sectionsUnderReview, sendNotes, stampOpened, writeReviewNotes } from './lib/review.mjs';
import { migrateReview } from './lib/migrate-review.mjs';
import { createMinter } from './lib/ids.mjs';
import { claudeState } from './lib/claude-state.mjs';
import { fileBuildRequests, stopRequest, writeRequest } from './lib/requests.mjs';
import { listBuilds, reviewCall, stopBuild } from './lib/builds.mjs';
import { findRequirement, findSection, listSections, setUserStage } from './lib/book-model.mjs';
import { ensureIgnores, findProjectRoot } from './lib/gitignore.mjs';
import { readJson, writeJsonAtomic } from './lib/json-file.mjs';
import { shareBrokerOf } from './lib/broker.mjs';
import { ensureDeps, loadRtc } from './lib/deps.mjs';
import { createHost } from './lib/host.mjs';
import { PIN } from './lib/secret.mjs';
import { SERVER_FIELDS, applyNoteChanges, checkGuestNotes, guestMay, guestOf, mergeGuestNotes, reviewForGuest } from './lib/guest.mjs';

const SpecModel = createRequire(import.meta.url)('../app/model.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', 'app');

// A stamp of the server's own code (this file, lib/, and the app model it loads). /api/health reports it, so a
// --detach run can tell a server that an older copy of the plugin started, and replace it.
const CODE = (() => {
  const hash = createHash('sha1');
  const lib = join(HERE, 'lib');
  const files = [fileURLToPath(import.meta.url), join(APP, 'model.js'),
    ...readdirSync(lib).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).sort().map(f => join(lib, f))];
  for (const f of files) {
    hash.update(readFileSync(f));
  }
  return hash.digest('hex').slice(0, 12);
})();

// The plugin's version: the share library is installed per version (lib/deps.mjs).
const VERSION = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) {
    return fallback;
  }
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dataArg = arg('data');
if (!dataArg || dataArg === true) {
  console.error('Usage: serve.mjs --data <project>/docs/specbook [--port 4180] [--detach] [--open] | --stop');
  process.exit(2);
}
const DATA = resolve(dataArg);
const PIDFILE = join(DATA, '.server.json');

if (arg('stop')) {
  if (!existsSync(PIDFILE)) {
    console.log('No spec book server recorded for this folder.');
    process.exit(0);
  }
  const { pid } = JSON.parse(readFileSync(PIDFILE, 'utf8'));
  try {
    process.kill(pid);
    console.log(`Stopped spec book server (pid ${pid}).`);
  } catch {
    console.log(`Server pid ${pid} was not running.`);
  }
  unlinkSync(PIDFILE);
  process.exit(0);
}

if (!existsSync(join(DATA, 'book.json'))) {
  console.error(`No book.json in ${DATA}. Run the skill's init first.`);
  process.exit(1);
}

// Is this folder's book served on `port`?
async function servingThis(port) {
  try {
    const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) {
      return false;
    }
    const j = await r.json();
    return j.data === DATA;
  } catch {
    return false;
  }
}
function portFree(port) {
  return new Promise(done => {
    const probe = createNetServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}
async function choosePort() {
  const asked = arg('port');
  if (asked && asked !== true) {
    return Number(asked);
  }
  const recorded = readJson(PIDFILE, null)?.port;
  const tries = [...new Set([recorded, ...Array.from({ length: 20 }, (_, i) => 4180 + i)])].filter(Number.isInteger);
  for (const port of tries) {
    if (await servingThis(port)) {
      return port;
    }
  }
  for (const port of tries) {
    if (await portFree(port)) {
      return port;
    }
  }
  console.error('No free port in 4180-4199; pass --port.');
  process.exit(1);
}
const PORT = await choosePort();
const url = `http://localhost:${PORT}/`;

// Whether this folder's book is served on PORT: true by this code, 'old' by other code (an older copy of the
// plugin), false when it is not.
async function alreadyServing() {
  try {
    const r = await fetch(`${url}api/health`);
    if (!r.ok) {
      return false;
    }
    const j = await r.json();
    if (j.data !== DATA) {
      return false;
    }
    return j.code === CODE ? true : 'old';
  } catch {
    return false;
  }
}

// Opens `target` (the book on localhost by default), in Chrome when it is installed (otherwise the default browser),
// and resolves once the opener has finished, so a caller can exit straight after.
function openBrowser(target = url) {
  const run = (cmd, args) => new Promise(done => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => done(1));
    p.on('exit', code => done(code));
  });
  if (process.platform === 'darwin') {
    return run('open', ['-a', 'Google Chrome', target]).then(code => (code === 0 ? 0 : run('open', [target])));
  }
  return run('xdg-open', [target]);
}

// With --detach on a book that is already served and shared: the share link and the owner's pin link. These two
// lines are the only place the pin is ever printed. A book that is not shared says nothing: sharing starts only when
// the owner presses Share in the bar and chooses a pin.
async function printShareLinks() {
  const view = await fetch(`${url}api/share`).then(r => (r.ok ? r.json() : null), () => null);
  if (view?.state === 'live' && view.url && view.pinUrl) {
    console.log(`Share link: ${view.url}`);
    console.log(`Your pin link (opens with your powers; never send it to anyone): ${view.pinUrl}`);
  }
}

// A server an older copy of the plugin started for this folder: stop it and start this one on its port.
if (arg('detach') && (await alreadyServing()) === 'old') {
  const rec = readJson(PIDFILE, null);
  try {
    if (rec?.port !== PORT) {
      throw new Error('not recorded');
    }
    process.kill(rec.pid);
  } catch {
    console.error(`An older copy of the plugin serves this book at ${url}, and it could not be stopped. Stop it, then try again.`);
    process.exit(1);
  }
  for (let i = 0; i < 50 && !(await portFree(PORT)); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  console.log('The server running this book was started by an older copy of the plugin; restarted it. Please reload any open book tab.');
}

if ((await alreadyServing()) === true) {
  console.log(`Spec book already served at ${url}`);
  // Opening a book that is already served gives its links too (the running server's owner view). --open opens the
  // book on localhost; the share link and pin link are only printed.
  if (arg('detach')) {
    await printShareLinks();
  }
  if (arg('open')) {
    await openBrowser(url);
  }
  process.exit(0);
}

if (arg('detach')) {
  // The share library, installed once per plugin version. Without it the book is still served, only not shared.
  const deps = await ensureDeps({ version: VERSION, log: m => console.log(m) });
  if (!deps.ok) {
    console.log(`The share library could not be installed (${deps.error}); the book is served, but not shared.`);
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--data', DATA, '--port', String(PORT)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(PIDFILE, JSON.stringify({ pid: child.pid, port: PORT, startedAt: new Date().toISOString() }, null, 2));
  for (let i = 0; i < 40 && (await alreadyServing()) !== true; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`Spec book served at ${url} (pid ${child.pid}). Stop with --stop.`);
  if (arg('open')) {
    await openBrowser(url);
  }
  process.exit(0);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function inside(base, rel) {
  const p = normalize(join(base, rel));
  return p === base || p.startsWith(base + sep) ? p : null;
}

// Whether a path relative to the data folder may be served as a static file: inside it, not private, no dot part.
function servable(relPath) {
  const rel = relPath.split(sep).join('/').toLowerCase();
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return false;
  }
  return !PRIVATE.some(p => rel === p || rel.startsWith(`${p}/`)) && !rel.split('/').some(part => part.startsWith('.'));
}

function sendFile(req, res, file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const size = statSync(file).size;
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  const common = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...common, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...common, 'content-length': size });
  createReadStream(file).pipe(res);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function listMedia() {
  const dir = join(DATA, 'media');
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}${name}/`);
      } else if (TYPES[extname(name).toLowerCase()]) {
        out.push(`media/${prefix}${name}`);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// When book.json or a mockup last changed on disk, so an open page can draw the book again after an edit made outside
// it (Claude editing the book in the terminal).
function bookStamp() {
  let at = 0;
  const seen = file => {
    try {
      at = Math.max(at, statSync(file).mtimeMs);
    } catch {
      // gone between listing and stat: nothing to add
    }
  };
  seen(join(DATA, 'book.json'));
  const dir = join(DATA, 'mockups');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.html') || name.endsWith('.css')) {
        seen(join(dir, name));
      }
    }
  }
  return at;
}

// Reached only through the API, never as static files.
const PRIVATE = ['requests', 'builds', 'revise', 'notes.json', 'review.json', 'history.json'];
const STATUS = {
  locked: 409,
  busy: 409,
  stale: 409,
  accepted: 409,
  unreviewed: 409,
  'not-under-review': 404,
  'not-running': 409,
  decided: 409,
  'bad-json': 400,
  'bad-stage': 400,
  'bad-accept': 400,
  'bad-change': 400,
  'bad-requirement': 400,
  'bad-note': 400,
  'too-many-notes': 413,
  'bad-share': 400,
  'nothing-ready': 400,
  'nothing-to-build': 400,
  'note-required': 400,
  'not-found': 404,
};

async function readJsonBody(req) {
  const text = await readBody(req);
  try {
    const parsed = text === '' ? {} : JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // falls through to the error below
  }
  const error = new Error('Request body is not a JSON object');
  error.code = 'bad-json';
  throw error;
}

// Only this machine's own page may use the server: another site's page is refused by its Origin, and a page reaching
// it through another name (DNS rebinding) by its Host.
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const ORIGINS = HOSTS.map(h => `http://${h}`);

function allowed(req) {
  const origin = req.headers.origin;
  return HOSTS.includes(req.headers.host) && (origin === undefined || ORIGINS.includes(origin));
}

// A form post from another page cannot send this content type without a CORS preflight, which is never answered.
function isJson(req) {
  return /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');
}

function readBook() {
  return JSON.parse(readFileSync(join(DATA, 'book.json'), 'utf8'));
}

// The writes that change what the book says or what the reader decided are refused while Claude revises or builds.
function assertIdle() {
  if (claudeState(DATA).state !== 'idle') {
    const error = new Error('Claude is working');
    error.code = 'locked';
    throw error;
  }
}

function badRequest(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const prefixOf = chapter => (chapter.prefix ?? chapter.id.slice(0, 3)).toUpperCase();

// The marker fields a page may send for a requirement; an empty or missing one is removed.
function applyFields(req, body) {
  req.text = body.text.trim();
  if (body.change !== undefined && body.change !== null && body.change !== '' && !['add', 'change', 'remove'].includes(body.change)) {
    throw badRequest('bad-change');
  }
  for (const key of ['change', 'today', 'reason']) {
    const value = body[key];
    if (typeof value === 'string' && value !== '') {
      req[key] = value;
    } else {
      delete req[key];
    }
  }
}

// A page edit to a ready or built section sends it back to drafting, as a revise does; returns whether it did.
function demote(section) {
  const stage = section.stage ?? 'drafting';
  if (stage === 'ready' || stage === 'built') {
    section.stage = 'drafting';
    return true;
  }
  return false;
}

// An optional one-line note saved on the item as already answered.
function saveRequirementNote(id, text) {
  if (typeof text === 'string' && text.trim() !== '') {
    addNote(DATA, { item: id, text: text.trim(), created: new Date().toISOString(), status: 'answered' });
  }
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPlain = v => typeof v === 'object' && v !== null && !Array.isArray(v);

// A draft note as the page may author it: item, text, created, the page target it was dropped on and its section (so
// the pin lands on that spot, which need not be a reviewable item: a recording, a decision), and a pin. The pin's
// sticky offset (dx, dy) is optional: the page places a sticky only once its target is on screen. Anything else is
// dropped; a note that does not fit is refused with 400 bad-note.
function cleanDraft(note, keys) {
  if (!isPlain(note) || typeof note.item !== 'string' || !keys.has(note.item) || typeof note.text !== 'string') {
    throw badRequest('bad-note');
  }
  const out = { item: note.item, text: note.text, status: 'draft' };
  for (const k of ['created', 'target', 'section']) {
    if (note[k] !== undefined) {
      if (typeof note[k] !== 'string') {
        throw badRequest('bad-note');
      }
      out[k] = note[k];
    }
  }
  if (note.pin !== undefined) {
    const pin = note.pin;
    const element = isPlain(pin) ? pin.element : undefined;
    const offset = isPlain(pin) && ['dx', 'dy'].every(k => pin[k] === undefined) ? [] : ['dx', 'dy'];
    if (!isPlain(pin) || !['rx', 'ry', ...offset].every(k => isNum(pin[k])) || (element !== undefined && typeof element !== 'string' && !isPlain(element))) {
      throw badRequest('bad-note');
    }
    out.pin = { rx: pin.rx, ry: pin.ry };
    // Optional, each group whole or absent: pixels from the target's top-left (ax, ay); a letter of the target's text
    // (ch, its index) and pixels from that letter's top-left (cx, cy).
    for (const group of [['ax', 'ay'], ['ch', 'cx', 'cy']]) {
      const given = group.filter(k => pin[k] !== undefined);
      if (!given.length) {
        continue;
      }
      if (given.length !== group.length || !group.every(k => isNum(pin[k])) || (group[0] === 'ch' && !(Number.isInteger(pin.ch) && pin.ch >= 0))) {
        throw badRequest('bad-note');
      }
      group.forEach(k => { out.pin[k] = pin[k]; });
    }
    if (offset.length) {
      out.pin.dx = pin.dx;
      out.pin.dy = pin.dy;
    }
    if (element !== undefined) {
      out.pin.element = element;
    }
  }
  return out;
}

// The page's drafts, each checked and cleaned, keyed by id.
function cleanDrafts(sent) {
  const snap = currentSnapshot(DATA);
  const keys = new Set([...Object.keys(snap.items), ...Object.keys(readReview(DATA).accepted)]);
  const out = {};
  for (const [id, note] of Object.entries(sent)) {
    if (id !== '__proto__') {
      out[id] = cleanDraft(note, keys);
    }
  }
  return out;
}

// Keeps every note that is no longer a draft exactly as stored; the page's draft notes replace the stored drafts.
function mergeNotes(stored, sent) {
  const out = {};
  for (const [id, note] of Object.entries(stored)) {
    if (note && note.status !== 'draft') {
      out[id] = note;
    }
  }
  const snap = currentSnapshot(DATA);
  const keys = new Set([...Object.keys(snap.items), ...Object.keys(readReview(DATA).accepted)]);
  for (const [id, note] of Object.entries(sent)) {
    if (id === '__proto__' || Object.hasOwn(out, id)) {
      continue;
    }
    out[id] = cleanDraft(note, keys);
    // What the server wrote on a stored draft (the items it caused, the keys it is closed for, a reply) stays: the
    // page cannot author those fields, and its copy of the note does not carry them.
    const was = Object.hasOwn(stored, id) ? stored[id] : null;
    for (const k of SERVER_FIELDS) {
      if (was && was[k] !== undefined) {
        out[id][k] = was[k];
      }
    }
  }
  return out;
}

// Sharing. This server hosts the share itself (lib/host.mjs), only once the owner presses Share in the bar and
// chooses a 6-digit pin (POST /api/share); it never shares on its own, at start or when a tab opens. It remembers the
// room (id, host token, expiry) and the pin in .share.json (git-ignored, never served), so a Start after a restart
// takes up the same link. Stop sharing ends the room: the next Start opens a new link. The owner's localhost tabs follow
// the share on /api/share/events and pass their live messages to the readers through /api/live.
const SHAREFILE = join(DATA, '.share.json');
const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;

const SHARE_TAB = /^[A-Za-z0-9_-]{8,64}$/;

// What .share.json remembers: { room, hostToken, pin, expiresAt }. An older file (with the link key `secret`, or
// `stopped`) keeps its room.
function readSavedShare() {
  const r = readJson(SHAREFILE, null);
  const ok = isPlain(r) && ROOM_ID.test(r.room ?? '') && typeof r.hostToken === 'string' && r.hostToken !== '';
  return {
    room: ok ? r.room : null,
    hostToken: ok ? r.hostToken : null,
    pin: isPlain(r) && PIN.test(r.pin ?? '') ? r.pin : null,
    expiresAt: ok && typeof r.expiresAt === 'string' ? r.expiresAt : null,
  };
}
let saved = readSavedShare();
let savedText = existsSync(SHAREFILE) ? readFileSync(SHAREFILE, 'utf8') : null;
function saveShare() {
  const text = JSON.stringify({ room: saved.room, hostToken: saved.hostToken, pin: saved.pin, expiresAt: saved.expiresAt }, null, 2);
  if (text === savedText) {
    return;
  }
  try {
    writeJsonAtomic(SHAREFILE, JSON.parse(text));
    savedText = text;
  } catch {
    // kept in memory only: the link lasts until this server stops
  }
}
// An older .share.json is rewritten in today's form.
if (savedText !== null) {
  saveShare();
}

// The host: the real one, or, for tests only, the module SPECBOOK_TEST_HOST names (CommonJS, exporting createHost),
// read once here. It lets serve.test.mjs run a fake host with no WebRTC and no share server. Never set it otherwise.
const makeHost = process.env.SPECBOOK_TEST_HOST ? createRequire(import.meta.url)(resolve(process.env.SPECBOOK_TEST_HOST)).createHost : createHost;
const RTC = loadRtc(VERSION);
let host = null;
let hostBroker = null;
let shareNow = { state: 'off', guests: [], error: null };
const shareTabs = new Map(); // the owner tabs' events responses -> their tab id (or null)

function sendEvent(event, data) {
  const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of shareTabs.keys()) {
    res.write(text);
  }
}
// The owner's open localhost tabs (their ids), so each tab's share menu lists every one.
function sendTabs() {
  sendEvent('tabs', { tabs: [...shareTabs.values()].filter(Boolean) });
}
function shareBroker() {
  try {
    return shareBrokerOf(readBook().settings);
  } catch {
    return null;
  }
}
// What the owner's tabs see. The pin link is for the owner's localhost tabs only: guests are refused these routes.
function shareView() {
  const broker = hostBroker ?? shareBroker();
  const link = broker && saved.room ? `${broker}/s/${saved.room}` : null;
  return { state: shareNow.state, url: link, pinUrl: link && shareNow.state === 'live' ? `${link}#pin=${saved.pin}` : null, expiresAt: link ? saved.expiresAt : null, guests: shareNow.guests, error: shareNow.error };
}
function setShare(next) {
  shareNow = { ...shareNow, ...next };
  sendEvent('state', shareView());
}

// The host for the book's share server, made when first needed (and again if book.json names another one).
function hostFor(broker) {
  if (host && hostBroker === broker) {
    return host;
  }
  if (host) {
    host.stop({ end: false }).catch(() => {});
  }
  const made = makeHost({
    broker,
    port: PORT,
    version: VERSION,
    ownerName: () => OWNER_NAME,
    saved: { ...saved },
    rtc: RTC,
    readNotes,
    onState(view) {
      if (host !== made) {
        return;
      }
      saved = { room: view.room ?? null, hostToken: view.hostToken ?? null, pin: PIN.test(view.pin ?? '') ? view.pin : saved.pin, expiresAt: view.expiresAt ?? null };
      saveShare();
      setShare({ state: view.state, guests: Array.isArray(view.guests) ? view.guests : [], error: view.error ?? null });
    },
  });
  host = made;
  hostBroker = broker;
  made.onLive(msg => {
    if (host === made) {
      sendEvent('live', msg);
    }
  });
  return made;
}

// Starts sharing with the owner's chosen pin. Returns false when the book names no valid share server.
function startShare(pin) {
  const broker = shareBroker();
  if (!broker) {
    setShare({ state: 'failed', error: 'book.json settings.shareBroker is not a valid share server address.' });
    return false;
  }
  hostFor(broker).start({ pin }).catch(() => {});
  return true;
}

// The notes the host checks each reader's draft and typing frame against (app/relay.js mayDraft), which come many a
// second: kept in memory, read again when review.json changes (on disk, or through this server), and at most every
// few seconds otherwise, in case the change went unseen.
let notesCache = null;
let notesAt = 0;
function readNotes() {
  if (!notesCache || Date.now() - notesAt > 3000) {
    notesCache = readReview(DATA).notes;
    notesAt = Date.now();
  }
  return notesCache;
}
function forgetNotes() {
  notesCache = null;
}

// The owner's first name, which guests see on the owner's face and notes: git's user.name for the project.
const OWNER_NAME = (() => {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd: DATA, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    return cleanOwnerName(name.split(/\s+/)[0]);
  } catch {
    return 'Owner';
  }
})();
function cleanOwnerName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, 40);
  return s || 'Owner';
}

// The book or its notes changed on disk: the owner's tabs and every reader hear it at once (they read it again).
let changeTimer = null;
try {
  watch(DATA, { recursive: true }, (_event, file) => {
    const f = String(file ?? '').split(sep).join('/');
    if (!/^(book\.json|review\.json|history\.json|mockups\/|evidence\/|media\/)/.test(f)) {
      return;
    }
    if (f.startsWith('review.json')) {
      forgetNotes();
    }
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      host?.changed();
      sendEvent('changed', {});
    }, 50);
  });
} catch {
  // no file watching here: pages still see changes on their next poll
}

// Stopping this server leaves its share's room alone: the next server takes it up from .share.json, so the link lasts.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => process.exit(0));
}

const server = createServer(async (req, res) => {
  if (!allowed(req)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  if ((req.method === 'POST' || req.method === 'PUT') && !isJson(req)) {
    json(res, 415, { error: 'json-required' });
    return;
  }
  try {
    const path = decodeURIComponent(new URL(req.url, url).pathname);
    // A guest of a shared book (through the host tab) may read it and keep their own notes, nothing else.
    const guest = guestOf(req.headers);
    if (guest && (guest.invalid || !guestMay(req.method, path))) {
      json(res, 403, { error: 'guest' });
      return;
    }
    // The share and the owner's live messages are the owner's alone, whatever guestMay allows.
    const flat = path.replace(/\/+/g, '/');
    if (guest && (flat.startsWith('/api/share') || flat === '/api/live' || flat.startsWith('/api/live/'))) {
      json(res, 403, { error: 'guest' });
      return;
    }
    // Any write may change the notes: the host's copy of them is read again.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.on('finish', forgetNotes);
    }
    if (path === '/api/health') {
      // `code` tells serve.mjs --detach whether this server runs its own code (see CODE).
      json(res, 200, guest ? { ok: true } : { ok: true, data: DATA, code: CODE });
      return;
    }
    if (path === '/api/book' && req.method === 'GET') {
      const book = JSON.parse(readFileSync(join(DATA, 'book.json'), 'utf8'));
      const evidenceFile = join(DATA, 'evidence', 'evidence.json');
      let evidence = {};
      if (existsSync(evidenceFile)) {
        try {
          const parsed = JSON.parse(readFileSync(evidenceFile, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { evidence = parsed; }
        } catch {
          // A corrupt or half-written evidence file must not take the book down.
        }
      }
      // Claude's own review.mjs writes do not check the revision, so nothing stamps while it works.
      // A guest's read is not the owner seeing the changes, so it stamps nothing.
      if (!guest && claudeState(DATA).state === 'idle') {
        stampOpened(DATA, new Date().toISOString());
      }
      const history = readHistory(DATA);
      json(res, 200, {
        book,
        media: listMedia(),
        evidence,
        review: guest ? reviewForGuest(readReview(DATA), guest) : readReview(DATA),
        changelog: history.changelog,
        historyCounts: Object.fromEntries(Object.entries(history.items).map(([key, entries]) => [key, entries.length])),
        claude: claudeState(DATA),
        viewer: guest ? { guest: true, name: guest.name, key: guest.key } : { guest: false, name: OWNER_NAME },
        owner: { name: OWNER_NAME },
      });
      return;
    }
    if (path === '/api/share/events' && req.method === 'GET') {
      const tab = new URL(req.url, url).searchParams.get('tab');
      // Only this page's own EventSource: a <script> or <img> on another site sends no Origin, but says what it is.
      const dest = req.headers['sec-fetch-dest'];
      if (dest !== undefined && dest !== 'empty') {
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (tab !== null && !SHARE_TAB.test(tab)) {
        json(res, 400, { error: 'bad-tab' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': listening\n\n');
      shareTabs.set(res, tab);
      res.write(`event: state\ndata: ${JSON.stringify(shareView())}\n\n`);
      sendTabs();
      // Who is reading already: a tab opened (or reloaded, or reconnected) while readers are connected hears them now,
      // not only when each says hello again.
      if (host && host.state() === 'live') {
        res.write(`event: live\ndata: ${JSON.stringify({ t: 'live', kind: 'roster', you: 'host', people: host.people() })}\n\n`);
      }
      const beat = setInterval(() => res.write(': beat\n\n'), 25000);
      req.on('close', () => {
        clearInterval(beat);
        shareTabs.delete(res);
        sendTabs();
      });
      return;
    }
    if (path === '/api/share' && req.method === 'GET') {
      json(res, 200, shareView());
      return;
    }
    if (path === '/api/share' && req.method === 'POST') {
      // The owner's own 6-digit pin: it gives the owner's powers on the link.
      const body = await readJsonBody(req);
      if (typeof body.pin !== 'string' || !PIN.test(body.pin)) {
        json(res, 400, { error: 'bad-pin' });
        return;
      }
      if (!startShare(body.pin)) {
        json(res, 409, { error: 'no-broker' });
        return;
      }
      json(res, 202, shareView());
      return;
    }
    if (path === '/api/share/stop' && req.method === 'POST') {
      // The room ends at the share server, so its link stops working; the next start opens a new one.
      const broker = shareBroker();
      if (host || (broker && saved.room)) {
        (host ?? hostFor(broker)).stop({ end: true }).catch(() => {});
      }
      saved = { ...saved, room: null, hostToken: null, expiresAt: null };
      saveShare();
      setShare({ state: 'off', guests: [], error: null });
      json(res, 200, shareView());
      return;
    }
    if (path === '/api/live' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!isPlain(body.msg)) {
        json(res, 400, { error: 'bad-live' });
        return;
      }
      // A tab closing says bye; the owner is still here while another of their tabs is open (its stream, and the
      // closing tab's own, which ends just after).
      if (body.msg.kind === 'bye' && shareTabs.size > 1) {
        json(res, 200, { ok: true });
        return;
      }
      host?.sendLive(body.msg);
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/api/claude' && req.method === 'GET') {
      const claude = claudeState(DATA);
      const calls = [];
      // The calls waiting for review, and those the running build has made so far, which its banner counts.
      const builds = (claude.review?.builds ?? []).map(b => b.build);
      if (claude.build?.state === 'running') {
        builds.push(claude.build.id);
      }
      for (const build of builds) {
        const found = listBuilds(DATA).find(b => b.id === build);
        for (const call of found?.calls ?? []) {
          if (call && call.status === 'pending') {
            calls.push({ ...call, build });
          }
        }
      }
      json(res, 200, { ...claude, calls: guest ? [] : calls, bookAt: bookStamp(), notesRev: readReview(DATA).rev });
      return;
    }
    if (path === '/api/notes' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      // A per-note save: only the notes this page changed (null deletes), applied on top of what is stored now.
      if (body.changes !== undefined) {
        if (!isPlain(body.changes)) {
          json(res, 400, { error: 'bad-notes' });
          return;
        }
        if (claudeState(DATA).state === 'revising') {
          json(res, 409, { error: 'locked' });
          return;
        }
        const snap = currentSnapshot(DATA);
        const review = readReview(DATA);
        const keys = new Set([...Object.keys(snap.items), ...Object.keys(review.accepted)]);
        const changes = {};
        for (const [id, n] of Object.entries(body.changes)) {
          if (id !== '__proto__') {
            changes[id] = n === null ? null : cleanDraft(n, keys);
          }
        }
        const writer = guest ? { guest: true, name: guest.name, key: guest.key } : { guest: false, name: OWNER_NAME };
        const skipped = [];
        const next = applyNoteChanges(review.notes, changes, writer, skipped);
        if (guest) {
          checkGuestNotes(next, guest);
        }
        // `skipped`: the ids this writer may not change (another's note, or one no longer a draft). The page moves its
        // own text in a skipped note to a new note, so nothing typed is lost.
        json(res, 200, { ...writeReviewNotes(DATA, next, review.rev), skipped });
        return;
      }
      const notes = body.notes;
      if (!notes || typeof notes !== 'object' || Array.isArray(notes) || typeof body.rev !== 'number') {
        json(res, 400, { error: 'bad-notes' });
        return;
      }
      if (claudeState(DATA).state === 'revising') {
        json(res, 409, { error: 'locked' });
        return;
      }
      const stored = readReview(DATA).notes;
      const next = guest ? mergeGuestNotes(stored, cleanDrafts(body.notes), guest) : mergeNotes(stored, body.notes);
      if (guest) {
        checkGuestNotes(next, guest);
      }
      json(res, 200, writeReviewNotes(DATA, next, body.rev));
      return;
    }
    if (path === '/api/revise' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (claudeState(DATA).state !== 'idle') {
        json(res, 409, { error: 'busy' });
        return;
      }
      if (!Array.isArray(body.items) || body.items.length === 0) {
        json(res, 400, { error: 'nothing-to-revise' });
        return;
      }
      const noteIds = Array.isArray(body.noteIds) ? body.noteIds : [];
      // Each item carries the id of the note it came from (the page sends it; older pages are matched by position).
      const items = body.items.map((it, i) => (it && typeof it === 'object' && !Array.isArray(it) && it.noteId === undefined && typeof noteIds[i] === 'string' ? { ...it, noteId: noteIds[i] } : it));
      const file = writeRequest(DATA, {
        kind: 'revise',
        status: 'pending',
        createdAt: new Date().toISOString(),
        items,
        noteIds,
      });
      sendNotes(DATA, noteIds.filter(id => typeof id === 'string'), new Date().toISOString());
      json(res, 201, { file, count: body.items.length });
      return;
    }
    if (path === '/api/build' && req.method === 'POST') {
      if (claudeState(DATA).state !== 'idle') {
        json(res, 409, { error: 'busy' });
        return;
      }
      const book = JSON.parse(readFileSync(join(DATA, 'book.json'), 'utf8'));
      const sections = listSections(book).filter(s => s.section.stage === 'ready').map(s => s.fullId);
      if (sections.length === 0) {
        json(res, 400, { error: 'nothing-ready' });
        return;
      }
      // Only accepted work is built: a Ready section edited since (by Claude or in the page) waits for its Accepts.
      const unreviewed = sectionsUnderReview(DATA, sections);
      if (unreviewed.length > 0) {
        json(res, 409, { error: 'unreviewed', sections: unreviewed });
        return;
      }
      const file = writeRequest(DATA, { kind: 'build', status: 'pending', createdAt: new Date().toISOString(), sections });
      json(res, 201, { file });
      return;
    }
    if (path === '/api/stage' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (claudeState(DATA).state !== 'idle') {
        json(res, 409, { error: 'locked' });
        return;
      }
      const book = JSON.parse(readFileSync(join(DATA, 'book.json'), 'utf8'));
      if (body.stage === 'ready') {
        // Ready is gated on review: the section, its requirements and everything its Accept gate covers (gateKeys) must
        // all be accepted.
        if (sectionsUnderReview(DATA, [body.section]).length > 0) {
          json(res, 409, { error: 'unreviewed' });
          return;
        }
      }
      setUserStage(book, body.section, body.stage);
      writeJsonAtomic(join(DATA, 'book.json'), book);
      json(res, 200, { stage: body.stage });
      return;
    }
    // Accept one review: the server reads the item's current value itself, so the page cannot send a stale or forged one.
    if (path === '/api/accept' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.key !== 'string' || !body.key) {
        throw badRequest('bad-accept');
      }
      assertIdle();
      acceptItem(DATA, body.key, new Date().toISOString());
      json(res, 200, { accepted: body.key });
      return;
    }
    // Change: freeze the item's current version as a try and write a new draft note against it.
    if (path === '/api/change' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.key !== 'string' || !body.key) {
        throw badRequest('bad-change');
      }
      assertIdle();
      const text = typeof body.note === 'string' ? body.note.trim() : '';
      if (text === '') {
        throw badRequest('note-required');
      }
      json(res, 200, changeItem(DATA, body.key, text, new Date().toISOString()));
      return;
    }
    const history = /^\/api\/history\/(.+)$/.exec(path);
    if (history && req.method === 'GET') {
      const items = readHistory(DATA).items;
      json(res, 200, { entries: Object.hasOwn(items, history[1]) ? items[history[1]] : [] });
      return;
    }
    if (path === '/api/requirements' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.section !== 'string' || typeof body.text !== 'string' || body.text.trim() === '') {
        throw badRequest('bad-requirement');
      }
      assertIdle();
      const book = readBook();
      const found = findSection(book, body.section);
      if (!found) {
        throw Object.assign(new Error(`No section ${body.section}`), { code: 'not-found' });
      }
      const id = createMinter(book).mint(prefixOf(found.chapter));
      const added = { id };
      applyFields(added, body);
      found.section.requirements = [...(found.section.requirements ?? []), added];
      const demoted = demote(found.section);
      writeJsonAtomic(join(DATA, 'book.json'), book);
      saveRequirementNote(id, body.note);
      json(res, 200, { id, demoted });
      return;
    }
    const requirement = /^\/api\/requirements\/([^/]+)$/.exec(path);
    if (requirement && req.method === 'PUT') {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        throw badRequest('bad-requirement');
      }
      assertIdle();
      const book = readBook();
      const found = findRequirement(book, requirement[1]);
      if (!found) {
        throw Object.assign(new Error(`No requirement ${requirement[1]}`), { code: 'not-found' });
      }
      applyFields(found.req, body);
      const demoted = demote(found.section);
      writeJsonAtomic(join(DATA, 'book.json'), book);
      saveRequirementNote(found.req.id, body.note);
      json(res, 200, { id: found.req.id, demoted });
      return;
    }
    if (requirement && req.method === 'DELETE') {
      assertIdle();
      const book = readBook();
      const found = findRequirement(book, requirement[1]);
      if (!found) {
        throw Object.assign(new Error(`No requirement ${requirement[1]}`), { code: 'not-found' });
      }
      if (Object.hasOwn(readReview(DATA).accepted, requirement[1])) {
        throw Object.assign(new Error('Requirement was accepted'), { code: 'accepted' });
      }
      found.section.requirements.splice(found.index, 1);
      const demoted = demote(found.section);
      writeJsonAtomic(join(DATA, 'book.json'), book);
      forgetItem(DATA, requirement[1]);
      json(res, 200, { id: requirement[1], demoted });
      return;
    }
    if (path === '/api/claude/stop' && req.method === 'POST') {
      // Stop in the reader's Claude menu: withdraw what Claude is working on. The skills notice (next-request --check).
      const stopped = stopRequest(DATA);
      if (!stopped) {
        json(res, 409, { error: 'idle' });
        return;
      }
      json(res, 200, stopped);
      return;
    }
    if (path === '/api/builds/pending/cancel' && req.method === 'POST') {
      // A stale build request that never started a build (or whose build has ended) is filed, which unlocks the book.
      const claude = claudeState(DATA);
      if (claude.build?.state === 'running') {
        json(res, 409, { error: 'busy' });
        return;
      }
      if (!claude.stale) {
        json(res, 409, { error: 'not-stale' });
        return;
      }
      json(res, 200, { filed: fileBuildRequests(DATA) });
      return;
    }
    const stop = /^\/api\/builds\/([^/]+)\/stop$/.exec(path);
    if (stop && req.method === 'POST') {
      const progress = stopBuild(DATA, stop[1], 'Marked as stopped in the reader');
      // The stopped build's request is filed too, or the book would stay locked.
      json(res, 200, { ...progress, filed: fileBuildRequests(DATA) });
      return;
    }
    const review = /^\/api\/builds\/([^/]+)\/calls\/([^/]+)$/.exec(path);
    if (review && req.method === 'POST') {
      const body = await readJsonBody(req);
      // A review writes to the book, which is locked while Claude works.
      if (claudeState(DATA).state !== 'idle') {
        json(res, 409, { error: 'locked' });
        return;
      }
      json(res, 200, reviewCall(DATA, review[1], review[2], { decision: body.decision, note: body.note }));
      return;
    }
    if (path === '/' || path === '/index.html') {
      sendFile(req, res, join(APP, 'index.html'));
      return;
    }
    if (path.startsWith('/app/')) {
      sendFile(req, res, inside(APP, path.slice('/app/'.length)));
      return;
    }
    if (path.startsWith('/data/')) {
      const file = inside(DATA, path.slice('/data/'.length));
      // Checked first on the resolved path, then on the canonical path the disk resolves it to (realpath), both
      // lowercased: an encoded slash, another case or a case-folded character such as U+017F for "s" (on a
      // case-insensitive disk such as APFS) must not reach a private file.
      if (!file || !servable(relative(DATA, file))) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const real = realpathSync.native(file);
      if (!servable(relative(realpathSync.native(DATA), real))) {
        res.writeHead(403);
        res.end();
        return;
      }
      sendFile(req, res, real);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    if (e instanceof URIError) {
      json(res, 400, { error: 'bad-path' });
      return;
    }
    const status = STATUS[e && e.code];
    if (status) {
      json(res, status, { error: e.code });
      return;
    }
    json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

// Carry an older book's notes and baseline over, then stamp every review (which also makes an interrupted migration whole).
migrateReview(DATA);
const projectRoot = findProjectRoot(DATA);
if (projectRoot) {
  ensureIgnores(projectRoot, relative(projectRoot, DATA));
}
stampOpened(DATA, new Date().toISOString());
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Spec book served at ${url} from ${DATA}`);
  if (arg('open')) {
    openBrowser();
  }
});
