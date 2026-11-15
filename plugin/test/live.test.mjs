import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// app/live.js's pure parts, run without a page: with no document it only defines them.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'live.js'), 'utf8');
const window = {};
runInNewContext(source, { window, setTimeout, clearTimeout, Date });
const L = window.SpecLive;

test('following stops when the follower scrolls, types, or the leader leaves; clicking the face again too', () => {
  const on = L._followState({ leader: null }, { type: 'follow', id: 'ana' });
  assert.equal(on.leader, 'ana');
  for (const type of ['user-scroll', 'typing', 'leader-left', 'unfollow']) {
    assert.equal(L._followState(on, { type }).leader, null, type);
  }
  assert.equal(L._followState(on, { type: 'follow', id: 'ana' }).leader, null, 'the same face again stops');
  assert.equal(L._followState(on, { type: 'follow', id: 'raj' }).leader, 'raj');
  assert.equal(L._followState(on, { type: 'leader-left', id: 'raj' }).leader, 'ana', 'someone else leaving changes nothing');
});

test('a throttled sender fires at once, then once more after the burst', async () => {
  let n = 0;
  const send = L._throttle(() => { n++; }, 100);
  for (let i = 0; i < 10; i++) {
    send();
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(n, 1);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(n, 2);
});
