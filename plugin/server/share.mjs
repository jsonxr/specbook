#!/usr/bin/env node
// Shares the live spec book through a share server (a Cloudflare Worker deployed on its own, outside this plugin):
// https://specbook.jasonrowland.com unless book.json settings.shareBroker names another. The owner's open book tab
// is the host (app/host.js): the book goes from that tab straight to each guest over WebRTC, encrypted end to end,
// and closing the tab ends the share.
//
//   node share.mjs --data <dir> [--hours 8]      start, opening the book in the browser if no tab is open; prints the link
//   node share.mjs --data <dir> --status | --stop
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
  console.error('Usage: share.mjs --data <project>/docs/specbook [--hours 8] | --status | --stop | --check | --set-broker URL');
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

// The port of this book's running server: true when it can check guests, 'old' when an older copy of the plugin
// started it, false when it is not this book's.
async function health(port) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    if (j.data !== DATA) {
      return false;
    }
    return j.guests === true ? true : 'old';
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
    console.log('Stopped sharing. The link no longer works.');
  } else {
    const who = view.guests.length ? `; guests: ${view.guests.join(', ')}` : '; no guests yet';
    console.log(`Sharing at ${view.url} until ${view.expiresAt}${who}.`);
  }
  process.exit(0);
}

// Start: this book's server (restarting one an older plugin started, which cannot check guests), an open tab, then
// the share.
if (!shareBrokerOf(settings())) {
  console.error(`settings.shareBroker in book.json is not an https:// address. Fix it, or remove it to share through the public server.`);
  process.exit(2);
}
const recorded = recordedPort();
if (recorded && (await health(recorded)) === 'old') {
  await serve('--stop');
  console.log("Restarted the book's server so it can check guests; reload any open book tab.");
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
const hours = Math.min(24, Math.max(1, Number(arg('hours', 8)) || 8));
let res = await api(port, 'POST', '/api/share', { hours });
if (res.status === 409 && res.body.error === 'no-tab') {
  // The share runs in an open book tab: open one, and wait for it to listen.
  await serve('--detach', '--open');
  for (let i = 0; i < 300 && (await api(port, 'GET', '/api/share')).body.tabs === 0; i++) {
    await sleep(100);
  }
  res = await api(port, 'POST', '/api/share', { hours });
}
if (res.status >= 400) {
  console.error(res.body.error === 'no-tab' ? 'No book tab opened in the browser, so there is nothing to share from.' : `Could not start sharing: ${res.body.error}`);
  process.exit(1);
}
for (let i = 0; i < 300; i++) {
  const view = (await api(port, 'GET', '/api/share')).body;
  if (view.state === 'live') {
    console.log(`Sharing at ${view.url} until ${view.expiresAt}. Closing the book tab ends it.`);
    process.exit(0);
  }
  if (view.state === 'idle') {
    console.error(view.error ?? 'The share did not start.');
    process.exit(1);
  }
  await sleep(100);
}
console.error('The book tab did not start the share in time.');
process.exit(1);
