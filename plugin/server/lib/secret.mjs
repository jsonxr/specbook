import { randomFillSync, timingSafeEqual } from 'node:crypto';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// A new room id or pin: 22 base-62 characters, without bias (a byte of 248 or more
// is skipped, then byte % 62). Same rule as newId in server/src/rules.mjs.
export function newId(bytes = a => randomFillSync(a)) {
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

// Constant-time comparison; false for anything that is not two strings of equal length.
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
