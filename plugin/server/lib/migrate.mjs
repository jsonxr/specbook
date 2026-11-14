export function plain(html) {
  return String(html).replace(/<[^>]*>/g, '').trim();
}

function isObject(x) {
  return !!x && typeof x === 'object';
}

function migrateSection(section) {
  const hadStage = !!section.stage;
  const fromDraft = section.status === 'proposed' || section.status === 'phase';
  if (!hadStage) {
    const anyProposed = (section.requirements ?? []).some(r => isObject(r) && r.status === 'proposed');
    section.stage = section.status === 'built' && !anyProposed ? 'built' : 'drafting';
    if (section.status === 'phase' && section.pill && !section.label) {
      section.label = section.pill;
    }
  }
  delete section.status;
  delete section.pill;
  // A plain string in a section that starts out drafting is a new requirement; assign-ids mints its id.
  if (!hadStage && fromDraft && section.requirements) {
    section.requirements = section.requirements.map(r => (typeof r === 'string' ? { text: r, change: 'add' } : r));
  }
  for (const req of section.requirements ?? []) {
    if (!isObject(req)) {
      continue;
    }
    if (req.status === 'proposed') {
      req.change = req.today ? 'change' : 'add';
    } else if (!hadStage && fromDraft && !req.change) {
      req.change = 'add';
    }
    delete req.status;
  }
}

// Moves an old-format book to section stages, requirement changes and the decision log. Idempotent.
export function migrateBook(book, today) {
  const before = JSON.stringify(book);
  for (const chapter of book.chapters ?? []) {
    delete chapter.status;
    delete chapter.pill;
    for (const section of chapter.sections ?? []) {
      migrateSection(section);
    }
  }
  for (const d of book.decisions ?? []) {
    if (!d.kind) {
      d.kind = 'decision';
      d.by = 'user';
      d.about = [];
      d.date = today;
    }
  }
  if (book.calls) {
    book.decisions = book.decisions ?? [];
    for (const raw of book.calls) {
      // A call may still be a plain string; assign-ids.mjs mints its id.
      const c = typeof raw === 'string' ? { text: raw } : raw;
      book.decisions.push({
        ...(c.id ? { id: c.id } : {}),
        date: today,
        about: [],
        by: 'user',
        title: plain(c.text).slice(0, 80),
        body: c.text,
        kind: 'decision',
      });
    }
    delete book.calls;
  }
  return { book, changed: JSON.stringify(book) !== before };
}
