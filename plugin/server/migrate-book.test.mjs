import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIGRATE = fileURLToPath(new URL('./migrate-book.mjs', import.meta.url));
const book = { chapters: [{ id: 'c', sections: [{ id: 's', stage: 'drafting', requirements: [] }] }] };

test('migrate-book adds the git-ignore lines in the project that holds the book', () => {
  const root = mkdtempSync(join(tmpdir(), 'specbook-mig-'));
  mkdirSync(join(root, '.git'));
  const data = join(root, 'docs', 'specbook');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'book.json'), JSON.stringify(book));
  execFileSync(process.execPath, [MIGRATE, '--data', data]);
  const gi = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
  assert.ok(gi.includes('/docs/specbook/requests/'));
  assert.ok(!gi.includes('/docs/specbook/revise/'));
});

test('migrate-book creates review.json and history.json and prints the result', () => {
  const data = mkdtempSync(join(tmpdir(), 'specbook-mig-'));
  writeFileSync(join(data, 'book.json'), JSON.stringify(book));
  const out = execFileSync(process.execPath, [MIGRATE, '--data', data], { encoding: 'utf8' });
  assert.match(out, /from-book/);
  assert.ok(existsSync(join(data, 'review.json')));
  assert.ok(existsSync(join(data, 'history.json')));
  assert.match(execFileSync(process.execPath, [MIGRATE, '--data', data], { encoding: 'utf8' }), /exists/);
});

test('migrate-book outside a git project leaves .gitignore alone', () => {
  const data = mkdtempSync(join(tmpdir(), 'specbook-mig-'));
  writeFileSync(join(data, 'book.json'), JSON.stringify(book));
  execFileSync(process.execPath, [MIGRATE, '--data', data]);
  assert.equal(existsSync(join(data, '.gitignore')), false);
});
