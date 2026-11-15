import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// app/relay.js runs in the page; here it runs in a bare context with the same globals it uses.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'relay.js'), 'utf8');
const window = {};
runInNewContext(source, { window, crypto: globalThis.crypto, TextEncoder, btoa });
const R = window.SpecRelay;

test('a live message goes to everyone but its sender', () => {
  assert.deepEqual(R.relayTargets('a', ['a', 'b', 'c']), ['b', 'c']);
  assert.deepEqual(R.relayTargets('host', ['a', 'b']), ['a', 'b']);
});

test('anyone in the book may send a draft of any note, as they may edit it', () => {
  const notes = { n1: { authorKey: 'k2' }, n2: { authorKey: 'k1' }, n3: {} };
  assert.equal(R.mayDraft({ host: true }, 'n1', notes), true);
  assert.equal(R.mayDraft({ key: 'k1' }, 'n1', notes), true);
  assert.equal(R.mayDraft({ key: 'k1' }, 'n2', notes), true);
  assert.equal(R.mayDraft({ key: 'k1' }, 'n3', notes), true);
  assert.equal(R.mayDraft({ key: 'k1' }, 'brand-new', notes), true);
  assert.equal(R.mayDraft({ key: 'k1' }, '__proto__', notes), false);
});

test('the owner always has the first color, guests one of the palette', () => {
  assert.equal(R.colorOf('host'), R.PALETTE[0]);
  assert.equal(R.PALETTE.length, 8);
  assert.ok(R.PALETTE.includes(R.colorOf('abcdef123456')));
  assert.equal(R.colorOf('abcdef123456'), R.colorOf('abcdef123456'));
});

test('a peer id is a short stable hash of the guest key', async () => {
  const a = await R.peerIdOf('guest-key-0001');
  assert.equal(a.length, 12);
  assert.equal(await R.peerIdOf('guest-key-0001'), a);
  assert.notEqual(await R.peerIdOf('guest-key-0002'), a);
  assert.match(a, /^[A-Za-z0-9_-]{12}$/);
});

test('one guest on one device is one person, whatever the tab; another device is another', async () => {
  const a = await R.peerIdOf('guest-key-0001', 'device-a');
  assert.equal(await R.peerIdOf('guest-key-0001', 'device-a'), a);
  assert.notEqual(await R.peerIdOf('guest-key-0001', 'device-b'), a);
  assert.notEqual(await R.peerIdOf('guest-key-0002', 'device-a'), a);
});

test('a guest\'s live frames are capped in size and rate', () => {
  assert.equal(R.liveFrameOk('x'.repeat(R.LIVE_MAX)), true);
  assert.equal(R.liveFrameOk('x'.repeat(R.LIVE_MAX + 1)), false);
  const bucket = {};
  let sent = 0;
  for (let i = 0; i < 200; i++) { if (R.liveRateOk(bucket, 1000)) { sent++; } }
  assert.equal(sent, R.LIVE_BURST, 'a burst gets through up to the cap, all at once');
  assert.equal(R.liveRateOk(bucket, 1000), false);
  assert.equal(R.liveRateOk(bucket, 2000), true, 'a second later there is room again');
});

test('a new note id belongs to whoever drafted it first; others cannot draft it', () => {
  const claims = {};
  assert.equal(R.mayDraft({ key: 'k1', id: 'p1' }, 'fresh', {}, claims), true);
  assert.equal(R.mayDraft({ key: 'k2', id: 'p2' }, 'fresh', {}, claims), false);
  assert.equal(R.mayDraft({ key: 'k1', id: 'p1' }, 'fresh', {}, claims), true);
  assert.equal(R.mayDraft({ host: true }, 'fresh', {}, claims), true);
});
