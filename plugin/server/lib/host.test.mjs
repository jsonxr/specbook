import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { framesOf } from './channel.mjs';
import { createHost } from './host.mjs';

// A fake share server: opens and renews rooms, answers a room's state and ICE, and records every POST body.
// Rooms in `taken` are held there under another token (409 taken); rooms in `missing` are not there (404).
function fakeBroker() {
  const posts = [];
  const taken = new Set();
  const missing = new Set();
  let n = 0;
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', d => { text += d; });
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const expiresAt = '2026-11-16T00:00:00.000Z';
      if (req.method === 'POST' && req.url === '/api/rooms') {
        const body = JSON.parse(text);
        posts.push(body);
        if (body.room && taken.has(body.room)) {
          send(409, { error: 'taken' });
          return;
        }
        if (body.room) {
          send(200, { room: body.room, hostToken: body.hostToken, expiresAt, keeps: true });
        } else {
          n++;
          send(201, { room: `Room${String(n).padStart(18, '0')}`, hostToken: 'T'.repeat(32), expiresAt, keeps: true });
        }
        return;
      }
      if (req.method === 'POST' && /^\/api\/rooms\/[^/]+\/end$/.test(req.url)) {
        posts.push({ end: req.url, ...JSON.parse(text) });
        send(200, { ok: true });
        return;
      }
      if (req.method === 'GET' && /^\/api\/rooms\/[^/]+\/ice\?/.test(req.url)) {
        send(200, { iceServers: [] });
        return;
      }
      if (req.method === 'GET' && /^\/api\/rooms\/[^/?]+$/.test(req.url)) {
        if (missing.has(req.url.slice('/api/rooms/'.length))) {
          send(404, { error: 'no-room' });
          return;
        }
        send(200, { host: false, protocol: 3, keeps: true, reader: '1.4.0' });
        return;
      }
      send(404, { error: 'not-found' });
    });
  });
  return { server, posts, taken, missing };
}

