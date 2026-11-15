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

  // After a save, the ids the server skipped (another's note, or one no longer a draft): a note this page changed moves
  // to a new id (from makeId) so the text typed is not lost; a delete it skipped is simply not ours to make. `unsynced`
  // are the ids to forget as saved, so the server's copy of each comes back on the next reload.
  function rekeySkipped(notes, changes, skipped, makeId) {
    if (!skipped || !skipped.length) { return { notes: notes, unsynced: [] }; }
    var out = {};
    Object.keys(notes).forEach(function (id) {
      var moved = skipped.indexOf(id) >= 0 && changes[id] != null;
      out[moved ? makeId() : id] = notes[id];
    });
    return { notes: out, unsynced: skipped.slice() };
  }

  // ---- Screens ----------------------------------------------------------------------------------------------------
  // A book-wide catalog: book.screens is a list of screens and components, each with states (one picture apiece, or
  // `sameAs` another state, or `absent`). A state's key is "<screen id>.<state id>". Pictures place components with
  // <sb-component id="..." state="..."></sb-component>; sections list the states they show in `shows`.
  var MAX_DEPTH = 8;

  function stateKey(screenId, stateId) { return screenId + '.' + stateId; }

  function screensOf(book) { return (book && book.screens) || []; }

  function screenIndex(book) {
    var out = { screens: {}, states: {}, byName: {} };
    screensOf(book).forEach(function (s) {
      if (!s || typeof s !== 'object') { return; }
      if (!has(out.screens, s.id)) { out.screens[s.id] = s; }
      if (!has(out.byName, s.name)) { out.byName[s.name] = s.id; }
      (s.states || []).forEach(function (st) {
        var key = stateKey(s.id, st.id);
        if (!has(out.states, key)) { out.states[key] = { screen: s, state: st }; }
      });
    });
    return out;
  }

  // The state whose picture a key draws: itself, or the one it is `sameAs` (one step). Null when either is missing.
  function drawnState(book, key) { return drawnIn(screenIndex(book), key); }

  function drawnIn(ix, key) {
    var hit = has(ix.states, key) ? ix.states[key] : null;
    if (!hit) { return null; }
    if (hit.state.sameAs) {
      var to = stateKey(hit.screen.id, hit.state.sameAs);
      return has(ix.states, to) ? ix.states[to] : null;
    }
    return hit;
  }

  function pictureOf(state) {
    var out = [];
    if (state.mockup) { out.push(state.mockup); }
    if (state.today) { out.push(state.today); }
    return out;
  }

  function mockupPaths(book) {
    var out = [];
    screensOf(book).forEach(function (s) {
      (s.states || []).forEach(function (st) {
        pictureOf(st).forEach(function (p) { if (out.indexOf(p) < 0) { out.push(p); } });
      });
    });
    return out;
  }

  function attr(tag, name) {
    var m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
  }

  function componentsIn(html) {
    var out = [];
    var re = /<sb-component\b[^>]*>/gi;
    var m;
    while ((m = re.exec(html || ''))) {
      out.push({ id: attr(m[0], 'id'), state: attr(m[0], 'state') });
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Replaces each component tag in `html` with that state's picture (nested tags too), wrapped in
  // <div class="sb-comp" data-key="...">. A cycle, a missing component or state, or a missing picture becomes a
  // visible <div class="sb-missing"> naming the key. opts.highlight is a component id to outline (class sb-hl).
  function expandMockup(book, mockups, html, opts) {
    return expandIn(screenIndex(book), mockups || {}, html, opts || {}, [], 0);
  }

  function expandIn(ix, mockups, html, opts, path, depth) {
    return String(html || '').replace(/<sb-component\b[^>]*>(?:\s*<\/sb-component>)?/gi, function (tag) {
      var id = attr(tag, 'id');
      var key = stateKey(id, attr(tag, 'state'));
      var missing = function (why) {
        return '<div class="sb-missing" data-key="' + escapeHtml(key) + '">' + escapeHtml(why + ': ' + key) + '</div>';
      };
      var d = drawnIn(ix, key);
      if (!d || !d.state.mockup) { return missing('Missing component state'); }
      var drawn = stateKey(d.screen.id, d.state.id);
      if (path.indexOf(drawn) >= 0 || depth >= MAX_DEPTH) { return missing('Component placed inside itself'); }
      var text = mockups[d.state.mockup];
      if (typeof text !== 'string') { return missing('Missing picture'); }
      var inner = expandIn(ix, mockups, text, opts, path.concat(drawn), depth + 1);
      var cls = 'sb-comp' + (opts.highlight && opts.highlight === id ? ' sb-hl' : '');
      return '<div class="' + cls + '" data-key="' + escapeHtml(key) + '">' + inner + '</div>';
    });
  }

  function eachSection(book, f) {
    ((book && book.chapters) || []).forEach(function (ch) {
      (ch.sections || []).forEach(function (s) { f(ch, s, ch.id + '-' + s.id); });
    });
  }

  function pushOnce(list, v) { if (list.indexOf(v) < 0) { list.push(v); } }

  // Component states a state's pictures place directly: the keys as written in the tags.
  function placedKeys(mockups, state) {
    var out = [];
    pictureOf(state).forEach(function (p) {
      componentsIn(mockups && mockups[p]).forEach(function (c) { pushOnce(out, stateKey(c.id, c.state)); });
    });
    return out;
  }

  // {component id: [state keys whose picture, today's included, places it]}
  function usedOn(book, mockups) {
    var out = {};
    screensOf(book).forEach(function (s) {
      (s.states || []).forEach(function (st) {
        var key = stateKey(s.id, st.id);
        pictureOf(st).forEach(function (p) {
          componentsIn(mockups && mockups[p]).forEach(function (c) {
            if (!has(out, c.id)) { out[c.id] = []; }
            pushOnce(out[c.id], key);
          });
        });
      });
    });
    return out;
  }

  // {state key: [section full ids in book order]}
  function shownIn(book) {
    var out = {};
    eachSection(book, function (ch, s, fullId) {
      (s.shows || []).forEach(function (sh) {
        if (!sh || !sh.state) { return; }
        if (!has(out, sh.state)) { out[sh.state] = []; }
        pushOnce(out[sh.state], fullId);
      });
    });
    return out;
  }

  // Everything a section's Accept gate covers beyond its own text: the states it shows, followed through sameAs and
  // through the components those pictures place (nested too), and the screen headings of all of them.
  function gateKeys(book, mockups, fullId) {
    var ix = screenIndex(book);
    var out = [];
    var seen = {};
    var add = function (key) {
      if (!has(ix.states, key)) { return; }
      pushOnce(out, key);
      pushOnce(out, ix.states[key].screen.id);
      var d = drawnIn(ix, key);
      if (!d) { return; }
      var dk = stateKey(d.screen.id, d.state.id);
      pushOnce(out, dk);
      if (has(seen, dk)) { return; }
      seen[dk] = true;
      placedKeys(mockups, d.state).forEach(add);
    };
    eachSection(book, function (ch, s, id) {
      if (id !== fullId) { return; }
      (s.shows || []).forEach(function (sh) { if (sh && sh.state) { add(sh.state); } });
    });
    return out;
  }

  // Component ids placed, at any depth, by any state of a screen.
  function placedComponents(ix, mockups, screenId) {
    var out = [];
    var seen = {};
    var walk = function (screen) {
      (screen.states || []).forEach(function (st) {
        placedKeys(mockups, st).forEach(function (key) {
          var c = has(ix.states, key) ? ix.states[key] : null;
          var id = key.split('.')[0];
          pushOnce(out, id);
          if (c && !has(seen, id)) { seen[id] = true; walk(c.screen); }
        });
      });
    };
    if (has(ix.screens, screenId)) { seen[screenId] = true; walk(ix.screens[screenId]); }
    return out;
  }

  // Requirements that apply to a screen, in book order: those naming it, and those naming a component it places
  // (`via` is that component's id).
  function requirementsFor(book, mockups, screenId) {
    var ix = screenIndex(book);
    var placed = placedComponents(ix, mockups, screenId);
    var out = [];
    eachSection(book, function (ch, s, fullId) {
      (s.requirements || []).forEach(function (req) {
        if (!req || typeof req !== 'object') { return; }
        (req.screens || []).forEach(function (e) {
          if (!e) { return; }
          var direct = e.screen === screenId;
          if (!direct && placed.indexOf(e.screen) < 0) { return; }
          out.push({ req: req, fullId: fullId, chapterId: ch.id, state: e.state || null, via: direct ? null : e.screen });
        });
      });
    });
    return out;
  }

  // Book roles that no state of a screen covers. Components, and screens with an "anyone" state, miss none.
  function missingRoles(book, screenId) {
    var screen = screenIndex(book).screens[screenId];
    if (!screen || screen.kind === 'component') { return []; }
    var covered = [];
    (screen.states || []).forEach(function (st) { if (st.when && st.when.role) { covered.push(st.when.role); } });
    if (covered.indexOf('anyone') >= 0) { return []; }
    return ((book && book.roles) || []).map(function (r) { return r.id; })
      .filter(function (id) { return id !== 'anyone' && covered.indexOf(id) < 0; });
  }

  // The first way the screens in a book are invalid, in words; null when valid (the spec's "Validity" list).
  // `exists(path)` says whether a mockup file is there; `mockups` holds the text of those that are.
  function screenProblem(book, exists, mockups) {
    var screens = screensOf(book);
    var ix = screenIndex(book);
    var ids = {};
    var names = {};
    var roles = ((book && book.roles) || []).map(function (r) { return r.id; });
    for (var i = 0; i < screens.length; i++) {
      var s = screens[i];
      if (has(ids, s.id)) { return 'Two screens share the id ' + s.id; }
      ids[s.id] = true;
      if (has(names, s.name)) { return 'Two screens are named ' + s.name + ' (' + s.id + ')'; }
      names[s.name] = true;
      var stateIds = {};
      var states = s.states || [];
      for (var j = 0; j < states.length; j++) {
        var st = states[j];
        var key = stateKey(s.id, st.id);
        if (has(stateIds, st.id)) { return 'Screen ' + s.id + ' has two states with the id ' + st.id; }
        stateIds[st.id] = true;
        var kinds = ['mockup', 'sameAs', 'absent'].filter(function (k) { return st[k]; });
        if (kinds.length !== 1) {
          return 'State ' + key + ' needs exactly one of mockup, sameAs and absent (it has ' + (kinds.join(', ') || 'none') + ')';
        }
        if (st.when && st.when.role && roles.indexOf(st.when.role) < 0) {
          return 'State ' + key + ' names the role ' + st.when.role + ', which the book does not define';
        }
        var files = pictureOf(st);
        for (var f = 0; f < files.length; f++) {
          if (!exists(files[f])) { return 'State ' + key + ' points at a missing picture, ' + files[f]; }
        }
        if (st.sameAs) {
          var to = has(ix.states, stateKey(s.id, st.sameAs)) ? ix.states[stateKey(s.id, st.sameAs)].state : null;
          if (!to) { return 'State ' + key + ' is sameAs ' + st.sameAs + ', which is not a state of ' + s.id; }
          if (to.sameAs) {
            var hops = 0;
            var at = to;
            while (at && at.sameAs && at.id !== st.id && hops++ < states.length) {
              at = has(ix.states, stateKey(s.id, at.sameAs)) ? ix.states[stateKey(s.id, at.sameAs)].state : null;
            }
            if (at && at.id === st.id) { return 'State ' + key + ' is in a sameAs cycle'; }
            return 'State ' + key + ' is sameAs ' + st.sameAs + ', which is itself sameAs another state';
          }
        }
      }
    }
    for (var i2 = 0; i2 < screens.length; i2++) {
      var states2 = screens[i2].states || [];
      for (var j2 = 0; j2 < states2.length; j2++) {
        var files2 = pictureOf(states2[j2]);
        for (var p = 0; p < files2.length; p++) {
          var tags = componentsIn(mockups && mockups[files2[p]]);
          for (var t = 0; t < tags.length; t++) {
            var tk = stateKey(tags[t].id, tags[t].state);
            var comp = has(ix.screens, tags[t].id) ? ix.screens[tags[t].id] : null;
            if (!comp || comp.kind !== 'component') {
              return 'The picture ' + files2[p] + ' places ' + tags[t].id + ', which is not a component in the book';
            }
            if (!has(ix.states, tk)) { return 'The picture ' + files2[p] + ' places ' + tk + ', which is not a state'; }
          }
        }
      }
    }
    var problem = null;
    eachSection(book, function (ch, sec, fullId) {
      if (problem) { return; }
      (sec.requirements || []).forEach(function (req) {
        if (problem || !req || typeof req !== 'object') { return; }
        (req.screens || []).forEach(function (e) {
          if (problem) { return; }
          if (!e || !has(ix.screens, e.screen)) {
            problem = 'Requirement ' + req.id + ' names ' + (e && e.screen) + ', which is not a screen or component';
          } else if (e.state && !has(ix.states, stateKey(e.screen, e.state))) {
            problem = 'Requirement ' + req.id + ' names ' + stateKey(e.screen, e.state) + ', which is not a state';
          }
        });
      });
      (sec.shows || []).forEach(function (sh) {
        if (problem) { return; }
        if (!sh || !has(ix.states, sh.state)) {
          problem = 'Section ' + fullId + ' shows ' + (sh && sh.state) + ', which is not a state';
        } else if (sh.highlight) {
          var d = drawnIn(ix, sh.state);
          var here = d ? placedKeys(mockups, d.state).map(function (k) { return k.split('.')[0]; }) : [];
          if (here.indexOf(sh.highlight) < 0) {
            problem = 'Section ' + fullId + ' highlights ' + sh.highlight + ', which ' + sh.state + ' does not place';
          }
        }
      });
    });
    return problem;
  }

  return {
    stateKey: stateKey,
    screenIndex: screenIndex,
    drawnState: drawnState,
    mockupPaths: mockupPaths,
    componentsIn: componentsIn,
    expandMockup: expandMockup,
    usedOn: usedOn,
    shownIn: shownIn,
    gateKeys: gateKeys,
    requirementsFor: requirementsFor,
    missingRoles: missingRoles,
    screenProblem: screenProblem,
    rekeySkipped: rekeySkipped,
    isProven: isProven,
    sectionStage: sectionStage,
    chapterStage: chapterStage,
    stagePill: stagePill,
    itemsOf: itemsOf,
    sameValue: sameValue,
    reviews: reviews
  };
});
