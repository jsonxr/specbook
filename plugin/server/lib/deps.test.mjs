import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depsDir, ensureDeps, loadRtc } from './deps.mjs';

function withDeps(fn) {
  const root = mkdtempSync(join(tmpdir(), 'specbook-deps-'));
  const prev = process.env.SPECBOOK_DEPS;
  process.env.SPECBOOK_DEPS = root;
  const restore = () => {
    if (prev === undefined) delete process.env.SPECBOOK_DEPS;
    else process.env.SPECBOOK_DEPS = prev;
    rmSync(root, { recursive: true, force: true });
  };
  return Promise.resolve(fn(root)).finally(restore);
}

test('depsDir is under SPECBOOK_DEPS', () =>
  withDeps(() => {
    process.env.SPECBOOK_DEPS = '/x';
    assert.equal(depsDir('1.4.0'), join('/x', '1.4.0'));
  }));

test('ensureDeps does not run npm when the library is already there', () =>
  withDeps(async root => {
    const lib = join(root, '1.4.0', 'node_modules', 'node-datachannel');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: 'node-datachannel', exports: { './polyfill': './polyfill.js' } }));
    writeFileSync(join(lib, 'polyfill.js'), '');
    let calls = 0;
    const logs = [];
    const r = await ensureDeps({ version: '1.4.0', log: m => logs.push(m), run: async () => { calls++; return { ok: true }; } });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
  }));

test('ensureDeps installs again when the library folder is only partly there', () =>
  withDeps(async root => {
    mkdirSync(join(root, '1.4.0', 'node_modules', 'node-datachannel'), { recursive: true });
    let calls = 0;
    const r = await ensureDeps({ version: '1.4.0', log: () => {}, run: async () => { calls++; return { ok: true }; } });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls, 1);
  }));

test('ensureDeps copies package.json, logs once and runs npm in the folder', () =>
  withDeps(async root => {
    const logs = [];
    const seen = [];
    const r = await ensureDeps({
      version: '1.4.0',
      log: m => logs.push(m),
      run: async dir => { seen.push(dir); return { ok: true }; },
    });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(seen, [join(root, '1.4.0')]);
    assert.deepEqual(logs, ['Installing the share library (once)…']);
    const pkg = JSON.parse(readFileSync(join(root, '1.4.0', 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['node-datachannel'], '0.33.6');
  }));

test('ensureDeps reports a failing install', () =>
  withDeps(async () => {
    const r = await ensureDeps({ version: '1.4.0', log: () => {}, run: async () => ({ ok: false, error: 'boom' }) });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /boom/);
  }));

test('ensureDeps rejects a version that is not a plain semver', () =>
  withDeps(async root => {
    const r = await ensureDeps({ version: '../evil', log: () => {}, run: async () => ({ ok: true }) });
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(root, '..', 'evil')), false);
  }));

test('loadRtc returns null when nothing is installed', () =>
  withDeps(() => {
    assert.equal(loadRtc('1.4.0'), null);
  }));
