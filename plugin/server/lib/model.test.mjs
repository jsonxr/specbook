import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const M = createRequire(import.meta.url)('../../app/model.js');

test('isProven needs a passed unit or e2e result', () => {
  const ev = { byId: { A: { unit: [{ status: 'failed' }], e2e: [{ status: 'passed' }] }, B: { unit: [{ status: 'unknown' }] } } };
  assert.equal(M.isProven(ev, 'A'), true);
  assert.equal(M.isProven(ev, 'B'), false);
  assert.equal(M.isProven({}, 'A'), false);
});
test('chapterStage', () => {
  const ch = st => ({ sections: st.map(s => ({ stage: s })) });
  assert.equal(M.chapterStage(ch(['built', 'building', 'drafting'])), 'building');
  assert.equal(M.chapterStage(ch(['built', 'ready', 'drafting'])), 'drafting');
  assert.equal(M.chapterStage(ch(['built', 'ready'])), 'ready');
  assert.equal(M.chapterStage(ch(['built', 'built'])), 'built');
  assert.equal(M.chapterStage({ sections: [] }), 'drafting');
});
test('stagePill names built sections with drafted changes, and labels', () => {
  const s = { stage: 'drafting', label: 'Phase 2', requirements: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b', change: 'add' }, { id: 'C', text: 'c', change: 'remove', reason: 'r' }] };
  assert.deepEqual(M.stagePill(s), { cls: 'drafting', text: 'Built · 2 changes drafting · Phase 2' });
  assert.deepEqual(M.stagePill({ stage: 'drafting', requirements: [{ id: 'B', change: 'add' }] }), { cls: 'drafting', text: 'Drafting' });
  assert.deepEqual(M.stagePill({ stage: 'built' }), { cls: 'built', text: 'Built' });
});

const book = () => ({ chapters: [{ id: 'c', title: 'C', intro: 'ci', sections: [{ id: 's', title: 'S', requirements: [
  { id: 'R1', text: 'one', change: 'change', today: 'was' }, 'plain string', { id: 'R2', text: 'two' }], frames: [{ id: 'c-s-1', caption: 'cap', role: 'admin', mockup: 'm/1.html' }, { id: 'c-s-2', mockup: 'm/none.html' }] }] }] });

test('itemsOf lists chapters, sections, requirements and frames by key', () => {
  const items = M.itemsOf(book(), { 'm/1.html': '<a>' });
  assert.deepEqual(Object.keys(items).sort(), ['R1', 'R2', 'c', 'c-s', 'c-s-1', 'c-s-2']);
  assert.deepEqual(items.c, { kind: 'chapter', value: { title: 'C', intro: 'ci' }, section: null, chapter: 'c' });
  assert.deepEqual(items['c-s'], { kind: 'section', value: { title: 'S', intro: '' }, section: 'c-s', chapter: 'c' });
  assert.deepEqual(items.R1, { kind: 'req', value: { text: 'one', change: 'change', today: 'was' }, section: 'c-s', chapter: 'c' });
  assert.deepEqual(items['c-s-1'].value, { caption: 'cap', role: 'admin', mockup: '<a>' });
  assert.equal(items['c-s-2'].value.mockup, null);
  assert.equal(items['c-s-1'].kind, 'frame');
});
test('sameValue ignores undefined fields and compares the rest', () => {
  assert.equal(M.sameValue({ text: 'a' }, { text: 'a', today: undefined }), true);
  assert.equal(M.sameValue({ text: 'a', change: 'add' }, { text: 'a', change: 'change' }), false);
  assert.equal(M.sameValue({ text: 'a' }, { text: 'a', change: 'add' }), false);
  assert.equal(M.sameValue(null, { text: 'a' }), false);
});

// Everything accepted as it is now.
const accepted = () => { const a = {}; const it = M.itemsOf(book(), { 'm/1.html': '<a>' }); Object.keys(it).forEach(k => { a[k] = it[k].value; }); return a; };
const MOCK = { 'm/1.html': '<a>' };

test('reviews: an item equal to its accepted copy with no notes or tries is not under review', () => {
  const r = M.reviews(book(), MOCK, { accepted: accepted(), notes: {}, tries: {} }, { items: {} });
  assert.deepEqual(r, { byKey: {}, bySection: {}, byChapter: {}, count: 0 });
});
test('reviews: null review and history are treated as empty', () => {
  const r = M.reviews(book(), MOCK, null, null);
  assert.equal(r.byKey.R1.status, 'new');
  assert.equal(M.reviews(book(), MOCK, undefined, undefined).count, 6);
});
test('reviews: no accepted copy → status new; differs → changed; accepted but absent from the book → removed (current null)', () => {
  const acc = accepted();
  delete acc.R2;
  acc.R1 = { text: 'older' };
  acc.GONE = { text: 'gone' };
  const r = M.reviews(book(), MOCK, { accepted: acc }, {});
  assert.equal(r.byKey.R2.status, 'new');
  assert.equal(r.byKey.R2.accepted, null);
  assert.equal(r.byKey.R1.status, 'changed');
  assert.deepEqual(r.byKey.R1.accepted, { text: 'older' });
  assert.equal(r.byKey.R1.current.text, 'one');
  assert.equal(r.byKey.GONE.status, 'removed');
  assert.equal(r.byKey.GONE.current, null);
  assert.equal(r.byKey.GONE.kind, 'req');
  assert.equal(r.count, 3);
});
test('reviews: an unchanged item with an open note → status noted', () => {
  const rv = { accepted: accepted(), notes: { n1: { item: 'R2', text: 'why?', status: 'sent' } } };
  const r = M.reviews(book(), MOCK, rv, {});
  assert.equal(r.byKey.R2.status, 'noted');
  assert.equal(r.byKey.R2.notes[0].id, 'n1');
  assert.equal(r.byKey.R2.notes[0].text, 'why?');
  assert.deepEqual(r.byKey.R2.accepted, r.byKey.R2.current);
  assert.equal(r.count, 1);
});
test('reviews: a note with causes [R2] shows under its own item and under R2; frozen notes are not open', () => {
  const rv = { accepted: accepted(), notes: {
    n1: { item: 'c-s', causes: ['R2'], text: 'add one', status: 'answered' },
    n2: { item: 'R2', text: 'old', status: 'frozen' },
  } };
  const r = M.reviews(book(), MOCK, rv, {});
  assert.deepEqual(Object.keys(r.byKey).sort(), ['R2', 'c-s']);
  assert.deepEqual(r.byKey['c-s'].notes.map(n => n.id), ['n1']);
  assert.deepEqual(r.byKey.R2.notes.map(n => n.id), ['n1']);
});
test('reviews: a note closedFor a key does not show under that key', () => {
  const rv = { accepted: accepted(), notes: { n1: { item: 'c-s', causes: ['R2'], status: 'answered', closedFor: ['R2'] } } };
  const r = M.reviews(book(), MOCK, rv, {});
  assert.deepEqual(Object.keys(r.byKey), ['c-s']);
  assert.deepEqual(r.byKey['c-s'].notes.map(n => n.id), ['n1']);
});
test('reviews: tries are returned oldest first with their frozen notes', () => {
  const rv = { accepted: accepted(), notes: { a: { item: 'R2', text: 'first', status: 'frozen' }, b: { item: 'R2', text: 'second', status: 'frozen' }, c: { item: 'R2', text: 'now', status: 'draft' } },
    tries: { R2: [{ value: { text: 't1' }, frozenAt: '2026-01-01', notes: ['a'] }, { value: { text: 't2' }, frozenAt: '2026-01-02', notes: ['b'] }] } };
  const r = M.reviews(book(), MOCK, rv, {}).byKey.R2;
  assert.equal(r.status, 'noted');
  assert.deepEqual(r.tries.map(t => t.value.text), ['t1', 't2']);
  assert.deepEqual(r.tries.map(t => t.frozenAt), ['2026-01-01', '2026-01-02']);
  assert.deepEqual(r.tries.map(t => t.notes.map(n => n.text)), [['first'], ['second']]);
  assert.deepEqual(r.notes.map(n => n.id), ['c']);
});
test('reviews: reversal when the current value equals the before of a history entry, with that entry\'s decisions', () => {
  const history = { items: { R2: [{ acceptedAt: '2026-03-04T10:00:00Z', before: { text: 'two' }, after: { text: 'zwei' }, decisions: ['DEC-1'] }] } };
  const acc = accepted();
  acc.R2 = { text: 'zwei' };
  const r = M.reviews(book(), MOCK, { accepted: acc }, history);
  assert.deepEqual(r.byKey.R2.reversal, { date: '2026-03-04', decisions: ['DEC-1'] });
  assert.equal(r.byKey.R1, undefined);
  // A history map holding only other keys, or an unrelated before, gives no warning.
  assert.equal(M.reviews(book(), MOCK, { accepted: acc }, { items: { R2: [{ acceptedAt: '2026-03-04', before: { text: 'else' } }] } }).byKey.R2.reversal, null);
  // Without decisions on the entry, decisions about the item are used.
  const b = book();
  b.decisions = [{ id: 'DEC-9', about: ['R2'] }, { id: 'DEC-8', about: ['R1'] }];
  const e = { items: { R2: [{ acceptedAt: '2026-03-04', before: { text: 'two' }, decisions: [] }] } };
  assert.deepEqual(M.reviews(b, MOCK, { accepted: acc }, e).byKey.R2.reversal.decisions, ['DEC-9']);
});
test('reviews: no reversal on a notes-only review whose value equals the accepted copy', () => {
  const history = { items: { R2: [{ acceptedAt: '2026-03-04T10:00:00Z', before: { text: 'two' }, after: { text: 'zwei' } }] } };
  const notes = { n1: { item: 'R2', text: 'hm', status: 'draft' } };
  const r = M.reviews(book(), MOCK, { accepted: accepted(), notes }, history);
  assert.equal(r.byKey.R2.status, 'noted');
  assert.equal(r.byKey.R2.reversal, null);
});
test('reviews: bySection/byChapter/count', () => {
  const acc = accepted();
  acc.R2 = { text: 'old' }; // requirement changed -> section c-s
  acc['c-s-1'] = { caption: 'x', role: 'admin', mockup: '<z>' }; // frame changed -> section c-s
  acc['c-s'] = { title: 'old', intro: '' }; // section heading -> itself
  acc.c = { title: 'old', intro: 'ci' }; // chapter heading -> chapter
  const r = M.reviews(book(), MOCK, { accepted: acc }, {});
  assert.equal(r.count, 4);
  assert.deepEqual(r.bySection, { 'c-s': 3 });
  assert.deepEqual(r.byChapter, { c: 4 });
});

test('reviews: a removed item takes kind, section and chapter from review.where; without it, only count', () => {
  const acc = accepted();
  acc.GONE = { text: 'gone' };
  acc.GONEF = { caption: 'x', mockup: '<q>' };
  const where = { GONE: { kind: 'req', section: 'c-s', chapter: 'c' }, GONEF: { kind: 'frame', section: 'c-s', chapter: 'c' } };
  const r = M.reviews(book(), MOCK, { accepted: acc, where }, {});
  assert.equal(r.byKey.GONE.kind, 'req');
  assert.equal(r.byKey.GONEF.kind, 'frame');
  assert.deepEqual(r.bySection, { 'c-s': 2 });
  assert.deepEqual(r.byChapter, { c: 2 });
  assert.equal(r.count, 2);
  const w2 = M.reviews(book(), MOCK, { accepted: { ...accepted(), GONE: { title: 'T', intro: '' } }, where: { GONE: { kind: 'chapter', section: null, chapter: 'c' } } }, {});
  assert.equal(w2.byKey.GONE.kind, 'chapter');
  assert.deepEqual(w2.bySection, {});
  assert.deepEqual(w2.byChapter, { c: 1 });
  const none = M.reviews(book(), MOCK, { accepted: acc }, {});
  assert.deepEqual(none.bySection, {});
  assert.equal(none.count, 2);
  assert.equal(none.byKey.GONEF.kind, 'frame');
});

test('reviews: a note whose item and causes are gone shows on its section, then its chapter, then the first chapter', () => {
  const book = { chapters: [{ id: 'a', sections: [{ id: 's', requirements: [] }] }, { id: 'b', sections: [{ id: 't', requirements: [] }] }] };
  const notes = {
    n1: { item: 'GONE1', text: 'x', status: 'answered' },
    n2: { item: 'GONE2', text: 'y', status: 'sent', section: 'b-t' },
    n3: { item: 'GONE3', text: 'z', status: 'sent', section: 'b' },
    n4: { item: 'GONE4', text: 'w', status: 'sent', section: 'nowhere' },
    n5: { item: 'GONE5', text: 'v', status: 'frozen' }
  };
  const accepted = Object.fromEntries(Object.entries(M.itemsOf(book, {})).map(([k, v]) => [k, v.value]));
  const r = M.reviews(book, {}, { accepted, notes, where: { GONE1: { kind: 'req', section: 'a-s', chapter: 'a' } } }, {});
  assert.deepEqual(Object.keys(r.byKey).filter(k => k.startsWith('GONE')).sort(), ['GONE1', 'GONE2', 'GONE3', 'GONE4']);
  assert.equal(r.byKey.GONE1.notes[0].id, 'n1');
  assert.deepEqual(r.bySection, { 'a-s': 1, 'b-t': 1 });
  assert.deepEqual(r.byChapter, { a: 2, b: 2 });
  assert.equal(r.count, 4);
});