// The book server on this machine, as far as the host can tell: it records every call.
function fakeBook() {
  const calls = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', d => { text += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: text });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, calls };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
  }
  send(text) { this.sent.push(text); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  deliver(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

class FakePeer extends EventTarget {
  static all = [];
  constructor(config) {
    super();
    this.config = config;
    this.iceGatheringState = 'complete';
    this.connectionState = 'new';
    this.localDescription = null;
    FakePeer.all.push(this);
  }
  async setRemoteDescription(d) { this.remote = d; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  close() { this.connectionState = 'closed'; }
}

class FakeChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.sent = [];
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 'closed'; this.onclose?.({}); }
  frame(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

async function until(fn, what) {
  for (let i = 0; i < 400; i++) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function setup(t, { saved = null, onState } = {}) {
  const broker = fakeBroker();
  const book = fakeBook();
  const brokerPort = await listen(broker.server);
  const port = await listen(book.server);
  const host = createHost({
    broker: `http://127.0.0.1:${brokerPort}`,
    port,
    version: '1.4.0',
    ownerName: 'Jason',
    saved,
    rtc: { RTCPeerConnection: FakePeer },
    WebSocket: FakeSocket,
    readNotes: () => ({}),
    onState: onState ?? (() => {}),
  });
  t.after(async () => {
    host.stop({ end: false });
    await close(broker.server);
    await close(book.server);
  });
  return { host, broker, book, brokerUrl: `http://127.0.0.1:${brokerPort}` };
}

// A reader connecting: the offer through the share server's socket, then its data channel.
async function connect(host) {
  const ws = FakeSocket.all.at(-1);
  if (ws.readyState !== 1) ws.open();
  const peers = FakePeer.all.length;
  const from = `g${peers}`;
  ws.deliver({ type: 'offer', from, key: `guestkey${String(peers).padStart(4, '0')}`, name: 'Ann', device: 'device0001', sdp: 'offer-sdp', protocol: 3 });
  await until(() => ws.sent.map(s => JSON.parse(s)).find(m => m.type === 'answer' && m.to === from), 'the answer');
  const pc = FakePeer.all.at(-1);
  const ch = new FakeChannel();
  pc.ondatachannel({ channel: ch });
  return ch;
}

async function call(ch, id, method, path, body = '') {
  for (const f of framesOf({ t: 'req', id, method, path }, Buffer.from(body))) ch.frame(f);
  const last = await until(() => ch.sent.find(f => f.t === 'res' && f.id === id && f.last), `the answer to ${path}`);
  return last.status;
}

test('start() with nothing saved opens a protocol 3 room and gives a plain link and a pin link', async t => {
  const { host, broker, brokerUrl } = await setup(t);
  assert.equal(host.state(), 'off');
  assert.equal(host.links(), null);
  await host.start();
  assert.deepEqual(broker.posts[0], { protocol: 3, reader: '1.4.0', hours: 24 });
  const { url, pinUrl } = host.links();
  assert.equal(url, `${brokerUrl}/s/Room000000000000000001`);
  assert.ok(!url.includes('#'));
  const m = /#pin=(.*)$/.exec(pinUrl);
  assert.ok(m);
  assert.equal(pinUrl, `${url}#pin=${m[1]}`);
  assert.match(m[1], /^[A-Za-z0-9]{22}$/);
  FakeSocket.all.at(-1).open();
  assert.equal(host.state(), 'live');
});

test('start() with a saved room renews that room and keeps its link and pin', async t => {
  const saved = { room: 'SavedRoom0000000000001', hostToken: 'H'.repeat(32), pin: 'p'.repeat(22), expiresAt: '2026-11-15T00:00:00.000Z' };
  const { host, broker, brokerUrl } = await setup(t, { saved });
  await host.start();
  assert.equal(broker.posts[0].room, saved.room);
  assert.equal(broker.posts[0].hostToken, saved.hostToken);
  assert.equal(broker.posts[0].protocol, 3);
  assert.equal(broker.posts[0].reader, '1.4.0');
  assert.equal(host.links().url, `${brokerUrl}/s/${saved.room}`);
  assert.equal(host.links().pinUrl, `${brokerUrl}/s/${saved.room}#pin=${saved.pin}`);
  assert.ok(FakeSocket.all.at(-1).url.endsWith(`/api/rooms/${saved.room}/host?token=${saved.hostToken}`));
});

test('start() with a saved room taken under another token opens a new room with a new pin', async t => {
  const saved = { room: 'SavedRoom0000000000003', hostToken: 'H'.repeat(32), pin: 'p'.repeat(22), expiresAt: null };
  const views = [];
  const { host, broker, brokerUrl } = await setup(t, { saved, onState: v => views.push(v) });
  broker.taken.add(saved.room);
  await host.start();
  assert.equal(broker.posts[0].room, saved.room);
  assert.equal(broker.posts[1].room, undefined);
  const { url, pinUrl } = host.links();
  assert.equal(url, `${brokerUrl}/s/Room000000000000000001`);
  const pin = /#pin=(.*)$/.exec(pinUrl)[1];
  assert.notEqual(pin, saved.pin);
  assert.match(pin, /^[A-Za-z0-9]{22}$/);
  assert.equal(views.at(-1).pin, pin);
});

test('a room taken while it is being reopened is let go, and the next start has a new pin', async t => {
  const saved = { room: 'SavedRoom0000000000004', hostToken: 'H'.repeat(32), pin: 'p'.repeat(22), expiresAt: null };
  const views = [];
  const { host, broker } = await setup(t, { saved, onState: v => views.push(v) });
  await host.start();
  assert.equal(host.links().pinUrl.endsWith(`#pin=${saved.pin}`), true);
  // The room expired there and someone else opened it under its id.
  broker.missing.add(saved.room);
  broker.taken.add(saved.room);
  const ws = FakeSocket.all.at(-1);
  ws.open();
  ws.onclose({ code: 1006 });
  await until(() => host.state() === 'off', 'the host to let the room go');
  assert.notEqual(views.at(-1).pin, saved.pin);
  await host.start();
  const pin = /#pin=(.*)$/.exec(host.links().pinUrl)[1];
  assert.notEqual(pin, saved.pin);
  assert.notEqual(host.links().url.split('/s/')[1], saved.room);
});

test('newPin() changes the pin, keeps the room, and reports the new pin', async t => {
  const views = [];
  const { host } = await setup(t, { onState: v => views.push(v) });
  await host.start();
  const before = host.links();
  host.newPin();
  const after = host.links();
  assert.equal(after.url, before.url);
  assert.notEqual(after.pinUrl, before.pinUrl);
  const pin = after.pinUrl.split('#pin=')[1];
  assert.match(pin, /^[A-Za-z0-9]{22}$/);
  assert.equal(views.at(-1).pin, pin);
  assert.equal(views.at(-1).room, before.url.split('/s/')[1]);
});

test('rights follow the pin', async t => {
  const { host, book } = await setup(t);
  await host.start();
  const pin = host.links().pinUrl.split('#pin=')[1];

  // A guest: an owner route is refused before it reaches the book server; a read goes through, marked as theirs.
  const guest = await connect(host);
  guest.frame({ t: 'req', id: 0, method: 'GET', path: '/api/book', seq: 0, last: true, data: '' });
  guest.frame({ t: 'hello', protocol: 3, version: '1.4.0' });
  const welcome = await until(() => guest.sent.find(f => f.t === 'welcome'), 'welcome');
  assert.equal(welcome.role, 'guest');
  assert.equal(welcome.protocol, 3);
  assert.equal(welcome.version, '1.4.0');
  assert.equal(welcome.ownerName, 'Jason');
  assert.equal(typeof welcome.you, 'string');
  assert.ok(!guest.sent.some(f => f.t === 'res' && f.id === 0), 'a frame before hello is dropped');
  assert.equal(await call(guest, 1, 'POST', '/api/requests', '{}'), 403);
  assert.equal(book.calls.length, 0);
  assert.equal(await call(guest, 2, 'GET', '/api/book'), 200);
  assert.equal(book.calls.length, 1);
  assert.ok(book.calls[0].headers['x-specbook-guest']);
  assert.equal(book.calls[0].headers.host, `127.0.0.1:${book.server.address().port}`);

  // The pin: the same call reaches the book server as the owner's (no guest header).
  const owner = await connect(host);
  owner.frame({ t: 'hello', protocol: 3, version: '1.4.0', pin });
  const ownerWelcome = await until(() => owner.sent.find(f => f.t === 'welcome'), 'owner welcome');
  assert.equal(ownerWelcome.role, 'owner');
  assert.equal(await call(owner, 1, 'POST', '/api/requests', '{"a":1}'), 200);
  const made = book.calls.at(-1);
  assert.equal(made.method, 'POST');
  assert.equal(made.url, '/api/requests');
  assert.equal(made.body, '{"a":1}');
  assert.equal(made.headers['x-specbook-guest'], undefined);
  // Even the owner cannot manage the share through the link.
  assert.equal(await call(owner, 2, 'POST', '/api/share/stop', '{}'), 403);

  const people = host.people();
  assert.deepEqual(people.map(p => p.role).sort(), ['guest', 'owner', 'owner']);
  const pinned = people.find(p => p.id === ownerWelcome.you);
  assert.equal(pinned.role, 'owner');
  assert.equal(pinned.name, 'Jason');
});

test('a wrong pin gets pin-bad and guest rights', async t => {
  const { host, book } = await setup(t);
  await host.start();
  const ch = await connect(host);
  ch.frame({ t: 'hello', protocol: 3, version: '1.4.0', pin: 'x'.repeat(22) });
  await until(() => ch.sent.find(f => f.t === 'welcome'), 'welcome');
  assert.equal(ch.sent[0].t, 'pin-bad');
  assert.equal(ch.sent.find(f => f.t === 'welcome').role, 'guest');
  assert.equal(await call(ch, 1, 'POST', '/api/requests', '{}'), 403);
  assert.equal(book.calls.length, 0);
});

test('a reader of another protocol hears only the protocol and version', async t => {
  const { host, book } = await setup(t);
  await host.start();
  const ch = await connect(host);
  ch.frame({ t: 'hello', protocol: 2, version: '1.3.0' });
  await until(() => ch.sent.length, 'an answer');
  assert.deepEqual(ch.sent, [{ t: 'welcome', protocol: 3, version: '1.4.0' }]);
  ch.frame({ t: 'req', id: 1, method: 'GET', path: '/api/book', seq: 0, last: true, data: '' });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(ch.sent.length, 1);
  assert.equal(book.calls.length, 0);
});

test('a path that names another host is refused', async t => {
  const { host, book } = await setup(t);
  await host.start();
  const ch = await connect(host);
  const pin = host.links().pinUrl.split('#pin=')[1];
  ch.frame({ t: 'hello', protocol: 3, version: '1.4.0', pin });
  await until(() => ch.sent.find(f => f.t === 'welcome'), 'welcome');
  assert.equal(await call(ch, 1, 'GET', '//example.com/x'), 403);
  assert.equal(await call(ch, 2, 'GET', '/\\example.com/x'), 403);
  assert.equal(await call(ch, 3, 'GET', 'http://example.com/x'), 403);
  assert.equal(book.calls.length, 0);
});

test('live frames pass between readers and to the localhost tabs, stamped by the host', async t => {
  const { host } = await setup(t);
  const heard = [];
  host.onLive(m => heard.push(m));
  await host.start();
  const a = await connect(host);
  a.frame({ t: 'hello', protocol: 3, version: '1.4.0' });
  const you = (await until(() => a.sent.find(f => f.t === 'welcome'), 'welcome')).you;
  const roster = await until(() => a.sent.find(f => f.t === 'live' && f.kind === 'roster'), 'roster');
  assert.equal(roster.you, you);
  a.frame({ t: 'live', kind: 'where', from: 'host', section: 's1' });
  const where = await until(() => heard.find(m => m.kind === 'where'), 'where');
  assert.equal(where.from, you);
  host.sendLive({ kind: 'where', section: 's2', from: 'someone' });
  const back = a.sent.find(f => f.t === 'live' && f.kind === 'where');
  assert.equal(back.from, 'host');
  host.changed();
  assert.ok(a.sent.some(f => f.t === 'changed'));
});

test('stop({ end: true }) ends the room at the share server', async t => {
  const { host, broker } = await setup(t);
  await host.start();
  const room = host.links().url.split('/s/')[1];
  await host.stop({ end: true });
  assert.equal(host.state(), 'off');
  assert.equal(host.links(), null);
  assert.deepEqual(broker.posts.at(-1), { end: `/api/rooms/${room}/end`, token: 'T'.repeat(32) });
});

test('stop({ end: true }) ends a remembered room it is not hosting, and a later start opens a new one', async t => {
  const saved = { room: 'SavedRoom0000000000002', hostToken: 'H'.repeat(32), pin: 'p'.repeat(22), expiresAt: null };
  const { host, broker } = await setup(t, { saved });
  await host.stop({ end: true });
  assert.deepEqual(broker.posts.at(-1), { end: `/api/rooms/${saved.room}/end`, token: saved.hostToken });
  await host.start();
  assert.deepEqual(broker.posts.at(-1), { protocol: 3, reader: '1.4.0', hours: 24 });
});

test('a stop while starting cancels that start, and start() works again after it', async t => {
  const { host } = await setup(t);
  const first = host.start();
  host.stop({ end: false });
  await first;
  assert.equal(host.links(), null);
  assert.equal(host.state(), 'off');
  await host.start();
  assert.ok(host.links());
});

async function ownerChannel(host) {
  const ch = await connect(host);
  ch.frame({ t: 'hello', protocol: 3, version: '1.4.0', pin: host.links().pinUrl.split('#pin=')[1] });
  await until(() => ch.sent.find(f => f.t === 'welcome' && f.role === 'owner'), 'owner welcome');
  return ch;
}
// A channel the real library might keep delivering on after it was closed.
function sendAnyway(ch, f) {
  ch.onmessage?.({ data: JSON.stringify(f) });
}

test('after newPin(), the old owner channel can make no call', async t => {
  const { host, book } = await setup(t);
  await host.start();
  const ch = await ownerChannel(host);
  host.newPin();
  for (const f of framesOf({ t: 'req', id: 9, method: 'POST', path: '/api/requests' }, Buffer.from('{}'))) sendAnyway(ch, f);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(book.calls.length, 0);
  assert.equal(ch.readyState, 'closed');
});

test('after a bye, the channel can make no call', async t => {
  const { host, book } = await setup(t);
  await host.start();
  const ch = await ownerChannel(host);
  ch.frame({ t: 'live', kind: 'bye' });
  assert.equal(ch.readyState, 'closed');
  for (const f of framesOf({ t: 'req', id: 9, method: 'GET', path: '/api/book' }, new Uint8Array(0))) sendAnyway(ch, f);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(book.calls.length, 0);
});

test('a live draft arriving after stop() does nothing and does not throw', async t => {
  const { host } = await setup(t);
  const heard = [];
  host.onLive(m => heard.push(m));
  await host.start();
  const ch = await connect(host);
  ch.frame({ t: 'hello', protocol: 3, version: '1.4.0' });
  await until(() => ch.sent.find(f => f.t === 'welcome'), 'welcome');
  await host.stop({ end: false });
  const before = heard.length;
  assert.doesNotThrow(() => sendAnyway(ch, { t: 'live', kind: 'draft', note: 'n1', text: 'hi' }));
  assert.doesNotThrow(() => sendAnyway(ch, { t: 'live', kind: 'typing', note: 'n1', on: true }));
  assert.equal(heard.length, before);
});

test('a reader cannot stamp its own name, role, color or author', async t => {
  const { host } = await setup(t);
  const heard = [];
  host.onLive(m => heard.push(m));
  await host.start();
  const ch = await connect(host);
  ch.frame({ t: 'hello', protocol: 3, version: '1.4.0' });
  const you = (await until(() => ch.sent.find(f => f.t === 'welcome'), 'welcome')).you;
  const spoof = { role: 'owner', name: 'Owner', color: '#000000', author: 'Owner' };
  ch.frame({ t: 'live', kind: 'typing', note: 'n1', on: true, ...spoof });
  const typing = await until(() => heard.find(m => m.kind === 'typing'), 'typing');
  assert.equal(typing.from, you);
  for (const k of ['role', 'name', 'color', 'author']) assert.equal(typing[k], undefined, k);
  ch.frame({ t: 'live', kind: 'draft', note: 'n1', text: 'x', ...spoof });
  const draft = await until(() => heard.find(m => m.kind === 'draft'), 'draft');
  assert.equal(draft.author, 'Ann');
  assert.equal(draft.role, undefined);
  ch.frame({ t: 'live', kind: 'hello', ...spoof });
  const hello = await until(() => heard.find(m => m.kind === 'hello' && m.color !== undefined && m.from === you && heard.indexOf(m) > heard.indexOf(draft)), 'hello');
  assert.equal(hello.role, 'guest');
  assert.equal(hello.name, 'Ann');
  assert.notEqual(hello.color, '#000000');
});
