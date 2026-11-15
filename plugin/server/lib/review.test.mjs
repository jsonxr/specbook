import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  acceptItem, appendBuiltHistory, appendChangelog, changeItem, currentItems, currentSnapshot, linkNote, readHistory, readReview,
  replyNote, sectionsUnderReview, stampOpened, writeReviewNotes
} from './review.mjs';

const Model = createRequire(import.meta.url)('../../app/model.js');
const NOW = '2026-11-14T10:00:00.000Z';

function bookWith(reqs, extra = {}) {
  return {
    chapters: [{ id: 'c', title: 'C', intro: '', sections: [{ id: 's', title: 'S', requirements: reqs, shows: [{ state: 'SCR-S.a' }] }] }],
    screens: [{ id: 'SCR-S', name: 'S', kind: 'screen', states: [{ id: 'a', name: 'cap', mockup: 'mockups/a.html' }] }],
    ...extra
  };
}

function setup(book, review) {
  const data = mkdtempSync(join(tmpdir(), 'review-'));
  mkdirSync(join(data, 'mockups'));
  writeFileSync(join(data, 'mockups/a.html'), '<a>');
  writeFileSync(join(data, 'book.json'), JSON.stringify(book));
  if (review) {
    writeFileSync(join(data, 'review.json'), JSON.stringify(review));
  }
  return data;
}

const writeBook = (data, book) => writeFileSync(join(data, 'book.json'), JSON.stringify(book));
const stateValue = { name: 'cap', mockup: '<a>', today: null };
const base = (extra = {}) => ({ rev: 3, accepted: { c: { title: 'C', intro: '' }, 'c-s': { title: 'S', intro: '', shows: [{ state: 'SCR-S.a' }] }, 'SCR-S': { name: 'S', kind: 'screen' }, 'SCR-S.a': stateValue }, notes: {}, tries: {}, opened: {}, where: {}, ...extra });

test('readReview defaults when missing or corrupt', () => {
  const data = setup(bookWith([]));
  assert.deepEqual(readReview(data), { rev: 0, accepted: {}, notes: {}, tries: {}, opened: {}, where: {} });
  writeFileSync(join(data, 'review.json'), '{nope');
  assert.equal(readReview(data).rev, 0);
  rmSync(data, { recursive: true });
});

test('currentItems reads mockups from disk', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'one' }]));
  assert.equal(currentItems(data)['SCR-S.a'].value.mockup, '<a>');
  assert.equal(currentItems(data).R1.value.text, 'one');
});

test('acceptItem accepts a changed requirement', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'new' }]), base({ accepted: { ...base().accepted, R1: { text: 'old' } }, opened: { R1: '2026-11-01T00:00:00Z' } }));
  const entry = acceptItem(data, 'R1', NOW);
  assert.deepEqual(entry.before, { text: 'old' });
  assert.deepEqual(entry.after, { text: 'new' });
  assert.equal(entry.kind, 'review');
  assert.equal(entry.opened, '2026-11-01T00:00:00Z');
  const review = readReview(data);
  assert.deepEqual(review.accepted.R1, { text: 'new' });
  assert.equal(review.rev, 4);
  assert.equal(review.opened.R1, undefined);
  assert.equal(readHistory(data).items.R1.length, 1);
});

test('acceptItem accepts a removal', () => {
  const data = setup(bookWith([]), base({ accepted: { ...base().accepted, R1: { text: 'old' } }, where: { R1: { kind: 'req', section: 'c-s', chapter: 'c' } } }));
  const entry = acceptItem(data, 'R1', NOW);
  assert.equal(entry.after, null);
  assert.deepEqual(entry.before, { text: 'old' });
  const review = readReview(data);
  assert.equal('R1' in review.accepted, false);
  assert.equal('R1' in review.where, false);
});

test('acceptItem throws not-under-review', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'a' }]), base({ accepted: { ...base().accepted, R1: { text: 'a' } } }));
  assert.throws(() => acceptItem(data, 'R1', NOW), { code: 'not-under-review' });
});

