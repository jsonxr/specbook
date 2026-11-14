import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
