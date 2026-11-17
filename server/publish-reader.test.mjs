import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from './publish-reader.mjs';

const FILES = ['book.css', 'book.js', 'model.js', 'live.js', 'relay.js', 'share.js'];
const INDEX = `<!doctype html>
<html>
<head>
<link rel="stylesheet" href="/app/book.css">
</head>
<body>
<script src="/app/relay.js"></script>
<script src="/app/owner.js"></script>
<script src="/app/model.js"></script>
<script src="/app/book.js"></script>
</body>
</html>
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'publish-reader-'));
  const app = join(root, 'app');
  const out = join(root, 'r');
  mkdirSync(app);
  for (const f of FILES) writeFileSync(join(app, f), `// ${f}\n`);
  writeFileSync(join(app, 'index.html'), INDEX);
  return { app, out };
}

const versions = out => JSON.parse(readFileSync(join(out, 'versions.json'), 'utf8'));

test('first publish writes the files and versions.json', () => {
  const { app, out } = fixture();
  assert.deepEqual(publish({ app, out, version: '1.4.0' }), { version: '1.4.0', wrote: true });
  for (const f of FILES) {
    assert.equal(readFileSync(join(out, '1.4.0', f), 'utf8'), `// ${f}\n`);
  }
  assert.deepEqual(versions(out), ['1.4.0']);
});

test('share.html is rewritten from index.html', () => {
  const { app, out } = fixture();
  publish({ app, out, version: '1.4.0' });
  const html = readFileSync(join(out, '1.4.0', 'share.html'), 'utf8');
  assert.ok(!html.includes('owner.js'));
  assert.ok(!html.includes('/app/'));
  const share = html.indexOf('/r/1.4.0/share.js');
  const model = html.indexOf('/r/1.4.0/model.js');
  assert.ok(share > -1 && model > share);
  assert.match(html, /<script src="\/r\/1\.4\.0\/share\.js\?h=[0-9a-f]{12}"><\/script>/);
  assert.match(html, /<head>[\s\S]*<meta name="specbook-reader" content="1.4.0">[\s\S]*<\/head>/);
});

// share.html is never cached (the worker serves /s/ no-store), so the hash in each file's address makes a phone load
// the files again when a version is republished with --force during development, though /r/ is cached for good.
test('share.html asks for each file by its content hash', () => {
  const { app, out } = fixture();
  publish({ app, out, version: '1.4.0' });
  const before = readFileSync(join(out, '1.4.0', 'share.html'), 'utf8');
  for (const f of ['book.css', 'relay.js', 'model.js', 'book.js', 'share.js']) {
    assert.match(before, new RegExp(`/r/1\\.4\\.0/${f.replace('.', '\\.')}\\?h=[0-9a-f]{12}"`), f);
  }
  writeFileSync(join(app, 'book.js'), '// book.js, changed\n');
  publish({ app, out, version: '1.4.0', force: true });
  const after = readFileSync(join(out, '1.4.0', 'share.html'), 'utf8');
  const h = (html, f) => new RegExp(`/r/1\\.4\\.0/${f.replace('.', '\\.')}\\?h=([0-9a-f]{12})"`).exec(html)[1];
  assert.notEqual(h(after, 'book.js'), h(before, 'book.js'));
  assert.equal(h(after, 'model.js'), h(before, 'model.js'));
});

test('the same bytes are a no-op', () => {
  const { app, out } = fixture();
  publish({ app, out, version: '1.4.0' });
  assert.equal(publish({ app, out, version: '1.4.0' }).wrote, false);
});

test('changed bytes throw unless forced', () => {
  const { app, out } = fixture();
  publish({ app, out, version: '1.4.0' });
  writeFileSync(join(app, 'book.js'), '// changed\n');
  assert.throws(() => publish({ app, out, version: '1.4.0' }), /published 1\.4\.0 differs/);
  assert.equal(readFileSync(join(out, '1.4.0', 'book.js'), 'utf8'), '// book.js\n');
  assert.deepEqual(publish({ app, out, version: '1.4.0', force: true }), { version: '1.4.0', wrote: true });
  assert.equal(readFileSync(join(out, '1.4.0', 'book.js'), 'utf8'), '// changed\n');
});

test('versions sort by semver', () => {
  const { app, out } = fixture();
  publish({ app, out, version: '1.4.0' });
  publish({ app, out, version: '1.10.0' });
  publish({ app, out, version: '1.9.0' });
  assert.deepEqual(versions(out), ['1.4.0', '1.9.0', '1.10.0']);
});

test('a bad version throws and writes nothing', () => {
  const { app, out } = fixture();
  assert.throws(() => publish({ app, out, version: '../x' }));
  assert.ok(!existsSync(join(out, '..', 'x')));
});