test('acceptItem keeps a note whose caused item is still open, and the last accept deletes it', () => {
  const book = bookWith([{ id: 'R1', text: 'new1' }, { id: 'R2', text: 'new2' }]);
  const data = setup(book, base({ accepted: { ...base().accepted, R1: { text: 'o1' }, R2: { text: 'o2' } }, notes: { n1: { item: 'R1', causes: ['R2'], text: 'why', status: 'answered', created: NOW } } }));
  const first = acceptItem(data, 'R1', NOW);
  assert.equal(first.notes.length, 1);
  let review = readReview(data);
  assert.deepEqual(review.notes.n1.closedFor, ['R1']);
  const open = Model.reviews(book, { 'mockups/a.html': '<a>' }, review, readHistory(data)).byKey;
  assert.equal(open.R1, undefined);
  assert.equal(open.R2.notes.length, 1);
  const second = acceptItem(data, 'R2', NOW);
  assert.equal(second.notes[0].text, 'why');
  review = readReview(data);
  assert.equal('n1' in review.notes, false);
});

test('changeItem freezes the current value and its notes, keeps them in notes, and adds a draft', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'cur' }]), base({ accepted: { ...base().accepted, R1: { text: 'old' } }, notes: { n1: { item: 'R1', text: 'q', status: 'answered', created: NOW } } }));
  const { noteId } = changeItem(data, 'R1', 'try again', NOW);
  const review = readReview(data);
  assert.deepEqual(review.tries.R1, [{ value: { text: 'cur' }, frozenAt: NOW, notes: ['n1'] }]);
  assert.equal(review.notes.n1.status, 'frozen');
  assert.deepEqual(review.notes[noteId], { item: 'R1', text: 'try again', created: NOW, status: 'draft' });
  assert.equal(review.rev, 4);
  assert.equal(review.opened.R1, NOW);
});

test('acceptItem after change copies tries with full frozen notes and deletes them', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'cur' }]), base({ accepted: { ...base().accepted, R1: { text: 'old' } }, notes: { n1: { item: 'R1', text: 'q', status: 'answered', created: NOW } } }));
  const { noteId } = changeItem(data, 'R1', 'again', NOW);
  const entry = acceptItem(data, 'R1', '2026-11-15T00:00:00Z');
  assert.equal(entry.tries.length, 1);
  assert.equal(entry.tries[0].notes[0].text, 'q');
  assert.equal(entry.tries[0].notes[0].status, 'frozen');
  assert.deepEqual(entry.tries[0].value, { text: 'cur' });
  assert.deepEqual(entry.notes.map((n) => n.text), ['again']);
  const review = readReview(data);
  assert.deepEqual(review.notes, {});
  assert.deepEqual(review.tries, {});
  assert.equal(noteId in review.notes, false);
});

test('decisions are matched by date', () => {
  const book = bookWith([{ id: 'R1', text: 'new' }], { decisions: [
    { id: 'D1', date: '2026-11-01', about: ['R1'] }, { id: 'D2', date: '2026-10-31', about: ['R1'] }, { id: 'D3', date: '2026-11-05', about: ['R2'] }, { id: 'D4', date: '2026-11-09', about: 'R1' }
  ] });
  const data = setup(book, base({ accepted: { ...base().accepted, R1: { text: 'old' } }, opened: { R1: '2026-11-01T08:00:00Z' } }));
  assert.deepEqual(acceptItem(data, 'R1', NOW).decisions, ['D1', 'D4']);
});

test('writeReviewNotes refuses stale and leaves the rest untouched', () => {
  const data = setup(bookWith([]), base({ tries: { X: [] }, accepted: { a: { text: 'x' } } }));
  assert.throws(() => writeReviewNotes(data, { n: {} }, 2), { code: 'stale' });
  assert.deepEqual(readReview(data).notes, {});
  assert.deepEqual(writeReviewNotes(data, { n: { item: 'a' } }, 3), { rev: 4 });
  const review = readReview(data);
  assert.deepEqual(review.accepted, { a: { text: 'x' } });
  assert.deepEqual(review.tries, { X: [] });
  assert.deepEqual(review.notes, { n: { item: 'a' } });
});

test('stampOpened stamps, records where, is idempotent and forgets finished reviews', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'new' }]), base({ opened: { OLD: 'x' }, where: { OLD: { kind: 'req' } } }));
  assert.equal(stampOpened(data, NOW), true);
  let review = readReview(data);
  assert.deepEqual(review.opened, { R1: NOW });
  assert.deepEqual(review.where, { R1: { kind: 'req', section: 'c-s', chapter: 'c' } });
  const rev = review.rev;
  assert.equal(stampOpened(data, '2027-01-01T00:00:00Z'), false);
  review = readReview(data);
  assert.equal(review.rev, rev);
  assert.equal(review.opened.R1, NOW);
});

