import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_DRAFTS, GUEST_TEXT, applyNoteChanges, checkGuestNotes, cleanName, encodeGuest, guestMay, guestOf, mergeGuestNotes, reviewForGuest } from './guest.mjs';

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
  // Another's note the guest changed last is held to the same length.
  assert.throws(() => checkGuestNotes({ o: { status: 'draft', text: 'x'.repeat(GUEST_TEXT + 1), lastByKey: 'ann-key-1' } }, ann), { code: 'bad-note' });
});

// Per-note saves (live sharing): each save carries only the notes it changed.
const ann = { guest: true, name: 'Ann', key: 'ann-key-0001' };
const owner = { guest: false, name: 'Jason' };
const stored = () => ({
  mine: { status: 'draft', text: 'owner', item: 'R1' },
  hers: { status: 'draft', text: 'ann', item: 'R1', author: 'Ann', authorKey: 'ann-key-0001' },
  bobs: { status: 'draft', text: 'bob', item: 'R1', author: 'Bob', authorKey: 'bob-key-0001' },
  sent: { status: 'sent', text: 'gone to Claude', item: 'R1' },
});

test('everyone in the book edits every draft; a note keeps who started it', () => {
  const out = applyNoteChanges(stored(), { hers: { text: 'ann 2', item: 'R1' }, fresh: { text: 'new', item: 'R1' }, bobs: { text: 'ann tidied', item: 'R1' }, mine: { text: 'ann too', item: 'R1' } }, ann);
  assert.equal(out.hers.text, 'ann 2');
  assert.equal(out.hers.authorKey, 'ann-key-0001');
  assert.equal(out.fresh.author, 'Ann');
  assert.equal(out.fresh.authorKey, 'ann-key-0001');
  assert.equal(out.fresh.status, 'draft');
  assert.equal(out.bobs.text, 'ann tidied');
  assert.equal(out.bobs.authorKey, 'bob-key-0001');
  assert.equal(out.mine.text, 'ann too');
  assert.equal(out.mine.authorKey, undefined);
  assert.equal(out.mine.lastByKey, 'ann-key-0001');
});

test('the owner may edit a guest\'s note; it stays theirs and says who changed it last', () => {
  const out = applyNoteChanges(stored(), { bobs: { text: 'tidied', item: 'R1' } }, owner);
  assert.equal(out.bobs.text, 'tidied');
  assert.equal(out.bobs.author, 'Bob');
  assert.equal(out.bobs.authorKey, 'bob-key-0001');
  assert.equal(out.bobs.lastBy, 'Jason');
  assert.equal(out.bobs.lastByKey, 'owner');
  assert.equal(out.hers.lastBy, undefined);
});

test('who changed a note last is known by key, so two people of one name are not mixed up', () => {
  const byAnn = applyNoteChanges(stored(), { hers: { text: 'ann 2', item: 'R1', lastByKey: 'owner' } }, ann);
  assert.equal(byAnn.hers.lastByKey, 'ann-key-0001');
  const forAnn = reviewForGuest({ rev: 1, notes: byAnn }, ann).notes;
  assert.equal(forAnn.hers.lastMine, true);
  assert.equal('lastByKey' in forAnn.hers, false);
  const otherAnn = reviewForGuest({ rev: 1, notes: byAnn }, { name: 'Ann', key: 'ann-key-0002' }).notes;
  assert.equal(otherAnn.hers.lastMine, undefined);
});

test('null deletes any draft, and notes past draft are never touched', () => {
  const byAnn = applyNoteChanges(stored(), { hers: null, bobs: null, mine: null, sent: null }, ann);
  assert.equal(byAnn.hers, undefined);
  assert.equal(byAnn.bobs, undefined);
  assert.equal(byAnn.mine, undefined);
  assert.equal(byAnn.sent.text, 'gone to Claude');
  const byOwner = applyNoteChanges(stored(), { bobs: null, sent: null, __proto__: null }, owner);
  assert.equal(byOwner.bobs, undefined);
  assert.equal(byOwner.sent.text, 'gone to Claude');
  assert.equal(applyNoteChanges(stored(), { sent: { text: 'x', item: 'R1' } }, owner).sent.text, 'gone to Claude');
});

test('a save reports the ids it was not allowed to change, so the page does not think them saved', () => {
  const skipped = [];
  applyNoteChanges(stored(), { hers: { text: 'x', item: 'R1' }, bobs: { text: 'x', item: 'R1' }, mine: null, sent: { text: 'x', item: 'R1' } }, ann, skipped);
  assert.deepEqual(skipped.sort(), ['sent']);
});
