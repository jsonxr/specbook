import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalOrigin, ROOMS_PER_HOUR, TURN_PER_IP, TURN_PER_ROOM, mayMintTurn, countRoom, fromGuest, fromHost, roomHours, turnServers, validId, roomProtocol, mayWait, WAIT_MS, newId, validReader, pageFor, PROTOCOL, CSP, assetHeaders, shareChoice, renewed, mayReopen, sameToken, HELD_KEPT_MS, heldUntil } from './rules.mjs';

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
  assert.deepEqual(fromGuest({ type: 'offer', sdp: 's', sig: 'x', key: 'k', name: 'n', from: 'forged' }, 'g'), { type: 'offer', from: 'g', key: 'k', name: 'n', device: '', sdp: 's', sig: 'x', protocol: 1 });
  assert.equal(fromGuest({ type: 'offer', sdp: 's', sig: 'x', key: 'k', name: 'n', device: 'device-0001' }, 'g').device, 'device-0001', 'the guest\'s device reaches the host');
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

test('a room speaks the protocol its host asked for, 1 when it asked none', () => {
  assert.equal(roomProtocol(2), 2);
  assert.equal(roomProtocol(undefined), 1);
  assert.equal(roomProtocol(3), 3);
  assert.equal(roomProtocol(9), 3);
  assert.equal(roomProtocol('x'), 1);
});

test('a guest offer carries its protocol to the host', () => {
  const out = fromGuest({ type: 'offer', sdp: 's', sig: 'g', key: 'k', name: 'n', protocol: 2 }, 'gid-000000001');
  assert.equal(out.protocol, 2);
  assert.equal(fromGuest({ type: 'offer', sdp: 's', sig: 'g' }, 'gid-000000001').protocol, 1);
});

test('a guest may wait for a host only in a room that has had one, three at most from one address', () => {
  assert.equal(mayWait({ hosted: false, waitingFromIp: 0 }), false);
  assert.equal(mayWait({ hosted: true, waitingFromIp: 2 }), true);
  assert.equal(mayWait({ hosted: true, waitingFromIp: 3 }), false);
  assert.equal(WAIT_MS, 3600_000, 'a guest waits an hour for the host at most');
});

test('newId gives 22 base-62 characters, skipping biased bytes', () => {
  for (let i = 0; i < 1000; i++) {
    assert.match(newId(), /^[A-Za-z0-9]{22}$/);
  }
  const cycle = [248, 255, 0];
  let n = 0;
  const source = a => {
    for (let i = 0; i < a.length; i++) {
      a[i] = cycle[n++ % 3];
    }
    return a;
  };
  const id = newId(source);
  assert.equal(id[0], 'A');
  assert.equal(id, 'A'.repeat(22));
});

test('a 22-character id, base-62 or with a dash, is a valid id', () => {
  assert.equal(validId('aB3dE6gH9jK2mN5pQ8sT1v'), true);
  assert.equal(validId('aB3dE6gH9jK2mN5pQ8-T1v'), true);
});

test('a reader version is three dot-separated numbers', () => {
  assert.equal(validReader('1.4.0'), true);
  assert.equal(validReader('1.4'), false);
  assert.equal(validReader('../1.4.0'), false);
  assert.equal(validReader('1.4.0/x'), false);
  assert.equal(validReader(undefined), false);
});

test('protocol 3 needs no signature from the guest or the host', () => {
  const offer = { type: 'offer', sdp: 's', key: 'k', name: 'n', device: 'd' };
  assert.deepEqual(fromGuest(offer, 'g', 3), { type: 'offer', from: 'g', key: 'k', name: 'n', device: 'd', sdp: 's', protocol: 3 });
  assert.equal(fromGuest(offer, 'g', 2), null);
  assert.deepEqual(fromHost({ type: 'answer', to: 'g', sdp: 's' }, 3), { to: 'g', out: { type: 'answer', sdp: 's' } });
  assert.equal(fromHost({ type: 'answer', to: 'g', sdp: 's' }, 2), null);
  assert.equal(PROTOCOL, 3);
});

