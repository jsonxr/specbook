import { randomInt } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O, 1/I

function collect(used, item) {
  if (item && typeof item === 'object' && item.id) {
    used.add(item.id);
  }
}

// Every id on requirements, screens, calls and decisions, plus the ids already retired in usedIds.
export function collectIds(book) {
  const used = new Set(book.usedIds ?? []);
  for (const ch of book.chapters ?? []) {
    for (const s of ch.sections ?? []) {
      (s.requirements ?? []).forEach(r => collect(used, r));
    }
  }
  (book.screens ?? []).forEach(sc => collect(used, sc));
  (book.calls ?? []).forEach(c => collect(used, c));
  (book.decisions ?? []).forEach(d => collect(used, d));
  return used;
}

// Mints <prefix>-<4 chars> ids that are never reused, recording each in book.usedIds (kept sorted).
export function createMinter(book) {
  const used = collectIds(book);
  return {
    mint(prefix) {
      for (;;) {
        let code = '';
        for (let k = 0; k < 4; k++) {
          code += ALPHABET[randomInt(ALPHABET.length)];
        }
        const id = `${prefix}-${code}`;
        if (!used.has(id)) {
          used.add(id);
          book.usedIds = [...(book.usedIds ?? []), id].sort();
          return id;
        }
      }
    },
  };
}
