// The specbook share server. One Durable Object holds every room; its sockets hibernate, so an idle share costs
// nothing. It never sees a book: only handshake messages pass through it. The host is the owner's book server (the
// specbook plugin's server/lib/host.mjs); for protocol 1 and 2 rooms, the owner's open book tab (plugin 1.3 and older).
//
//   GET  /                         the plugin's front page (public/index.html)
//   GET  /s/<room>                 the reader: public/r/<version>/share.html for a protocol 3 room (the version its host
//                                  named), with the CSP, or a 503 notice when that version is not published here;
//                                  public/guest.html, as it was, for protocol 1 and 2 rooms
//   GET  /r/<version>/...          the published readers, and /r/versions.json
//   GET  /guest.js                 the protocol 1 and 2 guest page's script
//   POST /api/rooms                { hours, protocol, reader } -> { room, hostToken, expiresAt }   (the host; CORS for localhost)
//                                  { ..., room, hostToken }: renews that room, or opens it again under its id
//   GET  /api/rooms/<room>          { host, protocol, reader, keeps }: whether the room exists, its host is there, its protocol,
//                                  and that this server renews and reopens rooms (open() with { room, hostToken })
//   POST /api/rooms/<room>/end      { token }: ends the room (the host's local server, or its tab)
//   GET  /api/rooms/<room>/host    WebSocket, ?token=hostToken
//   GET  /api/rooms/<room>/guest   WebSocket; while the host is away it waits, and hears host-online when it comes
//   GET  /api/rooms/<room>/ice     { iceServers }: STUN, plus TURN when the TURN secrets are set
import { DurableObject } from 'cloudflare:workers';
import { assetHeaders, CSP, heldUntil, mayReopen, sameToken, GUEST_IDLE_MS, isLocalOrigin, MAX_GUESTS, MAX_MESSAGE, STUN, countRoom, fromGuest, fromHost, mayMintTurn, mayWait, NEEDS_NEWER, newId, pageFor, renewed as renewedRoom, shareChoice, roomHours, roomProtocol, turnServers, validId, validReader, WAIT_MS } from './rules.mjs';


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // The front page tells what the specbook plugin is and how to install it.
    if (path === '/' || path === '/index.html') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url)));
    }
    const share = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(path);
    if (share) {
      return sharePage(request, env, url, share[1]);
    }
    // The reader, by version: a published folder never changes, so it is cached for good; the list of versions is not.
    if (path.startsWith('/r/')) {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(assetHeaders(path, res.status, { noCache: !!env.DEBUG_NO_CACHE }))) {
        headers.set(k, v);
      }
      return new Response(res.body, { status: res.status, headers });
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

// The versions of the reader this site holds (public/r/versions.json): a list of versions, or { versions: [...] }.
async function readerVersions(env, url) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/r/versions.json', url)));
    const body = res.ok ? await res.json() : [];
    const list = Array.isArray(body) ? body : body?.versions;
    return Array.isArray(list) ? list.filter(validReader) : [];
  } catch {
    return [];
  }
}

