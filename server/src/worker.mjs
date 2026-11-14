// The specbook share server. One Durable Object holds every room; its sockets hibernate, so an idle share costs
// nothing. It never sees a book: only signed handshake messages pass through it. The host is the owner's open book
// tab (the specbook plugin's app/host.js); the reader itself comes to each guest from that tab, over the connection.
//
//   GET  /                         the plugin's front page (public/index.html)
//   GET  /s/<room>                 the guest page (public/guest.html): asks a name, connects, loads the reader
//   GET  /guest.js                 its script
//   POST /api/rooms                { hours } -> { room, hostToken, expiresAt }   (the host tab; CORS for localhost)
//   GET  /api/rooms/<room>/host    WebSocket, ?token=hostToken
//   GET  /api/rooms/<room>/guest   WebSocket
//   GET  /api/rooms/<room>/ice     { iceServers }: STUN, plus TURN when the TURN secrets are set
import { DurableObject } from 'cloudflare:workers';
import { HOST_GRACE_MS, GUEST_IDLE_MS, isLocalOrigin, MAX_GUESTS, MAX_MESSAGE, STUN, countRoom, fromGuest, fromHost, mayMintTurn, roomHours, turnServers, validId } from './rules.mjs';


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // The front page tells what the specbook plugin is and how to install it.
    if (path === '/' || path === '/index.html') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url)));
    }
    if (/^\/s\/[A-Za-z0-9_-]+\/?$/.test(path)) {
      const page = await env.ASSETS.fetch(new Request(new URL('/guest.html', url)));
      const headers = new Headers(page.headers);
      headers.set('referrer-policy', 'no-referrer');
      headers.set('cache-control', 'no-store');
      return new Response(page.body, { status: page.status, headers });
    }
    if (path === '/guest.js') {
      return env.ASSETS.fetch(request);
    }
    if (path.startsWith('/api/')) {
      const cors = corsFor(request);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
      }
      const res = await env.BROKER.get(env.BROKER.idFromName('broker')).fetch(request);
      if (!cors || res.webSocket) {
        return res;
      }
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) {
        headers.set(k, v);
      }
      return new Response(res.body, { status: res.status, headers });
    }
    return new Response('Not found', { status: 404 });
  },
};

