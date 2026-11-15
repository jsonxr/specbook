// The book server as the host of a shared book. It opens a room on the share server (or keeps the one it remembers,
// so the link lasts), answers each reader's WebRTC offer, and serves the reader's calls by making them itself against
// this book server: a guest's marked as theirs (x-specbook-guest), so the server applies the guest's rights, and a
// reader who sent the pin as the owner's. It also passes live messages (presence, drafts, following: app/live.js)
// between everyone, the owner's localhost tabs included (sendLive and onLive). The reader's half is the reader the
// share server publishes under /r/<version>/.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { assembler, framesOf, mayCall, rightsOf } from './channel.mjs';
import { cleanName, encodeGuest, GUEST_HEADER } from './guest.mjs';
import { newPin as makePin, PIN, pinWaitMs } from './secret.mjs';

export const PROTOCOL = 3;
const MAX_GUESTS = 20;
const MAX_OPEN = 8;
const MAX_BODY = 2 * 1024 * 1024;
const IN_FLIGHT = 16; // requests one reader may have waiting
const SHARE_IN_FLIGHT = 48; // and all readers together
const MAX_RESPONSE = 64 * 1024 * 1024; // the largest file a reader may load (a recording, say)
const HOURS = 24;
const RENEW_MS = 6 * 3600 * 1000;
const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ID_OK = /^[A-Za-z0-9_-]{8,64}$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']);
const LIVE_KINDS = new Set(['hello', 'where', 'draft', 'typing', 'follow', 'bye']);

// app/relay.js, the rules the owner's page shares, run here as they do in the page.
const RELAY = (() => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'relay.js'), 'utf8');
  const window = {};
  runInNewContext(source, { window, crypto: globalThis.crypto, TextEncoder, btoa });
  return window.SpecRelay;
})();

function later(fn, ms) {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}
function every(fn, ms) {
  const t = setInterval(fn, ms);
  t.unref?.();
  return t;
}
function jsonBytes(o) {
  return new TextEncoder().encode(JSON.stringify(o));
}

// A response body, read no further than `max` bytes: null when it is larger.
async function readCapped(r, max) {
  if (Number(r.headers.get('content-length')) > max) {
    await r.body?.cancel().catch(() => {});
    return null;
  }
  if (!r.body) {
    return new Uint8Array(0);
  }
  const parts = [];
  let size = 0;
  for await (const part of r.body) {
    size += part.byteLength;
    if (size > max) {
      return null;
    }
    parts.push(part);
  }
  return new Uint8Array(Buffer.concat(parts));
}

