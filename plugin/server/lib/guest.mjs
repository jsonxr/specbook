// Guests: people reading a shared book through its host tab. They may read it and keep their own draft notes; nothing
// else. The host tab (app/host.js) checks every call with guestMay before forwarding it, and serve.mjs checks it again.

export const GUEST_HEADER = 'x-specbook-guest';

const READS = [/^\/$/, /^\/index\.html$/, /^\/app\/[^?#]*$/, /^\/data\/[^?#]*$/, /^\/api\/book$/, /^\/api\/claude$/, /^\/api\/history\/[^/?#]+$/, /^\/api\/health$/];

// True when a guest may make this call. `path` is the decoded path, without the query.
export function guestMay(method, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return false;
  }
  if (method === 'GET' || method === 'HEAD') {
    return READS.some(re => re.test(path));
  }
  return method === 'PUT' && path === '/api/notes';
}

// Fields only the server writes on a draft; a page's copy of the note never carries them.
export const SERVER_FIELDS = ['causes', 'closedFor', 'reply', 'from', 'author', 'authorKey', 'lastBy', 'lastByKey'];

const KEY = /^[A-Za-z0-9_-]{8,64}$/;

// A guest's name as they gave it: trimmed, inner whitespace collapsed, at most 40 characters.
export function cleanName(name) {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  return s || 'Guest';
}

export function validKey(key) {
  return typeof key === 'string' && KEY.test(key);
}

// The header value the host sends for a guest.
export function encodeGuest(guest) {
  return encodeURIComponent(JSON.stringify({ name: cleanName(guest.name), key: guest.key }));
}

// The guest a request is from: null for the owner (no header), { name, key } for a guest, or { invalid: true } for a
// header that cannot be read (treated as a guest with no rights).
export function guestOf(headers) {
  const raw = headers[GUEST_HEADER];
  if (raw === undefined) {
    return null;
  }
  try {
    const g = JSON.parse(decodeURIComponent(Array.isArray(raw) ? raw[0] : raw));
    if (g && typeof g === 'object' && validKey(g.key)) {
      return { name: cleanName(g.name), key: g.key };
    }
  } catch {
    // falls through
  }
  return { invalid: true };
}

// The most drafts one guest may keep, and all guests together; and the longest note a guest may write.
export const GUEST_DRAFTS = 50;
export const ALL_GUEST_DRAFTS = 500;
export const GUEST_TEXT = 4000;

// review.json as a guest may see it: no note carries another person's key (which would let them pose as that
// person); a guest's own notes say `mine: true` instead.
export function reviewForGuest(review, guest) {
  const notes = {};
  for (const [id, note] of Object.entries(review.notes ?? {})) {
    // Keys stay on the owner's machine: a guest learns only whether a note, or its last change, is theirs.
    const { authorKey, lastByKey, ...rest } = note ?? {};
    const out = authorKey !== undefined && authorKey === guest.key ? { ...rest, mine: true } : rest;
    if (lastByKey !== undefined && lastByKey === guest.key) {
      out.lastMine = true;
    }
    notes[id] = out;
  }
  return { ...review, notes };
}

// Throws when a guest's save would keep too many drafts, or one too long to be a note.
export function checkGuestNotes(notes, guest) {
  let theirs = 0;
  let guests = 0;
  for (const note of Object.values(notes)) {
    if (note && note.status === 'draft' && note.authorKey !== undefined) {
      guests++;
      if (note.authorKey === guest.key) {
        theirs++;
      }
    }
    // A note this guest wrote, or changed last, is held to a note's length.
    const wrote = note && note.status === 'draft' && (note.authorKey === guest.key || note.lastByKey === guest.key);
    if (wrote && typeof note.text === 'string' && note.text.length > GUEST_TEXT) {
      throw Object.assign(new Error('Note too long'), { code: 'bad-note' });
    }
  }
  if (theirs > GUEST_DRAFTS || guests > ALL_GUEST_DRAFTS) {
    throw Object.assign(new Error('Too many notes'), { code: 'too-many-notes' });
  }
}

// The notes to store after a guest's save. `stored` is review.json's notes, `sent` the page's drafts (already
// cleaned), `guest` who sent them. Every note that is not this guest's draft stays as stored; the guest's drafts are
// replaced by what they sent (a missing one is deleted); a new id becomes theirs. An id that belongs to anyone else is
// ignored.
export function mergeGuestNotes(stored, sent, guest) {
  const out = {};
  for (const [id, note] of Object.entries(stored)) {
    if (!(note && note.status === 'draft' && note.authorKey === guest.key)) {
      out[id] = note;
    }
  }
  for (const [id, note] of Object.entries(sent)) {
    if (id === '__proto__' || Object.hasOwn(out, id)) {
      continue;
    }
    out[id] = { ...note };
    // What the server wrote on the guest's stored draft stays, as for the owner (see serve.mjs mergeNotes).
    const was = Object.hasOwn(stored, id) ? stored[id] : null;
    for (const k of SERVER_FIELDS) {
      if (was && was[k] !== undefined) {
        out[id][k] = was[k];
      }
    }
    out[id].author = guest.name;
    out[id].authorKey = guest.key;
  }
  return out;
}

// The notes to store after a per-note save (live sharing): `changes` maps a note id to its new draft (already cleaned)
// or null to delete it. `writer` is { guest, name, key? }. Everyone in the book may change or delete any draft (they
// are collaborating); a new note keeps who started it. A note past draft (sent to Claude, answered) is never changed. Saves are applied one
// after another as they arrive, so a change to one note never drops another's: the later change to the same note
// wins, and `lastBy` says who made it.
// Ids that may not change (past draft) are left alone and listed in `skipped` (when given), so the page knows they
// were not saved.
export function applyNoteChanges(stored, changes, writer, skipped = []) {
  const out = { ...stored };
  for (const [id, next] of Object.entries(changes)) {
    if (id === '__proto__') {
      continue;
    }
    const was = Object.hasOwn(stored, id) ? stored[id] : null;
    if (was && was.status !== 'draft') {
      skipped.push(id);
      continue;
    }
    if (next === null) {
      delete out[id];
      continue;
    }
    const note = { ...next, status: 'draft' };
    for (const k of SERVER_FIELDS) {
      if (was && was[k] !== undefined) {
        note[k] = was[k];
      }
    }
    if (writer.guest && !was) {
      note.author = writer.name;
      note.authorKey = writer.key;
    }
    note.lastBy = writer.name;
    note.lastByKey = writer.guest ? writer.key : 'owner';
    out[id] = note;
  }
  return out;
}