test('stampOpened keeps where for a removed item still under review', () => {
  const data = setup(bookWith([]), base({ accepted: { ...base().accepted, R1: { text: 'old' } }, where: { R1: { kind: 'req', section: 'c-s', chapter: 'c' } } }));
  stampOpened(data, NOW);
  const review = readReview(data);
  assert.deepEqual(review.where.R1, { kind: 'req', section: 'c-s', chapter: 'c' });
  assert.equal(review.opened.R1, NOW);
});

test('linkNote and replyNote write the note and bump rev', () => {
  const data = setup(bookWith([]), base({ notes: { n1: { item: 'a', text: 't', status: 'sent' } } }));
  linkNote(data, 'n1', ['R1', 'R2']);
  linkNote(data, 'n1', ['R2', 'R3']);
  replyNote(data, 'n1', 'no change');
  const review = readReview(data);
  assert.deepEqual(review.notes.n1.causes, ['R1', 'R2', 'R3']);
  assert.equal(review.notes.n1.reply, 'no change');
  assert.equal(review.rev, 6);
  assert.throws(() => linkNote(data, 'zz', ['R1']), { code: 'not-found' });
  assert.throws(() => replyNote(data, 'zz', 'x'), { code: 'not-found' });
});

test('history file has sorted keys, is pretty-printed, and appends changelog and built entries', () => {
  const data = setup(bookWith([]));
  appendBuiltHistory(data, 'Z', { text: 'a' }, null, NOW);
  appendBuiltHistory(data, 'A', null, { text: 'b' }, NOW);
  appendBuiltHistory(data, 'A', { text: 'b' }, { text: 'c' }, NOW);
  appendChangelog(data, { build: 'b1', summary: 's' });
  const raw = readFileSync(join(data, 'history.json'), 'utf8');
  const history = JSON.parse(raw);
  assert.deepEqual(Object.keys(history.items), ['A', 'Z']);
  assert.equal(history.items.A.length, 2);
  assert.equal(history.items.A[0].kind, 'built');
  assert.equal(history.changelog.length, 1);
  assert.ok(raw.includes('\n  "items"'));
});

test('changeItem freezes a note only open here; a note open on another item stays open there', () => {
  const book = bookWith([{ id: 'R1', text: 'n1' }, { id: 'R2', text: 'n2' }]);
  const data = setup(book, base({ accepted: { ...base().accepted, R1: { text: 'o1' }, R2: { text: 'o2' } }, notes: {
    solo: { item: 'R1', text: 'a', status: 'answered', created: NOW },
    shared: { item: 'R1', causes: ['R2'], text: 'b', status: 'answered', created: NOW }
  } }));
  changeItem(data, 'R1', 'again', NOW);
  const review = readReview(data);
  assert.equal(review.notes.solo.status, 'frozen');
  assert.equal(review.notes.shared.status, 'answered');
  assert.deepEqual(review.notes.shared.closedFor, ['R1']);
  assert.deepEqual(review.tries.R1[0].notes.sort(), ['shared', 'solo']);
  const open = Model.reviews(book, { 'mockups/a.html': '<a>' }, review, readHistory(data)).byKey;
  assert.deepEqual(open.R2.notes.map((n) => n.id), ['shared']);
  assert.equal(open.R1.tries[0].notes.length, 2);
});

test('acceptItem keeps a try-listed note still open elsewhere, then deletes it with the last accept', () => {
  const book = bookWith([{ id: 'R1', text: 'n1' }, { id: 'R2', text: 'n2' }]);
  const data = setup(book, base({ accepted: { ...base().accepted, R1: { text: 'o1' }, R2: { text: 'o2' } }, notes: {
    solo: { item: 'R1', text: 'a', status: 'answered', created: NOW },
    shared: { item: 'R1', causes: ['R2'], text: 'b', status: 'answered', created: NOW }
  } }));
  changeItem(data, 'R1', 'again', NOW);
  const entry = acceptItem(data, 'R1', NOW);
  assert.deepEqual(entry.tries[0].notes.map((n) => n.text).sort(), ['a', 'b']);
  let review = readReview(data);
  assert.equal('solo' in review.notes, false);
  assert.equal(review.notes.shared.status, 'answered');
  acceptItem(data, 'R2', NOW);
  review = readReview(data);
  assert.equal('shared' in review.notes, false);
});

