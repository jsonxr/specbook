import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { createMinter } from './ids.mjs';
import { findRequirement, findSection, listSections } from './book-model.mjs';
import { addNote, recordBuild, setAccepted, readReview } from './review.mjs';
import { plain } from './migrate.mjs';

const { isProven } = createRequire(import.meta.url)('../../app/model.js');

const REQUIREMENT_STATUSES = ['queued', 'in_progress', 'proven', 'failed'];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const bookFile = data => join(data, 'book.json');
const buildDir = (data, id) => join(data, 'builds', id);
const progressFile = (data, id) => join(buildDir(data, id), 'progress.json');
const callsFile = (data, id) => join(buildDir(data, id), 'calls.json');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = text => text.replace(/[&<>"']/g, c => HTML_ESCAPES[c]);

const hasChange = req => Boolean(req && typeof req === 'object' && req.change);

// Every build folder, oldest first. Corrupt files read as null progress and no calls.
export function listBuilds(data) {
  const dir = join(data, 'builds');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .map(id => {
      const progress = readJson(progressFile(data, id), null);
      const calls = readJson(callsFile(data, id), null)?.calls;
      return { id, progress: progress && typeof progress === 'object' ? progress : null, calls: Array.isArray(calls) ? calls : [] };
    });
}

export function latestBuild(data) {
  const all = listBuilds(data);
  return all.length > 0 ? all[all.length - 1] : null;
}

function readRunning(data, id) {
  const progress = readJson(progressFile(data, id), null);
  if (!progress || progress.state !== 'running') {
    throw fail('not-running', `Build ${id} is not running`);
  }
  return progress;
}

function update(data, id, now, change) {
  const progress = readRunning(data, id);
  change(progress);
  progress.heartbeat = new Date(now).toISOString();
  writeJsonAtomic(progressFile(data, id), progress);
  return progress;
}

export function startBuild(data, now = Date.now()) {
  if (listBuilds(data).some(b => b.progress?.state === 'running')) {
    throw fail('busy', 'A build is already running');
  }
  const book = readJson(bookFile(data), null);
  const ready = listSections(book ?? {}).filter(s => s.section.stage === 'ready');
  if (ready.length === 0) {
    throw fail('nothing-ready', 'No section is ready to build');
  }
  const at = new Date(now).toISOString();
  const requirements = {};
  for (const { section, fullId } of ready) {
    section.stage = 'building';
    for (const req of section.requirements ?? []) {
      if (hasChange(req)) {
        requirements[req.id] = { status: 'queued', section: fullId };
      }
    }
  }
  const progress = {
    id: at.replace(/[:.]/g, '-'),
    startedAt: at,
    heartbeat: at,
    state: 'running',
    sections: ready.map(s => s.fullId),
    task: null,
    requirements,
  };
  writeJsonAtomic(bookFile(data), book);
  writeJsonAtomic(progressFile(data, progress.id), progress);
  writeJsonAtomic(callsFile(data, progress.id), { calls: [] });
  return progress;
}

export function recordTask(data, id, task, now = Date.now()) {
  return update(data, id, now, p => {
    p.task = task;
  });
}

export function recordRequirement(data, id, reqId, status, now = Date.now()) {
  if (!REQUIREMENT_STATUSES.includes(status)) {
    throw fail('bad-status', `Unknown requirement status: ${status}`);
  }
  return update(data, id, now, p => {
    p.requirements[reqId] = { ...p.requirements[reqId], status };
  });
}

export function beat(data, id, now = Date.now()) {
  return update(data, id, now, () => {});
}

// Mints a CALL id into book.usedIds and appends a pending call to the build's calls.json.
export function recordCall(data, id, input, now = Date.now()) {
  for (const field of ['title', 'before', 'after']) {
    if (typeof input?.[field] !== 'string' || input[field].trim() === '') {
      throw fail('missing-field', `A call needs a ${field}`);
    }
  }
  update(data, id, now, () => {});
  const book = readJson(bookFile(data), null);
  const callId = createMinter(book).mint('CALL');
  const call = { ...input, id: callId, status: 'pending', note: '' };
  const calls = readJson(callsFile(data, id), null)?.calls;
  writeJsonAtomic(bookFile(data), book);
  writeJsonAtomic(callsFile(data, id), { calls: [...(Array.isArray(calls) ? calls : []), call] });
  return call;
}

// Fails the build and returns its building sections to drafting; requirement text and changes stay as they are.
export function stopBuild(data, id, reason, now = Date.now()) {
  const progress = readRunning(data, id);
  const book = readJson(bookFile(data), null);
  for (const { section, fullId } of listSections(book ?? {})) {
    if (progress.sections.includes(fullId) && section.stage === 'building') {
      section.stage = 'drafting';
    }
  }
  progress.state = 'failed';
  progress.reason = reason;
  progress.finishedAt = new Date(now).toISOString();
  progress.heartbeat = progress.finishedAt;
  writeJsonAtomic(bookFile(data), book);
  writeJsonAtomic(progressFile(data, id), progress);
  return progress;
}

// Settles a running build from evidence: proven changes are applied, and a section whose changes are all proven
// is built (its removals become decisions). A section with removals also needs every requirement that stays proven.
// Any other section goes back to drafting with its unproven changes and its removals intact.
export function finishBuild(data, id, now = Date.now(), { summary } = {}) {
  const progress = readRunning(data, id);
  const book = readJson(bookFile(data), null) ?? {};
  const evidence = readJson(join(data, 'evidence', 'evidence.json'), null);
  const at = new Date(now).toISOString();
  const built = [];
  const drafting = [];
  const review = readReview(data);
  const landed = [];
  const accept = {};
  const builtItems = [];
  // Marks an item as landed: its accepted copy loses the change markers (or goes, for a removal).
  const land = (req, kind) => {
    const before = Object.hasOwn(review.accepted, req.id) ? review.accepted[req.id] : null;
    if (kind === 'removed') {
      landed.push({ id: req.id, kind, text: before?.text ?? req.text ?? '' });
      accept[req.id] = null;
      builtItems.push({ key: req.id, before, after: null });
      return;
    }
    // An accepted copy keeps its own text (a reword stays under review); an item never accepted takes today's value.
    const withoutMarkers = ({ change: _change, today: _today, ...rest }) => rest;
    const after = withoutMarkers(before ?? { text: req.text, reason: req.reason });
    if (after.reason === undefined) {
      delete after.reason;
    }
    landed.push({ id: req.id, kind, text: req.text ?? '' });
    accept[req.id] = after;
    builtItems.push({ key: req.id, before, after });
  };
  for (const { section, fullId } of listSections(book)) {
    if (!progress.sections.includes(fullId)) {
      continue;
    }
    const reqs = (section.requirements ?? []).filter(r => r && typeof r === 'object');
    const removals = reqs.filter(r => r.change === 'remove');
    const unproven = [];
    for (const req of reqs) {
      if (req.change === 'remove') {
        continue;
      }
      const proven = isProven(evidence, req.id);
      if (req.change === 'add' || req.change === 'change') {
        if (proven) {
          land(req, req.change === 'add' ? 'added' : 'changed');
          delete req.change;
          delete req.today;
        }
        progress.requirements[req.id] = { ...progress.requirements[req.id], status: proven ? 'proven' : 'failed' };
      } else if (removals.length === 0) {
        // Without removals, only the section's changes need proof.
        continue;
      }
      // With removals, the section is built only when every requirement that stays is proven.
      if (!proven) {
        unproven.push(req.id);
      }
    }
    // A removal is proven once applied, and failed when it is held back.
    for (const req of removals) {
      progress.requirements[req.id] = { ...progress.requirements[req.id], status: unproven.length === 0 ? 'proven' : 'failed' };
    }
    if (unproven.length === 0) {
      book.decisions = book.decisions ?? [];
      for (const req of removals) {
        land(req, 'removed');
        book.decisions.push({
          id: req.id,
          date: at.slice(0, 10),
          about: [req.id],
          by: 'build',
          title: plain(req.text ?? ''),
          body: req.reason ?? '',
          kind: 'removed',
        });
      }
      section.requirements = (section.requirements ?? []).filter(r => !(r && typeof r === 'object' && r.change === 'remove'));
      section.stage = 'built';
      built.push(fullId);
    } else {
      section.stage = 'drafting';
      drafting.push({ section: fullId, unproven });
    }
  }
  progress.state = 'done';
  progress.finishedAt = at;
  progress.heartbeat = at;
  // History first (guarded by the build id), then the accepted copy, then the book and progress: a crash at any
  // point leaves the build running, and a retry repeats only steps that are safe to repeat.
  recordBuild(
    data,
    {
      build: id,
      date: at.slice(0, 10),
      summary: summary ?? '',
      sections: [...progress.sections],
      landed,
      commits: Array.isArray(progress.commits) ? progress.commits : [],
    },
    builtItems,
    at
  );
  setAccepted(data, accept);
  writeJsonAtomic(bookFile(data), book);
  writeJsonAtomic(progressFile(data, id), progress);
  const lines = ['# Build summary', '', '## Built', ...(built.length > 0 ? built.map(s => `- ${s}`) : ['- none']), '', '## Back to drafting'];
  lines.push(...(drafting.length > 0 ? drafting.map(d => `- ${d.section}: unproven ${d.unproven.join(', ')}`) : ['- none']), '');
  writeFileSync(join(buildDir(data, id), 'summary.md'), lines.join('\n'));
  return { built, drafting };
}

// Accepts or rejects one of a build's calls. Rejecting reopens the requirement (or its section, when the requirement
// is gone), leaves a note for the next revise and records what the user wanted instead.
export function reviewCall(data, buildId, callId, { decision, note } = {}, now = Date.now()) {
  const calls = readJson(callsFile(data, buildId), null)?.calls;
  const call = Array.isArray(calls) ? calls.find(c => c.id === callId) : undefined;
  if (!call) {
    throw fail('not-found', `Call ${callId} not found`);
  }
  if (call.status !== 'pending') {
    throw fail('decided', `Call ${callId} is already ${call.status}`);
  }
  const accept = decision === 'accept';
  const text = typeof note === 'string' ? note.trim() : '';
  if (!accept && text === '') {
    throw fail('note-required', 'A rejection needs a note');
  }
  const book = readJson(bookFile(data), null) ?? {};
  const mint = createMinter(book).mint;
  const at = new Date(now).toISOString();
  const date = at.slice(0, 10);
  book.decisions = book.decisions ?? [];
  if (accept) {
    book.decisions.push({ id: mint('DEC'), date, about: call.about, by: 'build', title: call.title, body: call.body, kind: 'decision' });
    call.status = 'accepted';
  } else {
    const found = findRequirement(book, call.about?.[0]);
    const text_ = `Rejected call "${call.title}": ${text}`;
    if (found) {
      found.req.change = 'change';
      found.req.text = call.before;
      found.req.today = call.after;
      found.section.stage = 'drafting';
      addNote(data, { item: found.req.id, target: found.req.id, section: found.fullId, pin: { rx: 0, ry: 0.5 }, text: text_, created: at });
    } else {
      const target = findSection(book, call.section);
      if (target) {
        target.section.stage = 'drafting';
      }
      addNote(data, { item: call.section, target: call.section, section: call.section, pin: { rx: 0, ry: 0.5 }, text: text_, created: at });
    }
    book.decisions.push({
      id: mint('DEC'),
      date,
      about: call.about,
      by: 'user',
      title: `Rejected: ${call.title}`,
      // Decision bodies are HTML; the user's note is plain text.
      body: `${call.body}\n\nInstead: ${escapeHtml(text)}`,
      kind: 'rejected',
    });
    call.status = 'rejected';
    call.note = text;
  }
  writeJsonAtomic(bookFile(data), book);
  writeJsonAtomic(callsFile(data, buildId), { calls });
  return call;
}
