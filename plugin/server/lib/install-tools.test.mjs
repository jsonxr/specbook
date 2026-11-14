import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTools } from './install-tools.mjs';

const SOURCE = fileURLToPath(new URL('../collect-evidence.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url)), 'utf8')).version;

function fresh() {
  return mkdtempSync(join(tmpdir(), 'tools-'));
}

test('installs collect-evidence.mjs with a stamp, then leaves a current copy alone', () => {
  const data = fresh();
  assert.deepEqual(installTools(data), [`Installed tools/collect-evidence.mjs (specbook ${VERSION})`]);
  const copy = readFileSync(join(data, 'tools', 'collect-evidence.mjs'), 'utf8');
  const lines = copy.split('\n');
  assert.equal(lines[0], '#!/usr/bin/env node');
  assert.match(lines[1], new RegExp(`^// specbook-tool ${VERSION.replace(/\./g, '\\.')} sha256=[0-9a-f]{16} `));
  assert.equal(lines.slice(2).join('\n'), readFileSync(SOURCE, 'utf8').split('\n').slice(1).join('\n'));
  assert.deepEqual(installTools(data), []);
});

test('replaces an older, untouched copy', () => {
  const data = fresh();
  installTools(data);
  const file = join(data, 'tools', 'collect-evidence.mjs');
  // An older plugin version wrote a different body, stamped with that body's own hash.
  const oldBody = '// old evidence script\n';
  const stamp = `// specbook-tool 1.0.9 sha256=${createHash('sha256').update(oldBody).digest('hex').slice(0, 16)} (copied)\n`;
  writeFileSync(file, '#!/usr/bin/env node\n' + stamp + oldBody);
  assert.deepEqual(installTools(data), [`Updated tools/collect-evidence.mjs from specbook 1.0.9 to ${VERSION}`]);
  assert.equal(installTools(data).length, 0);
});

test('never overwrites a copy edited by hand', () => {
  const data = fresh();
  installTools(data);
  const file = join(data, 'tools', 'collect-evidence.mjs');
  const edited = readFileSync(file, 'utf8') + '// my change\n';
  writeFileSync(file, edited);
  const [line] = installTools(data);
  assert.match(line, /^Left tools\/collect-evidence\.mjs alone: it was edited by hand/);
  assert.equal(readFileSync(file, 'utf8'), edited);
});

test('the installed copy runs on its own and writes evidence.json', () => {
  const data = fresh();
  writeFileSync(join(data, 'book.json'), JSON.stringify({ chapters: [{ id: 'c', sections: [{ id: 's', requirements: [{ id: 'C-2222', text: 'x' }] }] }] }));
  writeFileSync(join(data, 'a.test.ts'), "it('[C-2222] does x', () => {});");
  installTools(data);
  execFileSync(process.execPath, [join(data, 'tools', 'collect-evidence.mjs'), '--data', data, '--unit', '*.test.ts'], { cwd: data, stdio: 'pipe' });
  const ev = JSON.parse(readFileSync(join(data, 'evidence', 'evidence.json'), 'utf8'));
  assert.deepEqual(ev.byId['C-2222'].unit.map(u => u.title), ['[C-2222] does x']);
});

test('CLI prints what it did', () => {
  const data = fresh();
  const cli = fileURLToPath(new URL('../install-tools.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [cli, '--data', data], { encoding: 'utf8' });
  assert.equal(out, `Installed tools/collect-evidence.mjs (specbook ${VERSION})\n`);
});
