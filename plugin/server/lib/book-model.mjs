import { createRequire } from 'node:module';

const { sectionStage } = createRequire(import.meta.url)('../../app/model.js');

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function listSections(book) {
  const out = [];
  for (const chapter of book.chapters ?? []) {
    for (const section of chapter.sections ?? []) {
      out.push({ chapter, section, fullId: `${chapter.id}-${section.id}` });
    }
  }
  return out;
}

export function findSection(book, fullId) {
  return listSections(book).find(s => s.fullId === fullId) ?? null;
}

export function findRequirement(book, id) {
  for (const found of listSections(book)) {
    const reqs = found.section.requirements ?? [];
    for (let index = 0; index < reqs.length; index++) {
      const req = reqs[index];
      if (req && typeof req === 'object' && req.id === id) {
        return { ...found, index, req };
      }
    }
  }
  return null;
}

// The user may only move a section between drafting and ready, and only a section with a drafted change to ready;
// a build owns the other stages.
export function setUserStage(book, fullId, stage) {
  if (stage !== 'drafting' && stage !== 'ready') {
    throw fail('bad-stage', `Stage must be drafting or ready, not ${stage}`);
  }
  const found = findSection(book, fullId);
  if (!found) {
    throw fail('not-found', `No section ${fullId}`);
  }
  const current = sectionStage(found.section);
  if (current === 'building') {
    throw fail('locked', `Section ${fullId} is being built`);
  }
  if (stage === 'ready') {
    const hasChange = (found.section.requirements ?? []).some(r => r && typeof r === 'object' && r.change);
    if (!hasChange) {
      throw fail('nothing-to-build', `Section ${fullId} has no drafted change`);
    }
  }
  found.section.stage = stage;
}
