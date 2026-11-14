import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_DRAFTS, GUEST_TEXT, checkGuestNotes, cleanName, encodeGuest, guestMay, guestOf, mergeGuestNotes, reviewForGuest } from './guest.mjs';

test('guestMay allows reads and saving notes, nothing else', () => {
  for (const [m, p] of [['GET', '/'], ['GET', '/index.html'], ['GET', '/app/book.js'], ['GET', '/data/mockups/a.html'], ['GET', '/api/book'], ['GET', '/api/claude'], ['GET', '/api/history/R1'], ['HEAD', '/api/health'], ['PUT', '/api/notes']]) {
    assert.equal(guestMay(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [['POST', '/api/revise'], ['POST', '/api/build'], ['POST', '/api/accept'], ['POST', '/api/stage'], ['PUT', '/api/requirements/R1'], ['DELETE', '/api/requirements/R1'], ['POST', '/api/notes'], ['GET', '/api/history/a/b'], ['GET', 'api/book'], ['GET', undefined], ['POST', '/api/builds/x/stop']]) {
    assert.equal(guestMay(m, p), false, `${m} ${p}`);
  }
});

test('names are cleaned and keys checked; the header round-trips', () => {
  assert.equal(cleanName('  Ann\n  Lee  '), 'Ann Lee');
  assert.equal(cleanName('Ann\u202eeve\u0085'), 'Anneve');
  assert.equal(cleanName(''), 'Guest');
  assert.equal(cleanName(42), 'Guest');
  assert.equal(cleanName('x'.repeat(60)).length, 40);
  const header = encodeGuest({ name: 'Ann', key: 'abcdefgh' });
  assert.deepEqual(guestOf({ 'x-specbook-guest': header }), { name: 'Ann', key: 'abcdefgh' });
  assert.equal(guestOf({}), null);
  assert.deepEqual(guestOf({ 'x-specbook-guest': 'nope' }), { invalid: true });
  assert.deepEqual(guestOf({ 'x-specbook-guest': encodeURIComponent('{"key":"a b"}') }), { invalid: true });
});

test('mergeGuestNotes touches only the guest\'s drafts and keeps server-written fields', () => {
  const ann = { name: 'Ann', key: 'ann-key-1' };
  const stored = {
    sent: { status: 'sent', text: 's', authorKey: 'ann-key-1' },
    mine: { status: 'draft', text: 'old', authorKey: 'ann-key-1', author: 'Ann', reply: 'r' },
    gone: { status: 'draft', text: 'g', authorKey: 'ann-key-1' },
    theirs: { status: 'draft', text: 't', authorKey: 'bob' },
  };
  const out = mergeGuestNotes(stored, { mine: { status: 'draft', text: 'new' }, theirs: { status: 'draft', text: 'x' }, sent: { status: 'draft', text: 'y' }, fresh: { status: 'draft', text: 'f' } }, ann);
  assert.deepEqual(Object.keys(out).sort(), ['fresh', 'mine', 'sent', 'theirs']);
  assert.equal(out.mine.text, 'new');
  assert.equal(out.mine.reply, 'r');
  assert.equal(out.theirs.text, 't');
  assert.equal(out.sent.status, 'sent');
  assert.equal(out.fresh.author, 'Ann');
  assert.equal(out.fresh.authorKey, 'ann-key-1');
});

test('a guest sees no one\'s key, and their own notes as mine', () => {
  const ann = { name: 'Ann', key: 'ann-key-1' };
  const out = reviewForGuest({ rev: 3, notes: { a: { text: 'a', authorKey: 'ann-key-1', author: 'Ann' }, b: { text: 'b', authorKey: 'bob-key-1', author: 'Bob' }, o: { text: 'o' } } }, ann);
  assert.equal(out.rev, 3);
  assert.deepEqual(out.notes, { a: { text: 'a', author: 'Ann', mine: true }, b: { text: 'b', author: 'Bob' }, o: { text: 'o' } });
});

test('a guest may keep only so many drafts, each of a note\'s length', () => {
  const ann = { name: 'Ann', key: 'ann-key-1' };
  const many = Object.fromEntries(Array.from({ length: GUEST_DRAFTS + 1 }, (_, i) => [`n${i}`, { status: 'draft', text: 't', authorKey: 'ann-key-1' }]));
  assert.throws(() => checkGuestNotes(many, ann), { code: 'too-many-notes' });
  assert.throws(() => checkGuestNotes({ a: { status: 'draft', text: 'x'.repeat(GUEST_TEXT + 1), authorKey: 'ann-key-1' } }, ann), { code: 'bad-note' });
  checkGuestNotes({ a: { status: 'draft', text: 'fine', authorKey: 'ann-key-1' }, o: { status: 'draft', text: 'x'.repeat(GUEST_TEXT + 1) } }, ann);
});
