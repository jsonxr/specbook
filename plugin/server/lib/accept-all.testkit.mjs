// Test helpers: accept the whole book as it stands, so a Ready section may build (only accepted work is built).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { acceptItem, currentItems, currentSnapshot, readHistory, readReview, sectionsUnderReview } from './review.mjs';
import { startBuild } from './builds.mjs';

const SpecModel = createRequire(import.meta.url)('../../app/model.js');

export function acceptAll(data) {
  for (const key of Object.keys(currentItems(data))) {
    try {
      acceptItem(data, key, '2026-11-01T00:00:00.000Z');
    } catch (e) {
      if (e.code !== 'not-under-review') {
        throw e;
      }
    }
  }
}

// Accepts everything, then starts the build.
export function startAccepted(data, now) {
  acceptAll(data);
  return startBuild(data, now);
}

// Starts the build past the Accept gate, then puts review.json and history.json back as they were: for tests of how
// finish treats review state a build can reach on its own (a call that rewords, a never-accepted item).
export function startKeepingReview(data, now) {
  const files = ['review.json', 'history.json'].map(name => join(data, name));
  const saved = files.map(f => (existsSync(f) ? readFileSync(f, 'utf8') : null));
  const progress = startAccepted(data, now);
  files.forEach((f, i) => (saved[i] === null ? rmSync(f, { force: true }) : writeFileSync(f, saved[i])));
  return progress;
}

// Asserts that a finished build reopened nothing in the sections it built: no review on their headings, their
// requirements or anything their Accept gate covers, and none of them still under review.
export function assertNothingReopens(data, built) {
  const { book, mockups } = currentSnapshot(data);
  const rv = SpecModel.reviews(book, mockups, readReview(data), readHistory(data));
  const keys = [];
  for (const ch of book.chapters ?? []) {
    for (const s of ch.sections ?? []) {
      const fullId = `${ch.id}-${s.id}`;
      if (!built.includes(fullId)) {
        continue;
      }
      keys.push(fullId, ...(s.requirements ?? []).map(r => r?.id).filter(Boolean), ...SpecModel.gateKeys(book, mockups, fullId));
    }
  }
  assert.deepEqual(keys.filter(k => rv.byKey[k]).map(k => `${k} (${rv.byKey[k].status})`), [], 'nothing reopens after a build');
  assert.deepEqual(sectionsUnderReview(data, built), [], 'no built section is under review');
}
