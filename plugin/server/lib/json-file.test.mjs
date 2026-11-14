import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';

const dir = mkdtempSync(join(tmpdir(), 'specbook-json-'));

test('readJson returns fallback for missing, empty and corrupt files', () => {
  assert.deepEqual(readJson(join(dir, 'nope.json'), { a: 1 }), { a: 1 });
  writeFileSync(join(dir, 'empty.json'), '');
  assert.equal(readJson(join(dir, 'empty.json'), null), null);
  writeFileSync(join(dir, 'half.json'), '{"notes": {');
  assert.deepEqual(readJson(join(dir, 'half.json'), {}), {});
});

test('readJson returns the parsed file', () => {
  writeFileSync(join(dir, 'ok.json'), '{"a":2}');
  assert.deepEqual(readJson(join(dir, 'ok.json'), null), { a: 2 });
});

test('writeJsonAtomic creates folders and leaves no tmp file', () => {
  writeJsonAtomic(join(dir, 'a/b/c.json'), { x: 1 });
  assert.equal(readFileSync(join(dir, 'a/b/c.json'), 'utf8'), '{\n  "x": 1\n}\n');
  assert.equal(existsSync(join(dir, 'a/b/c.json.tmp')), false);
});
