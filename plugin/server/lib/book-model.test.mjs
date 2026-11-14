import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRequirement, setUserStage } from './book-model.mjs';

test('setUserStage guards', () => {
  const book = { chapters: [{ id: 'c', sections: [{ id: 'a', stage: 'building' }, { id: 'b', stage: 'built', requirements: [{ id: 'B', text: 'b' }] }, { id: 'd', stage: 'drafting', requirements: [{ id: 'D', text: 'd', change: 'add' }] }] }] };
  assert.throws(() => setUserStage(book, 'c-a', 'ready'), { code: 'locked' });
  assert.throws(() => setUserStage(book, 'c-b', 'ready'), { code: 'nothing-to-build' });
  assert.throws(() => setUserStage(book, 'c-d', 'built'), { code: 'bad-stage' });
  assert.throws(() => setUserStage(book, 'c-x', 'ready'), { code: 'not-found' });
  setUserStage(book, 'c-d', 'ready');
  assert.equal(book.chapters[0].sections[2].stage, 'ready');
});

test('findRequirement', () => {
  const book = { chapters: [{ id: 'c', sections: [{ id: 'a', requirements: [{ id: 'A1', text: 'x' }] }] }] };
  assert.equal(findRequirement(book, 'A1').fullId, 'c-a');
  assert.equal(findRequirement(book, 'nope'), null);
});

test('setUserStage refuses ready for any section with nothing to build', () => {
  const book = { chapters: [{ id: 'c', sections: [{ id: 'd', stage: 'drafting', requirements: [{ id: 'D', text: 'd' }] }, { id: 'e', stage: 'drafting' }] }] };
  assert.throws(() => setUserStage(book, 'c-d', 'ready'), { code: 'nothing-to-build' });
  assert.throws(() => setUserStage(book, 'c-e', 'ready'), { code: 'nothing-to-build' });
  setUserStage(book, 'c-d', 'drafting');
  assert.equal(book.chapters[0].sections[0].stage, 'drafting');
});
