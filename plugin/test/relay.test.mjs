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

test('only the owner, or the note\'s own guest, may send a draft of it', () => {
  const notes = { n1: { authorKey: 'k2' }, n2: { authorKey: 'k1' }, n3: {} };
  assert.equal(R.mayDraft({ host: true }, 'n1', notes), true);
  assert.equal(R.mayDraft({ key: 'k1' }, 'n1', notes), false);
  assert.equal(R.mayDraft({ key: 'k1' }, 'n2', notes), true);
  assert.equal(R.mayDraft({ key: 'k1' }, 'n3', notes), false);
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

test('two tabs with the same guest key are two people, each with a stable id', async () => {
  const a = await R.peerIdOf('guest-key-0001', 'conn-a');
  const b = await R.peerIdOf('guest-key-0001', 'conn-b');
  assert.notEqual(a, b);
  assert.equal(await R.peerIdOf('guest-key-0001', 'conn-a'), a);
});

test('a new note id belongs to whoever drafted it first; others cannot draft it', () => {
  const claims = {};
  assert.equal(R.mayDraft({ key: 'k1', id: 'p1' }, 'fresh', {}, claims), true);
  assert.equal(R.mayDraft({ key: 'k2', id: 'p2' }, 'fresh', {}, claims), false);
  assert.equal(R.mayDraft({ key: 'k1', id: 'p1' }, 'fresh', {}, claims), true);
  assert.equal(R.mayDraft({ host: true }, 'fresh', {}, claims), true);
});
