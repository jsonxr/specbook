import { createRequire } from 'node:module';
import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';
import { currentSnapshot, stampOpened } from './review.mjs';

const SpecModel = createRequire(import.meta.url)('../../app/model.js');

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// The item a note belongs to: its target when that is a current key, else the section of its decision, else the note's
// own `section`, else the section a `…-rN` fallback target sits in, else the closest section or chapter whose key
// starts the target, else the first chapter (the raw target is kept in `from`). A note is never dropped.
function itemFor(note, items, book) {
  const target = typeof note.target === 'string' ? note.target : '';
  if (items[target]) {
    return target;
  }
  const decision = (book.decisions ?? []).find((d) => d?.id === target);
  if (decision) {
    if (items[decision.section]) {
      return decision.section;
    }
    const about = [].concat(decision.about ?? []).map((k) => items[k]?.section).find(Boolean);
    if (about) {
      return about;
    }
  }
  if (items[note.section]) {
    return note.section;
  }
  const fallback = /^(.*)-r\d+$/.exec(target);
  if (fallback && items[fallback[1]]) {
    return fallback[1];
  }
  const under = (kind) => Object.keys(items)
    .filter((k) => items[k].kind === kind && target.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  const firstChapter = Object.keys(items).find((k) => items[k].kind === 'chapter');
  return under('section') ?? under('chapter') ?? firstChapter ?? target;
}

// True when the note's item came from something other than the first-chapter fallback.
function isDerived(note, items, book) {
  const first = Object.keys(items).find((k) => items[k].kind === 'chapter');
  const target = typeof note.target === 'string' ? note.target : '';
  return itemFor({ ...note, target }, items, book) !== first || target.startsWith(`${first}-`) || target === first || note.section === first;
}

function pinOf(note) {
  const pin = {};
  for (const k of ['rx', 'ry', 'dx', 'dy', 'element']) {
    if (note[k] !== undefined) {
      pin[k] = clone(note[k]);
    }
  }
  return pin;
}

function migrateNotes(old, items, book, now) {
  const notes = {};
  for (const [id, note] of Object.entries(isObject(old?.notes) ? old.notes : {})) {
    if (!isObject(note)) {
      continue;
    }
    const item = itemFor(note, items, book);
    const next = { item, text: String(note.text ?? ''), status: 'draft', created: note.created ?? now };
    for (const k of ['target', 'section']) {
      if (note[k] !== undefined) {
        next[k] = note[k];
      }
    }
    if (item !== note.target && !items[note.target] && !isDerived(note, items, book)) {
      next.from = note.target;
    }
    next.pin = pinOf(note);
    notes[id] = next;
  }
  return notes;
}

// Accepted values: the baseline book's items, then the old per-item accepts (new keys), then dismissed keys at their
// current value.
function acceptedFromBaseline(baseline, items) {
  const was = SpecModel.itemsOf(baseline.book ?? { chapters: [] }, baseline.mockups ?? {});
  const accepted = {};
  for (const [key, item] of Object.entries(was)) {
    accepted[key] = clone(item.value);
  }
  for (const [old, value] of Object.entries(isObject(baseline.accepted) ? baseline.accepted : {})) {
    if (old.endsWith(':stage')) {
      continue;
    }
    const key = old.endsWith(':sec') ? old.slice(0, -4) : old;
    if (value === null || value === undefined) {
      delete accepted[key];
    } else if (typeof value === 'string') {
      const frame = items[key] ?? was[key];
      if (frame?.kind === 'frame') {
        accepted[key] = { caption: frame.value.caption, role: frame.value.role, mockup: value };
      }
    } else if (isObject(value)) {
      const { id, ...rest } = value;
      accepted[key] = clone(rest);
    }
  }
  for (const old of Array.isArray(baseline.dismissed) ? baseline.dismissed : []) {
    if (typeof old !== 'string' || old.endsWith(':stage')) {
      continue;
    }
    const key = old.replace(/:(new|edit)$/, '');
    if (items[key]) {
      accepted[key] = clone(items[key].value);
    } else {
      delete accepted[key];
    }
  }
  return accepted;
}

// Builds review.json and history.json from the old revise/before.json and notes.json (or from the current book), deletes
// the old files and stamps every carried-over review. Returns 'exists' when review.json is already there.
export function migrateReview(data, now = new Date().toISOString()) {
  if (existsSync(join(data, 'review.json'))) {
    return 'exists';
  }
  const { book, items } = currentSnapshot(data);
  const baselineFile = join(data, 'revise', 'before.json');
  const baseline = readJson(baselineFile, null);
  const hasBaseline = isObject(baseline);
  let accepted = {};
  if (hasBaseline) {
    accepted = acceptedFromBaseline(baseline, items);
  } else {
    for (const [key, item] of Object.entries(items)) {
      accepted[key] = clone(item.value);
    }
  }
  const notes = migrateNotes(readJson(join(data, 'notes.json'), null), items, book, now);
  writeJsonAtomic(join(data, 'review.json'), { rev: 1, accepted, notes, tries: {}, opened: {}, where: {} });
  if (!existsSync(join(data, 'history.json'))) {
    writeJsonAtomic(join(data, 'history.json'), { items: {}, changelog: [] });
  }
  stampOpened(data, now);
  rmSync(join(data, 'notes.json'), { force: true });
  rmSync(baselineFile, { force: true });
  if (existsSync(join(data, 'revise')) && readdirSync(join(data, 'revise')).length === 0) {
    rmdirSync(join(data, 'revise'));
  }
  return hasBaseline ? 'from-baseline' : 'from-book';
}
