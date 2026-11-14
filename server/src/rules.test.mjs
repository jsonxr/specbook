import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalOrigin, ROOMS_PER_HOUR, TURN_PER_IP, TURN_PER_ROOM, mayMintTurn, countRoom, fromGuest, fromHost, roomHours, turnServers, validId } from './rules.mjs';

test('room length is clamped to 1-24 hours, 8 by default', () => {
  assert.equal(roomHours(undefined), 8);
  assert.equal(roomHours('x'), 8);
  assert.equal(roomHours(0), 1);
  assert.equal(roomHours(100), 24);
  assert.equal(roomHours(3), 3);
});

test('an address may open ROOMS_PER_HOUR rooms an hour', () => {
  let w;
  for (let i = 0; i < ROOMS_PER_HOUR; i++) {
    const r = countRoom(w, 1000 + i);
    assert.equal(r.ok, true);
    w = r.next;
  }
  assert.equal(countRoom(w, 2000).ok, false);
  assert.equal(countRoom(w, 1000 + 3600_000).ok, true);
});

test('only offers pass from a guest, and only answers or rejections from the host', () => {
  assert.equal(fromGuest({ type: 'answer', sdp: 's', sig: 'x' }, 'g'), null);
  assert.equal(fromGuest({ type: 'offer', sdp: 's' }, 'g'), null);
  assert.deepEqual(fromGuest({ type: 'offer', sdp: 's', sig: 'x', key: 'k', name: 'n', from: 'forged' }, 'g'), { type: 'offer', from: 'g', key: 'k', name: 'n', sdp: 's', sig: 'x' });
  assert.equal(fromHost({ type: 'offer', to: 'g', sdp: 's', sig: 'x' }), null);
  assert.equal(fromHost({ type: 'answer', sdp: 's', sig: 'x' }), null);
  assert.deepEqual(fromHost({ type: 'answer', to: 'g', sdp: 's', sig: 'x' }), { to: 'g', out: { type: 'answer', sdp: 's', sig: 'x' } });
  assert.deepEqual(fromHost({ type: 'reject', to: 'g' }), { to: 'g', out: { type: 'reject', error: 'rejected' } });
});

test('ids are checked, and TURN servers lose port 53', () => {
  assert.equal(validId('abcdefghijklmnop'), true);
  assert.equal(validId('short'), false);
  assert.equal(validId('../../../../etc/passwd!'), false);
  assert.deepEqual(turnServers({ iceServers: [{ urls: ['turn:a:3478', 'turn:a:53?transport=udp'], username: 'u', credential: 'c' }, { urls: 'turn:b:53' }] }), [{ urls: ['turn:a:3478'], username: 'u', credential: 'c' }]);
  assert.deepEqual(turnServers(null), []);
});

test('a TURN credential needs the room, the address and the day under their caps', () => {
  assert.equal(mayMintTurn({ room: 0, ip: 0, day: 0, cap: 200 }), true);
  assert.equal(mayMintTurn({ room: TURN_PER_ROOM, ip: 0, day: 0, cap: 200 }), false);
  assert.equal(mayMintTurn({ room: 0, ip: TURN_PER_IP, day: 0, cap: 200 }), false);
  assert.equal(mayMintTurn({ room: 0, ip: 0, day: 200, cap: 200 }), false);
});

test('only a page on this machine is a local origin', () => {
  assert.equal(isLocalOrigin('http://localhost:4180'), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:4181'), true);
  assert.equal(isLocalOrigin('https://evil.example'), false);
  assert.equal(isLocalOrigin('http://localhost.evil.example'), false);
  assert.equal(isLocalOrigin(null), false);
});
