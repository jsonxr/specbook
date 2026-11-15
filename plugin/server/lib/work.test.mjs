import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { stopRequest, writeRequest } from './requests.mjs';
import { landWork, startWork } from './work.mjs';

let data;
let file;
const book = () => readJson(join(data, 'book.json'), null);

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'specbook-work-'));
  writeJsonAtomic(join(data, 'book.json'), {
    chapters: [{ id: 'c', title: 'C', sections: [
      { id: 's', title: 'S', stage: 'drafting', frames: [{ id: 'c-s-1', mockup: 'mockups/a.html' }], requirements: [{ id: 'R0', text: 'a' }] },
    ] }],
    usedIds: ['R0'],
  });
  mkdirSync(join(data, 'mockups'));
  writeFileSync(join(data, 'mockups', 'a.html'), '<p>a</p>');
  writeFileSync(join(data, 'mockups', 'gone.html'), '<p>gone</p>');
  writeJsonAtomic(join(data, 'review.json'), { rev: 1, accepted: {}, notes: {}, tries: {} });
  file = writeRequest(data, { kind: 'revise', status: 'pending', createdAt: new Date().toISOString(), items: [], noteIds: [] });
});

test('startWork copies the book and its mockups to a working folder under requests/, and keeps one already there', () => {
  const work = startWork(data, file);
  assert.equal(work, join(data, 'requests', 'work', file.replace('requests/', '').replace(/\.json$/, '')));
  assert.equal(readJson(join(work, 'book.json'), null).chapters[0].id, 'c');
  assert.equal(readFileSync(join(work, 'mockups', 'a.html'), 'utf8'), '<p>a</p>');
  writeFileSync(join(work, 'mockups', 'a.html'), '<p>edited</p>');
  assert.equal(startWork(data, file), work);
  assert.equal(readFileSync(join(work, 'mockups', 'a.html'), 'utf8'), '<p>edited</p>');
});

test('landWork writes the working book and mockups in one go while the request is pending', () => {
  const work = startWork(data, file);
  const b = readJson(join(work, 'book.json'), null);
  b.chapters[0].sections[0].requirements[0].text = 'reworded';
  b.chapters[0].sections[0].frames.push({ id: 'c-s-2', mockup: 'mockups/b.html' });
  writeJsonAtomic(join(work, 'book.json'), b);
  writeFileSync(join(work, 'mockups', 'b.html'), '<p>b</p>');
  rmSync(join(work, 'mockups', 'gone.html'));
  assert.deepEqual(landWork(data, file), { landed: true });
  assert.equal(book().chapters[0].sections[0].requirements[0].text, 'reworded');
  assert.equal(readFileSync(join(data, 'mockups', 'b.html'), 'utf8'), '<p>b</p>');
  assert.equal(existsSync(join(data, 'mockups', 'gone.html')), false);
});

test('landWork refuses once the request was stopped, and the book is untouched', () => {
  const work = startWork(data, file);
  const b = readJson(join(work, 'book.json'), null);
  b.chapters[0].sections[0].requirements[0].text = 'half done';
  writeJsonAtomic(join(work, 'book.json'), b);
  stopRequest(data);
  assert.throws(() => landWork(data, file), { code: 'stopped' });
  assert.equal(book().chapters[0].sections[0].requirements[0].text, 'a');
});

test('landWork refuses a working book that is not valid', () => {
  const work = startWork(data, file);
  const cases = [
    b => { b.chapters[0].sections[0].requirements.push({ id: 'R0', text: 'twice' }); },
    b => { b.chapters[0].sections[0].frames.push({ id: 'c-s-9', mockup: 'mockups/missing.html' }); },
    b => { b.chapters = 'x'; },
  ];
  for (const change of cases) {
    const b = structuredClone(book());
    change(b);
    writeJsonAtomic(join(work, 'book.json'), b);
    assert.throws(() => landWork(data, file), { code: 'invalid' });
  }
  writeFileSync(join(work, 'book.json'), '{ not json');
  assert.throws(() => landWork(data, file), { code: 'invalid' });
  assert.equal(book().chapters[0].sections[0].requirements.length, 1);
});
