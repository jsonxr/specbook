import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { migrateReview } from './migrate-review.mjs';
import { readHistory, readReview } from './review.mjs';

const Model = createRequire(import.meta.url)('../../app/model.js');
const NOW = '2026-11-14T10:00:00.000Z';

function book(text = 'now', caption = 'cap now', intro = 'intro now') {
  return {
    chapters: [{
      id: 'c', title: 'C', intro: '',
      sections: [{
        id: 's', title: 'S', intro, stage: 'ready',
        requirements: [{ id: 'R1', text }, { id: 'R2', text: 'two' }],
        shows: [{ state: 'SCR-S.a' }]
      }]
    }],
    screens: [{ id: 'SCR-S', name: 'S', kind: 'screen', states: [{ id: 'a', name: caption, mockup: 'mockups/a.html' }] }],
    decisions: [{ id: 'D1', about: ['R1'], date: '2026-11-01', section: 'c-s' }]
  };
}

function setup({ current = book(), baseline, notes, mockup = '<now>' } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'migrate-review-'));
  mkdirSync(join(data, 'mockups'));
  writeFileSync(join(data, 'mockups/a.html'), mockup);
  writeFileSync(join(data, 'book.json'), JSON.stringify(current));
  if (baseline) {
    mkdirSync(join(data, 'revise'));
    writeFileSync(join(data, 'revise/before.json'), JSON.stringify(baseline));
  }
  if (notes) {
    writeFileSync(join(data, 'notes.json'), JSON.stringify({ rev: 4, notes }));
  }
  return data;
}

const open = (data) => {
  const review = readReview(data);
  return Model.reviews(JSON.parse(readFileSync(join(data, 'book.json'), 'utf8')), { 'mockups/a.html': readFileSync(join(data, 'mockups/a.html'), 'utf8') }, review, readHistory(data));
};

test('no baseline: everything is accepted from the current book', () => {
  const data = setup();
  assert.equal(migrateReview(data, NOW), 'from-book');
  const review = readReview(data);
  assert.deepEqual(review.accepted.R1, { text: 'now' });
  assert.deepEqual(review.accepted['SCR-S.a'], { name: 'cap now', mockup: '<now>', today: null });
  assert.deepEqual(review.accepted['c-s'], { title: 'S', intro: 'intro now', shows: [{ state: 'SCR-S.a' }] });
  assert.deepEqual(review.accepted.c, { title: 'C', intro: '' });
  assert.equal(open(data).count, 0);
  assert.deepEqual(readHistory(data), { items: {}, changelog: [] });
});

test('baseline: accepted holds the old values, so changes become reviews stamped with opened and where', () => {
  const data = setup({
    baseline: { takenAt: 'x', book: book('old', 'cap old', 'intro old'), mockups: { 'mockups/a.html': '<old>' }, dismissed: [] }
  });
  assert.equal(migrateReview(data, NOW), 'from-baseline');
  const review = readReview(data);
  assert.deepEqual(review.accepted.R1, { text: 'old' });
  assert.deepEqual(review.accepted['SCR-S.a'], { name: 'cap old', mockup: '<old>', today: null });
  assert.deepEqual(review.accepted['c-s'], { title: 'S', intro: 'intro old', shows: [{ state: 'SCR-S.a' }] });
  assert.deepEqual(Object.keys(open(data).byKey).sort(), ['R1', 'SCR-S.a', 'c-s']);
  assert.equal(review.opened.R1, NOW);
  assert.deepEqual(review.where.R1, { kind: 'req', section: 'c-s', chapter: 'c' });
  assert.equal(existsSync(join(data, 'revise/before.json')), false);
  assert.equal(existsSync(join(data, 'notes.json')), false);
});

test('old accepted entries are mapped to the new keys; :stage dropped; state strings keep the state other fields', () => {
  const data = setup({
    baseline: {
      book: book('old', 'cap old', 'intro old'), mockups: { 'mockups/a.html': '<old>' }, dismissed: [],
      accepted: {
        R1: { id: 'R1', text: 'now' },
        'c-s:sec': { title: 'S', intro: 'intro now' },
        'c-s:stage': 'drafting',
        'SCR-S.a': '<now>',
        R2: null
      }
    }
  });
  migrateReview(data, NOW);
  const review = readReview(data);
  assert.deepEqual(review.accepted.R1, { text: 'now' });
  assert.deepEqual(review.accepted['c-s'], { title: 'S', intro: 'intro now' });
  assert.deepEqual(review.accepted['SCR-S.a'], { name: 'cap now', mockup: '<now>', today: null });
  assert.equal('c-s:sec' in review.accepted, false);
  assert.equal('c-s:stage' in review.accepted, false);
  assert.equal('R2' in review.accepted, false);
  // R2 was accepted as removed, but it is still in the book: it is new again. The old section entry has no `shows`.
  assert.deepEqual(Object.keys(open(data).byKey).sort(), ['R2', 'c-s']);
});

