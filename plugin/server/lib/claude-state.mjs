import { statSync } from 'node:fs';
import { join } from 'node:path';
import { latestBuild, listBuilds } from './builds.mjs';
import { listPending } from './requests.mjs';

const STALE_MS = 10 * 60 * 1000;

// When a pending request was written: its createdAt, else the file's modification time.
function requestTime(data, { file, request }) {
  const at = Date.parse(request.createdAt);
  if (!Number.isNaN(at)) {
    return at;
  }
  try {
    return statSync(join(data, 'requests', file)).mtimeMs;
  } catch {
    return 0;
  }
}

// What Claude is doing now: idle, revising or building, plus any calls still waiting for the user's review.
// A build is stale when its heartbeat is over 10 minutes old, and so is a pending build request with no running
// build and nothing written for it (the request, or the last heartbeat of a build started since) for 10 minutes.
export function claudeState(data, now = Date.now()) {
  const pending = listPending(data);
  const latest = latestBuild(data);
  const running = latest?.progress?.state === 'running' ? latest.progress : null;
  const oldest = pending[0] ?? null;
  const buildRequests = pending.filter(p => p.request.kind === 'build');

  let state = 'idle';
  if (oldest && (oldest.request.kind ?? 'revise') === 'revise') {
    state = 'revising';
  } else if (buildRequests.length > 0 || running) {
    state = 'building';
  }

  let stale = Boolean(running) && !(now - Date.parse(running.heartbeat) <= STALE_MS);
  let build = running ?? latest?.progress ?? null;
  if (state === 'building' && !running) {
    const asked = buildRequests.map(p => requestTime(data, p));
    // Only a build started since the request was made counts as working on it.
    const since = Date.parse(latest?.progress?.startedAt) >= Math.min(...asked) ? Date.parse(latest.progress.heartbeat) : NaN;
    const last = Math.max(...asked, Number.isNaN(since) ? 0 : since);
    if (now - last > STALE_MS) {
      stale = true;
      build = null;
    }
  }

  const builds = [];
  for (const b of listBuilds(data)) {
    const count = b.calls.filter(c => c && c.status === 'pending').length;
    if (b.progress?.state !== 'running' && count > 0) {
      builds.push({ build: b.id, pending: count });
    }
  }

  return {
    state,
    request: oldest ? oldest.file : null,
    // What was sent, for the reader's running row: its kind, when, and how many notes or sections.
    sent: oldest ? { kind: oldest.request.kind ?? 'revise', at: oldest.request.createdAt ?? null, count: (oldest.request.kind === 'build' ? oldest.request.sections : oldest.request.items)?.length ?? 0 } : null,
    build,
    stale,
    review: builds.length > 0 ? { builds, pending: builds.reduce((n, b) => n + b.pending, 0) } : null,
  };
}
