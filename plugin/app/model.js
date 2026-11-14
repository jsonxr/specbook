// Shared model for the reader (window.SpecModel) and the server (CommonJS). ES5 on purpose.
(function (root, f) {
  if (typeof module === 'object' && module.exports) {
    module.exports = f();
  } else {
    root.SpecModel = f();
  }
})(this, function () {
  var STAGE_TEXT = { drafting: 'Drafting', ready: 'Ready', building: 'Building', built: 'Built' };

  function isPassed(t) { return t.status === 'passed'; }

  // A requirement is proven when any unit or e2e result naming it has status "passed".
  function isProven(evidence, id) {
    var by = evidence && evidence.byId;
    var e = id && by && by[id] ? by[id] : null;
    return !!e && ((e.e2e || []).some(isPassed) || (e.unit || []).some(isPassed));
  }

  function sectionStage(section) {
    return (section && section.stage) || 'drafting';
  }

  function chapterStage(chapter) {
    var stages = ((chapter && chapter.sections) || []).map(sectionStage);
    if (stages.indexOf('building') !== -1) {
      return 'building';
    }
    if (stages.length === 0 || stages.indexOf('drafting') !== -1) {
      return 'drafting';
    }
    if (stages.indexOf('ready') !== -1) {
      return 'ready';
    }
    return 'built';
  }

  function stagePill(section) {
    var stage = sectionStage(section);
    var text = STAGE_TEXT[stage] || STAGE_TEXT.drafting;
    if (stage === 'drafting') {
      var reqs = (section && section.requirements) || [];
      var n = reqs.filter(function (r) { return r && typeof r === 'object' && r.change; }).length;
      if (n > 0 && n < reqs.length) {
        text = 'Built · ' + n + (n === 1 ? ' change drafting' : ' changes drafting');
      }
    }
    if (section && section.label) {
      text += ' · ' + section.label;
    }
    return { cls: stage, text: text };
  }

  // ---- Items and reviews ----------------------------------------------------------------------------------------
  // A reviewable item has a key and a value: a requirement (its id; text, change, today, reason), a frame (its id;
  // caption, role, mockup text), a section heading ("<chapter>-<section>"; title, intro) and a chapter heading (the
  // chapter id; title, intro). Stage, label, frame state and decisions are not reviewed.
  var REQ_FIELDS = ['text', 'change', 'today', 'reason'];

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function itemsOf(book, mockups) {
    var items = {};
    var texts = mockups || {};
    ((book && book.chapters) || []).forEach(function (c) {
      items[c.id] = { kind: 'chapter', value: { title: c.title || '', intro: c.intro || '' }, section: null, chapter: c.id };
      (c.sections || []).forEach(function (s) {
        var fullId = c.id + '-' + s.id;
        items[fullId] = { kind: 'section', value: { title: s.title || '', intro: s.intro || '' }, section: fullId, chapter: c.id };
        (s.requirements || []).forEach(function (r) {
          if (!r || typeof r !== 'object' || !r.id) {
            return;
          }
          var v = {};
          REQ_FIELDS.forEach(function (k) { if (r[k] !== undefined) { v[k] = r[k]; } });
          items[r.id] = { kind: 'req', value: v, section: fullId, chapter: c.id };
        });
        (s.frames || []).forEach(function (fr) {
          if (!fr || !fr.id) {
            return;
          }
          var m = fr.mockup !== undefined && has(texts, fr.mockup) && texts[fr.mockup] !== undefined ? texts[fr.mockup] : null;
          items[fr.id] = { kind: 'frame', value: { caption: fr.caption, role: fr.role, mockup: m }, section: fullId, chapter: c.id };
        });
      });
    });
    return items;
  }

  // Deep equality over a value's own fields; a field that is undefined counts as absent.
  function sameValue(a, b) {
    if (a === b) {
      return true;
    }
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
      return false;
    }
    var defined = function (o) { return Object.keys(o).filter(function (k) { return o[k] !== undefined; }); };
    var ka = defined(a);
    var kb = defined(b);
    return ka.length === kb.length && ka.every(function (k) { return has(b, k) && sameValue(a[k], b[k]); });
  }

  function dateOf(iso) { return String(iso || '').slice(0, 10); }

  // Every item under review. An item is under review when it has no accepted copy (new), differs from it (changed),
  // is accepted but gone from the book (removed), or is otherwise unchanged but has an open note or a try (noted).
  // A note is open when it is not frozen and does not list the key in `closedFor`; it shows under its own `item` and
  // under every key in its `causes`. Tries come back oldest first with their notes. A review whose current value
  // equals the `before` of one of the item's history entries carries a `reversal`.
  // `byKey` holds the reviews; `bySection` and `byChapter` count them (a removed item takes its place from `review.where`
  // (key -> { kind, section, chapter }) when present, else it counts only toward `count`); `count` is every review.
  function reviews(book, mockups, review, history) {
    var out = { byKey: {}, bySection: {}, byChapter: {}, count: 0 };
    var rv = review || {};
    var accepted = rv.accepted || {};
    var notes = rv.notes || {};
    var tries = rv.tries || {};
    var where = rv.where || {};
    var past = (history && history.items) || {};
    var items = itemsOf(book, mockups);
    var decisions = (book && book.decisions) || [];

    var noteWithId = function (id) {
      var o = { id: id };
      Object.keys(notes[id]).forEach(function (k) { o[k] = notes[id][k]; });
      return o;
    };

    var inTries = function (key, id) {
      return (tries[key] || []).some(function (t) { return (t.notes || []).indexOf(id) !== -1; });
    };

    var openNotes = function (key) {
      return Object.keys(notes).filter(function (id) {
        var n = notes[id];
        if (!n || n.status === 'frozen') {
          return false;
        }
        if ((n.closedFor || []).indexOf(key) !== -1) {
          return false;
        }
        // A note kept with one of this item's tries shows there, with the version it was written about.
        if (inTries(key, id)) {
          return false;
        }
        return n.item === key || (n.causes || []).indexOf(key) !== -1;
      }).map(noteWithId);
    };

    var reversalOf = function (key, current) {
      if (!current) {
        return null;
      }
      var entries = past[key] || [];
      for (var i = entries.length - 1; i >= 0; i--) {
        var e = entries[i];
        if (e && e.before && sameValue(current, e.before)) {
          var ids = e.decisions || [];
          if (ids.length === 0) {
            ids = decisions.filter(function (d) {
              var about = d && d.about;
              return d && d.id && (Array.isArray(about) ? about.indexOf(key) !== -1 : about === key);
            }).map(function (d) { return d.id; });
          }
          return { date: dateOf(e.acceptedAt), decisions: ids };
        }
      }
      return null;
    };

    var keys = Object.keys(items);
    Object.keys(accepted).forEach(function (k) { if (!has(items, k)) { keys.push(k); } });
    keys.forEach(function (key) {
      var item = has(items, key) ? items[key] : null;
      var current = item ? item.value : null;
      var was = has(accepted, key) ? accepted[key] : null;
      var open = openNotes(key);
      var mine = (tries[key] || []).map(function (t) {
        return {
          value: t.value,
          frozenAt: t.frozenAt,
          notes: (t.notes || []).filter(function (id) { return notes[id]; }).map(noteWithId)
        };
      });
      var status = null;
      if (item && !was) {
        status = 'new';
      } else if (!item && was) {
        status = 'removed';
      } else if (item && !sameValue(current, was)) {
        status = 'changed';
      } else if (item && (open.length > 0 || mine.length > 0)) {
        status = 'noted';
      }
      if (!status) {
        return;
      }
      // A removed item is no longer in the book; where it lived comes from review.where when the server wrote it.
      // Without review.where the kind is guessed from the accepted value's shape: a chapter and a section share
      // {title, intro}, so a removed chapter guesses 'section'.
      var place = item || (has(where, key) && where[key] ? where[key] : null);
      out.byKey[key] = {
        key: key,
        kind: place && place.kind ? place.kind : (was && was.title !== undefined ? 'section' : was && was.mockup !== undefined ? 'frame' : 'req'),
        status: status,
        accepted: was,
        current: current,
        tries: mine,
        notes: open,
        // Only a value that differs from the accepted copy can bring back old wording; a notes-only review cannot.
        reversal: status === 'new' || status === 'changed' ? reversalOf(key, current) : null
      };
      out.count++;
      if (place) {
        if (place.section) {
          out.bySection[place.section] = (out.bySection[place.section] || 0) + 1;
        }
        if (place.chapter) {
          out.byChapter[place.chapter] = (out.byChapter[place.chapter] || 0) + 1;
        }
      }
    });
    // A note whose item and causes are gone from the book and from `accepted` (a draft requirement Claude deleted, a new
    // frame dropped) has nothing to show on. It gets a review under its own item key, placed on its section: from
    // `review.where`, else the note's `section`, else that chapter, else the first chapter. Accepting that key settles it.
    var placeOf = function (key, n) {
      var chapters = (book && book.chapters) || [];
      var w = has(where, key) && where[key] ? where[key] : null;
      var section = w && w.section ? w.section : n.section;
      var chapter = w && w.chapter ? w.chapter : null;
      var found = null;
      chapters.forEach(function (ch) {
        (ch.sections || []).forEach(function (s) { if (ch.id + '-' + s.id === section) { found = ch.id; } });
        if (!found && !chapter && ch.id === section) { chapter = ch.id; }
      });
      chapter = found || chapter || (chapters[0] ? chapters[0].id : null);
      return { section: found ? section : (w && w.section ? w.section : null), chapter: chapter };
    };
    var known = function (k) { return typeof k === 'string' && (has(items, k) || has(accepted, k)); };
    Object.keys(notes).forEach(function (id) {
      var n = notes[id];
      if (!n || n.status === 'frozen' || typeof n.item !== 'string' || has(out.byKey, n.item) || known(n.item)) {
        return;
      }
      if ((n.closedFor || []).indexOf(n.item) !== -1 || (n.causes || []).some(known)) {
        return;
      }
      var key = n.item;
      var place = placeOf(key, n);
      var kind = has(where, key) && where[key] && where[key].kind ? where[key].kind : 'req';
      out.byKey[key] = { key: key, kind: kind, status: 'removed', orphan: true, place: place, accepted: null, current: null, tries: [], notes: openNotes(key), reversal: null };
      out.count++;
      if (place.section) { out.bySection[place.section] = (out.bySection[place.section] || 0) + 1; }
      if (place.chapter) { out.byChapter[place.chapter] = (out.byChapter[place.chapter] || 0) + 1; }
    });
    return out;
  }

  return {
    isProven: isProven,
    sectionStage: sectionStage,
    chapterStage: chapterStage,
    stagePill: stagePill,
    itemsOf: itemsOf,
    sameValue: sameValue,
    reviews: reviews
  };
});
