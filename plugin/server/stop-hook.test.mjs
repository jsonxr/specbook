import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/json-file.mjs';

const HOOK = fileURLToPath(new URL('./stop-hook.mjs', import.meta.url));
let project;
let data;
const hook = input => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, ...input }), encoding: 'utf8' });
const flag = (at = new Date().toISOString()) => writeJsonAtomic(join(data, 'requests', 'stop.flag'), { request: '2026-11-15T17-15-49-984Z.json', kind: 'revise', at });

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'specbook-hook-'));
  data = join(project, 'docs', 'specbook');
  mkdirSync(join(data, 'requests', 'work', 'x', 'mockups'), { recursive: true });
  writeJsonAtomic(join(data, 'book.json'), { chapters: [] });
  writeJsonAtomic(join(data, 'requests', 'work', 'x', 'book.json'), { chapters: [] });
});

test('with no Stop, every tool goes ahead', () => {
  for (const input of [{ tool_name: 'Edit', tool_input: { file_path: join(data, 'book.json') } }, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }]) {
    assert.equal(hook(input).status, 0);
  }
});

test('after a Stop, edits to the book, its mockups and its working copy are refused, and so is git commit', () => {
  flag();
  for (const input of [
    { tool_name: 'Edit', tool_input: { file_path: join(data, 'book.json') } },
    { tool_name: 'Write', tool_input: { file_path: join(data, 'mockups', 'a.html') } },
    { tool_name: 'MultiEdit', tool_input: { file_path: join(data, 'requests', 'work', 'x', 'book.json') } },
    { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "build"' } },
  ]) {
    const out = hook(input);
    assert.equal(out.status, 2, JSON.stringify(input));
    assert.match(out.stderr, /pressed Stop/);
  }
});

test('after a Stop, other files and other commands still go ahead', () => {
  flag();
  for (const input of [
    { tool_name: 'Edit', tool_input: { file_path: join(project, 'src', 'app.ts') } },
    { tool_name: 'Read', tool_input: { file_path: join(data, 'book.json') } },
    { tool_name: 'Bash', tool_input: { command: 'git status' } },
    { tool_name: 'Bash', tool_input: { command: 'node next-request.mjs --data docs/specbook --check x.json' } },
  ]) {
    assert.equal(hook(input).status, 0, JSON.stringify(input));
  }
});

test('a Stop over an hour old no longer blocks, and bad input never does', () => {
  flag(new Date(Date.now() - 61 * 60 * 1000).toISOString());
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: join(data, 'book.json') } }).status, 0);
  assert.equal(spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' }).status, 0);
});
