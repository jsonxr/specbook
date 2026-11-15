// The broker's limits and checks, kept apart from the Worker so node:test can run them.

export const ROOMS_PER_HOUR = 10; // rooms one IP address may open in an hour
export const MAX_GUESTS = 20; // guests waiting or connecting in one room at once
export const MAX_MESSAGE = 64 * 1024; // bytes in one handshake message
export const DEFAULT_HOURS = 8;
export const MAX_HOURS = 24;
export const GUEST_IDLE_MS = 60_000; // a guest's handshake socket is closed after this while the host is there
export const PROTOCOL = 3;
export const WAIT_MS = 3600_000; // a guest waits this long for a host that is away before its socket closes
export const WAIT_PER_IP = 3; // guests one address may have waiting in one room
// The newest wire protocol between a host and a guest page (3: the book server hosts, no signatures).
export const TURN_PER_ROOM = 30; // relay credentials one room may hand out
export const TURN_PER_IP = 30; // relay credentials one address may get in a day
export const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const ID = /^[A-Za-z0-9_-]{16,64}$/;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const VERSION = /^\d+\.\d+\.\d+$/;

// The CSP of the reader pages (/s/<room> on protocol 3 and /r/*): only scripts from this site run.
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https:; img-src 'self' blob: data: https:; font-src 'self' https: data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// A new room id: 22 base-62 characters, without bias (a byte of 248 or more is skipped, then byte % 62).
export function newId(bytes = a => crypto.getRandomValues(a)) {
  let id = '';
  while (id.length < 22) {
    const buf = new Uint8Array(32);
    const got = bytes(buf) ?? buf;
    for (const b of got) {
      if (b < 248 && id.length < 22) {
        id += BASE62[b % 62];
      }
    }
  }
  return id;
}

// Whether a reader version may go into a path.
export function validReader(v) {
  return typeof v === 'string' && VERSION.test(v);
}

// The page a room's guests get: the old guest page (protocol below 3), the reader of the room's version, or the newest
// reader when the room's version is not published (or the room is not there), which tells the guest itself.
export function pageFor(room, versions) {
  if (!room) {
    return { kind: 'none' };
  }
  if ((room.protocol ?? 1) < 3) {
    return { kind: 'legacy' };
  }
  return versions.includes(room.reader) ? { kind: 'reader', version: room.reader } : { kind: 'missing', version: room.reader };
}

export function validId(id) {
  return typeof id === 'string' && ID.test(id);
}

// How long a room lasts, in hours: what the host asked for, from 1 to MAX_HOURS.
export function roomHours(asked) {
  const n = Number(asked);
  return Number.isFinite(n) ? Math.min(MAX_HOURS, Math.max(1, Math.round(n))) : DEFAULT_HOURS;
}

// The protocol a room speaks: what its host asked for (1 for hosts that sent none), at most PROTOCOL.
export function roomProtocol(asked) {
  const n = Number(asked);
  return Number.isInteger(n) && n >= 1 ? Math.min(PROTOCOL, n) : 1;
}

// Whether a guest may wait in a room whose host is away: only in a room a host has opened (so nobody can park sockets
// in rooms made for it), and only a few from one address (so one person cannot fill a room).
export function mayWait({ hosted, waitingFromIp }) {
  return !!hosted && waitingFromIp < WAIT_PER_IP;
}

// The rate window for one address after one more room: { ok, next } where next is the window to store.
export function countRoom(window, now) {
  const fresh = !window || now - window.start >= 3600_000;
  const w = fresh ? { start: now, count: 0 } : window;
  if (w.count >= ROOMS_PER_HOUR) {
    return { ok: false, next: w };
  }
  return { ok: true, next: { start: w.start, count: w.count + 1 } };
}

// A guest's message the host may hear: only an offer, passed on with the broker's id for the guest.
// From protocol 3 the offer is not signed.
export function fromGuest(msg, gid, protocol = 1) {
  const signed = protocol < 3;
  if (!msg || msg.type !== 'offer' || typeof msg.sdp !== 'string' || (signed && typeof msg.sig !== 'string')) {
    return null;
  }
  const out = { type: 'offer', from: gid, key: String(msg.key ?? ''), name: String(msg.name ?? ''), device: String(msg.device ?? '').slice(0, 64), sdp: msg.sdp };
  if (signed) {
    out.sig = msg.sig;
  }
  out.protocol = protocol >= 3 ? protocol : roomProtocol(msg.protocol);
  return out;
}

// A host's message for one guest: an answer or a rejection, addressed by `to`.
export function fromHost(msg, protocol = 1) {
  if (!msg || typeof msg.to !== 'string') {
    return null;
  }
  if (msg.type === 'answer' && typeof msg.sdp === 'string') {
    if (protocol >= 3) {
      return { to: msg.to, out: { type: 'answer', sdp: msg.sdp } };
    }
    if (typeof msg.sig === 'string') {
      return { to: msg.to, out: { type: 'answer', sdp: msg.sdp, sig: msg.sig } };
    }
  }
  if (msg.type === 'reject') {
    return { to: msg.to, out: { type: 'reject', error: String(msg.error ?? 'rejected') } };
  }
  return null;
}

// TURN servers from Cloudflare's answer, without port 53 (which browsers block).
export function turnServers(answer) {
  const list = Array.isArray(answer?.iceServers) ? answer.iceServers : [];
  return list
    .map(s => ({ ...s, urls: [].concat(s.urls ?? []).filter(u => !/:53(\?|$)/.test(u)) }))
    .filter(s => s.urls.length);
}

// Whether one more relay credential may be handed out: under the room's, the address's and the day's caps.
export function mayMintTurn({ room, ip, day, cap }) {
  return room < TURN_PER_ROOM && ip < TURN_PER_IP && day < cap;
}

// The owner's book tab is served from this machine: only such a page may open rooms from a browser.
export function isLocalOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(origin));
}