export function createHost({ broker, port, version, ownerName, saved = null, rtc, WebSocket: Socket = globalThis.WebSocket, readNotes = () => ({}), onState = () => {} }) {
  broker = String(broker || '').replace(/\/+$/, '');
  const origin = `http://127.0.0.1:${port}`;
  const nameOfOwner = () => (typeof ownerName === 'function' ? ownerName() : ownerName) || 'Owner';
  // A saved pin of the old 22-character kind is replaced: pins are 6 digits.
  let pin = typeof saved?.pin === 'string' && PIN.test(saved.pin) ? saved.pin : makePin();
  // Wrong pins in a row, and until when every pin waits (pinWaitMs): a guess at the pin is slow.
  let wrongPins = 0;
  let pinsWaitUntil = 0;
  // The room this host keeps, while it lasts: { room, hostToken, expiresAt }.
  let kept = saved && ROOM_ID.test(saved.room ?? '') && typeof saved.hostToken === 'string' ? { room: saved.room, hostToken: saved.hostToken, expiresAt: saved.expiresAt ?? null } : null;
  let share = null; // the share being hosted: { room, token, expiresAt, keeps, ws, peers, claims, live, ice }
  let hostState = 'off';
  let error = null;
  let starting = 0; // which start is current: a stop while a room is being opened cancels it
  let inFlight = 0;
  const liveListeners = [];

  function joinedPeers() {
    return share ? Object.values(share.peers).filter(p => p.joined && p.id) : [];
  }
  // One person may have the book open in several tabs (the same key and device): they are one face.
  function once() {
    const seen = new Set();
    return joinedPeers().filter(p => !seen.has(p.id) && seen.add(p.id));
  }
  function view() {
    return {
      state: hostState,
      room: share?.room ?? kept?.room ?? null,
      hostToken: share?.token ?? kept?.hostToken ?? null,
      pin,
      expiresAt: share?.expiresAt ?? kept?.expiresAt ?? null,
      guests: once().filter(p => p.rights === 'guest').map(p => p.name),
      error,
    };
  }
  function report() {
    try {
      onState(view());
    } catch {
      // the caller's problem
    }
  }
  function setState(st, err = null) {
    hostState = st;
    error = err;
    report();
  }

  function nameOf(peer) {
    return peer.rights === 'owner' ? nameOfOwner() : peer.name;
  }
  function people() {
    const out = [{ id: 'host', name: nameOfOwner(), color: RELAY.colorOf('host'), role: 'owner' }];
    for (const p of once()) {
      out.push({ id: p.id, name: nameOf(p), color: RELAY.colorOf(p.id), role: p.rights });
    }
    return out;
  }

  function send(peer, msg) {
    try {
      if (peer.channel && peer.channel.readyState === 'open') {
        peer.channel.send(JSON.stringify(msg));
      }
    } catch {
      // closing
    }
  }
  // Live messages: to every joined reader but `except`, and to the localhost tabs unless `fromHost`.
  function relay(msg, except, fromHost) {
    for (const p of joinedPeers()) {
      if (p.id !== except) {
        send(p, msg);
      }
    }
    if (!fromHost) {
      for (const fn of liveListeners) {
        try {
          fn(msg);
        } catch {
          // a listener's problem
        }
      }
    }
  }
  function roster(peer) {
    send(peer, { t: 'live', kind: 'roster', you: peer.id, people: people() });
  }

  // A reader's live message: stamped with who sent it (never trusted from the reader), checked, then passed on.
  // Whether this reader is still connected to the share being hosted: a dropped or revoked connection has no rights,
  // whatever its channel still delivers.
  function current(peer) {
    return !!share && share.peers[peer.from] === peer;
  }

  function onLiveFrame(peer, f) {
    if (!LIVE_KINDS.has(f.kind)) {
      return;
    }
    // A reader closing their tab says so: they are let go at once, not when the connection times out.
    if (f.kind === 'bye') {
      drop(peer);
      return;
    }
    if (!current(peer)) {
      return;
    }
    // Who sent it is the host's to say: what the reader wrote there is dropped, on every kind.
    const { name, role, color, author, you, people: _, ...rest } = f;
    const msg = { ...rest, t: 'live', from: peer.id };
    if (msg.kind === 'hello') {
      Object.assign(msg, { name: nameOf(peer), color: RELAY.colorOf(peer.id), role: peer.rights });
      roster(peer);
    }
    if (msg.kind === 'draft' || (msg.kind === 'typing' && msg.note != null)) {
      let notes = {};
      try {
        notes = readNotes() ?? {};
      } catch {
        // no notes to check against
      }
      const sender = peer.rights === 'owner' ? { host: true } : { key: peer.key, id: peer.id };
      if (!RELAY.mayDraft(sender, msg.note, notes, share.claims)) {
        return;
      }
      if (msg.kind === 'draft') {
        msg.author = nameOf(peer);
      }
    }
    if (msg.kind === 'follow' && msg.leader !== null && typeof msg.leader !== 'string') {
      return;
    }
    relay(msg, peer.id, false);
  }

  // Sends frames as the channel drains.
  function sendFrames(ch, frames) {
    let i = 0;
    return new Promise(resolve => {
      function pump() {
        while (i < frames.length) {
          if (ch.readyState !== 'open') {
            resolve();
            return;
          }
          if (ch.bufferedAmount > 1000000) {
            ch.addEventListener('bufferedamountlow', pump, { once: true });
            return;
          }
          try {
            ch.send(JSON.stringify(frames[i++]));
          } catch {
            resolve();
            return;
          }
        }
        resolve();
      }
      ch.bufferedAmountLowThreshold = 256 * 1024;
      pump();
    });
  }

  // One reader's call: checked, then made against this book server with that reader's rights.
  async function answer(peer, header, body) {
    const reply = (status, type, bytes) => sendFrames(peer.channel, framesOf({ t: 'res', id: header.id, status, type }, bytes));
    const method = String(header.method || 'GET').toUpperCase();
    const raw = typeof header.path === 'string' && header.path.length < 2048 ? header.path : '';
    // Parsed against this server's own origin, and refused unless it stays there: a backslash, a tab or a // must not
    // turn the path into another host. What is fetched is the parsed path, never the raw text.
    let u = null;
    let path = '';
    try {
      u = new URL(raw, origin);
      path = decodeURIComponent(u.pathname);
    } catch {
      u = null;
    }
    if (!u || u.origin !== origin || !raw.startsWith('/') || !METHODS.has(method) || !mayCall(peer.rights, method, path)) {
      return reply(403, 'application/json', jsonBytes({ error: peer.rights === 'owner' ? 'forbidden' : 'guest' }));
    }
    if (!current(peer)) {
      return undefined;
    }
    if (peer.inFlight >= IN_FLIGHT || inFlight >= SHARE_IN_FLIGHT) {
      return reply(429, 'application/json', jsonBytes({ error: 'busy' }));
    }
    peer.inFlight++;
    inFlight++;
    try {
      const headers = {};
      if (peer.rights !== 'owner') {
        headers[GUEST_HEADER] = encodeGuest({ name: peer.name, key: peer.key });
      }
      // Every call that may carry a body takes JSON (the book server refuses any other type).
      const withBody = method !== 'GET' && method !== 'HEAD';
      if (withBody) {
        headers['content-type'] = 'application/json';
      }
      let r;
      try {
        if (!current(peer)) {
          return undefined;
        }
        r = await fetch(origin + u.pathname + u.search, { method, headers, body: withBody && body ? body : undefined, redirect: 'error' });
      } catch {
        return await reply(502, 'application/json', jsonBytes({ error: 'unreachable' }));
      }
      const bytes = await readCapped(r, MAX_RESPONSE).catch(() => undefined);
      if (bytes === undefined) {
        return await reply(502, 'application/json', jsonBytes({ error: 'unreachable' }));
      }
      if (bytes === null) {
        return await reply(413, 'application/json', jsonBytes({ error: 'too-large' }));
      }
      return await reply(r.status, r.headers.get('content-type') || 'application/octet-stream', bytes);
    } finally {
      peer.inFlight--;
      inFlight--;
    }
  }

  // The reader's first frame says who it is: the pin makes it the owner's.
  function onHello(peer, f) {
    if (f.protocol !== PROTOCOL) {
      peer.mismatched = true;
      send(peer, { t: 'welcome', protocol: PROTOCOL, version });
      return;
    }
    const tried = typeof f.pin === 'string' && f.pin !== '';
    const wait = pinsWaitUntil - Date.now();
    if (tried && wait > 0) {
      // Too many wrong pins were tried: this one is not even looked at. The reader keeps it and is a guest for now.
      peer.rights = 'guest';
      send(peer, { t: 'pin-wait', seconds: Math.ceil(wait / 1000) });
    } else {
      peer.rights = rightsOf(f, pin);
      if (tried && peer.rights !== 'owner') {
        wrongPins++;
        pinsWaitUntil = Date.now() + pinWaitMs(wrongPins);
        send(peer, { t: 'pin-bad' });
      } else if (tried) {
        wrongPins = 0;
      }
    }
    send(peer, { t: 'welcome', role: peer.rights, protocol: PROTOCOL, version, you: peer.id, ownerName: nameOfOwner() });
    // The same person in another tab (or device) of theirs stays: both tabs are live, as one face.
    peer.joined = true;
    roster(peer);
    relay({ t: 'live', kind: 'hello', from: peer.id, name: nameOf(peer), color: RELAY.colorOf(peer.id), role: peer.rights }, peer.id, false);
    report();
  }

  function onChannel(peer, ch) {
    peer.channel = ch;
    const frames = assembler({ maxOpen: MAX_OPEN, maxBody: MAX_BODY });
    ch.onmessage = e => {
      if (!current(peer) || peer.mismatched || typeof e.data !== 'string') {
        return;
      }
      let f;
      try {
        f = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!f || typeof f !== 'object') {
        return;
      }
      if (!peer.rights) {
        if (f.t === 'hello') {
          onHello(peer, f);
        }
        return; // frames before hello are dropped
      }
      if (f.t === 'live') {
        if (RELAY.liveFrameOk(e.data) && RELAY.liveRateOk(peer.bucket, Date.now())) {
          onLiveFrame(peer, f);
        }
        return;
      }
      const got = frames.push(f);
      if (got) {
        answer(peer, got.header, got.body.length ? got.body : null).catch(() => {});
      }
    };
    ch.onclose = () => drop(peer);
  }

  function drop(peer) {
    const s = share;
    if (!s || s.peers[peer.from] !== peer) {
      return;
    }
    delete s.peers[peer.from];
    clearTimeout(peer.timer);
    try {
      peer.channel?.close();
    } catch {
      // closed
    }
    try {
      peer.pc?.close();
    } catch {
      // closed
    }
    // They leave only when their last tab does.
    if (peer.joined && peer.id && !joinedPeers().some(p => p.id === peer.id)) {
      relay({ t: 'live', kind: 'bye', from: peer.id }, peer.id, false);
    }
    report();
  }

  async function iceServers(s) {
    if (s.ice) {
      return s.ice;
    }
    try {
      const r = await fetch(`${broker}/api/rooms/${s.room}/ice?token=${encodeURIComponent(s.token)}`);
      const j = await r.json();
      if (Array.isArray(j.iceServers)) {
        s.ice = j.iceServers;
        return s.ice;
      }
    } catch {
      // falls through
    }
    return [{ urls: 'stun:stun.cloudflare.com:3478' }];
  }
  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise(done => {
      const t = later(done, 5000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          done();
        }
      });
    });
  }

  function toBroker(s, msg) {
    try {
      s.ws.send(JSON.stringify(msg));
    } catch {
      // the socket is closing: the reader asks again
    }
  }

  async function onOffer(s, msg) {
    const reject = err => toBroker(s, { type: 'reject', to: msg.from, error: err });
    if (typeof msg.from !== 'string' || !ID_OK.test(msg.key ?? '') || !ID_OK.test(msg.device ?? '') || typeof msg.sdp !== 'string') {
      reject('bad-offer');
      return;
    }
    // One connection per reader socket, and the slot is taken before anything waits.
    if (Object.hasOwn(s.peers, msg.from) || Object.keys(s.peers).length >= MAX_GUESTS) {
      reject('full');
      return;
    }
    const peer = { from: msg.from, name: cleanName(msg.name), key: msg.key, id: null, rights: null, inFlight: 0, joined: false, channel: null, pc: null, bucket: {} };
    s.peers[msg.from] = peer;
    peer.timer = later(() => {
      if (!peer.joined) {
        drop(peer);
      }
    }, 30000);
    try {
      peer.id = await RELAY.peerIdOf(msg.key, msg.device);
      const ice = await iceServers(s);
      if (share !== s || s.peers[msg.from] !== peer) {
        return;
      }
      const pc = (peer.pc = new rtc.RTCPeerConnection({ iceServers: ice }));
      pc.ondatachannel = e => onChannel(peer, e.channel);
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          drop(peer);
        }
      });
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (share === s && s.peers[msg.from] === peer) {
        toBroker(s, { type: 'answer', to: msg.from, sdp: pc.localDescription.sdp });
      }
    } catch {
      drop(peer);
    }
  }

  function connectBroker(s, delay) {
    const ws = new Socket(`${broker.replace(/^http/, 'ws')}/api/rooms/${s.room}/host?token=${encodeURIComponent(s.token)}`);
    s.ws = ws;
    let ping = null;
    ws.onopen = () => {
      delay = 1000;
      ping = every(() => {
        if (ws.readyState === 1) {
          ws.send('ping');
        }
      }, 30000);
      if (share === s && !s.live) {
        s.live = true;
        setState('live');
      }
    };
    ws.onmessage = e => {
      if (e.data === 'pong' || share !== s) {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg?.type === 'offer') {
        onOffer(s, msg).catch(() => {});
      }
      if (msg?.type === 'gone') {
        gone(s);
      }
    };
    ws.onerror = () => {};
    ws.onclose = e => {
      clearInterval(ping);
      if (share !== s) {
        return;
      }
      if (e?.code === 4404 || e?.code === 4403) {
        gone(s);
        return;
      }
      // A room that is gone answers its address with 404 (which a socket only reports as a failed connection), so
      // that is asked first.
      s.retry = later(async () => {
        if (share !== s) {
          return;
        }
        const next = Math.min(delay * 2, 15000);
        try {
          const r = await fetch(`${broker}/api/rooms/${s.room}`);
          if (share !== s) {
            return;
          }
          // Expired (or ended) there: open it again under the same id, so the link keeps working.
          if (r.status === 404) {
            renew(s, () => connectBroker(s, 1000));
            return;
          }
          if (r.status === 410) {
            gone(s); // ended by its host
            return;
          }
          connectBroker(s, next);
        } catch {
          if (share === s) {
            connectBroker(s, next);
          }
        }
      }, delay);
    };
  }

  // Opens a room at the share server; with `keep` ({ room, hostToken }), that same room: renewed, or opened again under
  // its id. Resolves with { room, hostToken, expiresAt, keeps }; rejects with .status when the share server refused.
  async function openRoom(keep) {
    const body = { hours: HOURS, protocol: PROTOCOL, reader: version };
    if (keep) {
      body.room = keep.room;
      body.hostToken = keep.hostToken;
    }
    const r = await fetch(`${broker}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const t = (await r.text().catch(() => '')).slice(0, 300);
      let code = null;
      try {
        code = JSON.parse(t)?.error ?? null;
      } catch {
        // not JSON
      }
      throw Object.assign(new Error(`The share server refused to open a room (${r.status}): ${t}`), { status: r.status, code });
    }
    const room = await r.json();
    if (!room || !ROOM_ID.test(room.room ?? '') || typeof room.hostToken !== 'string' || !room.hostToken) {
      throw new Error('The share server sent a room this host cannot use.');
    }
    return room;
  }

  // Keeps this share's room open at the share server (its link unchanged). `then`, when the room is missing there: it is
  // opened again, then `then` runs; one that cannot be had back is gone.
  async function renew(s, then) {
    if (s.keeps === false) {
      if (then) {
        gone(s);
      }
      return;
    }
    try {
      const room = await openRoom({ room: s.room, hostToken: s.token });
      if (share !== s) {
        return;
      }
      // A share server too old to keep rooms opened a new one instead (left to expire there).
      if (room.room !== s.room) {
        s.keeps = false;
        if (then) {
          gone(s);
        }
        return;
      }
      s.keeps = true;
      s.expiresAt = room.expiresAt;
      kept = { room: s.room, hostToken: s.token, expiresAt: s.expiresAt };
      report();
      then?.();
    } catch (e) {
      if (share !== s) {
        return;
      }
      if (e.status === 409) {
        if (e.code === 'taken') {
          forgetPin();
        }
        gone(s);
        return;
      }
      if (then) {
        s.retry = later(then, 5000); // unreachable for now: try again
      }
    }
  }

  // The room was ended elsewhere, or taken: it is forgotten, and the next start opens a new one.
  function gone(s) {
    if (share !== s) {
      return;
    }
    letGo(false);
    kept = null;
    setState('off');
  }

  // The room for a start: the kept one renewed, or opened again under its id, or a new one.
  async function roomFor(keep) {
    if (!keep) {
      return openRoom(null);
    }
    let there;
    try {
      const r = await fetch(`${broker}/api/rooms/${keep.room}`);
      there = r.status === 410 ? 'ended' : r.ok ? await r.json() : null;
    } catch {
      // Unreachable for now: host the remembered room, and keep trying to reach it.
      return { ...keep };
    }
    if (there === 'ended') {
      return openRoom(null);
    }
    // A share server too old to keep rooms (it does not say `keeps`): the remembered room is used while it lasts.
    if (there && !there.keeps) {
      return { ...keep, keeps: false };
    }
    try {
      return await openRoom(keep);
    } catch (e) {
      // Taken under another token: a new room. The pin stays: the owner chose it for this start.
      if (e.status === 409) {
        return openRoom(null);
      }
      throw e;
    }
  }

  // Resolves once the room is open (or could not be). `pin`, the owner's choice of 6 digits, replaces the pin first.
  let pending = null;
  function start({ pin: chosen } = {}) {
    if (typeof chosen === 'string' && PIN.test(chosen) && chosen !== pin) {
      newPin(chosen);
    }
    if (share) {
      report();
      return Promise.resolve();
    }
    if (!pending) {
      const p = begin().finally(() => {
        if (pending === p) {
          pending = null;
        }
      });
      pending = p;
    }
    return pending;
  }
  async function begin() {
    if (!rtc?.RTCPeerConnection || !Socket) {
      setState('failed', 'The share library is not installed.');
      return;
    }
    const mine = ++starting;
    setState('starting');
    let room;
    try {
      room = await roomFor(kept);
    } catch (e) {
      if (mine === starting) {
        setState('failed', e?.message || `Could not reach the share server at ${broker}`);
      }
      return;
    }
    if (mine !== starting || share) {
      return;
    }
    kept = { room: room.room, hostToken: room.hostToken, expiresAt: room.expiresAt ?? null };
    const s = (share = { room: room.room, token: room.hostToken, expiresAt: room.expiresAt ?? null, keeps: room.keeps, peers: Object.create(null), claims: Object.create(null), live: false, ice: null });
    s.timer = every(() => renew(s), RENEW_MS);
    report();
    connectBroker(s, 1000);
  }

  function endAt(room, token) {
    return fetch(`${broker}/api/rooms/${room}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(() => {}, () => {});
  }

  // Lets go of the share: every reader's connection closes. With `end`, the room ends at the share server too, so the
  // link stops working.
  function letGo(end) {
    starting++;
    pending = null;
    const s = share;
    if (!s) {
      return null;
    }
    share = null;
    clearInterval(s.timer);
    clearTimeout(s.retry);
    let ended = null;
    if (end) {
      ended = endAt(s.room, s.token);
    }
    try {
      s.ws?.close();
    } catch {
      // closed
    }
    // Readers hear that the owner left before the connections close.
    for (const p of Object.values(s.peers)) {
      clearTimeout(p.timer);
      if (p.joined) {
        send(p, { t: 'live', kind: 'bye', from: 'host' });
      }
      try {
        p.channel?.close();
        p.pc?.close();
      } catch {
        // closed
      }
    }
    return ended;
  }

  async function stop({ end = false } = {}) {
    let ended = letGo(end);
    if (end && !ended && kept) {
      // Not hosting it now, but the room is still open there: it ends too.
      ended = endAt(kept.room, kept.hostToken);
    }
    if (end) {
      kept = null;
    }
    setState('off');
    await ended;
  }

  // A new pin (`next`, or a random one): the room stays, every saved pin stops working, and readers connected with the
  // old one are let go (they connect again, and hear pin-bad).
  function newPin(next = makePin()) {
    pin = next;
    wrongPins = 0;
    pinsWaitUntil = 0;
    for (const p of share ? Object.values(share.peers) : []) {
      if (p.rights === 'owner') {
        try {
          p.channel?.close();
        } catch {
          // closed
        }
        drop(p);
      }
    }
    report();
  }

  // The room was taken under another token while it was shared: whoever holds it may have heard the pin from a
  // reader, so the pin is not kept (the owner chooses another at the next Start).
  function forgetPin() {
    pin = makePin();
    report();
  }

  // The book or its notes changed on disk: every reader polls at once.
  function changed() {
    for (const p of share ? Object.values(share.peers) : []) {
      if (p.rights) {
        send(p, { t: 'changed' });
      }
    }
  }

  return {
    start,
    stop,
    newPin,
    state: () => hostState,
    links() {
      if (!share) {
        return null;
      }
      const url = `${broker}/s/${share.room}`;
      return { url, pinUrl: `${url}#pin=${pin}` };
    },
    people,
    // A live message from the owner's localhost tab: to every reader, as the host.
    sendLive(msg) {
      if (share) {
        relay({ ...(msg && typeof msg === 'object' ? msg : {}), t: 'live', from: 'host' }, null, true);
      }
    },
    changed,
    onLive(fn) {
      liveListeners.push(fn);
    },
  };
}
