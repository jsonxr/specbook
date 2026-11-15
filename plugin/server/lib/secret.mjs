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

// The owner's pin: 6 digits, typed or carried by the pin link.
export const PIN = /^\d{6}$/;

// A new pin, without bias: a 32-bit draw at or past the last whole million (4,294,000,000) is drawn again.
export function newPin(bytes = a => randomFillSync(a)) {
  for (;;) {
    const buf = new Uint8Array(4);
    const got = bytes(buf) ?? buf;
    const n = new DataView(got.buffer, got.byteOffset, 4).getUint32(0);
    if (n < 4294000000) {
      return String(n % 1000000).padStart(6, '0');
    }
  }
}

// How long every pin waits after `wrong` wrong pins in a row: two are free (typos), then 2 s, doubling, at most an
// hour. With a million pins, guessing then takes years.
export function pinWaitMs(wrong) {
  return wrong < 3 ? 0 : Math.min(2 ** (wrong - 2) * 1000, 3600000);
}
