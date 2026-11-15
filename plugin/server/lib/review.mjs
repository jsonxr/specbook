import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';

const SpecModel = createRequire(import.meta.url)('../../app/model.js');

const reviewFile = (data) => join(data, 'review.json');
const historyFile = (data) => join(data, 'history.json');

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// The whole review store; empty defaults for anything missing, corrupt or the wrong shape.
export function readReview(data) {
  const stored = readJson(reviewFile(data), null);
  const s = isObject(stored) ? stored : {};
  const obj = (v) => (isObject(v) ? v : {});
  return {
    rev: typeof s.rev === 'number' ? s.rev : 0,
    accepted: obj(s.accepted),
    notes: obj(s.notes),
    tries: obj(s.tries),
    opened: obj(s.opened),
    where: obj(s.where)
  };
}

// Writes the review with the next revision.
function saveReview(data, review) {
  const next = { ...review, rev: review.rev + 1 };
  writeJsonAtomic(reviewFile(data), next);
  return next;
}

// Replaces only `notes`. Throws code 'stale' when baseRev is not the current revision.
export function writeReviewNotes(data, notes, baseRev) {
  const review = readReview(data);
  if (baseRev !== review.rev) {
    throw fail('stale', `review revision is ${review.rev}, not ${baseRev}`);
  }
  return { rev: saveReview(data, { ...review, notes }).rev };
}

// { items, changelog }; empty when missing or corrupt.
export function readHistory(data) {
  const stored = readJson(historyFile(data), null);
  const s = isObject(stored) ? stored : {};
  return { items: isObject(s.items) ? s.items : {}, changelog: Array.isArray(s.changelog) ? s.changelog : [] };
}

function saveHistory(data, history) {
  const items = {};
  for (const key of Object.keys(history.items).sort()) {
    items[key] = history.items[key];
  }
  writeJsonAtomic(historyFile(data), { items, changelog: history.changelog });
}

function readBook(data) {
  return readJson(join(data, 'book.json'), { chapters: [] });
}

// State mockup and today texts, keyed by their path (relative to the data folder, never outside it).
function readMockups(data, book) {
  const root = resolve(data);
  const mockups = {};
  for (const rel of SpecModel.mockupPaths(book)) {
    const file = resolve(root, rel);
    if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      mockups[rel] = readFileSync(file, 'utf8');
    }
  }
  return mockups;
}

// The book as it stands now and its items by key.
function snapshot(data) {
  const book = readBook(data);
  const mockups = readMockups(data, book);
  return { book, mockups, items: SpecModel.itemsOf(book, mockups) };
}

// The book, its mockup texts and its items by key, as they stand now.
export function currentSnapshot(data) {
  return snapshot(data);
}

export function currentItems(data) {
  return snapshot(data).items;
}

function reviewsOf(snap, review, history) {
  return SpecModel.reviews(snap.book, snap.mockups, review, history);
}

// Notes shown on `key`: not frozen, not closed for it, dropped on it or caused changes on it.
function openNoteIds(review, key) {
  return Object.keys(review.notes).filter((id) => {
    const n = review.notes[id];
    if (!n || n.status === 'frozen' || (n.closedFor ?? []).includes(key)) {
      return false;
    }
    return n.item === key || (n.causes ?? []).includes(key);
  });
}