// /s/<room>: the guest page that matches the room's protocol and reader version.
async function sharePage(request, env, url, id) {
  const info = await env.BROKER.get(env.BROKER.idFromName('broker')).fetch(new Request(new URL(`/api/rooms/${id}`, url)));
  const room = info.ok ? await info.json() : null;
  const versions = await readerVersions(env, url);
  const page = pageFor(room, versions);
  const choice = shareChoice(page, versions);
  if (choice.unavailable) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>Spec book</title><p>${NEEDS_NEWER}</p>`, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' },
    });
  }
  const res = await env.ASSETS.fetch(new Request(new URL(choice.file, url)));
  const headers = new Headers(res.headers);
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cache-control', 'no-store');
  if (choice.csp) {
    headers.set('content-security-policy', CSP);
  }
  return new Response(res.body, { status: res.status, headers });
}

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

// A host token, as open() makes them (24 random bytes, base64url).
const HOST_TOKEN = /^[A-Za-z0-9_-]{32}$/;
// How long an ended room's address keeps saying it ended.
const ENDED_KEPT_MS = 7 * 86400_000;

// The SHA-256 of a host token, base64url: what `held:<id>` keeps, so the token itself is not stored past its room.
async function tokenHash(token) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    const m = /^\/api\/rooms\/([^/]+)(?:\/(host|guest|ice|end))?$/.exec(url.pathname);
    if (!m) {
      return json(404, { error: 'not-found' });
    }
    const room = await this.room(m[1]);
    if (!room) {
      // Ended by its host (New link, Stop): 410, so its guests are told it ended, not that it is closed for now.
      if (validId(m[1]) && (await this.ctx.storage.get(`ended:${m[1]}`))) {
        return json(410, { error: 'ended' });
      }
      return json(404, { error: 'no-room' });
    }
    // Whether the room still exists, and whether its host is there.
    if (!m[2]) {
      return json(200, { host: this.ctx.getWebSockets(`host:${m[1]}`).length > 0, protocol: room.protocol ?? 1, reader: room.reader, keeps: true });
    }
    // The host ends its room: its tab on New link or Stop, or its local server when it stops.
    if (m[2] === 'end') {
      if (request.method !== 'POST') {
        return json(405, { error: 'post-required' });
      }
      let body = {};
      try {
        body = await request.json();
      } catch {
        // no body: no token
      }
      if (!sameToken(body.token, room.hostToken)) {
        return json(403, { error: 'bad-token' });
      }
      await this.close(m[1], true);
      return new Response(null, { status: 204 });
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
      const res = this.accept({ role: 'host', room: m[1] }, [`host:${m[1]}`]);
      // Only a room a host has opened lets guests wait for it.
      if (!room.hosted) {
        await this.ctx.storage.put(`room:${m[1]}`, { ...(await this.room(m[1])), hosted: true });
      }
      // Guests waiting for the host start their handshake now, with a fresh minute for it.
      const now = Date.now();
      for (const g of this.ctx.getWebSockets(`guest:${m[1]}`)) {
        const a = g.deserializeAttachment();
        g.serializeAttachment({ ...a, at: now, iced: false, offered: false });
        try {
          g.send(JSON.stringify({ type: 'host-online' }));
        } catch {
          // closing
        }
      }
      await this.schedule(now + GUEST_IDLE_MS);
      return res;
    }
    if (this.ctx.getWebSockets(`guest:${m[1]}`).length >= MAX_GUESTS) {
      return json(429, { error: 'full' });
    }
    const gid = randomId(9);
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    const away = !this.ctx.getWebSockets(`host:${m[1]}`).length;
    if (away) {
      const waitingFromIp = this.ctx.getWebSockets(`guest:${m[1]}`).filter(g => g.deserializeAttachment()?.ip === ip).length;
      if (!mayWait({ hosted: room.hosted, waitingFromIp })) {
        return json(409, { error: room.hosted ? 'too-many-waiting' : 'host-offline' });
      }
    }
    const res = this.accept({ role: 'guest', room: m[1], gid, at: Date.now(), ip, iced: false, offered: false }, [`guest:${m[1]}`, `g:${m[1]}:${gid}`], away ? { type: 'host-offline' } : null);
    // A guest's socket is for the handshake: while the host is there, the alarm closes any left open, so idle sockets
    // cannot fill a room. While the host is away it waits (hibernating, at no cost) to hear host-online.
    await this.schedule(Date.now() + (away ? WAIT_MS : GUEST_IDLE_MS));
    return res;
  }

  accept(attachment, tags, hello = null) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment(attachment);
    if (hello) {
      pair[1].send(JSON.stringify(hello));
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Opens a room. With { room, hostToken }, the host keeps its link: its room is renewed (200), or opened again under
  // the same id once it expired or was ended (201); a room held under another token is not given up (409).
  async open(request) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    const now = Date.now();
    let body = {};
    try {
      body = await request.json();
    } catch {
      // no body: the default length
    }
    const until = now + roomHours(body.hours) * 3600_000;
    const keep = validId(body.room) && typeof body.hostToken === 'string' && HOST_TOKEN.test(body.hostToken);
    if (keep && (await this.ctx.storage.get(`ended:${body.room}`))) {
      return json(409, { error: 'ended' });
    }
    if (keep) {
      const held = await this.room(body.room);
      if (held) {
        if (!sameToken(body.hostToken, held.hostToken)) {
          return json(409, { error: 'taken' });
        }
        const renewed = renewedRoom(held, body, until);
        await this.ctx.storage.put(`room:${body.room}`, renewed);
        await this.hold(body.room, held.hostToken, renewed.expiresAt);
        await this.schedule();
        return json(200, { room: body.room, hostToken: held.hostToken, expiresAt: new Date(renewed.expiresAt).toISOString(), keeps: true });
      }
      // Expired: only the token it was held under opens it again. Under protocol 3 whoever holds the room is the book,
      // so a former guest who knows its id must not get it.
      if (!mayReopen({ held: await this.ctx.storage.get(`held:${body.room}`), tokenHash: await tokenHash(body.hostToken), now })) {
        return json(409, { error: 'taken' });
      }
    }
    const rate = countRoom(await this.ctx.storage.get(`ip:${ip}`), now);
    await this.ctx.storage.put(`ip:${ip}`, rate.next);
    if (!rate.ok) {
      return json(429, { error: 'too-many-rooms' });
    }
    const id = keep ? body.room : newId();
    const room = { hostToken: keep ? body.hostToken : randomId(24), expiresAt: until, created: now, protocol: roomProtocol(body.protocol) };
    if (validReader(body.reader)) {
      room.reader = body.reader;
    }
    await this.ctx.storage.put(`room:${id}`, room);
    await this.hold(id, room.hostToken, room.expiresAt);
    await this.schedule();
    return json(201, { room: id, hostToken: room.hostToken, expiresAt: new Date(room.expiresAt).toISOString(), keeps: true });
  }

  // Keeps a room's id for its host until HELD_KEPT_MS past its expiry: only its token opens it again.
  async hold(id, hostToken, expiresAt) {
    await this.ctx.storage.put(`held:${id}`, { hash: await tokenHash(hostToken), until: heldUntil(expiresAt) });
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
      const out = fromGuest(msg, me.gid, ((await this.room(me.room))?.protocol ?? 1));
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
      await this.close(me.room, true);
      return;
    }
    const out = fromHost(msg, ((await this.room(me.room))?.protocol ?? 1));
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
      const now = Date.now();
      for (const g of this.ctx.getWebSockets(`guest:${me.room}`)) {
        // The wait for the host starts now.
        g.serializeAttachment({ ...g.deserializeAttachment(), at: now });
        g.send(JSON.stringify({ type: 'host-offline' }));
      }
      await this.schedule(now + WAIT_MS);
      // The host tab closed or reloaded: the room stays until it expires or is ended, so the same link works when the
      // book is open again. Its guests wait for host-online.
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }

  // Ends a room: every socket in it is closed and it is forgotten. One its host ended stays ended: it is not opened
  // again under its id, and for a week its address says so (410).
  async close(id, ended = false) {
    await this.ctx.storage.delete(`room:${id}`);
    if (ended) {
      await this.ctx.storage.put(`ended:${id}`, Date.now() + ENDED_KEPT_MS);
    }
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
      soonest = Math.min(soonest, r.expiresAt);
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
    let waitEnds = Infinity;
    for (const g of this.ctx.getWebSockets()) {
      const a = g.deserializeAttachment();
      if (a?.role === 'guest') {
        // A guest waiting for a host that is away is not idle, but it waits WAIT_MS at most.
        if (!this.ctx.getWebSockets(`host:${a.room}`).length) {
          if (now - a.at >= WAIT_MS) {
            try {
              g.close(4408, 'waited');
            } catch {
              // already closed
            }
          } else {
            waitEnds = Math.min(waitEnds, a.at + WAIT_MS);
          }
          continue;
        }
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
      if (r.expiresAt <= now) {
        await this.close(key.slice('room:'.length));
      }
    }
    for (const [key, until] of await this.ctx.storage.list({ prefix: 'ended:' })) {
      if (until <= now) {
        await this.ctx.storage.delete(key);
      }
    }
    for (const [key, held] of await this.ctx.storage.list({ prefix: 'held:' })) {
      if (!(held?.until > now)) {
        await this.ctx.storage.delete(key);
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
    await this.schedule(Math.min(guestsLeft ? now + GUEST_IDLE_MS : Infinity, waitEnds));
  }
}
