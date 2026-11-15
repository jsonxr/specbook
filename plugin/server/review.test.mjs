import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/json-file.mjs';
import { readReview } from './lib/review.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));

let data;
const cli = args => spawnSync('node', [REVIEW, '--data', data, ...args], { encoding: 'utf8' });

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'specbook-review-cli-'));
  writeJsonAtomic(join(data, 'book.json'), {
    chapters: [{ id: 'c', sections: [{ id: 's', requirements: [{ id: 'R1', text: 'a' }, { id: 'R2', text: 'b' }] }] }],
  });
  writeJsonAtomic(join(data, 'review.json'), {
    rev: 1, accepted: { R9: { text: 'gone' } }, notes: { n1: { item: 'R1', text: 'hi', status: 'sent' } }, tries: {}, opened: {}, where: {},
  });
});

test('reply writes the answer on the note', () => {
  const out = cli(['reply', '--note', 'n1', '--text', 'No change needed']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readReview(data).notes.n1.reply, 'No change needed');
});

test('link adds each item to the note causes, including an item that is only accepted', () => {
  const out = cli(['link', '--note', 'n1', '--item', 'R2', '--item', 'R9']);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(readReview(data).notes.n1.causes, ['R2', 'R9']);
});

test('an unknown note or an unknown item exits 1 with a message and changes nothing', () => {
  for (const args of [['reply', '--note', 'zz', '--text', 'x'], ['link', '--note', 'zz', '--item', 'R1'], ['link', '--note', 'n1', '--item', 'NOPE']]) {
    const out = cli(args);
    assert.equal(out.status, 1, args.join(' '));
    assert.ok(out.stderr.length > 0);
  }
  assert.equal(readReview(data).rev, 1);
});

test('missing flags, no data and unknown commands fail', () => {
  assert.equal(cli(['reply', '--note', 'n1']).status, 1);
  assert.equal(cli(['link', '--note', 'n1']).status, 1);
  assert.equal(cli(['nope']).status, 1);
  assert.equal(spawnSync('node', [REVIEW], { encoding: 'utf8' }).status, 2);
});

test('while the reader\'s Stop flag is up, reply and link fail with stopped and change nothing', () => {
  writeJsonAtomic(join(data, 'requests', 'stop.flag'), { request: 'x.json', kind: 'revise', at: new Date().toISOString() });
  for (const args of [['reply', '--note', 'n1', '--text', 'x'], ['link', '--note', 'n1', '--item', 'R2']]) {
    const out = cli(args);
    assert.equal(out.status, 1, args.join(' '));
    assert.equal(JSON.parse(out.stderr).error, 'stopped');
  }
  assert.equal(readReview(data).rev, 1);
});

test('work then land, from the command line', () => {
  writeJsonAtomic(join(data, 'requests', 'r.json'), { kind: 'revise', status: 'pending', items: [], noteIds: [] });
  const work = JSON.parse(cli(['work', '--request', 'requests/r.json']).stdout).work;
  const b = JSON.parse(readFileSync(join(work, 'book.json'), 'utf8'));
  b.chapters[0].sections[0].requirements[0].text = 'landed';
  writeJsonAtomic(join(work, 'book.json'), b);
  const out = cli(['land', '--request', 'requests/r.json']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(readFileSync(join(data, 'book.json'), 'utf8')).chapters[0].sections[0].requirements[0].text, 'landed');
});
