import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./add-media.mjs', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'add-media-'));
  const data = join(root, 'data');
  spawnSync('mkdir', ['-p', data]);
  writeFileSync(
    join(data, 'book.json'),
    JSON.stringify({ screens: [{ id: 'SCR-HOME', name: 'HomeScreen', kind: 'screen', states: [{ id: 'admin', name: 'Admin' }] }], chapters: [] })
  );
  const png = join(root, 'shot.png');
  writeFileSync(png, 'png');
  return { data, png };
}
const run = (data, key, file) => spawnSync(process.execPath, [SCRIPT, '--data', data, '--screen', key, file], { encoding: 'utf8' });

test('--screen copies a picture under the state key', () => {
  const { data, png } = fixture();
  const r = run(data, 'SCR-HOME.admin', png);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(data, 'media', 'screens', 'SCR-HOME.admin.png')));
});

test('--screen refuses a key that is not a state in the book', () => {
  const { data, png } = fixture();
  const r = run(data, 'SCR-HOME.nope', png);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SCR-HOME\.nope/);
  assert.equal(existsSync(join(data, 'media', 'screens', 'SCR-HOME.nope.png')), false);
});