test('the page a room gets follows its protocol and reader version', () => {
  assert.deepEqual(pageFor(null, ['1.4.0']), { kind: 'none' });
  assert.deepEqual(pageFor({ protocol: 2 }, []), { kind: 'legacy' });
  assert.deepEqual(pageFor({ protocol: 3, reader: '1.4.0' }, ['1.4.0']), { kind: 'reader', version: '1.4.0' });
  assert.deepEqual(pageFor({ protocol: 3, reader: '1.5.0' }, ['1.4.0']), { kind: 'missing', version: '1.5.0' });
  assert.match(CSP, /^default-src 'self'; script-src 'self';/);
});

test('only a good answer under /r/ is cached for good', () => {
  assert.match(assetHeaders('/r/1.4.0/share.js', 200)['cache-control'], /immutable/);
  assert.equal(assetHeaders('/r/1.5.0/share.html', 404)['cache-control'], 'no-store');
  // A share server under development (server/dev.mjs, DEBUG_NO_CACHE) never lets a browser keep the reader.
  assert.equal(assetHeaders('/r/1.0.0/share.js', 200, { noCache: true })['cache-control'], 'no-store');
  assert.equal(assetHeaders('/r/1.4.0/share.js', 307)['cache-control'], 'no-store');
  assert.equal(assetHeaders('/r/versions.json', 200)['cache-control'], 'no-store');
  assert.equal(assetHeaders('/r/versions.json', 200)['content-security-policy'], CSP);
});

test('a protocol 3 room with no reader published gets the notice, not the old guest page', () => {
  assert.deepEqual(shareChoice({ kind: 'legacy' }, []), { file: '/guest.html', csp: false });
  assert.deepEqual(shareChoice({ kind: 'none' }, []), { unavailable: true });
  assert.deepEqual(shareChoice({ kind: 'missing', version: '1.5.0' }, []), { unavailable: true });
  assert.deepEqual(shareChoice({ kind: 'none' }, ['1.4.0', '1.10.0', '1.9.0']), { file: '/r/1.10.0/share.html', csp: true });
  assert.deepEqual(shareChoice({ kind: 'reader', version: '1.4.0' }, ['1.4.0']), { file: '/r/1.4.0/share.html', csp: true });
});

test('renewing a room takes the host\'s current reader and protocol', () => {
  const held = { hostToken: 't', expiresAt: 100, protocol: 3, reader: '1.4.0' };
  assert.deepEqual(renewed(held, { reader: '1.5.0', protocol: 3 }, 50), { hostToken: 't', expiresAt: 100, protocol: 3, reader: '1.5.0' });
  assert.equal(renewed(held, { reader: '../x' }, 200).reader, '1.4.0');
  assert.equal(renewed(held, {}, 200).protocol, 3);
  assert.equal(renewed(held, {}, 200).expiresAt, 200);
});

test('a room whose host names a reader this site does not hold says the share server needs deploying', () => {
  // Serving another version's reader would only tell the guest to reload, again and again.
  assert.deepEqual(shareChoice({ kind: 'missing', version: '9.9.9' }, ['1.4.0', '1.10.0']), { unavailable: true });
});

test('an expired room is opened again only by the token it was held under', () => {
  const now = 1_000_000;
  const held = { hash: 'a'.repeat(43), until: now + 1 };
  assert.equal(mayReopen({ held, tokenHash: 'a'.repeat(43), now }), true);
  assert.equal(mayReopen({ held, tokenHash: 'b'.repeat(43), now }), false);
  assert.equal(mayReopen({ held, tokenHash: 'a'.repeat(42), now }), false);
  assert.equal(mayReopen({ held, tokenHash: undefined, now }), false);
  // No record: an id never held here, or one let go long ago.
  assert.equal(mayReopen({ held: undefined, tokenHash: 'b'.repeat(43), now }), true);
  assert.equal(mayReopen({ held: { hash: 'a'.repeat(43), until: now }, tokenHash: 'b'.repeat(43), now }), true);
});

test('a room is held for its host 30 days past its expiry', () => {
  assert.equal(HELD_KEPT_MS, 30 * 86400_000);
  assert.equal(heldUntil(500), 500 + HELD_KEPT_MS);
});

test('tokens are compared whole', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abc', 'abd'), false);
  assert.equal(sameToken('abc', 'abcd'), false);
  assert.equal(sameToken(undefined, 'abc'), false);
});
