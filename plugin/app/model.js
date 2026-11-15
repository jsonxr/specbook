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
  // A reviewable item has a key and a value: a requirement (its id; text, change, today, reason, screens), a screen
  // (its id; name, kind, file, intro, variables, undrawn), a state (its key "<screen id>.<state id>"; when, sameAs,
  // absent, change, reason, also, name, and the text of its mockup and today files, each only when the state has that
  // path), a section heading ("<chapter>-<section>"; title, intro, shows)
  // and a chapter heading (the chapter id; title, intro). Screens and states belong to no section or chapter; the
  // sections that show them count their reviews. Stage, label and decisions are not reviewed.
  var REQ_FIELDS = ['text', 'change', 'today', 'reason', 'screens'];
  // Only fields a screen or state has: a screen with no variables or undrawn keeps the value it had before them.
  var SCREEN_FIELDS = ['name', 'kind', 'file', 'intro', 'variables', 'undrawn'];
  var STATE_FIELDS = ['when', 'sameAs', 'absent', 'change', 'reason', 'also', 'name'];

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function itemsOf(book, mockups) {
    var items = {};
    var texts = mockups || {};
    ((book && book.chapters) || []).forEach(function (c) {
      items[c.id] = { kind: 'chapter', value: { title: c.title || '', intro: c.intro || '' }, section: null, chapter: c.id };
      (c.sections || []).forEach(function (s) {
        var fullId = c.id + '-' + s.id;
        var sv = { title: s.title || '', intro: s.intro || '' };
        if (s.shows !== undefined) { sv.shows = s.shows; }
        items[fullId] = { kind: 'section', value: sv, section: fullId, chapter: c.id };
        (s.requirements || []).forEach(function (r) {
          if (!r || typeof r !== 'object' || !r.id) {
            return;
          }
          var v = {};
          REQ_FIELDS.forEach(function (k) { if (r[k] !== undefined) { v[k] = r[k]; } });
          items[r.id] = { kind: 'req', value: v, section: fullId, chapter: c.id };
        });
      });
    });
    screensOf(book).forEach(function (sc) {
      if (!sc || typeof sc !== 'object' || !sc.id) { return; }
      var sv = {};
      SCREEN_FIELDS.forEach(function (k) { if (sc[k] !== undefined) { sv[k] = sc[k]; } });
      items[sc.id] = { kind: 'screen', value: sv, section: null, chapter: null, screen: sc.id };
      (sc.states || []).forEach(function (st) {
        if (!st || typeof st !== 'object' || !st.id) { return; }
        var v = {};
        STATE_FIELDS.forEach(function (k) { if (st[k] !== undefined) { v[k] = st[k]; } });
        var text = function (path) {
          return typeof path === 'string' && has(texts, path) && texts[path] !== undefined ? texts[path] : null;
        };
        // A picture field is there only when the state has that path (a path whose file is missing reads as null).
        if (st.mockup !== undefined) { v.mockup = text(st.mockup); }
        if (st.today !== undefined) { v.today = text(st.today); }
        items[stateKey(sc.id, st.id)] = { kind: 'state', value: v, section: null, chapter: null, screen: sc.id };
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
    var out = { byKey: {}, bySection: {}, byChapter: {}, byScreen: {}, count: 0 };
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

    // The sections that show a state, or any state of a screen, once each, in book order.
    var shown = shownIn(book);
    var chapterOf = {};
    ((book && book.chapters) || []).forEach(function (c) {
      (c.sections || []).forEach(function (s) { chapterOf[c.id + '-' + s.id] = c.id; });
    });
    var showingSections = function (key, kind) {
      var found = {};
      Object.keys(shown).forEach(function (sk) {
        if (kind === 'screen' ? sk.split('.')[0] === key : sk === key) {
          shown[sk].forEach(function (fullId) { found[fullId] = true; });
        }
      });
      return Object.keys(chapterOf).filter(function (fullId) { return found[fullId]; });
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
      // Without review.where the kind is guessed: a key with a dot is a state; otherwise from the accepted value's
      // shape, where a chapter and a section share {title, intro}, so a removed chapter guesses 'section'.
      var place = item || (has(where, key) && where[key] ? where[key] : null);
      out.byKey[key] = {
        key: key,
        kind: place && place.kind ? place.kind : (key.indexOf('.') >= 0 ? 'state' : was && was.title !== undefined ? 'section' : was && was.mockup !== undefined ? 'state' : 'req'),
        status: status,
        accepted: was,
        current: current,
        tries: mine,
        notes: open,
        // Only a value that differs from the accepted copy can bring back old wording; a notes-only review cannot.
        reversal: status === 'new' || status === 'changed' ? reversalOf(key, current) : null
      };
      out.count++;
      var kind = out.byKey[key].kind;
      if (kind === 'screen' || kind === 'state') {
        var sid = place && place.screen ? place.screen : (kind === 'screen' ? key : key.split('.')[0]);
        out.byScreen[sid] = (out.byScreen[sid] || 0) + 1;
        var holders = showingSections(key, kind);
        // A removed one is shown nowhere any more; it counts where review.where put it.
        if (holders.length === 0 && place && place.section) { holders = [place.section]; }
        holders.forEach(function (fullId) {
          out.bySection[fullId] = (out.bySection[fullId] || 0) + 1;
          var ch = chapterOf[fullId] || (place && place.chapter);
          if (ch) { out.byChapter[ch] = (out.byChapter[ch] || 0) + 1; }
        });
      } else if (place) {
        if (place.section) {
          out.bySection[place.section] = (out.bySection[place.section] || 0) + 1;
        }
        if (place.chapter) {
          out.byChapter[place.chapter] = (out.byChapter[place.chapter] || 0) + 1;
        }
      }
    });
    // A note whose item and causes are gone from the book and from `accepted` (a draft requirement Claude deleted, a new
    // state dropped) has nothing to show on. It gets a review under its own item key, placed on its section: from
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
        if (!st || typeof st !== 'object') { return; }
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
    // After whitespace only, so data-id and data-state are not read as id and state.
    var m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
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
  // <div class="sb-component" data-key="...">. A cycle, a missing component or state, or a missing picture becomes a
  // visible <div class="sb-missing"> naming the key. opts.highlight is a component id to outline (class sb-hl).
  function expandMockup(book, mockups, html, opts) {
    return expandIn(screenIndex(book), mockups || {}, html, opts || {}, [], 0);
  }

  function expandIn(ix, mockups, html, opts, path, depth) {
    return String(html || '').replace(/<sb-component\b[^>]*>(?:\s*<\/sb-component>)?/gi, function (tag) {
      var id = attr(tag, 'id');
      var key = stateKey(id, attr(tag, 'state'));
      var missing = function () {
        return '<div class="sb-missing" data-key="' + escapeHtml(key) + '">' + escapeHtml('Missing component ' + key) + '</div>';
      };
      var d = drawnIn(ix, key);
      if (!d || !d.state.mockup) { return missing(); }
      var drawn = stateKey(d.screen.id, d.state.id);
      if (path.indexOf(drawn) >= 0 || depth >= MAX_DEPTH) { return missing(); }
      var text = mockups[d.state.mockup];
      if (typeof text !== 'string') { return missing(); }
      var inner = expandIn(ix, mockups, text, opts, path.concat(drawn), depth + 1);
      var cls = 'sb-component' + (opts.highlight && opts.highlight === id ? ' sb-hl' : '');
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

  // Component ids placed by a state's pictures, at any depth.
  function placedFromState(ix, mockups, state) {
    var out = [];
    var seen = {};
    var walk = function (st) {
      placedKeys(mockups, st).forEach(function (key) {
        var c = has(ix.states, key) ? ix.states[key] : null;
        var id = key.split('.')[0];
        pushOnce(out, id);
        if (c && !has(seen, key)) { seen[key] = true; walk(c.state); }
      });
    };
    walk(state);
    return out;
  }

  // Component ids placed, at any depth, by any state of a screen.
  function placedComponents(ix, mockups, screenId) {
    var out = [];
    if (has(ix.screens, screenId)) {
      (ix.screens[screenId].states || []).forEach(function (st) {
        placedFromState(ix, mockups, st).forEach(function (id) { if (id !== screenId) { pushOnce(out, id); } });
      });
    }
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

  // Reviews a section's Accept gate covers (gateKeys) that the section cannot draw itself: everything but the states it
  // shows directly (the screen headings of those states, states drawn through sameAs, component states placed in its
  // pictures). `rv` is reviews(); `keys` are those under review there, in gate order. `uncounted` is how many of them
  // rv.bySection leaves out: it counts the states a section shows and the headings of their screens, nothing else.
  function offPageKeys(book, mockups, fullId, rv) {
    var shown = {};
    var shownScreens = {};
    eachSection(book, function (ch, s, id) {
      if (id !== fullId) { return; }
      (s.shows || []).forEach(function (sh) {
        if (sh && typeof sh.state === 'string') { shown[sh.state] = true; shownScreens[sh.state.split('.')[0]] = true; }
      });
    });
    var byKey = (rv && rv.byKey) || {};
    var keys = gateKeys(book, mockups, fullId).filter(function (k) { return !has(shown, k) && has(byKey, k); });
    var uncounted = keys.filter(function (k) { return k.indexOf('.') >= 0 || !has(shownScreens, k); }).length;
    return { keys: keys, uncounted: uncounted };
  }

  // Screen and component ids in book order of first appearance (what each section shows, then what those pictures
  // place, then what its requirements name), then any the book never reaches, in catalog order.
  function screenOrder(book, mockups) {
    var ix = screenIndex(book);
    var out = [];
    var add = function (id) { if (has(ix.screens, id)) { pushOnce(out, id); } };
    eachSection(book, function (ch, s, fullId) {
      gateKeys(book, mockups, fullId).forEach(function (k) { add(k.split('.')[0]); });
      (s.requirements || []).forEach(function (r) {
        (r && Array.isArray(r.screens) ? r.screens : []).forEach(function (e) { if (e && typeof e.screen === 'string') { add(e.screen); } });
      });
    });
    screensOf(book).forEach(function (sc) { if (sc && sc.id) { add(sc.id); } });
    return out;
  }

  // A screen's states laid out by role: "anyone" first, then the book's roles in order, then roles the book does not
  // define, then states with no role; each group keeps the states' own order.
  function byRole(book, states) {
    var roles = ((book && book.roles) || []).map(function (r) { return r.id; });
    var rank = function (st) {
      var r = st && st.when && st.when.role;
      // A list of roles (an absent or sameAs state) sorts by its first.
      if (Array.isArray(r)) { r = r[0]; }
      if (!r) { return roles.length + 1; }
      if (r === 'anyone') { return -1; }
      return roles.indexOf(r) < 0 ? roles.length : roles.indexOf(r);
    };
    return (states || []).map(function (st, i) { return { st: st, i: i }; })
      .sort(function (a, b) { return rank(a.st) - rank(b.st) || a.i - b.i; })
      .map(function (x) { return x.st; });
  }

  // ---- State variables ---------------------------------------------------------------------------------------------
  // A screen lists the variables it uses (`variables`: ids of the book's variables, "role", or inline declarations
  // { id, label, values }). A state's `when` sets some of them; one left out is any value. A variable's first value is
  // its default; role has none, and its values are the book's roles ("anyone" is also allowed in a `when`). A screen
  // that lists no variables uses only role; a component that lists none has none.
  function rolesOf(book) { return ((book && book.roles) || []).filter(function (r) { return r && r.id; }); }

  function variableIds(screen) {
    if (Array.isArray(screen.variables)) { return screen.variables; }
    return screen.kind === 'component' ? [] : ['role'];
  }

  // A screen's list entry resolved to { id, label, values, isRole }, or null when it is not declared.
  function resolveVariable(book, entry) {
    if (entry === 'role') {
      return { id: 'role', label: 'Role', values: rolesOf(book).map(function (r) { return { id: r.id, label: r.label || r.id }; }), isRole: true };
    }
    var v = null;
    if (typeof entry === 'string') {
      ((book && book.variables) || []).forEach(function (d) { if (!v && d && d.id === entry) { v = d; } });
    } else if (entry && typeof entry === 'object') {
      v = entry;
    }
    if (!v || typeof v.id !== 'string' || !Array.isArray(v.values)) { return null; }
    return { id: v.id, label: v.label || v.id, values: v.values, isRole: false };
  }

  function variablesIn(book, screen) {
    var out = [];
    variableIds(screen).forEach(function (e) {
      var v = resolveVariable(book, e);
      if (v) { out.push(v); }
    });
    return out;
  }

  function variablesOf(book, screenId) {
    var screen = screenIndex(book).screens[screenId];
    return screen ? variablesIn(book, screen) : [];
  }

  function valueLabel(v, id) {
    for (var i = 0; i < v.values.length; i++) {
      if (v.values[i] && v.values[i].id === id) { return v.values[i].label || id; }
    }
    return String(id);
  }

  function rolesIn(when) {
    var r = when && when.role;
    if (Array.isArray(r)) { return r.slice(); }
    return typeof r === 'string' && r ? [r] : [];
  }

  // A state's caption: the role ids for its pills (none on a component, or when the state is for any role), and the
  // labels of the values that are not defaults, in the screen's variable order, joined by ", ". A component shows every
  // value's label, defaults included. A typed `name` overrides the text.
  function stateCaption(book, key) {
    var hit = screenIndex(book).states[key];
    if (!hit) { return { roles: [], text: '' }; }
    var when = hit.state.when || {};
    var component = hit.screen.kind === 'component';
    var labels = [];
    variablesIn(book, hit.screen).forEach(function (v) {
      if (v.isRole || !has(when, v.id) || when[v.id] === undefined) { return; }
      var isDefault = v.values.length > 0 && v.values[0] && v.values[0].id === when[v.id];
      if (component || !isDefault) { labels.push(valueLabel(v, when[v.id])); }
    });
    var name = hit.state.name;
    return {
      roles: component ? [] : rolesIn(when),
      text: typeof name === 'string' && name ? name : labels.join(', ')
    };
  }

  // Every combination a screen accounts for: each state (drawn, same as another, or absent), then each `undrawn` entry
  // (a combination its requirements imply that has no picture), in that order.
  function coverage(book, screenId) {
    var screen = screenIndex(book).screens[screenId];
    if (!screen) { return []; }
    var out = [];
    (screen.states || []).forEach(function (st) {
      if (!st || typeof st !== 'object') { return; }
      out.push({ when: st.when || {}, kind: st.sameAs ? 'same' : st.absent ? 'absent' : 'drawn', key: stateKey(screen.id, st.id) });
    });
    (Array.isArray(screen.undrawn) ? screen.undrawn : []).forEach(function (u) {
      if (!u || typeof u !== 'object') { return; }
      var row = { when: u.when || {}, kind: 'undrawn', about: Array.isArray(u.about) ? u.about : [] };
      if (u.note !== undefined) { row.note = u.note; }
      out.push(row);
    });
    return out;
  }

  // What is wrong with one `when` on a screen, in words after `who` ("State X.y"), or null. Roles are always checked; the
  // rest only on a screen that lists its variables (one that does not may still hold free words in `when`). `vars` is
  // the screen's resolved variables, or null when it lists none.
  function whenProblem(book, screen, vars, who, when, mayList) {
    var w = when || {};
    var roles = rolesOf(book).map(function (r) { return r.id; });
    if (Array.isArray(w.role) && !mayList) {
      return who + ' lists several roles, which only an absent or sameAs state may';
    }
    var rs = rolesIn(w);
    for (var r = 0; r < rs.length; r++) {
      // "anyone" covers every role, whether or not the book lists it.
      if (rs[r] !== 'anyone' && roles.indexOf(rs[r]) < 0) {
        return who + ' names the role ' + rs[r] + ', which the book does not define';
      }
    }
    if (!vars) { return null; }
    var keys = Object.keys(w);
    for (var k = 0; k < keys.length; k++) {
      var v = null;
      vars.forEach(function (x) { if (x.id === keys[k]) { v = x; } });
      if (!v) { return who + ' sets ' + keys[k] + ', which ' + screen.id + ' does not list in its variables'; }
      var known = v.values.some(function (x) { return x && x.id === w[keys[k]]; });
      if (!v.isRole && !known) {
        return who + ' sets ' + keys[k] + ' to ' + w[keys[k]] + ', which is not a value of ' + keys[k];
      }
    }
    return null;
  }

  // The first way a screen's variables, its states' `when`s and its `undrawn` entries are invalid, or null.
  function variableProblem(book, screen, reqIds) {
    var vars = null;
    if (Array.isArray(screen.variables)) {
      vars = [];
      for (var i = 0; i < screen.variables.length; i++) {
        var e = screen.variables[i];
        var v = resolveVariable(book, e);
        if (!v) {
          var id = e && typeof e === 'object' ? e.id : e;
          return 'Screen ' + screen.id + ' uses the variable ' + id + ', which is not declared';
        }
        vars.push(v);
      }
    }
    var states = screen.states || [];
    var drawn = [];
    for (var j = 0; j < states.length; j++) {
      var st = states[j];
      var key = stateKey(screen.id, st.id);
      var p = whenProblem(book, screen, vars, 'State ' + key, st.when, !!(st.absent || st.sameAs));
      if (p) { return p; }
      if (vars && st.mockup) {
        for (var d = 0; d < drawn.length; d++) {
          if (sameValue(drawn[d].when || {}, st.when || {})) {
            return 'States ' + stateKey(screen.id, drawn[d].id) + ' and ' + key + ' have the same when';
          }
        }
        drawn.push(st);
      }
    }
    var undrawn = Array.isArray(screen.undrawn) ? screen.undrawn : [];
    for (var u = 0; u < undrawn.length; u++) {
      var who = 'Screen ' + screen.id + '\'s undrawn entry ' + (u + 1);
      var entry = undrawn[u];
      if (!entry || typeof entry !== 'object') { return who + ' is not an object'; }
      var up = whenProblem(book, screen, vars, who, entry.when, false);
      if (up) { return up; }
      var about = Array.isArray(entry.about) ? entry.about : [];
      for (var a = 0; a < about.length; a++) {
        if (!has(reqIds, about[a])) { return who + ' names ' + about[a] + ', which is not a requirement'; }
      }
    }
    return null;
  }

  // The first way the screens in a book are invalid, in words; null when valid (the spec's "Validity" list).
  // `exists(path)` says whether a mockup file is there; `mockups` holds the text of those that are.
  function screenProblem(book, exists, mockups) {
    var screens = screensOf(book);
    var ix = screenIndex(book);
    var ids = {};
    var names = {};
    var reqIds = {};
    eachSection(book, function (ch, sec) {
      (sec.requirements || []).forEach(function (r) { if (r && typeof r === 'object' && r.id) { reqIds[r.id] = true; } });
    });
    for (var g = 0; g < screens.length; g++) {
      var sg = screens[g];
      if (!sg || typeof sg !== 'object' || !sg.id) { return 'Screen entry ' + (g + 1) + ' is not an object with an id'; }
      var sts = sg.states || [];
      for (var h = 0; h < sts.length; h++) {
        if (!sts[h] || typeof sts[h] !== 'object' || !sts[h].id) {
          return 'State ' + (h + 1) + ' of screen ' + sg.id + ' is not an object with an id';
        }
      }
    }
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
        if (st.change !== undefined && ['add', 'change', 'remove'].indexOf(st.change) < 0) {
          return 'State ' + key + ' has the change ' + st.change + ', which is not add, change or remove';
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
      var vp = variableProblem(book, s, reqIds);
      if (vp) { return vp; }
    }
    // A picture's component tags, and theirs in turn, walked as expandMockup draws them: each names a component state
    // that draws a picture, and none leads back to a state already on the way (`path`, the drawn keys so far).
    // `clean` holds drawn keys whose pictures were walked without a problem.
    var clean = {};
    var tagProblem = function (file, path) {
      var tags = componentsIn(mockups && mockups[file]);
      for (var t = 0; t < tags.length; t++) {
        var tk = stateKey(tags[t].id, tags[t].state);
        var comp = has(ix.screens, tags[t].id) ? ix.screens[tags[t].id] : null;
        if (!comp || comp.kind !== 'component') {
          return 'The picture ' + file + ' places ' + tags[t].id + ', which is not a component in the book';
        }
        if (!has(ix.states, tk)) { return 'The picture ' + file + ' places ' + tk + ', which is not a state'; }
        var d = drawnIn(ix, tk);
        if (!d || !d.state.mockup) { return 'The picture ' + file + ' places ' + tk + ', which draws no picture'; }
        var dk = stateKey(d.screen.id, d.state.id);
        if (path.indexOf(dk) >= 0) {
          return 'The picture ' + file + ' places ' + tk + ', a component cycle: ' + path.slice(path.indexOf(dk)).concat(dk).join(' \u2192 ');
        }
        if (!has(clean, dk)) {
          var inner = tagProblem(d.state.mockup, path.concat(dk));
          if (inner) { return inner; }
          clean[dk] = true;
        }
      }
      return null;
    };
    for (var i2 = 0; i2 < screens.length; i2++) {
      var states2 = screens[i2].states || [];
      for (var j2 = 0; j2 < states2.length; j2++) {
        var own = stateKey(screens[i2].id, states2[j2].id);
        // A state's own picture is drawn as that state; today's picture is drawn on its own.
        var pm = states2[j2].mockup ? tagProblem(states2[j2].mockup, [own]) : null;
        var pt = pm || !states2[j2].today ? null : tagProblem(states2[j2].today, []);
        if (pm || pt) { return pm || pt; }
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
          var here = d ? placedFromState(ix, mockups, d.state) : [];
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
    variablesOf: variablesOf,
    stateCaption: stateCaption,
    coverage: coverage,
    offPageKeys: offPageKeys,
    screenOrder: screenOrder,
    byRole: byRole,
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
