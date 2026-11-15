import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembler, framesOf, mayCall, rightsOf } from './channel.mjs';

function bytesOf(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

function roundTrip(n) {
  const a = assembler({});
  const frames = framesOf({ t: 'req', id: 1, method: 'PUT', path: '/api/notes' }, bytesOf(n));
  let got = null;
  for (const f of frames) {
    got = a.push(JSON.parse(JSON.stringify(f)));
  }
  return { frames, got };
}

test('framesOf then assembler.push round-trips 0, 1 and 40,000 bytes', () => {
  for (const n of [0, 1, 40000]) {
    const { frames, got } = roundTrip(n);
    assert.ok(got, `assembled ${n} bytes`);
    assert.equal(got.header.method, 'PUT');
    assert.equal(got.header.path, '/api/notes');
    assert.deepEqual(Buffer.from(got.body), Buffer.from(bytesOf(n)));
    assert.equal(frames.at(-1).last, true);
    assert.ok(frames.slice(0, -1).every(f => f.last === false));
  }
  assert.equal(roundTrip(0).frames.length, 1);
  assert.ok(roundTrip(40000).frames.length > 1);
});

test('an out-of-order seq drops the request', () => {
  const a = assembler({});
  const frames = framesOf({ t: 'req', id: 'x', method: 'PUT', path: '/api/notes' }, bytesOf(40000));
  assert.ok(frames.length >= 3);
  assert.equal(a.push(frames[0]), null);
  assert.equal(a.push(frames[2]), null);
  for (const f of frames.slice(1)) {
    assert.equal(a.push(f), null);
  }
});

test('a ninth open request is ignored', () => {
  const a = assembler({});
  const open = [];
  for (let id = 0; id < 8; id++) {
    const frames = framesOf({ t: 'req', id, method: 'PUT', path: '/api/notes' }, bytesOf(12000));
    assert.equal(frames.length, 2);
    assert.equal(a.push(frames[0]), null);
    open.push(frames);
  }
  const ninth = framesOf({ t: 'req', id: 8, method: 'GET', path: '/api/book' }, new Uint8Array(0));
  assert.equal(ninth.length, 1);
  assert.equal(a.push(ninth[0]), null);
  // An open one still completes, and then there is room again.
  assert.ok(a.push(open[0][1]));
  assert.ok(a.push(ninth[0]));
});

test('a body over maxBody is dropped', () => {
  const a = assembler({ maxBody: 1000 });
  const frames = framesOf({ t: 'req', id: 1, method: 'PUT', path: '/api/notes' }, bytesOf(5000), 400);
  let got = null;
  for (const f of frames) got = a.push(f) ?? got;
  assert.equal(got, null);
  const ok = framesOf({ t: 'req', id: 2, method: 'PUT', path: '/api/notes' }, bytesOf(900), 400);
  for (const f of ok) got = a.push(f) ?? got;
  assert.ok(got);
});

test('frames that are not requests are ignored', () => {
  const a = assembler({});
  assert.equal(a.push(null), null);
  assert.equal(a.push({ t: 'live', kind: 'where' }), null);
  assert.equal(a.push({ t: 'req', id: 1, seq: 0, last: true, data: 5 }), null);
});

test('the pin gives owner rights; anything else is a guest', () => {
  assert.equal(rightsOf({ t: 'hello', pin: 'P' }, 'P'), 'owner');
  assert.equal(rightsOf({}, 'P'), 'guest');
  assert.equal(rightsOf({ pin: 'Q' }, 'P'), 'guest');
  assert.equal(rightsOf({ pin: '' }, ''), 'guest');
  assert.equal(rightsOf({ pin: 'P' }, null), 'guest');
  assert.equal(rightsOf(null, 'P'), 'guest');
});

test('mayCall: owners call anything but the share, guests what guestMay allows', () => {
  assert.equal(mayCall('guest', 'POST', '/api/requests'), false);
  assert.equal(mayCall('owner', 'POST', '/api/requests'), true);
  assert.equal(mayCall('owner', 'POST', '/api/share/stop'), false);
  assert.equal(mayCall('owner', 'GET', '/api/share'), false);
  assert.equal(mayCall('owner', 'GET', '/api/share/events'), false);
  assert.equal(mayCall('owner', 'GET', '//api/share/events'), false);
  assert.equal(mayCall('guest', 'PUT', '/api/notes'), true);
  assert.equal(mayCall('guest', 'GET', '/api/book'), true);
  assert.equal(mayCall('owner', 'GET', 'api/book'), false);
  assert.equal(mayCall('nobody', 'GET', '/api/book'), false);
});

test('mayCall: nobody calls /api/live over the channel', () => {
  assert.equal(mayCall('owner', 'POST', '/api/live'), false);
  assert.equal(mayCall('owner', 'POST', '/api/live/x'), false);
  assert.equal(mayCall('owner', 'POST', '//api/live'), false);
  assert.equal(mayCall('guest', 'POST', '/api/live'), false);
  assert.equal(mayCall('owner', 'GET', '/api/lively'), true);
});
