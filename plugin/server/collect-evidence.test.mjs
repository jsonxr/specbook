import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./collect-evidence.mjs', import.meta.url));

const BOOK = {
  chapters: [
    {
      id: 'onboarding',
      sections: [{ id: 'a', requirements: [{ id: 'ONB-S5U2', text: 'x' }, { id: 'ONB-GH94', text: 'y' }, { id: 'ONB-AAAA', text: 'z' }] }]
    }
  ],
  calls: [{ id: 'CALL-7Q2D', text: 'c' }],
  decisions: []
};

function fixture({ units = {}, e2e = {}, book = BOOK, results = {}, e2eTests = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-'));
  const data = join(root, 'data');
  mkdirSync(data);
  writeFileSync(join(data, 'book.json'), JSON.stringify(book));
  for (const [name, body] of Object.entries(units)) {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', name), body);
  }
  for (const [name, body] of Object.entries(e2eTests)) {
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(join(root, 'e2e', name), body);
  }
  for (const [name, body] of Object.entries(results)) {
    writeFileSync(join(root, name), JSON.stringify(body));
  }
  if (Object.keys(e2e).length > 0) {
    mkdirSync(join(root, 'e2e-results'));
    for (const [name, body] of Object.entries(e2e)) {
      writeFileSync(join(root, 'e2e-results', name), JSON.stringify(body));
    }
  }
  return { root, data };
}

function run(root, data, args) {
  execFileSync('node', [SCRIPT, '--data', data, ...args], { cwd: root, stdio: 'pipe' });
  return JSON.parse(readFileSync(join(data, 'evidence', 'evidence.json'), 'utf8'));
}

test('finds ids in it and test titles', () => {
  const { root, data } = fixture({
    units: {
      'a.test.ts': `
        it('[ONB-S5U2] landing shows Join', () => {});
        test("[ONB-S5U2][ONB-GH94] both ids", () => {});
        it('no id here', () => {});
        it('mentions [ONB-AAAA] mid title', () => {});
        it.skip('[ONB-AAAA] skipped one', () => {});
      `
    }
  });
  const ev = run(root, data, ['--unit', 'src/*.test.ts']);
  assert.deepEqual(ev.byId['ONB-S5U2'].unit.map(u => u.title), ['[ONB-S5U2] landing shows Join', '[ONB-S5U2][ONB-GH94] both ids']);
  assert.deepEqual(ev.byId['ONB-GH94'].unit.map(u => u.title), ['[ONB-S5U2][ONB-GH94] both ids']);
  assert.deepEqual(ev.byId['ONB-AAAA'].unit.map(u => u.title), ['[ONB-AAAA] skipped one']);
  assert.equal(ev.byId['ONB-S5U2'].unit[0].status, 'unknown');
  assert.deepEqual(ev.unknownIds, []);
});

test('reads pass/fail from a jest json and a vitest json', () => {
  const { root, data } = fixture({
    units: {
      'a.test.ts': `it('[ONB-S5U2] one', () => {}); it('[ONB-GH94] two', () => {}); it('[ONB-AAAA] three', () => {});`,
      'b.test.ts': `it('[ONB-S5U2] one', () => {});`
    }
  });
  const abs = f => join(root, 'src', f);
  writeFileSync(
    join(root, 'jest.json'),
    JSON.stringify({
      testResults: [
        {
          name: abs('a.test.ts'),
          assertionResults: [
            { title: '[ONB-S5U2] one', fullName: 'suite [ONB-S5U2] one', status: 'passed' },
            { title: '[ONB-GH94] two', fullName: 'suite [ONB-GH94] two', status: 'failed' }
          ]
        }
      ]
    })
  );
  writeFileSync(
    join(root, 'vitest.json'),
    JSON.stringify({ testResults: [{ name: abs('b.test.ts'), assertionResults: [{ title: '[ONB-S5U2] one', status: 'passed' }] }] })
  );
  const ev = run(root, data, ['--unit', 'src/*.test.ts', '--unit-results', 'jest.json', 'vitest.json']);
  const s5 = ev.byId['ONB-S5U2'].unit;
  assert.deepEqual(s5.map(u => [u.file, u.status]), [['src/a.test.ts', 'passed'], ['src/b.test.ts', 'passed']]);
  assert.equal(ev.byId['ONB-GH94'].unit[0].status, 'failed');
  assert.equal(ev.byId['ONB-AAAA'].unit[0].status, 'unknown');
});

test('reads an escaped quote in a title as the quote itself, and still finds its result', () => {
  const { root, data } = fixture({
    units: {
      'a.test.ts': String.raw`it('[ONB-S5U2] a visitor\'s rows say \"hi\" \\ once', () => {}); test("[ONB-GH94] say \"no\"", () => {});`
    },
    e2eTests: { 'onboarding.test.ts': String.raw`await requirement('ONB-ZZZZ', 'it\'s unknown', async () => {});` }
  });
  writeFileSync(
    join(root, 'jest.json'),
    JSON.stringify({
      testResults: [
        {
          name: join(root, 'src', 'a.test.ts'),
          assertionResults: [{ title: `[ONB-S5U2] a visitor's rows say "hi" \\ once`, status: 'passed' }]
        }
      ]
    })
  );
  const ev = run(root, data, ['--unit', 'src/*.test.ts', '--unit-results', 'jest.json', '--e2e-tests', 'e2e/*.test.ts']);
  assert.deepEqual(ev.byId['ONB-S5U2'].unit.map(u => [u.title, u.status]), [[`[ONB-S5U2] a visitor's rows say "hi" \\ once`, 'passed']]);
  assert.equal(ev.byId['ONB-GH94'].unit[0].title, '[ONB-GH94] say "no"');
  assert.equal(ev.unknownIds.find(u => u.id === 'ONB-ZZZZ').title, "it's unknown");
});

test('lists unknown ids', () => {
  const { root, data } = fixture({
    units: { 'a.test.ts': `it('[ONB-S5U2] known', () => {}); it('[ZZZ-9999] ghost', () => {});` },
    e2eTests: { 'onboarding.test.ts': `await requirement('ONB-GH94', 'ok', async () => {}); await requirement("QQQ-1234", 'ghost e2e', async () => {});` },
    e2e: { 'onboarding.json': { chapter: 'onboarding', video: 'v.mov', runAt: 'now', blocks: [{ id: 'RES-0000', title: 'ghost block', start: 0, end: 1, status: 'passed', screenshot: null, error: null }] } }
  });
  const ev = run(root, data, ['--unit', 'src/*.test.ts', '--e2e-tests', 'e2e/*.test.ts', '--e2e', 'e2e-results']);
  assert.deepEqual(
    ev.unknownIds.map(u => [u.id, u.file, u.title]),
    [
      ['ZZZ-9999', 'src/a.test.ts', '[ZZZ-9999] ghost'],
      ['QQQ-1234', 'e2e/onboarding.test.ts', 'ghost e2e'],
      ['RES-0000', 'e2e-results/onboarding.json', 'ghost block']
    ]
  );
  assert.equal(ev.byId['ZZZ-9999'], undefined);
});

test('keeps e2e and unit evidence side by side', () => {
  const { root, data } = fixture({
    units: { 'a.test.ts': `it('[ONB-S5U2] unit side', () => {});` },
    e2e: {
      'onboarding.json': {
        chapter: 'onboarding',
        video: 'media/e2e/onboarding.mov',
        runAt: '2026-11-11T00:00:00Z',
        blocks: [
          { id: 'ONB-S5U2', title: 'e2e side', start: 1.5, end: 4, status: 'passed', screenshot: 'media/e2e/ONB-S5U2.png', error: null },
          { id: 'ONB-GH94', title: 'broken', start: 4, end: 6, status: 'failed', screenshot: 'media/e2e/ONB-GH94.failed.png', error: 'boom' }
        ]
      }
    }
  });
  const ev = run(root, data, ['--unit', 'src/*.test.ts', '--e2e', 'e2e-results']);
  assert.equal(ev.byId['ONB-S5U2'].unit.length, 1);
  assert.deepEqual(ev.byId['ONB-S5U2'].e2e, [
    { chapter: 'onboarding', title: 'e2e side', video: 'media/e2e/onboarding.mov', start: 1.5, end: 4, status: 'passed', screenshot: 'media/e2e/ONB-S5U2.png', error: null }
  ]);
  assert.equal(ev.byId['ONB-GH94'].unit.length, 0);
  assert.equal(ev.byId['ONB-GH94'].e2e[0].status, 'failed');
  assert.equal(ev.byId['ONB-GH94'].e2e[0].error, 'boom');
});

test('drops evidence for an id no longer named', () => {
  const { root, data } = fixture({
    units: { 'a.test.ts': `it('[ONB-S5U2] one', () => {}); it('[ONB-GH94] two', () => {});` }
  });
  const first = run(root, data, ['--unit', 'src/*.test.ts']);
  assert.ok(first.byId['ONB-GH94']);
  writeFileSync(join(root, 'src', 'a.test.ts'), `it('[ONB-S5U2] one', () => {});`);
  const second = run(root, data, ['--unit', 'src/*.test.ts']);
  assert.ok(second.byId['ONB-S5U2']);
  assert.equal(second.byId['ONB-GH94'], undefined);
});

test('a missing result file or e2e directory means no results, not an error', () => {
  const { root, data } = fixture({ units: { 'a.test.ts': `it('[ONB-S5U2] known', () => {});` } });
  const ev = run(root, data, ['--unit', 'src/*.test.ts', '--unit-results', 'nope.json', '--e2e', 'no-such-dir']);
  assert.equal(ev.byId['ONB-S5U2'].unit[0].status, 'unknown');
  assert.deepEqual(ev.byId['ONB-S5U2'].e2e, []);
});

test('a repeated flag accumulates its values', () => {
  const { root, data } = fixture({
    units: {
      'a.test.ts': `it('[ONB-S5U2] first', () => {});`,
      'b.test.tsx': `it('[ONB-GH94] second', () => {});`
    }
  });
  const ev = run(root, data, ['--unit', 'src/*.test.ts', '--unit', 'src/*.test.tsx']);
  assert.equal(ev.byId['ONB-S5U2'].unit.length, 1);
  assert.equal(ev.byId['ONB-GH94'].unit.length, 1);
});
