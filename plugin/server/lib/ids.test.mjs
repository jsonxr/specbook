import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectIds, createMinter } from './ids.mjs';

test('collectIds gathers requirements, calls, decisions and usedIds', () => {
  const book = {
    chapters: [{ sections: [{ requirements: [{ id: 'A-1' }, 'plain'] }, {}] }, {}],
    calls: [{ id: 'CALL-1' }],
    decisions: [{ id: 'DEC-1' }],
    usedIds: ['OLD-1'],
  };
  assert.deepEqual([...collectIds(book)].sort(), ['A-1', 'CALL-1', 'DEC-1', 'OLD-1']);
});

test('mint never reuses an id and records it in usedIds', () => {
  const book = { chapters: [], decisions: [{ id: 'DEC-2222' }], usedIds: ['DEC-3333'] };
  const m = createMinter(book);
  const ids = new Set(Array.from({ length: 200 }, () => m.mint('DEC')));
  assert.equal(ids.size, 200);
  assert.ok(!ids.has('DEC-2222') && !ids.has('DEC-3333'));
  assert.ok(book.usedIds.includes([...ids][0]));
  assert.match([...ids][0], /^DEC-[2-9A-HJ-NP-Z]{4}$/);
});

test('mint keeps usedIds sorted and creates it when absent', () => {
  const book = {};
  const m = createMinter(book);
  for (let k = 0; k < 20; k++) {
    m.mint('CALL');
  }
  assert.equal(book.usedIds.length, 20);
  assert.deepEqual(book.usedIds, [...book.usedIds].sort());
});