// JSON with object keys in sorted order, so equal values compare equal whatever their key order.
function canonical(value) {
  return JSON.stringify(value, (k, v) => (isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
}

// Stamps `opened` for every item under review that lacks it, records where items still in the book live, and
// forgets both for keys no longer under review. Writes only when something changed, and not when the review moved
// on since it was read (another process wrote it: that write wins, and the next call stamps again). `afterRead` is a
// test hook that runs between the read and the check.
export function stampOpened(data, now, afterRead) {
  const snap = snapshot(data);
  const review = readReview(data);
  const under = reviewsOf(snap, review, readHistory(data)).byKey;
  const opened = {};
  const where = {};
  for (const key of Object.keys(under)) {
    opened[key] = review.opened[key] ?? now;
    const item = snap.items[key];
    if (item) {
      where[key] = { kind: item.kind, section: item.section, chapter: item.chapter };
    } else if (review.where[key]) {
      where[key] = review.where[key];
    }
  }
  if (canonical(opened) === canonical(review.opened) && canonical(where) === canonical(review.where)) {
    return false;
  }
  if (afterRead) {
    afterRead();
  }
  if (readReview(data).rev !== review.rev) {
    return false;
  }
  saveReview(data, { ...review, opened, where });
  return true;
}

function decisionsFor(book, key, opened) {
  const since = String(opened).slice(0, 10);
  return (book.decisions ?? [])
    .filter((d) => {
      const about = d?.about;
      return d?.id && (Array.isArray(about) ? about.includes(key) : about === key) && String(d.date ?? '') >= since;
    })
    .map((d) => d.id);
}

// Accepts the item's current value: appends the history entry, updates the accepted copy and clears the item's tries
// and notes. Throws code 'not-under-review' when the item has no review.
export function acceptItem(data, key, now) {
  const snap = snapshot(data);
  const review = readReview(data);
  const history = readHistory(data);
  if (!reviewsOf(snap, review, history).byKey[key]) {
    throw fail('not-under-review', `${key} is not under review`);
  }
  const item = snap.items[key];
  const after = item ? clone(item.value) : null;
  const before = Object.hasOwn(review.accepted, key) ? clone(review.accepted[key]) : null;
  const opened = review.opened[key] ?? now;

  const tries = (review.tries[key] ?? []).map((t) => ({
    value: t.value,
    frozenAt: t.frozenAt,
    notes: (t.notes ?? []).filter((id) => review.notes[id]).map((id) => clone(review.notes[id]))
  }));
  const shown = openNoteIds(review, key);
  const entry = {
    acceptedAt: now,
    opened,
    before,
    after,
    tries,
    notes: shown.map((id) => clone(review.notes[id])),
    decisions: decisionsFor(snap.book, key, opened),
    kind: 'review'
  };

  const accepted = { ...review.accepted };
  if (item) {
    accepted[key] = after;
  } else {
    delete accepted[key];
  }
  const notes = { ...review.notes };
  // Notes listed on this item's tries: frozen ones go now; one still open on another item waits for that review.
  const tryIds = [...new Set((review.tries[key] ?? []).flatMap((t) => t.notes ?? []))].filter((id) => notes[id]);
  const waiting = tryIds.filter((id) => notes[id].status !== 'frozen');
  for (const id of tryIds) {
    if (notes[id].status === 'frozen') {
      delete notes[id];
    }
  }
  const nextTries = { ...review.tries };
  delete nextTries[key];
  const opens = { ...review.opened };
  delete opens[key];
  const where = { ...review.where };
  delete where[key];

  // Which other items still have a review once this one is accepted, ignoring the notes being settled.
  const settling = Object.fromEntries(shown.map((id) => [id, notes[id]]));
  const without = { ...notes };
  for (const id of [...shown, ...waiting]) {
    delete without[id];
  }
  const pending = reviewsOf(snap, { ...review, accepted, notes: without, tries: nextTries }, history).byKey;
  for (const id of shown) {
    const note = settling[id];
    const others = [note.item, ...(note.causes ?? [])].filter((k) => k && k !== key);
    if (others.every((k) => !pending[k])) {
      delete notes[id];
    } else {
      notes[id] = { ...note, closedFor: [...new Set([...(note.closedFor ?? []), key])] };
    }
  }

  for (const id of waiting) {
    if (shown.includes(id) || !notes[id]) {
      continue;
    }
    const note = notes[id];
    const others = [note.item, ...(note.causes ?? [])].filter((k) => k && k !== key && !(note.closedFor ?? []).includes(k));
    if (others.every((k) => !pending[k])) {
      delete notes[id];
    }
  }

  history.items[key] = [...(history.items[key] ?? []), entry];
  saveHistory(data, history);
  saveReview(data, { ...review, accepted, notes, tries: nextTries, opened: opens, where });
  return entry;
}

// Freezes the item's current value with the notes shown on it (they become `frozen`, kept in `notes`) and adds a new
// draft note against the current version.
export function changeItem(data, key, text, now) {
  const snap = snapshot(data);
  const review = readReview(data);
  if (!reviewsOf(snap, review, readHistory(data)).byKey[key]) {
    throw fail('not-under-review', `${key} is not under review`);
  }
  const item = snap.items[key];
  const frozenIds = openNoteIds(review, key);
  const notes = { ...review.notes };
  // Keys that still have a review once these notes are set aside from this one.
  const rest = Object.fromEntries(Object.entries(notes).filter(([id]) => !frozenIds.includes(id)));
  const pending = reviewsOf(snap, { ...review, notes: rest }, readHistory(data)).byKey;
  for (const id of frozenIds) {
    const note = notes[id];
    const others = [note.item, ...(note.causes ?? [])].filter((k) => k && k !== key && !(note.closedFor ?? []).includes(k) && pending[k]);
    notes[id] = others.length === 0 ? { ...note, status: 'frozen' } : { ...note, closedFor: [...new Set([...(note.closedFor ?? []), key])] };
  }
  let noteId;
  do {
    noteId = `n${randomBytes(3).toString('hex')}`;
  } while (notes[noteId]);
  notes[noteId] = { item: key, text, created: now, status: 'draft' };
  const tries = { ...review.tries, [key]: [...(review.tries[key] ?? []), { value: item ? clone(item.value) : null, frozenAt: now, notes: frozenIds }] };
  const opened = { ...review.opened, [key]: review.opened[key] ?? now };
  const where = item ? { ...review.where, [key]: { kind: item.kind, section: item.section, chapter: item.chapter } } : review.where;
  saveReview(data, { ...review, notes, tries, opened, where });
  return { noteId };
}

function noteOrThrow(review, noteId) {
  if (!review.notes[noteId]) {
    throw fail('not-found', `no note ${noteId}`);
  }
}

// Adds the keys to the note's `causes` (no duplicates).
export function linkNote(data, noteId, keys) {
  const review = readReview(data);
  noteOrThrow(review, noteId);
  const note = review.notes[noteId];
  const causes = [...new Set([...(note.causes ?? []), ...keys])];
  return { rev: saveReview(data, { ...review, notes: { ...review.notes, [noteId]: { ...note, causes } } }).rev };
}

// Writes Claude's answer on a note that led to no change.
export function replyNote(data, noteId, text) {
  const review = readReview(data);
  noteOrThrow(review, noteId);
  return { rev: saveReview(data, { ...review, notes: { ...review.notes, [noteId]: { ...review.notes[noteId], reply: text } } }).rev };
}

export function appendChangelog(data, entry) {
  const history = readHistory(data);
  history.changelog.push(entry);
  saveHistory(data, history);
}

// A history entry for a build that landed an item: no review, so no tries, notes or decisions.
export function appendBuiltHistory(data, key, before, after, now) {
  const history = readHistory(data);
  history.items[key] = [
    ...(history.items[key] ?? []),
    { acceptedAt: now, opened: now, before, after, tries: [], notes: [], decisions: [], kind: 'built' }
  ];
  saveHistory(data, history);
}

// Adds one note under a new id with the next revision, and returns the id. The note's status defaults to `draft`.
export function addNote(data, note) {
  const review = readReview(data);
  let id;
  do {
    id = `n${randomBytes(3).toString('hex')}`;
  } while (review.notes[id]);
  const notes = { ...review.notes, [id]: { status: 'draft', ...note } };
  saveReview(data, { ...review, notes });
  return id;
}

// Sets the status of the listed notes that exist and are not frozen, with no revision check.
// Revise sends the reader's drafts. Each item they are on keeps the version they were written about as a try, with
// those notes, so the review shows what the notes asked of and what Claude made of it.
export function sendNotes(data, ids, now) {
  const snap = snapshot(data);
  const review = readReview(data);
  const notes = { ...review.notes };
  const byItem = {};
  for (const id of ids) {
    const note = Object.hasOwn(notes, id) ? notes[id] : null;
    if (!note || note.status !== 'draft') {
      continue;
    }
    notes[id] = { ...note, status: 'sent' };
    if (typeof note.item === 'string' && Object.hasOwn(snap.items, note.item)) {
      (byItem[note.item] ??= []).push(id);
    }
  }
  const tries = { ...review.tries };
  const opened = { ...review.opened };
  const where = { ...review.where };
  for (const [key, noteIds] of Object.entries(byItem)) {
    const item = snap.items[key];
    tries[key] = [...(tries[key] ?? []), { value: clone(item.value), frozenAt: now, notes: noteIds }];
    opened[key] = opened[key] ?? now;
    where[key] = { kind: item.kind, section: item.section, chapter: item.chapter };
  }
  saveReview(data, { ...review, notes, tries, opened, where });
}

// Undoes sendNotes for a withdrawn Revise: the listed notes still `sent` go back to `draft`, and each item's last try
// made of only those notes is dropped. Returns how many notes went back. Anything Claude already changed stays.
export function unsendNotes(data, ids) {
  const review = readReview(data);
  const notes = { ...review.notes };
  const back = new Set();
  for (const id of ids) {
    if (Object.hasOwn(notes, id) && notes[id].status === 'sent') {
      // A reply or links Claude wrote before the Stop belong to the withdrawn request, not to the draft.
      const { reply, causes, ...rest } = notes[id];
      notes[id] = { ...rest, status: 'draft' };
      back.add(id);
    }
  }
  const tries = { ...review.tries };
  for (const [key, list] of Object.entries(tries)) {
    const last = list[list.length - 1];
    if (last && Array.isArray(last.notes) && last.notes.length > 0 && last.notes.every(id => back.has(id))) {
      tries[key] = list.slice(0, -1);
      if (tries[key].length === 0) {
        delete tries[key];
      }
    }
  }
  if (back.size > 0) {
    saveReview(data, { ...review, notes, tries });
  }
  return back.size;
}

export function setNotesStatus(data, ids, status) {
  const review = readReview(data);
  const notes = { ...review.notes };
  let changed = false;
  for (const id of ids) {
    if (notes[id] && notes[id].status !== 'frozen' && notes[id].status !== status) {
      notes[id] = { ...notes[id], status };
      changed = true;
    }
  }
  if (changed) {
    saveReview(data, { ...review, notes });
  }
  return changed;
}

// Drops an item that was never accepted, with its notes, tries and bookkeeping.
export function forgetItem(data, key) {
  const review = readReview(data);
  const notes = Object.fromEntries(Object.entries(review.notes).filter(([, n]) => n && n.item !== key));
  const drop = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
  saveReview(data, { ...review, notes, tries: drop(review.tries), opened: drop(review.opened), where: drop(review.where) });
}

// Records a finished build in one history write: a `built` entry per landed item and the changelog entry. Does
// nothing (returns false) when the changelog already has an entry for this build, so a retried finish adds nothing twice.
export function recordBuild(data, entry, built, now) {
  const history = readHistory(data);
  if (history.changelog.some((e) => e && e.build === entry.build)) {
    return false;
  }
  for (const { key, before, after } of built) {
    history.items[key] = [
      ...(history.items[key] ?? []),
      { acceptedAt: now, opened: now, before, after, tries: [], notes: [], decisions: [], kind: 'built' }
    ];
  }
  history.changelog.push(entry);
  saveHistory(data, history);
  return true;
}

// Sets (or, for null, removes) accepted copies by key in one write. Writes nothing when no copy changes.
export function setAccepted(data, changes) {
  const review = readReview(data);
  const accepted = { ...review.accepted };
  let changed = false;
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      changed = Object.hasOwn(accepted, key) || changed;
      delete accepted[key];
    } else if (!SpecModel.sameValue(accepted[key], value)) {
      accepted[key] = value;
      changed = true;
    }
  }
  if (changed) {
    saveReview(data, { ...review, accepted });
  }
  return changed;
}

// Whether the key names an item in the book now or an accepted copy.
export function knownItem(data, key) {
  return Object.hasOwn(currentItems(data), key) || Object.hasOwn(readReview(data).accepted, key);
}

// The sections, of those named by `<chapter-id>-<section-id>`, that still have something under review: their heading,
// a requirement or a state they show, or a removed item that lived there. Only accepted work is built, so Ready and
// Build both refuse these.
export function sectionsUnderReview(data, sectionIds) {
  const snap = snapshot(data);
  const review = readReview(data);
  const { bySection } = reviewsOf(snap, review, readHistory(data));
  return sectionIds.filter((id) => (bySection[id] ?? 0) > 0);
}
