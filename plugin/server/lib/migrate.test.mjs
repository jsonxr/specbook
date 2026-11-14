import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateBook } from './migrate.mjs';

test('migrates statuses, today, pills and calls', () => {
  const old = { chapters: [{ id: 'c', status: 'built', pill: 'Built', sections: [
    { id: 'a', status: 'built', pill: 'Built', requirements: [{ id: 'A1', text: 'x' }, { id: 'A2', text: 'y', status: 'proposed', today: 'z' }] },
    { id: 'b', status: 'phase', pill: 'Phase 2', requirements: [{ id: 'B1', text: 'p' }] },
    { id: 'd', status: 'built', requirements: [{ id: 'D1', text: 'q' }] }] }],
    calls: [{ id: 'CALL-2345', text: 'Kept on <b>device</b>' }], decisions: [{ id: 'DEC-2345', title: 't', body: 'b' }] };
  const { book, changed } = migrateBook(structuredClone(old), '2026-11-12');
  assert.equal(changed, true);
  const [a, b, d] = book.chapters[0].sections;
  assert.equal(a.stage, 'drafting');
  assert.deepEqual(a.requirements, [{ id: 'A1', text: 'x' }, { id: 'A2', text: 'y', change: 'change', today: 'z' }]);
  assert.equal(b.stage, 'drafting'); assert.equal(b.label, 'Phase 2'); assert.equal(b.requirements[0].change, 'add');
  assert.equal(d.stage, 'built');
  assert.equal(book.chapters[0].status, undefined); assert.equal(a.pill, undefined);
  assert.equal(book.calls, undefined);
  assert.deepEqual(book.decisions.map(x => [x.id, x.kind, x.by, x.date]), [['DEC-2345', 'decision', 'user', '2026-11-12'], ['CALL-2345', 'decision', 'user', '2026-11-12']]);
  assert.equal(book.decisions[1].title, 'Kept on device');
  assert.equal(migrateBook(book, '2026-11-13').changed, false);
});

test('plain-string requirements in a drafting section become id-less adds', () => {
  const old = { chapters: [{ id: 'c', sections: [
    { id: 'p', status: 'proposed', requirements: ['one', { id: 'P2', text: 'two' }] },
    { id: 'b', status: 'built', requirements: ['kept'] }] }] };
  const { book } = migrateBook(old, '2026-11-12');
  assert.deepEqual(book.chapters[0].sections[0].requirements, [{ text: 'one', change: 'add' }, { id: 'P2', text: 'two', change: 'add' }]);
  assert.deepEqual(book.chapters[0].sections[1].requirements, ['kept']);
});

test('string and id-less calls become id-less decisions', () => {
  const { book } = migrateBook({ chapters: [], calls: ['Plain <i>call</i>', { text: 'Obj' }] }, '2026-11-12');
  assert.deepEqual(book.decisions, [
    { date: '2026-11-12', about: [], by: 'user', title: 'Plain call', body: 'Plain <i>call</i>', kind: 'decision' },
    { date: '2026-11-12', about: [], by: 'user', title: 'Obj', body: 'Obj', kind: 'decision' },
  ]);
});

test('migrate, assign-ids, migrate is stable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specbook-mig-'));
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ chapters: [{ id: 'c', sections: [{ id: 'p', status: 'proposed', requirements: ['one'] }] }], calls: ['A call'] }));
  const run = script => execFileSync('node', [fileURLToPath(new URL(script, import.meta.url)), '--data', dir], { encoding: 'utf8' });
  assert.match(run('../migrate-book.mjs'), /Migrated book.json/);
  run('../assign-ids.mjs');
  assert.match(run('../migrate-book.mjs'), /Already in the new format/);
  const book = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'));
  assert.match(book.decisions[0].id, /^DEC-/);
  assert.match(book.chapters[0].sections[0].requirements[0].id, /^C-/);
});
