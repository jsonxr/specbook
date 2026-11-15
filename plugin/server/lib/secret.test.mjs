import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, sameSecret } from './secret.mjs';

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