test('dismissed keys are accepted at the current value', () => {
  const data = setup({
    baseline: { book: book('old', 'cap old', 'intro old'), mockups: { 'mockups/a.html': '<old>' }, dismissed: ['R1', 'SCR-S.a', 'c-s:new', 'c-s:edit', 'c-s:stage'] }
  });
  migrateReview(data, NOW);
  assert.equal(open(data).count, 0);
  assert.deepEqual(readReview(data).accepted.R1, { text: 'now' });
});

test('a dismissed requirement gone from the book is accepted as removed', () => {
  const baseline = book();
  baseline.chapters[0].sections[0].requirements.push({ id: 'R3', text: 'gone' });
  const data = setup({ baseline: { book: baseline, mockups: { 'mockups/a.html': '<now>' }, dismissed: ['R3'] } });
  migrateReview(data, NOW);
  assert.equal('R3' in readReview(data).accepted, false);
  assert.equal(open(data).count, 0);
});

test('a requirement removed from the book stays accepted: a pending removal', () => {
  const baseline = book();
  baseline.chapters[0].sections[0].requirements.push({ id: 'R3', text: 'gone' });
  const data = setup({ baseline: { book: baseline, mockups: { 'mockups/a.html': '<now>' }, dismissed: [] } });
  migrateReview(data, NOW);
  assert.deepEqual(readReview(data).accepted.R3, { text: 'gone' });
  assert.deepEqual(Object.keys(open(data).byKey), ['R3']);
});

test('notes become drafts on their item, keeping pin fields', () => {
  const element = { mockup: 'mockups/a.html', selector: 'b', text: 't', html: '<b>' };
  const data = setup({
    notes: {
      n1: { text: 'on req', target: 'R1', section: 'c-s', rx: 0.4, ry: 0.2, dx: 90, dy: -70, created: '2026-11-13T00:00:00Z' },
      n2: { text: 'fallback', target: 'c-s-r2', section: 'c-s', rx: 0, ry: 0.5 },
      n3: { text: 'decision', target: 'D1', section: 'c-s', rx: 0, ry: 0.5 },
      n4: { text: 'frame', target: 'SCR-S.a', section: 'c-s', rx: 0.1, ry: 0.1, element },
      n5: { text: 'heading', target: 'c-s', rx: 0, ry: 0 }
    }
  });
  migrateReview(data, NOW);
  const { notes } = readReview(data);
  assert.deepEqual(notes.n1, { item: 'R1', text: 'on req', status: 'draft', created: '2026-11-13T00:00:00Z', target: 'R1', section: 'c-s', pin: { rx: 0.4, ry: 0.2, dx: 90, dy: -70 } });
  assert.equal(notes.n2.item, 'c-s');
  assert.equal(notes.n3.item, 'c-s');
  assert.equal(notes.n4.item, 'SCR-S.a');
  assert.deepEqual(notes.n4.pin.element, element);
  assert.equal(notes.n5.item, 'c-s');
  assert.ok(Object.values(notes).every((n) => n.status === 'draft' && typeof n.created === 'string'));
  assert.deepEqual(Object.keys(open(data).byKey).sort(), ['R1', 'SCR-S.a', 'c-s']);
});

test('a note whose target maps to no key is kept on the closest section, else the chapter', () => {
  const data = setup({
    notes: {
      a: { text: 'by prefix', target: 'c-s-r9', rx: 0, ry: 0 },
      b: { text: 'by chapter prefix', target: 'c-zzz-r1', rx: 0, ry: 0 },
      c: { text: 'by section field', target: 'WHO-KNOWS', section: 'c-s', rx: 0, ry: 0 },
      d: { text: 'nothing', target: 'WHO-KNOWS', rx: 0, ry: 0 }
    }
  });
  migrateReview(data, NOW);
  const { notes } = readReview(data);
  assert.equal(Object.keys(notes).length, 4);
  assert.equal(notes.a.item, 'c-s');
  assert.equal(notes.b.item, 'c');
  assert.equal(notes.c.item, 'c-s');
  assert.equal(notes.d.item, 'c');
  assert.equal(notes.d.from, 'WHO-KNOWS');
  assert.equal(notes.d.text, 'nothing');
  assert.equal('from' in notes.a, false);
});

test('a second run does nothing', () => {
  const data = setup({ notes: { n1: { text: 'x', target: 'R1', rx: 0, ry: 0 } } });
  assert.equal(migrateReview(data, NOW), 'from-book');
  const before = readFileSync(join(data, 'review.json'), 'utf8');
  assert.equal(migrateReview(data, NOW), 'exists');
  assert.equal(readFileSync(join(data, 'review.json'), 'utf8'), before);
});