test('a note on a deleted never-accepted item is a review that Accept settles', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'one' }]), base({
    accepted: { ...base().accepted, R1: { text: 'one' } },
    notes: { n1: { item: 'DEL', text: 'duplicate, drop it', created: NOW, status: 'answered', section: 'c-s' } }
  }));
  const snap = currentSnapshot(data);
  const under = Model.reviews(snap.book, snap.mockups, readReview(data), {});
  assert.equal(under.byKey.DEL.orphan, true);
  assert.equal(under.bySection['c-s'], 1);
  stampOpened(data, NOW);
  assert.ok(readReview(data).opened.DEL);
  const entry = acceptItem(data, 'DEL', NOW);
  assert.equal(entry.notes[0].text, 'duplicate, drop it');
  assert.deepEqual(readReview(data).notes, {});
  assert.equal(readHistory(data).items.DEL.length, 1);
  assert.throws(() => acceptItem(data, 'DEL', NOW), { code: 'not-under-review' });
});

test('stampOpened does not overwrite a write made after it read the review', () => {
  const data = setup(bookWith([{ id: 'R1', text: 'one' }]), base({ notes: { n1: { item: 'R1', text: 't', created: NOW, status: 'sent' } } }));
  const stale = stampOpened(data, NOW, () => { linkNote(data, 'n1', ['c-s']); });
  assert.equal(stale, false);
  assert.deepEqual(readReview(data).notes.n1.causes, ['c-s']);
  // The next call, with nothing racing, stamps.
  assert.equal(stampOpened(data, NOW), true);
  assert.deepEqual(readReview(data).notes.n1.causes, ['c-s']);
});

test('sectionsUnderReview follows sameAs and placed components, not only the states a section shows', () => {
  const book = {
    roles: [{ id: 'member' }, { id: 'admin' }, { id: 'visitor' }],
    screens: [
      { id: 'SCR-HOME', name: 'HomeScreen', kind: 'screen', states: [
        { id: 'member', name: 'Member', when: { role: 'member' }, mockup: 'mockups/home-member.html' },
        { id: 'admin', name: 'Admin', when: { role: 'admin' }, mockup: 'mockups/home-admin.html' },
        { id: 'visitor', name: 'Visitor', when: { role: 'visitor' }, sameAs: 'member' }
      ] },
      { id: 'SCR-CARD', name: 'VisitorsCard', kind: 'component', states: [
        { id: 'waiting', name: '3 waiting', when: { also: 'visitors waiting' }, mockup: 'mockups/card-waiting.html' }
      ] }
    ],
    chapters: [{ id: 'c', title: 'C', intro: '', sections: [
      { id: 'a', title: 'A', shows: [{ state: 'SCR-HOME.admin', highlight: 'SCR-CARD' }] },
      { id: 'b', title: 'B', shows: [{ state: 'SCR-HOME.visitor' }] }
    ] }]
  };
  const data = mkdtempSync(join(tmpdir(), 'review-'));
  mkdirSync(join(data, 'mockups'));
  const files = {
    'home-member.html': '<p>member home</p>',
    'home-admin.html': '<main><sb-component id="SCR-CARD" state="waiting"></sb-component></main>',
    'card-waiting.html': '<b>3 waiting</b>'
  };
  const put = (name, text) => writeFileSync(join(data, 'mockups', name), text);
  for (const [name, text] of Object.entries(files)) {
    put(name, text);
  }
  writeBook(data, book);
  for (const key of Object.keys(currentItems(data))) {
    acceptItem(data, key, NOW);
  }
  assert.deepEqual(sectionsUnderReview(data, ['c-a', 'c-b']), []);
  put('card-waiting.html', '<b>4 waiting</b>');
  assert.deepEqual(sectionsUnderReview(data, ['c-a', 'c-b']), ['c-a']);
  acceptItem(data, 'SCR-CARD.waiting', NOW);
  put('home-member.html', '<p>edited member home</p>');
  assert.deepEqual(sectionsUnderReview(data, ['c-a', 'c-b']), ['c-b']);
  rmSync(data, { recursive: true });
});
