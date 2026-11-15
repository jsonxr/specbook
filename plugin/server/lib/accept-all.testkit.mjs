// Test helpers: accept the whole book as it stands, so a Ready section may build (only accepted work is built).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptItem, currentItems } from './review.mjs';
import { startBuild } from './builds.mjs';

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
