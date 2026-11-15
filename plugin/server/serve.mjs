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
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptItem, addNote, changeItem, currentSnapshot, forgetItem, readHistory, readReview, sendNotes, stampOpened, writeReviewNotes } from './lib/review.mjs';
import { migrateReview } from './lib/migrate-review.mjs';
import { createMinter } from './lib/ids.mjs';
import { claudeState } from './lib/claude-state.mjs';
import { fileBuildRequests, writeRequest } from './lib/requests.mjs';
import { listBuilds, reviewCall, stopBuild } from './lib/builds.mjs';
import { findRequirement, findSection, listSections, setUserStage } from './lib/book-model.mjs';
import { ensureIgnores, findProjectRoot } from './lib/gitignore.mjs';
import { readJson, writeJsonAtomic } from './lib/json-file.mjs';
import { shareBrokerOf } from './lib/broker.mjs';
import { SERVER_FIELDS, applyNoteChanges, checkGuestNotes, guestMay, guestOf, mergeGuestNotes, reviewForGuest } from './lib/guest.mjs';

const SpecModel = createRequire(import.meta.url)('../app/model.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', 'app');

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

async function alreadyServing() {
  try {
    const r = await fetch(`${url}api/health`);
    if (!r.ok) {
      return false;
    }
    const j = await r.json();
    return j.data === DATA;
  } catch {
    return false;
  }
}

// Opens the page, in Chrome when it is installed (otherwise the default browser), and resolves once the opener has
// finished, so a caller can exit straight after.
function openBrowser() {
  const run = (cmd, args) => new Promise(done => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => done(1));
    p.on('exit', code => done(code));
  });
  if (process.platform === 'darwin') {
    return run('open', ['-a', 'Google Chrome', url]).then(code => (code === 0 ? 0 : run('open', [url])));
  }
  return run('xdg-open', [url]);
}

if (await alreadyServing()) {
  console.log(`Spec book already served at ${url}`);
  if (arg('open')) {
    await openBrowser();
  }
  process.exit(0);
}

