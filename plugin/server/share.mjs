#!/usr/bin/env node
// The live book is shared whenever its book tab is open (unless book.json says settings.share: false), through a share
// server deployed on its own, outside this plugin: https://specbook.jasonrowland.com unless book.json
// settings.shareBroker names another. The owner's open book tab is the host (app/host.js): the book goes from that tab
// straight to each guest over WebRTC, encrypted end to end. The link lasts as long as the book's server runs.
//
//   node share.mjs --data <dir>                   the link: starts the server and opens the book if needed
//   node share.mjs --data <dir> --status | --stop | --new-link
//   node share.mjs --data <dir> --check           { broker, sharing } for the share skill
//   node share.mjs --data <dir> --set-broker https://…   share through your own server instead
//
// Used by the specbook:share skill. Guests may read the book and keep their own notes, nothing else; the host tab
// and the server both check every call.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/json-file.mjs';
import { shareBrokerOf } from './lib/broker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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
  console.error('Usage: share.mjs --data <project>/docs/specbook [--status | --stop | --new-link | --check | --set-broker URL]');
  process.exit(2);
}
const DATA = resolve(dataArg);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function settings() {
  try {
    return JSON.parse(readFileSync(join(DATA, 'book.json'), 'utf8')).settings ?? {};
  } catch {
    return {};
  }
}

const setBroker = arg('set-broker');
if (setBroker) {
  const value = String(setBroker).replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+$/.test(value)) {
    console.error('The share server must be an https:// address, such as https://specbook-share.<account>.workers.dev');
    process.exit(2);
  }
  const file = join(DATA, 'book.json');
  const book = JSON.parse(readFileSync(file, 'utf8'));
  book.settings = { ...(book.settings ?? {}), shareBroker: value };
  writeJsonAtomic(file, book);
  console.log(`This book now shares through ${value}.`);
  process.exit(0);
}

function recordedPort() {
  try {
    return JSON.parse(readFileSync(join(DATA, '.server.json'), 'utf8')).port;
  } catch {
    return null;
  }
}

// The port of this book's running server: true when it shares by itself, 'old' when an older copy of the plugin
// started it, false when it is not this book's.
async function health(port) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    if (j.data !== DATA) {
      return false;
    }
    return j.guests === true && j.share === 2 ? true : 'old';
  } catch {
    return false;
  }
}

async function findServer() {
  const p = recordedPort();
  if (p && (await health(p)) === true) {
    return p;
  }
  for (let q = 4180; q < 4200; q++) {
    if ((await health(q)) === true) {
      return q;
    }
  }
  return null;
}

function serve(...args) {
  return new Promise(done => spawn(process.execPath, [join(HERE, 'serve.mjs'), '--data', DATA, ...args], { stdio: 'ignore' }).on('exit', done));
}

async function api(port, method, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

if (arg('check')) {
  const port = await findServer();
  const view = port ? (await api(port, 'GET', '/api/share')).body : null;
  console.log(JSON.stringify({ broker: shareBrokerOf(settings()), sharing: view?.state === 'live' ? view.url : null }));
  process.exit(0);
}

if (arg('new-link')) {
  const port = await findServer();
  const r = port ? await api(port, 'POST', '/api/share/new-link', {}) : { status: 409 };
  if (r.status !== 202) {
    console.log('Not sharing: open the book to share it.');
    process.exit(0);
  }
  for (let i = 0; i < 300; i++) {
    const view = (await api(port, 'GET', '/api/share')).body;
    if (view.state === 'live' && view.room) {
      console.log(`New link: ${view.url}. The old link no longer works.`);
      process.exit(0);
    }
    await sleep(100);
  }
  console.error('The book tab did not make a new link in time.');
  process.exit(1);
}

if (arg('status') || arg('stop')) {
  const port = await findServer();
  if (!port) {
    console.log('Not sharing.');
    process.exit(0);
  }
  const view = (await api(port, 'GET', '/api/share')).body;
  if (view.state !== 'live') {
    console.log('Not sharing.');
    process.exit(0);
  }
  if (arg('stop')) {
    await api(port, 'POST', '/api/share/stop', {});
    console.log('Stopped sharing. The link no longer works; reopening the book shares it again, with a new link.');
  } else {
    const who = view.guests.length ? `; guests: ${view.guests.join(', ')}` : '; no guests yet';
    console.log(`Sharing at ${view.url}${who}.`);
  }
  process.exit(0);
}

// The link: this book's server (restarting one an older plugin started), an open tab, which shares by itself.
if (!shareBrokerOf(settings())) {
  console.error(`settings.shareBroker in book.json is not an https:// address. Fix it, or remove it to share through the public server.`);
  process.exit(2);
}
const recorded = recordedPort();
if (recorded && (await health(recorded)) === 'old') {
  await serve('--stop');
  console.log("Restarted the book's server for live sharing; reload any open book tab.");
}
let port = await findServer();
if (!port) {
  await serve('--detach');
  port = await findServer();
}
if (!port) {
  console.error('The spec book server did not start.');
  process.exit(1);
}
let view = (await api(port, 'GET', '/api/share')).body;
if (view.tabs === 0) {
  // The share runs in an open book tab: open one.
  await serve('--detach', '--open');
  for (let i = 0; i < 300 && (await api(port, 'GET', '/api/share')).body.tabs === 0; i++) {
    await sleep(100);
  }
}
view = (await api(port, 'GET', '/api/share')).body;
if (view.tabs === 0) {
  console.error('No book tab opened in the browser, so there is nothing to share from.');
  process.exit(1);
}
// A book that does not share by itself (settings.share: false), or one stopped: start it.
if (view.state === 'idle' && !view.room) {
  const res = await api(port, 'POST', '/api/share', {});
  if (res.status >= 400) {
    console.error(`Could not start sharing: ${res.body.error}`);
    process.exit(1);
  }
}
for (let i = 0; i < 300; i++) {
  view = (await api(port, 'GET', '/api/share')).body;
  if (view.state === 'live') {
    console.log(`Sharing at ${view.url}. It lasts while the book's server runs; closing the book tab pauses it.`);
    process.exit(0);
  }
  if (view.state === 'idle' && view.error) {
    console.error(view.error);
    process.exit(1);
  }
  await sleep(100);
}
console.error('The book tab did not start the share in time.');
process.exit(1);
