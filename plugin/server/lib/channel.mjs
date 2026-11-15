// The share's data channel, without the network: how a request or a response is cut into frames and put back
// together, and what a connection may call. host.mjs uses these; the reader's half is the share server's reader.
//   reader -> host  { t: 'req', id, method, path, seq, last, data }        data: base64 of a slice of the body
//   host -> reader  { t: 'res', id, status, type, seq, last, data }
import { sameSecret } from './secret.mjs';
import { guestMay } from './guest.mjs';

export const CHUNK = 12000;

// The frames that carry `bytes` under `header`: at least one, the last marked `last`.
export function framesOf(header, bytes, chunk = CHUNK) {
  const all = Buffer.from(bytes ?? new Uint8Array(0)).toString('base64');
  const out = [];
  for (let seq = 0, at = 0; at < all.length || seq === 0; seq++, at += chunk) {
    out.push({ ...header, seq, last: at + chunk >= all.length, data: all.slice(at, at + chunk) });
  }
  return out;
}

// Puts one connection's request frames back together. `push` answers null until a request's last frame, then
// { header, body } (body a Uint8Array, maybe empty). A frame out of order, or a body over `maxBody`, drops that
// request; a new request while `maxOpen` are unfinished is ignored.
export function assembler({ maxOpen = 8, maxBody = 2 * 1024 * 1024 } = {}) {
  const open = new Map();
  return {
    push(f) {
      if (!f || f.t !== 'req' || typeof f.data !== 'string' || !(typeof f.id === 'string' || Number.isFinite(f.id))) {
        return null;
      }
      let was = open.get(f.id);
      if (!was) {
        if (open.size >= maxOpen) {
          return null;
        }
        was = { header: f, parts: [], size: 0 };
        open.set(f.id, was);
      }
      if (f.seq !== was.parts.length) {
        open.delete(f.id);
        return null;
      }
      was.parts.push(f.data);
      was.size += f.data.length;
      if (was.size * 0.75 > maxBody) {
        open.delete(f.id);
        return null;
      }
      if (!f.last) {
        return null;
      }
      open.delete(f.id);
      const { seq, last, data, ...header } = was.header;
      return { header, body: new Uint8Array(Buffer.from(was.parts.join(''), 'base64')) };
    },
  };
}

// A connection's rights, from its first frame: the owner's with the pin (compared in constant time), else a guest's.
export function rightsOf(hello, pin) {
  if (!hello || typeof pin !== 'string' || !pin) {
    return 'guest';
  }
  return sameSecret(hello.pin, pin) ? 'owner' : 'guest';
}

// Whether a connection may make this call. `path` is the decoded path, without the query. The owner may call anything
// but the share itself, which is managed only from localhost; a guest only what guestMay allows (checked again by the
// book server).
export function mayCall(rights, method, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return false;
  }
  if (rights === 'owner') {
    // Repeated slashes are collapsed first, so '//api/share' is no way around it.
    return !path.replace(/\/+/g, '/').startsWith('/api/share');
  }
  if (rights === 'guest') {
    return guestMay(method, path);
  }
  return false;
}
