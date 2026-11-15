import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, newPin, PIN, sameSecret, pinWaitMs } from './secret.mjs';

test('newId gives 22 base-62 characters over 1,000 draws', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = newId();
    assert.match(id, /^[A-Za-z0-9]{22}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 1000);
});

test('newId skips bytes of 248 or more', () => {
  let call = 0;
  const id = newId(buf => {
    buf.fill(call++ === 0 ? 255 : 1);
    return buf;
  });
  assert.equal(id, 'B'.repeat(22));
});

test('sameSecret compares in constant time over equal lengths', () => {
  assert.equal(sameSecret('a', 'a'), true);
  assert.equal(sameSecret('a', 'b'), false);
  assert.equal(sameSecret('a', 'ab'), false);
  assert.equal(sameSecret(undefined, 'a'), false);
  assert.equal(sameSecret('a', undefined), false);
});

test('newPin gives 6 digits, leading zeros kept', () => {
  for (let i = 0; i < 1000; i++) {
    assert.match(newPin(), /^\d{6}$/);
  }
  assert.equal(newPin(buf => { buf.fill(0); return buf; }), '000000');
  assert.ok(PIN.test('012345'));
  assert.ok(!PIN.test('12345') && !PIN.test('1234567') && !PIN.test('12a456'));
});

test('newPin skips draws past the last whole million, without bias', () => {
  let call = 0;
  const pin = newPin(buf => {
    // First 0xFFFFFFFF (skipped), then 1,000,007 (7 after the million).
    new DataView(buf.buffer).setUint32(0, call++ === 0 ? 0xffffffff : 1000007);
    return buf;
  });
  assert.equal(pin, '000007');
});

test('pinWaitMs: two wrong pins are free, then the wait doubles from 2 s up to an hour', () => {
  assert.equal(pinWaitMs(0), 0);
  assert.equal(pinWaitMs(1), 0);
  assert.equal(pinWaitMs(2), 0);
  assert.equal(pinWaitMs(3), 2000);
  assert.equal(pinWaitMs(4), 4000);
  assert.equal(pinWaitMs(13), 2048000);
  assert.equal(pinWaitMs(14), 3600000);
  assert.equal(pinWaitMs(1000), 3600000);
});
