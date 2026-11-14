import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureIgnores, IGNORED } from './gitignore.mjs';

const lines = file => readFileSync(file, 'utf8').split('\n');

test('ensureIgnores adds every line once', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-gi-'));
  const added = ensureIgnores(root, 'docs/specbook');
  const want = IGNORED.map(l => l.replace('<rel>', '/docs/specbook'));
  assert.deepEqual(added, want);
  for (const line of ['/docs/specbook/requests/', '/docs/specbook/**/*.tmp', '!/docs/specbook/media/*/.gitkeep']) {
    assert.ok(lines(join(root, '.gitignore')).includes(line), line);
  }
  assert.ok(!lines(join(root, '.gitignore')).some(l => l.includes('builds')));
  assert.deepEqual(ensureIgnores(root, 'docs/specbook'), []);
});

test('ensureIgnores appends only the missing lines, after a file with no final new line', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-gi-'));
  writeFileSync(join(root, '.gitignore'), 'node_modules\n/docs/specbook/requests/\n/docs/specbook/.server.json');
  const added = ensureIgnores(root, '/docs/specbook');
  assert.ok(!added.includes('/docs/specbook/requests/'));
  assert.ok(added.includes('/docs/specbook/media/*/*'));
  const all = lines(join(root, '.gitignore'));
  assert.equal(all.filter(l => l === '/docs/specbook/requests/').length, 1);
  assert.ok(all.includes('/docs/specbook/.server.json'));
  assert.ok(all.includes('node_modules'));
});

test('ensureIgnores writes one leading slash when the data folder is the project root', () => {
  for (const rel of ['', '/']) {
    const root = mkdtempSync(join(tmpdir(), 'specbook-gi-'));
    const added = ensureIgnores(root, rel);
    assert.deepEqual(added, IGNORED.map(l => l.replace('<rel>', '')), JSON.stringify(rel));
    const all = lines(join(root, '.gitignore'));
    for (const line of ['/requests/', '/.server.json', '/**/*.tmp', '!/media/*/.gitkeep']) {
      assert.ok(all.includes(line), line);
    }
    assert.ok(!all.some(l => l.includes('//')));
  }
});

test('ensureIgnores adds no second header after the old init.mjs header', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-gi-'));
  const old = '# spec book (served by the specbook plugin): requests and captured media stay local';
  writeFileSync(join(root, '.gitignore'), `node_modules\n\n${old}\n/docs/specbook/requests/\n/docs/specbook/media/*/*\n`);
  const added = ensureIgnores(root, 'docs/specbook');
  assert.ok(added.includes('/docs/specbook/**/*.tmp'));
  const all = lines(join(root, '.gitignore'));
  assert.equal(all.filter(l => l.startsWith('# spec book')).length, 1);
});

test('ensureIgnores adds the header once, and only with lines to append', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-gi-'));
  ensureIgnores(root, 'docs/specbook');
  const file = join(root, '.gitignore');
  // A line removed by hand is added back under the existing header.
  writeFileSync(file, readFileSync(file, 'utf8').replace('/docs/specbook/.server.json\n', ''));
  assert.deepEqual(ensureIgnores(root, 'docs/specbook'), ['/docs/specbook/.server.json']);
  assert.equal(lines(file).filter(l => l.startsWith('# spec book')).length, 1);
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(ensureIgnores(root, 'docs/specbook'), []);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('ensureIgnores removes the old revise and notes lines and does not list them as added', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-gi-'));
  writeFileSync(join(root, '.gitignore'), 'node_modules\n/docs/specbook/revise/\n/docs/specbook/notes.json\n/docs/specbook/requests/\n');
  const added = ensureIgnores(root, 'docs/specbook');
  assert.ok(!added.some(l => l.includes('revise') || l.includes('notes.json')));
  const all = lines(join(root, '.gitignore'));
  assert.ok(!all.includes('/docs/specbook/revise/'));
  assert.ok(!all.includes('/docs/specbook/notes.json'));
  assert.ok(all.includes('node_modules'));
  assert.ok(all.includes('/docs/specbook/requests/'));
  assert.deepEqual(ensureIgnores(root, 'docs/specbook'), []);
});

test('ensureIgnores removes the old lines even when nothing needs adding', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-gi-'));
  ensureIgnores(root, 'docs/specbook');
  const file = join(root, '.gitignore');
  writeFileSync(file, readFileSync(file, 'utf8') + '/docs/specbook/notes.json\n');
  assert.deepEqual(ensureIgnores(root, 'docs/specbook'), []);
  assert.ok(!lines(file).includes('/docs/specbook/notes.json'));
});
