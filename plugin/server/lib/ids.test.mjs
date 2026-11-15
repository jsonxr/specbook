import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectIds, createMinter } from './ids.mjs';

const ASSIGN = join(import.meta.dirname, '..', 'assign-ids.mjs');

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

test('collectIds includes screen ids', () => {
  assert.deepEqual([...collectIds({ screens: [{ id: 'SCR-A' }, { name: 'no id' }] })], ['SCR-A']);
});

test('assign-ids mints SCR ids for screens without one and keeps existing ones', () => {
  const data = mkdtempSync(join(tmpdir(), 'ids-'));
  writeFileSync(join(data, 'book.json'), JSON.stringify({ chapters: [], screens: [{ id: 'SCR-KEEP', name: 'A' }, { name: 'B' }] }));
  execFileSync(process.execPath, [ASSIGN, '--data', data], { stdio: 'ignore' });
  const book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
  assert.equal(book.screens[0].id, 'SCR-KEEP');
  assert.match(book.screens[1].id, /^SCR-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(book.screens[1].name, 'B');
  assert.ok(book.usedIds.includes(book.screens[1].id));
});