if (arg('detach')) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--data', DATA, '--port', String(PORT)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(PIDFILE, JSON.stringify({ pid: child.pid, port: PORT, startedAt: new Date().toISOString() }, null, 2));
  for (let i = 0; i < 40 && !(await alreadyServing()); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`Spec book served at ${url} (pid ${child.pid}). Stop with --stop.`);
  if (arg('open')) {
    await openBrowser();
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

// Sharing. The book is shared whenever an owner tab is open (unless book.json says settings.share: false): every
// owner tab holds /api/share/events, and the one listening (one per book, by a Web Lock in app/host.js) is asked to
// host. That tab does the WebRTC; this server only remembers its room (id, host token, link key) in memory, so a
// reloaded or reopened tab reuses it and the link lasts as long as this server runs. Nothing is written to disk.
const shareTabs = new Map(); // tab id -> its events response, newest last
let share = { state: 'idle', room: null, stopped: false };
function sendEvent(tab, event, data) {
  const res = shareTabs.get(tab);
  if (res) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
function shareView() {
  // A tab asked to host that has not answered in 30 seconds is not going to.
  if (share.state === 'starting' && Date.now() - share.at > 30000) {
    share = { ...share, state: 'idle', error: 'The book tab did not start the share.' };
  }
  return { state: share.state, url: share.room?.url ?? null, expiresAt: share.room?.expiresAt ?? null, guests: share.guests ?? [], error: share.error ?? null, tabs: shareTabs.size, room: !!share.room, stopped: !!share.stopped };
}
function shareBroker() {
  try {
    return shareBrokerOf(readBook().settings);
  } catch {
    return null;
  }
}
function shareOn() {
  try {
    return readBook().settings?.share !== false;
  } catch {
    return false;
  }
}
// Asks a tab to host: with the remembered room when there is one, so the link stays the same.
function askToHost(tab) {
  const broker = shareBroker();
  if (!broker || !shareTabs.has(tab)) {
    return false;
  }
  share = { ...share, state: 'starting', tab, at: Date.now(), error: null };
  sendEvent(tab, 'start', { hours: 24, broker, room: share.room ? { room: share.room.room, hostToken: share.room.hostToken, secret: share.room.secret, url: share.room.url, expiresAt: share.room.expiresAt } : null });
  return true;
}
// Ends the remembered room at the share server (best effort: it also ends by itself when it expires).
function endRoomAtBroker(room) {
  const broker = shareBroker();
  if (!room || !broker) {
    return Promise.resolve();
  }
  return fetch(`${broker}/api/rooms/${encodeURIComponent(room.room)}/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: room.hostToken }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}
const SHARE_TAB = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;

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

// The book or its notes changed on disk: the owner's listening tab hears it at once (it reloads, and passes it on to
// the guests while it hosts).
let changeTimer = null;
try {
  watch(DATA, { recursive: true }, (_event, file) => {
    const f = String(file ?? '').split(sep).join('/');
    if (!/^(book\.json|review\.json|history\.json|mockups\/|evidence\/|media\/)/.test(f)) {
      return;
    }
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      for (const tab of shareTabs.keys()) {
        sendEvent(tab, 'changed', {});
      }
    }, 50);
  });
} catch {
  // no file watching here: pages still see changes on their next poll
}

// Stopping this server ends its share's room, so the link stops working with it.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    const room = share.room;
    share = { state: 'idle', room: null, stopped: false };
    endRoomAtBroker(room).finally(() => process.exit(0));
  });
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
    // A guest of a shared book (share.mjs) may read it and keep their own notes, nothing else.
    const guest = guestOf(req.headers);
    if (guest && (guest.invalid || !guestMay(req.method, path))) {
      json(res, 403, { error: 'guest' });
      return;
    }
    if (path === '/api/health') {
      // `guests`: this server checks shared-book guests; `share: 2`: it remembers the share's room and shares by
      // itself (share.mjs restarts a server without them).
      json(res, 200, guest ? { ok: true, guests: true, share: 2 } : { ok: true, data: DATA, guests: true, share: 2 });
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
      if (!SHARE_TAB.test(tab ?? '')) {
        json(res, 400, { error: 'bad-tab' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': listening\n\n');
      shareTabs.delete(tab);
      shareTabs.set(tab, res);
      // An opened (or reloaded) book shares again, even after Stop sharing.
      share = { ...share, stopped: false };
      if (shareOn()) {
        askToHost(tab);
      }
      const beat = setInterval(() => res.write(': beat\n\n'), 25000);
      req.on('close', () => {
        clearInterval(beat);
        if (shareTabs.get(tab) === res) {
          shareTabs.delete(tab);
        }
        // The hosting tab closed: nobody hosts until a tab opens again. The room is kept for it.
        if (share.tab === tab && !shareTabs.has(tab)) {
          share = { ...share, state: 'idle', tab: null, guests: [] };
        }
      });
      return;
    }
    if (path === '/api/share' && req.method === 'GET') {
      json(res, 200, shareView());
      return;
    }
    if (path === '/api/share' && req.method === 'POST') {
      const view = shareView();
      if (view.state !== 'idle') {
        json(res, 200, view);
        return;
      }
      if (!shareBroker()) {
        json(res, 409, { error: 'no-broker' });
        return;
      }
      if (shareTabs.size === 0) {
        json(res, 409, { error: 'no-tab' });
        return;
      }
      share = { ...share, stopped: false };
      askToHost([...shareTabs.keys()].at(-1));
      json(res, 202, shareView());
      return;
    }
    const shareMsg = /^\/api\/share\/(live|failed|ended|guests|stop|new-link)$/.exec(path);
    if (shareMsg && req.method === 'POST') {
      const body = await readJsonBody(req);
      const kind = shareMsg[1];
      if (kind === 'stop') {
        // The tab ends the room at the share server; the next opened book makes a new one.
        if (share.tab) {
          sendEvent(share.tab, 'stop', {});
        } else {
          endRoomAtBroker(share.room);
        }
        share = { state: 'idle', room: null, stopped: true, tab: null };
        json(res, 200, shareView());
        return;
      }
      if (kind === 'new-link') {
        const tab = share.tab ?? [...shareTabs.keys()].at(-1);
        if (!tab) {
          endRoomAtBroker(share.room);
          share = { ...share, room: null };
          json(res, 409, { error: 'no-tab' });
          return;
        }
        sendEvent(tab, 'end-room', {});
        share = { ...share, room: null, stopped: false };
        askToHost(tab);
        json(res, 202, shareView());
        return;
      }
      if (body.tab !== share.tab) {
        json(res, 409, { error: 'not-hosting' });
        return;
      }
      if (kind === 'live') {
        const broker = shareBroker();
        const ok = broker && ROOM_ID.test(body.room ?? '') && typeof body.hostToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.secret ?? '') &&
          body.url === `${broker}/s/${body.room}#${body.secret}`;
        if (!ok) {
          throw badRequest('bad-share');
        }
        share = { ...share, state: 'live', room: { room: body.room, hostToken: body.hostToken, secret: body.secret, url: body.url, expiresAt: String(body.expiresAt ?? '') }, guests: [] };
      } else if (kind === 'guests') {
        share = { ...share, guests: Array.isArray(body.guests) ? body.guests.filter(g => typeof g === 'string').slice(0, 50).map(g => g.slice(0, 40)) : [] };
      } else {
        // The tab could not open a room, or its room is gone (expired or ended): the next start makes a new one.
        share = { ...share, state: 'idle', room: null, tab: null, error: kind === 'failed' ? String(body.error ?? 'The share could not start.').slice(0, 300) : null };
      }
      json(res, 200, shareView());
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
        const next = applyNoteChanges(review.notes, changes, writer);
        if (guest) {
          checkGuestNotes(next, guest);
        }
        json(res, 200, writeReviewNotes(DATA, next, review.rev));
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
        // Ready is gated on review: the section, its requirements and its frames must all be accepted.
        const snap = currentSnapshot(DATA);
        const review = readReview(DATA);
        const under = SpecModel.reviews(snap.book, snap.mockups, review, readHistory(DATA)).byKey;
        const unreviewed = Object.keys(under).some(key => key === body.section || (snap.items[key]?.section ?? under[key]?.place?.section ?? review.where[key]?.section) === body.section);
        if (unreviewed) {
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
