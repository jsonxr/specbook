import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHARE_BROKER, shareBrokerOf } from './broker.mjs';

test('a book that names no share server uses the public one', () => {
  assert.equal(DEFAULT_SHARE_BROKER, 'https://specbook.jasonrowland.com');
  assert.equal(shareBrokerOf(undefined), DEFAULT_SHARE_BROKER);
  assert.equal(shareBrokerOf({}), DEFAULT_SHARE_BROKER);
  assert.equal(shareBrokerOf({ shareBroker: '' }), DEFAULT_SHARE_BROKER);
});

test('a book may name its own share server', () => {
  assert.equal(shareBrokerOf({ shareBroker: 'https://share.example/' }), 'https://share.example');
  assert.equal(shareBrokerOf({ shareBroker: 'http://127.0.0.1:8798' }), 'http://127.0.0.1:8798');
});

test('a share server that is not a valid address is refused, not replaced', () => {
  assert.equal(shareBrokerOf({ shareBroker: 'http://share.example' }), null);
  assert.equal(shareBrokerOf({ shareBroker: 'https://share.example/path' }), null);
  assert.equal(shareBrokerOf({ shareBroker: 42 }), null);
});

test('SPECBOOK_SHARE_BROKER, when set, wins over the book (a share server on this machine, for development)', () => {
  assert.equal(shareBrokerOf({ shareBroker: 'https://share.example' }, 'http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(shareBrokerOf(undefined, 'http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(shareBrokerOf({ shareBroker: 'https://share.example' }, ''), 'https://share.example');
  assert.equal(shareBrokerOf({}, 'http://share.example'), null);
});
