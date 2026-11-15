import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const INIT = fileURLToPath(new URL('./init.mjs', import.meta.url));

test('init git-ignores what stays local and keeps builds/ tracked', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-init-'));
  execFileSync(process.execPath, [INIT, '--project', root], { stdio: 'ignore' });
  assert.ok(existsSync(join(root, 'docs', 'specbook', 'book.json')));
  const gi = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
  for (const line of ['/docs/specbook/requests/', '/docs/specbook/.server.json', '/docs/specbook/media/*/*', '!/docs/specbook/media/*/.gitkeep', '/docs/specbook/**/*.tmp']) {
    assert.ok(gi.includes(line), line);
  }
  assert.ok(!gi.some(l => l.includes('builds')));
  const data = join(root, 'docs', 'specbook');
  const review = JSON.parse(readFileSync(join(data, 'review.json'), 'utf8'));
  assert.ok(Object.keys(review.accepted).length > 0);
  assert.deepEqual(review.notes, {});
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'history.json'), 'utf8')), { items: {}, changelog: [] });
  assert.match(readFileSync(join(root, 'docs', 'specbook', 'tools', 'collect-evidence.mjs'), 'utf8').split('\n')[1], /^\/\/ specbook-tool /);
});

test('the starter book has screens, no frames, and valid screens', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-init-'));
  execFileSync(process.execPath, [INIT, '--project', root], { stdio: 'ignore' });
  const data = join(root, 'docs', 'specbook');
  const book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
  assert.ok(book.screens.length > 0);
  for (const ch of book.chapters) for (const sec of ch.sections) assert.equal(sec.frames, undefined, sec.id);
  const mockups = {};
  const exists = p => {
    if (!existsSync(join(data, p))) return false;
    mockups[p] = readFileSync(join(data, p), 'utf8');
    return true;
  };
  const M = createRequire(import.meta.url)('../app/model.js');
  assert.equal(M.screenProblem(book, exists, mockups), null);
  const bar = book.screens.find(s => s.name === 'FiltersBar');
  for (const s of book.screens) {
    assert.ok(Array.isArray(s.variables), s.id);
    for (const st of s.states) {
      assert.equal(st.name, undefined, st.id);
      const cap = M.stateCaption(book, s.id + '.' + st.id);
      assert.ok(cap.roles.length > 0 || cap.text !== '', st.id);
    }
  }
  assert.equal(book.screens.find(s => s.name === 'TodosScreen').undrawn.length, 1);
  const todos = book.screens.find(s => s.name === 'TodosScreen');
  const list = todos.states.find(s => s.id === 'list');
  assert.equal(list.change, 'change');
  assert.ok(list.today);
  const tag = `<sb-component id="${bar.id}"`;
  assert.ok(mockups[list.mockup].includes(tag));
  assert.ok(mockups[todos.states.find(s => s.id === 'activeonly').mockup].includes(tag));
});