// The owner's book tab runs on the local server (http://localhost:<port>), so it calls this server across origins.
function corsFor(request) {
  const origin = request.headers.get('origin');
  if (!origin || !isLocalOrigin(origin)) {
    return null;
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function randomId(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export class Broker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // A keepalive ping is answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async room(id) {
    if (!validId(id)) {
      return null;
    }
    const room = await this.ctx.storage.get(`room:${id}`);
    return room && room.expiresAt > Date.now() ? room : null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return this.open(request);
    }
    const m = /^\/api\/rooms\/([^/]+)(?:\/(host|guest|ice))?$/.exec(url.pathname);
    if (!m) {
      return json(404, { error: 'not-found' });
    }
    const room = await this.room(m[1]);
    if (!room) {
      return json(404, { error: 'no-room' });
    }
    // Whether the room still exists, and whether its host is there.
    if (!m[2]) {
      return json(200, { host: this.ctx.getWebSockets(`host:${m[1]}`).length > 0 });
    }
    // The host's ICE servers (it asks once a share, with its token). A guest gets TURN only over its socket, once, and
    // only while the host is there; asked here, it gets STUN.
    if (m[2] === 'ice') {
      const host = sameToken(url.searchParams.get('token'), room.hostToken);
      return json(200, { iceServers: host ? await this.ice(m[1], room, 'host', true) : STUN });
    }
    if (request.headers.get('upgrade') !== 'websocket') {
      return json(426, { error: 'websocket-required' });
    }
    if (m[2] === 'host') {
      if (!sameToken(url.searchParams.get('token'), room.hostToken)) {
        return json(403, { error: 'bad-token' });
      }
      // A host that reconnects replaces its old socket.
      for (const old of this.ctx.getWebSockets(`host:${m[1]}`)) {
        old.close(4000, 'replaced');
      }
      if (room.hostGoneAt) {
        await this.ctx.storage.put(`room:${m[1]}`, { ...room, hostGoneAt: null });
      }
      return this.accept({ role: 'host', room: m[1] }, [`host:${m[1]}`]);
    }
    if (!this.ctx.getWebSockets(`host:${m[1]}`).length) {
      return json(409, { error: 'host-offline' });
    }
    if (this.ctx.getWebSockets(`guest:${m[1]}`).length >= MAX_GUESTS) {
      return json(429, { error: 'full' });
    }
    const gid = randomId(9);
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    const res = this.accept({ role: 'guest', room: m[1], gid, at: Date.now(), ip, iced: false, offered: false }, [`guest:${m[1]}`, `g:${m[1]}:${gid}`]);
    // A guest's socket is only for the handshake: the alarm closes any left open, so idle sockets cannot fill a room.
    const due = Date.now() + GUEST_IDLE_MS;
    const set = await this.ctx.storage.getAlarm();
    if (!set || set > due) {
      await this.ctx.storage.setAlarm(due);
    }
    return res;
  }

  accept(attachment, tags) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async open(request) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    const now = Date.now();
    const rate = countRoom(await this.ctx.storage.get(`ip:${ip}`), now);
    await this.ctx.storage.put(`ip:${ip}`, rate.next);
    if (!rate.ok) {
      return json(429, { error: 'too-many-rooms' });
    }
    let body = {};
    try {
      body = await request.json();
    } catch {
      // no body: the default length
    }
    const id = randomId(16);
    const room = { hostToken: randomId(24), expiresAt: now + roomHours(body.hours) * 3600_000, created: now };
    await this.ctx.storage.put(`room:${id}`, room);
    await this.schedule();
    return json(201, { room: id, hostToken: room.hostToken, expiresAt: new Date(room.expiresAt).toISOString() });
  }

  // STUN always; a TURN credential too while the room, the caller's address and the day are all under their caps.
  // The host asks once a share (with its token); each guest asks once a connection.
  async ice(id, room, ip, host) {
    const { TURN_KEY_ID: keyId, TURN_KEY_API_TOKEN: token } = this.env;
    if (!keyId || !token) {
      return STUN;
    }
    const today = new Date().toISOString().slice(0, 10);
    const day = `turn:${today}`;
    const byIp = `turnip:${today}:${ip}`;
    const used = (await this.ctx.storage.get(day)) ?? 0;
    const usedIp = host ? 0 : ((await this.ctx.storage.get(byIp)) ?? 0);
    if (!mayMintTurn({ room: room.turn ?? 0, ip: usedIp, day: used, cap: Number(this.env.TURN_DAILY_CAP ?? 200) })) {
      return STUN;
    }
    await this.ctx.storage.put(day, used + 1);
    if (!host) {
      await this.ctx.storage.put(byIp, usedIp + 1);
    }
    await this.ctx.storage.put(`room:${id}`, { ...room, turn: (room.turn ?? 0) + 1 });
    const ttl = Math.max(60, Math.min(86400, Math.round((room.expiresAt - Date.now()) / 1000)));
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl }),
      });
      return r.ok ? [...STUN, ...turnServers(await r.json())] : STUN;
    } catch {
      return STUN;
    }
  }

  async webSocketMessage(ws, message) {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_MESSAGE) {
      ws.close(1009, 'too-large');
      return;
    }
    const me = ws.deserializeAttachment();
    if (!me || !(await this.room(me.room))) {
      ws.close(4404, 'no-room');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (me.role === 'guest') {
      const hosts = this.ctx.getWebSockets(`host:${me.room}`);
      if (!hosts.length) {
        ws.send(JSON.stringify({ type: 'host-offline' }));
        return;
      }
      // One ICE request and one offer a socket: a socket cannot mint relay credentials or flood the host.
      if (msg.type === 'ice') {
        const iceServers = me.iced ? STUN : await this.ice(me.room, await this.room(me.room), me.ip, false);
        ws.serializeAttachment({ ...me, iced: true });
        ws.send(JSON.stringify({ type: 'ice', iceServers }));
        return;
      }
      const out = fromGuest(msg, me.gid);
      if (!out || me.offered) {
        return;
      }
      ws.serializeAttachment({ ...me, iced: true, offered: true });
      for (const h of hosts) {
        h.send(JSON.stringify(out));
      }
      return;
    }
    if (msg.type === 'end') {
      await this.close(me.room);
      return;
    }
    const out = fromHost(msg);
    if (out) {
      for (const g of this.ctx.getWebSockets(`g:${me.room}:${out.to}`)) {
        g.send(JSON.stringify(out.out));
      }
    }
  }

  async webSocketClose(ws, code) {
    const me = ws.deserializeAttachment();
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
    // A host that reconnected has a newer socket: its guests have not lost it.
    if (me?.role === 'host' && this.ctx.getWebSockets(`host:${me.room}`).every(h => h === ws)) {
      for (const g of this.ctx.getWebSockets(`guest:${me.room}`)) {
        g.send(JSON.stringify({ type: 'host-offline' }));
      }
      // The host tab closed, or lost its connection: the room ends unless it comes back within the grace.
      const room = await this.room(me.room);
      if (room) {
        await this.ctx.storage.put(`room:${me.room}`, { ...room, hostGoneAt: Date.now() });
        await this.schedule(Date.now() + HOST_GRACE_MS);
      }
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }

  // Ends a room: every socket in it is closed and it is forgotten.
  async close(id) {
    await this.ctx.storage.delete(`room:${id}`);
    for (const tag of [`host:${id}`, `guest:${id}`]) {
      for (const s of this.ctx.getWebSockets(tag)) {
        try {
          s.send(JSON.stringify({ type: 'gone' }));
          s.close(4404, 'room-closed');
        } catch {
          // already closed
        }
      }
    }
  }

  // The alarm fires when the soonest room expires, or at `sooner` (to close idle guest sockets).
  async schedule(sooner = Infinity) {
    const rooms = await this.ctx.storage.list({ prefix: 'room:' });
    let soonest = sooner;
    for (const r of rooms.values()) {
      soonest = Math.min(soonest, r.expiresAt, r.hostGoneAt ? r.hostGoneAt + HOST_GRACE_MS : Infinity);
    }
    const set = await this.ctx.storage.getAlarm();
    if (set && set > Date.now() && set < soonest) {
      return;
    }
    if (soonest !== Infinity) {
      await this.ctx.storage.setAlarm(soonest);
    }
  }

  async alarm() {
    const now = Date.now();
    let guestsLeft = false;
    for (const g of this.ctx.getWebSockets()) {
      const a = g.deserializeAttachment();
      if (a?.role === 'guest') {
        if (now - a.at >= GUEST_IDLE_MS) {
          try {
            g.close(4408, 'idle');
          } catch {
            // already closed
          }
        } else {
          guestsLeft = true;
        }
      }
    }
    for (const [key, r] of await this.ctx.storage.list({ prefix: 'room:' })) {
      if (r.expiresAt <= now || (r.hostGoneAt && now - r.hostGoneAt >= HOST_GRACE_MS)) {
        await this.close(key.slice('room:'.length));
      }
    }
    for (const [key, w] of await this.ctx.storage.list({ prefix: 'ip:' })) {
      if (now - w.start >= 3600_000) {
        await this.ctx.storage.delete(key);
      }
    }
    const date = new Date().toISOString().slice(0, 10);
    const today = `turn:${date}`;
    for (const prefix of ['turn:', 'turnip:']) {
      for (const key of (await this.ctx.storage.list({ prefix })).keys()) {
        if (key !== today && !key.startsWith(`turnip:${date}:`)) {
          await this.ctx.storage.delete(key);
        }
      }
    }
    await this.schedule(guestsLeft ? now + GUEST_IDLE_MS : Infinity);
  }
}
