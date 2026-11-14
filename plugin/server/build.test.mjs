import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/json-file.mjs';
import { latestBuild } from './lib/builds.mjs';
import { readHistory } from './lib/review.mjs';

const BUILD = fileURLToPath(new URL('./build.mjs', import.meta.url));

let data;
const cli = args => execFileSync('node', [BUILD, '--data', data, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const errorOf = fn => {
  try {
    fn();
  } catch (e) {
    return JSON.parse(e.stderr.toString());
  }
  return null;
};

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'specbook-build-cli-'));
  writeJsonAtomic(join(data, 'book.json'), {
    chapters: [
      {
        id: 'c',
        sections: [
          {
            id: 'r',
            stage: 'ready',
            requirements: [
              { id: 'R1', text: 'b', change: 'change', today: 'old' },
              { id: 'R2', text: 'c', change: 'remove', reason: 'gone' },
            ],
          },
        ],
      },
    ],
    usedIds: [],
  });
});

test('start then task then finish through the CLI', () => {
  const start = JSON.parse(cli(['start']));
  assert.equal(start.scope[0].id, 'R1');
  assert.deepEqual(start.scope[0], { id: 'R1', section: 'c-r', change: 'change', text: 'b', today: 'old' });
  assert.deepEqual(start.scope[1], { id: 'R2', section: 'c-r', change: 'remove', text: 'c', reason: 'gone' });
  cli(['task', '--build', start.id, '--index', '1', '--of', '3', '--title', 'Add filter bar', '--section', 'c-r', '--req', 'R1']);
  assert.deepEqual(latestBuild(data).progress.task, { index: 1, of: 3, title: 'Add filter bar', section: 'c-r', req: 'R1' });
  assert.equal(errorOf(() => cli(['start'])).error, 'busy');
  const req = JSON.parse(cli(['req', '--build', start.id, '--id', 'R1', '--status', 'in_progress']));
  assert.equal(req.requirements.R1.status, 'in_progress');
  assert.equal(JSON.parse(cli(['beat', '--build', start.id])).state, 'running');
  const finished = JSON.parse(cli(['finish', '--build', start.id]));
  assert.deepEqual(finished, { built: [], drafting: [{ section: 'c-r', unproven: ['R1'] }] });
});

test('call prints the call, and fails cleanly when a flag is missing', () => {
  const start = JSON.parse(cli(['start']));
  const call = JSON.parse(
    cli(['call', '--build', start.id, '--about', 'R1,R2', '--section', 'c-r', '--title', 't', '--body', 'b', '--before', 'x', '--after', 'y'])
  );
  assert.deepEqual(call.about, ['R1', 'R2']);
  assert.equal(call.status, 'pending');
  const err = errorOf(() => cli(['call', '--build', start.id, '--about', 'R1', '--section', 'c-r', '--title', 't', '--body', 'b', '--before', 'x']));
  assert.equal(err.error, 'missing-field');
  assert.equal(latestBuild(data).calls.length, 1);
});

test('stop fails the build with a reason; unknown command and missing data are errors', () => {
  const start = JSON.parse(cli(['start']));
  const stopped = JSON.parse(cli(['stop', '--build', start.id, '--reason', 'tired']));
  assert.equal(stopped.state, 'failed');
  assert.equal(stopped.reason, 'tired');
  assert.equal(errorOf(() => cli(['beat', '--build', start.id])).error, 'not-running');
  assert.equal(errorOf(() => cli(['nope'])).error, 'unknown-command');
});

test('finish --summary lands in the changelog; without it finish warns on stderr and the summary is empty', () => {
  const run = args => spawnSync('node', [BUILD, '--data', data, ...args], { encoding: 'utf8' });
  const start = JSON.parse(cli(['start']));
  const bare = run(['finish', '--build', start.id]);
  assert.equal(bare.status, 0);
  assert.match(bare.stderr, /no summary/);
  assert.equal(readHistory(data).changelog[0].summary, '');
  const book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
  book.chapters[0].sections[0].stage = 'ready';
  writeJsonAtomic(join(data, 'book.json'), book);
  const next = JSON.parse(cli(['start']));
  const withSummary = run(['finish', '--build', next.id, '--summary', 'Filtering is easier.']);
  assert.equal(withSummary.stderr, '');
  assert.equal(readHistory(data).changelog[1].summary, 'Filtering is easier.');
});
