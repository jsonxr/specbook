/* Spec book reader. Renders book.json from the project's specbook folder: chapters, sections, numbered
   requirements, every screen for every role, screenshots and recordings, and a note mode that sends change
   requests back to the project folder for Claude. Notes are kept on the server, with the book. */
(function () {
  'use strict';

  // review: review.json as the server sent it; reviews: SpecModel.reviews of it, computed on each render; notes: only the
  // draft notes (the page's own shape, see Notes); history: the history entries loaded so far, by key.
  var state = { book: null, media: [], evidence: {}, notes: {}, notesRev: 0, claude: { state: 'idle' }, view: 'mockup', noteKey: '', mockups: {},
    review: null, reviews: null, items: {}, history: { items: {} }, historyCounts: {}, changelog: [], diff: false };
  var main = document.getElementById('main');
  if ('scrollRestoration' in history) { history.scrollRestoration = 'manual'; }
  window.addEventListener('hashchange', function () {
    var t = document.getElementById(location.hash.slice(1));
    if (t) { t.scrollIntoView({ behavior: 'instant', block: 'start' }); }
  });

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html !== undefined) { e.innerHTML = html; }
    return e;
  }
  // Safe in text and in quoted attributes alike.
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // A key in a CSS attribute selector.
  function attrSel(k) { return String(k).replace(/["\\]/g, '\\$&'); }
  function plain(html) { var d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.trim(); }
  // Keys keep the old "spec-book-" prefix on purpose: renaming them would lose the notes people have drafted.
  function store(k, v) {
    try {
      if (v === undefined) { return localStorage.getItem(k); }
      if (v === null) { localStorage.removeItem(k); } else { localStorage.setItem(k, v); }
    } catch (e) { return null; }
    return null;
  }

  function findMedia(prefix, exts) {
    return state.media.filter(function (m) {
      if (m.indexOf(prefix) !== 0) { return false; }
      var ext = m.slice(m.lastIndexOf('.') + 1).toLowerCase();
      return exts.indexOf(ext) >= 0;
    });
  }
  function screenshotFor(frame, section) {
    if (frame.screenshot) { return frame.screenshot; }
    var hits = findMedia('media/screens/' + frame.id + '.', ['png', 'jpg', 'jpeg', 'webp']);
    if (hits[0]) { return hits[0]; }
    return section ? sectionEvidenceShot(section) : null;
  }
  function videosFor(fullId, section) {
    var list = (section.videos || []).slice();
    findMedia('media/videos/' + fullId, ['mp4', 'mov', 'webm']).forEach(function (p) {
      if (!list.some(function (v) { return v.path === p; })) {
        list.push({ path: p, caption: p.slice(p.lastIndexOf('/') + 1) });
      }
    });
    return list;
  }

  function roleInfo(id) {
    var roles = state.book.roles || [];
    for (var i = 0; i < roles.length; i++) { if (roles[i].id === id) { return roles[i]; } }
    return { id: id, label: id, color: '#c9ccd2' };
  }

  var STAGE_TEXT = { drafting: 'Drafting', ready: 'Ready', building: 'Building', built: 'Built' };
  function pill(cls, text) {
    return '<span class="pill ' + esc(cls) + '">' + esc(text) + '</span>';
  }

  // A tag for a decision: who made it, or what it records.
  function decisionTag(d) {
    if (d.kind === 'removed' || d.kind === 'rejected') { return '<span class="tag ' + d.kind + '">' + d.kind + '</span>'; }
    if (d.by === 'build') { return '<span class="tag by-build">by build</span>'; }
    return '';
  }
  function decisionHtml(d, did) {
    return '<h4>' + esc(d.title) + ' ' + decisionTag(d) + (did ? ' <span class="sid">' + esc(did) + '</span>' : '') + '</h4><p>' + (d.body || '') + '</p>';
  }
  // The decisions whose about names the section (by its full id), or any of its requirements or frames.
  function sectionDecisions(s, fullId) {
    var ids = [fullId];
    (s.requirements || []).forEach(function (r) { if (r && r.id) { ids.push(r.id); } });
    (s.frames || []).forEach(function (f) { if (f && f.id) { ids.push(f.id); } });
    return (state.book.decisions || []).filter(function (d) {
      return (d.about || []).some(function (a) { return ids.indexOf(a) !== -1; });
    });
  }

  // Ready is gated on review: the server refuses it (409 unreviewed) while the section, any of its requirements or any
  // of its frames is under review. The reason shows under the section's heading, next to the button.
  var READY_GATE = 'Accept this section\'s changes before marking it ready.';
  function stageMessage(btn, text) {
    var h = btn.closest('h3');
    if (!h) { msgEl.textContent = text; return; }
    var next = h.nextElementSibling;
    var p = next && next.classList.contains('stage-msg') ? next : null;
    if (!p) {
      // A live region is announced only when its text changes after it is in the page: in empty first, then the text.
      p = el('p', { class: 'stage-msg', role: 'status' });
      h.parentNode.insertBefore(p, h.nextSibling);
    }
    p.textContent = '';
    setTimeout(function () { p.textContent = text; }, 50);
  }
  // While Claude is idle, a drafting section can be marked ready and a ready one sent back to drafting.
  function stageButton(fullId, stage) {
    var to = stage === 'drafting' ? 'ready' : stage === 'ready' ? 'drafting' : null;
    if (!to) { return null; }
    var btn = el('button', { type: 'button', class: 'stage-btn' });
    btn.textContent = to === 'ready' ? 'Mark ready' : 'Back to drafting';
    btn.hidden = state.claude.state !== 'idle';
    btn.addEventListener('click', function () {
      if (btn.disabled) { return; }
      btn.disabled = true;
      postJson('/api/stage', { section: fullId, stage: to })
        .then(function (res) {
          if (!res.ok) {
            if (res.j.error === 'unreviewed') {
              stageMessage(btn, READY_GATE);
            } else {
              msgEl.textContent = res.j.error === 'locked' ? 'Claude is busy; the book is locked until it is done.' :
                res.j.error === 'nothing-to-build' ? 'Nothing to build: no requirement in this section has a change.' : 'Could not change the stage: ' + (res.j.error || 'failed') + '.';
            }
            btn.disabled = false;
            pollClaude();
            return;
          }
          var s = findSection(fullId);
          if (s) { s.stage = res.j.stage; }
          var y = window.scrollY;
          render();
          window.scrollTo(0, y);
          showClaude();
        })
        .catch(function () { btn.disabled = false; msgEl.textContent = 'Server unreachable: the stage was not changed.'; });
    });
    return btn;
  }
  // Reviews -------------------------------------------------------------------------------------------
  // Every item with an open review (SpecModel.reviews) gets a review stack under it, shown only in Changes mode:
  // the accepted version (or "New"), each try with the notes that led to it (older ones folded behind "▸ n earlier"),
  // the current version (or "Removed") with its open notes, a reversal warning, then ✓ Accept.
  // The stack sits in the item's row (.item-row), beside its .item-tools, outside the item itself,
  // so it never moves the item's pins.
  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function reviewOf(key) { return state.reviews && hasOwn(state.reviews.byKey, key) ? state.reviews.byKey[key] : null; }
  function computeReviews() {
    state.reviews = window.SpecModel.reviews(state.book, state.mockups, state.review, state.history);
    return state.reviews;
  }
  function shortDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  var MARKER = { add: 'Add', change: 'Change', remove: 'Remove' };
  // One field of a version: the earlier wording struck through and the new one highlighted when they differ.
  function diffField(was, now, wrap) {
    var w = wrap || function (s) { return s; };
    var hadWas = was !== undefined && was !== null && was !== '';
    var hasNow = now !== undefined && now !== null && now !== '';
    if (was === undefined || was === now || (!hadWas && !hasNow)) { return hasNow ? w(now) : ''; }
    return (hadWas ? '<del class="was">' + w(was) + '</del>' : '') + (hadWas && hasNow ? ' ' : '') + (hasNow ? '<ins class="now">' + w(now) + '</ins>' : '');
  }
  // A version of an item, compared with the one before it (prev; null for the first version shown).
  function versionHtml(kind, v, prev) {
    var p = prev || {};
    var cmp = function (k) { return prev ? p[k] : undefined; };
    var line = function (cls, label, html) { return html ? '<p class="' + cls + '">' + (label ? '<span>' + label + '</span> ' : '') + html + '</p>' : ''; };
    if (kind === 'req') {
      var tag = function (m) { return m ? '<span class="tag chg-tag">' + esc(MARKER[m] || m) + '</span>' : ''; };
      return line('rv-text', '', diffField(cmp('text'), v.text)) +
        line('rv-field', 'Marker:', prev && p.change !== v.change ? diffField(p.change || '', v.change || '', tag) : tag(v.change)) +
        line('rv-field', 'Today:', diffField(cmp('today'), v.today)) +
        line('rv-field', 'Why:', diffField(cmp('reason'), v.reason));
    }
    if (kind === 'frame') {
      var role = function (r) { return esc(roleInfo(r).label); };
      return line('rv-text', '', diffField(cmp('caption'), v.caption, esc)) +
        line('rv-field', 'Role:', diffField(cmp('role'), v.role, role)) +
        (prev && p.mockup !== v.mockup ? '<p class="rv-field rv-mock">Mockup changed</p>' : '');
    }
    return line('rv-text', '', diffField(cmp('title'), v.title, esc)) + line('rv-field', 'Intro:', diffField(cmp('intro'), v.intro));
  }
  // What the reader sees of an item a note was dropped on, for a note shown under another item it caused.
  // (From the items, not the page: the stack is drawn before the rest of the book is.)
  function itemLabel(key) {
    var it = hasOwn(state.items, key) ? state.items[key] : null;
    if (!it) { return key; }
    if (it.kind === 'chapter') { return 'chapter “' + it.value.title + '”'; }
    if (it.kind === 'section') { return 'section “' + it.value.title + '”'; }
    if (it.kind === 'frame') { return 'screen “' + (it.value.caption || key) + '”'; }
    return key;
  }
  var NOTE_STATUS = { draft: 'Draft', sent: 'Sent', answered: 'Answered', frozen: 'Kept' };
  // plain: no status tag (a note in history is read-only and settled).
  function noteHtml(n, key, plain) {
    var html = (plain ? '' : '<span class="tag rv-ns ' + esc(n.status || 'draft') + '">' + esc(NOTE_STATUS[n.status] || n.status || 'Draft') + '</span> ') + esc(n.text);
    if (n.item && n.item !== key) { html += ' <span class="rv-from">from a note on ' + esc(itemLabel(n.item)) + '</span>'; }
    if (n.reply) { html += '<span class="rv-reply"><span>Claude:</span> ' + esc(n.reply) + '</span>'; }
    return '<li class="rv-note">' + html + '</li>';
  }
  // A draft is shown by its sticky on the page; the stack shows a note once it is sent.
  function sentOnly(list) { return (list || []).filter(function (n) { return n.status && n.status !== 'draft'; }); }
  function notesHtml(list, key, plain) {
    return list && list.length ? '<ul class="rv-notes">' + list.map(function (n) { return noteHtml(n, key, plain); }).join('') + '</ul>' : '';
  }
  function decisionRef(id) {
    var d = ((state.book && state.book.decisions) || []).filter(function (x) { return x && x.id === id; })[0];
    return '<li><a href="#' + esc(id) + '">' + esc(id) + '</a>' + (d && d.title ? ' ' + esc(d.title) : '') + '</li>';
  }
  function reviewBusy() { return state.claude.state !== 'idle' || reviewPending; }
  var reviewPending = false;
  var ownReviewAt = 0;
  // What survives a redraw of the stacks, by item key: an opened "▸ n earlier", and an open Change composer's text.
  var openEarlier = {};
  var openEditors = {};
  // What a stack shows of its notes; a save that changes it (a draft added, edited or deleted) redraws the stack.
  function notesSig(r) {
    return (r.notes || []).map(function (n) { return n.id + ':' + n.status + ':' + (n.text || ''); }).join('|');
  }
  function reviewButton(cls, text, title) {
    var b = el('button', { type: 'button', class: 'rv-btn ' + cls, title: title }, text);
    b.disabled = reviewBusy();
    var p = el('p', { class: 'rv-act' });
    p.appendChild(b);
    return { p: p, b: b };
  }
  // Accept, then the book is fetched again and drawn where the reader is.
  // Pending note edits are saved first (as Revise does).
  function sendReview(path, body, failText) {
    if (reviewBusy()) { return Promise.resolve(false); }
    reviewPending = true;
    showReviewButtons();
    return flushNotes().then(function () { return postJson(path, body); })
      .then(function (res) {
        reviewPending = false;
        if (!res.ok) {
          var e = res.j && res.j.error;
          msgEl.textContent = e === 'locked' ? 'Claude is busy; the book is locked until it is done.' :
            e === 'note-required' ? 'Say what to change before saving.' :
            e === 'not-under-review' ? 'That item is no longer under review.' : failText + ': ' + (e || 'failed') + '.';
          showReviewButtons();
          if (e === 'locked') { pollClaude(); }
          if (e === 'not-under-review') { refetchBook(); }
          return false;
        }
        // The reader's own Accept moved review.json on: a save based on the old revision is not news.
        ownReviewAt = Date.now();
        return flushNotes().then(function () { return refetchBook(); }).then(function () { return true; });
      })
      .catch(function () { reviewPending = false; showReviewButtons(); msgEl.textContent = 'Server unreachable: ' + failText.toLowerCase() + '.'; return false; });
  }
  function showReviewButtons() {
    var busy = reviewBusy();
    document.querySelectorAll('.rv-btn').forEach(function (b) {
      b.disabled = busy || (b.classList.contains('rv-save') && !b.closest('.rv-compose').querySelector('textarea').value.trim());
    });
  }
  // ✓ Accept for an item under review; nothing while it has a note not yet sent. A
  // requirement shows them in its own bullet; other items at the top of their review stack.
  function reviewActions(key) {
    var r = reviewOf(key);
    if (!r) { return null; }
    // A note not yet sent is the reader's answer to this version: they edit or delete it, or send it with Revise.
    // Until then the version is neither accepted nor changed.
    var drafted = (r.notes || []).some(function (n) { return n.status === 'draft'; }) ||
      Object.keys(state.notes).some(function (id) { return state.notes[id] && state.notes[id].item === key; });
    if (drafted) {
      return null;
    }
    // To ask for something else instead, the reader drops a note on it (Comment mode), as anywhere in the book.
    var accept = reviewButton('rv-accept', '✓ Accept', 'Accept this version: the review closes and goes into the item’s history');
    accept.p.classList.add('rv-acts');
    accept.p.setAttribute('data-key', key);
    accept.b.addEventListener('click', function () {
      sendReview('/api/accept', { key: key }, 'Could not accept');
    });
    return accept.p;
  }
  // The review stack under an item: the item itself shows the current version, so the stack holds what came
  // before it, newest first: the tries (all but the newest folded away), then the accepted version (or New).
  var KIND_WORD = { req: 'requirement', frame: 'screen', section: 'section', chapter: 'chapter' };
  function reviewStack(key) {
    var r = reviewOf(key);
    if (!r) { return null; }
    var kind = r.kind;
    var box = el('div', { class: 'rv-stack rv-' + r.status, 'data-key': key, role: 'group', 'aria-label': 'Review of ' + key });
    box.setAttribute('data-sig', notesSig(r));
    var html = '';
    if (r.status === 'removed') {
      html += '<div class="rv-ver rv-current"><p class="rv-head"><span class="tag removed">Removed</span></p></div>';
    }
    // Sent notes on the current version (a note that caused this change from another item, say).
    var open = sentOnly(r.notes);
    if (open.length) { html += '<div class="rv-ver rv-current"><p class="rv-head">Notes</p>' + notesHtml(open, key) + '</div>'; }
    if (r.reversal) {
      html += '<div class="rv-reversal" role="note"><p>⚠ This brings back the wording replaced on ' + esc(r.reversal.date) + '.</p>' +
        (r.reversal.decisions.length ? '<ul>' + r.reversal.decisions.map(decisionRef).join('') + '</ul>' : '') + '</div>';
    }
    var tries = r.tries || [];
    // Each older version as it was; a frame also says when its mockup differs from the version after it.
    var newer = r.current;
    var oldHtml = function (v) {
      var mock = kind === 'frame' && v && newer && v.mockup !== newer.mockup ? '<p class="rv-field rv-mock">Mockup changed</p>' : '';
      newer = v || newer;
      return versionHtml(kind, v, null) + mock;
    };
    var tryHtml = function (t, i) {
      return '<div class="rv-ver rv-try"><p class="rv-head">Try ' + (i + 1) + ' · ' + esc(shortDate(t.frozenAt)) + '</p>' +
        (t.value ? oldHtml(t.value) : '<p class="rv-field"><em>Not in the book</em></p>') + notesHtml(t.notes, key) + '</div>';
    };
    if (tries.length) { html += tryHtml(tries[tries.length - 1], tries.length - 1); }
    if (tries.length > 1) {
      var older = tries.slice(0, -1).map(function (t, i) { return { t: t, i: i }; }).reverse();
      html += '<details class="rv-earlier"' + (openEarlier[key] ? ' open' : '') + '><summary>' + (openEarlier[key] ? '▾ ' : '▸ ') + (tries.length - 1) + ' earlier</summary>' +
        older.map(function (x) { return tryHtml(x.t, x.i); }).join('') + '</details>';
    }
    if (r.orphan) {
      html += '';
    } else if (r.accepted) {
      html += '<div class="rv-ver rv-accepted' + (r.status === 'removed' ? ' rv-struck' : '') + '"><p class="rv-head">Original</p>' + oldHtml(r.accepted) + '</div>';
    } else {
      html += '<div class="rv-ver rv-isnew"><p class="rv-head">Original</p><p class="rv-field"><em>This ' + (KIND_WORD[kind] || 'item') + ' is new.</em></p></div>';
    }
    box.innerHTML = html;
    var details = box.querySelector('.rv-earlier');
    if (details) {
      details.addEventListener('toggle', function () {
        if (details.open) { openEarlier[key] = true; } else { delete openEarlier[key]; }
        details.querySelector('summary').textContent = (details.open ? '▾ ' : '▸ ') + (tries.length - 1) + ' earlier';
      });
    }
    // A requirement carries its buttons in its own bullet (see addItem); anything else carries them here, on top.
    if (kind !== 'req' || !hasOwn(state.items, key)) {
      var acts = reviewActions(key);
      if (acts) { box.insertBefore(acts, box.firstChild); }
    }
    return box;
  }
  // An item's row: its tools (History, an open requirement editor) and its review stack. Empty rows take no room.
  function itemRow(tag, key) {
    var row = el(tag, { class: 'item-row', 'data-key': key });
    row.appendChild(itemTools(key));
    var stack = reviewStack(key);
    if (stack) { row.appendChild(stack); row.classList.add('has-rv-row'); }
    return row;
  }

  // History -------------------------------------------------------------------------------------------
  // "History (n) ▸" beside every item that has history, in any mode. Its entries load on the first expand
  // (GET /api/history/<key>) and show newest first: the date, the first note (or Built, or Edited) as the line, the
  // decisions, and "▸ details" for before/after, the tries and the notes. What is open stays open across redraws.
  var openHistory = {}; // key -> true while expanded
  var openDetails = {}; // '<key>#<entry index>' -> true while its details are open
  var historyCache = {}; // key -> { count, entries }
  function historyCount(key) { return hasOwn(state.historyCounts, key) ? state.historyCounts[key] : 0; }
  function kindOf(key) {
    if (hasOwn(state.items, key)) { return state.items[key].kind; }
    var w = state.review && state.review.where;
    if (w && hasOwn(w, key) && w[key] && w[key].kind) { return w[key].kind; }
    var r = reviewOf(key);
    return r ? r.kind : 'req';
  }
  function loadHistory(key) {
    var n = historyCount(key);
    var c = hasOwn(historyCache, key) ? historyCache[key] : null;
    if (c && c.count === n) { return Promise.resolve(c.entries); }
    var known = state.history && state.history.items;
    if (known && hasOwn(known, key) && known[key].length === n) {
      historyCache[key] = { count: n, entries: known[key] };
      return Promise.resolve(known[key]);
    }
    return fetch('/api/history/' + encodeURIComponent(key), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) { throw new Error('status ' + r.status); } return r.json(); })
      .then(function (j) {
        historyCache[key] = { count: n, entries: j.entries || [] };
        return historyCache[key].entries;
      });
  }
  function historyEntry(key, kind, e, idx) {
    var first = (e.notes || []).filter(function (n) { return n && n.text; })[0];
    var line = first ? esc(first.text) : e.kind === 'built' ? 'Built' : 'Edited';
    var detailKey = key + '#' + idx;
    var body = '<div class="rv-ver"><p class="rv-head">Before</p>' + (e.before ? versionHtml(kind, e.before, null) : '<p class="rv-field"><span class="tag new">New</span></p>') + '</div>';
    var prev = e.before;
    (e.tries || []).forEach(function (t, i) {
      body += '<div class="rv-ver rv-try"><p class="rv-head">Try ' + (i + 1) + ' · ' + esc(shortDate(t.frozenAt)) + '</p>' +
        (t.value ? versionHtml(kind, t.value, prev) : '') + notesHtml(t.notes, key, true) + '</div>';
      prev = t.value || prev;
    });
    body += '<div class="rv-ver"><p class="rv-head">After</p>' + (e.after ? versionHtml(kind, e.after, prev) : '<p class="rv-field"><span class="tag removed">Removed</span></p>') + '</div>';
    if (e.notes && e.notes.length) { body += '<div class="rv-ver"><p class="rv-head">Notes</p>' + notesHtml(e.notes, key, true) + '</div>'; }
    var li = el('li', { class: 'hi-entry' + (e.kind === 'built' ? ' built' : '') });
    li.innerHTML = '<p class="hi-line"><span class="hi-date">' + esc(shortDate(e.acceptedAt)) + '</span> ' + line + '</p>' +
      ((e.decisions || []).length ? '<ul class="hi-decs">' + e.decisions.map(decisionRef).join('') + '</ul>' : '') +
      '<details class="hi-details"' + (openDetails[detailKey] ? ' open' : '') + '><summary>' + (openDetails[detailKey] ? '▾' : '▸') + ' details</summary>' + body + '</details>';
    var d = li.querySelector('.hi-details');
    d.addEventListener('toggle', function () {
      if (d.open) { openDetails[detailKey] = true; } else { delete openDetails[detailKey]; }
      d.querySelector('summary').textContent = (d.open ? '▾' : '▸') + ' details';
    });
    return li;
  }
  // Built at once when the entries are cached (so an open history keeps its height across a redraw and the reading
  // place holds); otherwise loaded.
  function historyBox(key) {
    var box = el('div', { class: 'history', 'data-key': key });
    var fill = function (entries) {
      box.innerHTML = '';
      var ol = el('ol', { class: 'hi-list' });
      var kind = kindOf(key);
      for (var i = entries.length - 1; i >= 0; i--) { ol.appendChild(historyEntry(key, kind, entries[i] || {}, i)); }
      if (!entries.length) { ol.appendChild(el('li', { class: 'hi-entry' }, 'No history yet.')); }
      box.appendChild(ol);
    };
    var c = hasOwn(historyCache, key) ? historyCache[key] : null;
    if (c && c.count === historyCount(key)) { fill(c.entries); return box; }
    box.appendChild(el('p', { class: 'hi-wait' }, 'Loading…'));
    loadHistory(key).then(fill).catch(function () {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'hi-wait' }, 'Could not load the history.'));
    });
    return box;
  }
  function itemTools(key) {
    var tools = el('div', { class: 'item-tools', 'data-key': key });
    var n = historyCount(key);
    if (n > 0) {
      var btn = el('button', { type: 'button', class: 'linkbtn hi-toggle', 'aria-expanded': String(!!openHistory[key]) });
      var label = function () { btn.textContent = 'History (' + n + ') ' + (openHistory[key] ? '▾' : '▸'); };
      label();
      tools.appendChild(btn);
      var box = openHistory[key] ? historyBox(key) : null;
      if (box) { tools.appendChild(box); }
      btn.addEventListener('click', function () {
        if (openHistory[key]) {
          delete openHistory[key];
          if (box) { box.remove(); box = null; }
        } else {
          openHistory[key] = true;
          box = historyBox(key);
          btn.parentNode.insertBefore(box, btn.nextSibling);
        }
        btn.setAttribute('aria-expanded', String(!!openHistory[key]));
        label();
      });
    }
    var form = hasOwn(openForms, 'edit:' + key) ? reqForm('edit:' + key) : null;
    if (form) { tools.appendChild(form); }
    return tools;
  }

  // Editing requirements ----------------------------------------------------------------------------
  // While Claude is idle, in any mode: ＋ Add requirement at the end of each section's list, and Edit and Remove on
  // each requirement. Each opens an inline editor (an .inline-editor, so the book is never drawn again under it, and
  // its fields survive a redraw through openForms). The server mints ids and writes book.json; every edit opens a
  // review like any other change. Field values are set with .value, never written into HTML.
  var openForms = {}; // 'add:<section>' | 'edit:<id>' -> { mode, id, section, text, change, today, reason, note, touched }
  var MARKERS = [['', 'No change (as built)'], ['add', 'Add (not built yet)'], ['change', 'Change (built differently today)'], ['remove', 'Remove']];
  var EDIT_ERRORS = {
    'bad-change': 'Pick a marker: none, add, change or remove.',
    'bad-requirement': 'Write the requirement first.',
    accepted: 'This requirement has been accepted: mark it for removal instead of deleting it.',
    locked: 'Claude is busy; the book is locked until it is done.',
    'not-found': 'That requirement or section is no longer in the book.'
  };
  function findReq(id) {
    var found = null;
    ((state.book && state.book.chapters) || []).forEach(function (ch) {
      (ch.sections || []).forEach(function (s) {
        (s.requirements || []).forEach(function (r) { if (r && typeof r === 'object' && r.id === id) { found = r; } });
      });
    });
    return found;
  }
  function isAccepted(id) { return hasOwn(state.review && state.review.accepted, id); }
  function sendJson(method, path, body) {
    var o = { method: method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) { o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function openForm(formKey, init) {
    if (!hasOwn(openForms, formKey)) { openForms[formKey] = init; }
  }
  // The editor for openForms[formKey]. Modes: add (a new requirement in a section), edit (text and marker), remove
  // (a reason, for an accepted requirement; a never-accepted one is deleted outright).
  function reqForm(formKey) {
    var f = openForms[formKey];
    var orig = f.mode === 'add' ? null : findReq(f.id);
    if (f.mode !== 'add' && !orig) { delete openForms[formKey]; return null; }
    var del = f.mode === 'remove' && !isAccepted(f.id);
    var box = el('div', { class: 'req-form inline-editor', 'data-key': formKey, role: 'group' });
    box.setAttribute('aria-label', f.mode === 'add' ? 'New requirement' : (f.mode === 'remove' ? 'Remove ' : 'Edit ') + f.id);
    var field = function (name, label, multi) {
      var wrap = el('label', { class: 'rf-field rf-' + name });
      wrap.appendChild(el('span', {}, esc(label)));
      var input = el(multi ? 'textarea' : 'input', multi ? { name: name, rows: '2' } : { name: name, type: 'text' });
      input.value = f[name] || '';
      wrap.appendChild(input);
      box.appendChild(wrap);
      return { wrap: wrap, input: input };
    };
    var text = null;
    var marker = null;
    var today = null;
    var reason = null;
    if (f.mode === 'remove') {
      box.appendChild(el('p', { class: 'rf-what' }, del ? 'This requirement was never accepted: removing it deletes it from the book.' : 'Removing marks it to be taken out of the app (change: remove), with the reason.'));
      if (!del) { reason = field('reason', 'Why:', true); }
    } else {
      text = field('text', f.mode === 'add' ? 'New requirement:' : 'Text:', true);
      var mwrap = el('label', { class: 'rf-field rf-change' });
      mwrap.appendChild(el('span', {}, 'Marker:'));
      marker = el('select', { name: 'change' });
      MARKERS.forEach(function (m) {
        var o = el('option', { value: m[0] });
        o.textContent = m[1];
        marker.appendChild(o);
      });
      marker.value = f.change || '';
      mwrap.appendChild(marker);
      box.appendChild(mwrap);
      today = field('today', 'Today:', true);
      reason = field('reason', 'Why:', true);
    }
    var note = del ? null : field('note', 'Note (optional):', false);
    var msg = el('p', { class: 'rf-msg', role: 'status' });
    box.appendChild(msg);
    // A message (an error from the last save) is kept with the editor's fields, so a redraw does not lose it.
    if (f.msg) { setTimeout(function () { msg.textContent = f.msg; }, 0); }
    if (f.saving) { box.dataset.saving = '1'; }
    var btns = el('p', { class: 'rf-btns' });
    var save = el('button', { type: 'button', class: 'rv-btn rf-save' }, f.mode === 'remove' ? (del ? 'Delete' : 'Remove') : 'Save');
    var cancel = el('button', { type: 'button', class: 'rv-cancel rf-cancel' }, 'Cancel');
    btns.appendChild(save);
    btns.appendChild(cancel);
    box.appendChild(btns);
    var shown = function () {
      if (marker) {
        today.wrap.hidden = marker.value !== 'change';
        reason.wrap.hidden = marker.value !== 'remove';
      }
      save.disabled = reviewBusy() || !!f.saving;
    };
    var keep = function () {
      f.dirty = true;
      if (text) { f.text = text.input.value; }
      if (marker) { f.change = marker.value; }
      if (today) { f.today = today.input.value; }
      if (reason) { f.reason = reason.input.value; }
      if (note) { f.note = note.input.value; }
    };
    if (text) {
      text.input.addEventListener('input', function () {
        grow(text.input);
        // The book's rule: new wording on a requirement with no marker is a change to what is built, so the old text
        // is what happens today. The reader can clear it (a correction the app already meets).
        if (f.mode === 'edit' && orig && !orig.change && !f.touched) {
          var differs = text.input.value.trim() !== String(orig.text || '').trim();
          marker.value = differs ? 'change' : '';
          today.input.value = differs ? String(orig.text || '') : '';
          shown();
        }
        keep();
      });
    }
    if (marker) { marker.addEventListener('change', function () { f.touched = true; keep(); shown(); }); }
    [today, reason, note].forEach(function (x) { if (x) { x.input.addEventListener('input', function () { if (x.input.tagName === 'TEXTAREA') { grow(x.input); } keep(); }); } });
    cancel.addEventListener('click', function () {
      delete openForms[formKey];
      box.remove();
      focusOpener(f);
      resumeRefetch();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.click(); }
    });
    save.addEventListener('click', function () {
      if (save.disabled) { return; }
      keep();
      var body = null;
      var method = 'PUT';
      var path = '/api/requirements/' + encodeURIComponent(f.id || '');
      if (del) {
        method = 'DELETE';
      } else if (f.mode === 'remove') {
        if (!(f.reason || '').trim()) { setFormMsg(formKey, 'Say why it is removed.'); return; }
        body = { text: orig.text, change: 'remove', reason: f.reason.trim(), note: f.note || '' };
      } else {
        if (!(f.text || '').trim()) { setFormMsg(formKey, EDIT_ERRORS['bad-requirement']); return; }
        body = { text: f.text.trim(), change: f.change || '', note: f.note || '' };
        if (f.change === 'change') { body.today = (f.today || '').trim(); }
        if (f.change === 'remove') {
          if (!(f.reason || '').trim()) { setFormMsg(formKey, 'Say why it is removed.'); return; }
          body.reason = f.reason.trim();
        }
        if (f.mode === 'add') {
          method = 'POST';
          path = '/api/requirements';
          body.section = f.section;
        }
      }
      // While the request is out the editor stays (a redraw rebuilds it, still saving); on success it closes at once
      // and the cursor goes back to the button that opened it; on failure the message shows in the live editor.
      f.saving = true;
      box.dataset.saving = '1';
      setFormMsg(formKey, '');
      var act = document.activeElement;
      if (act && box.contains(act)) { act.blur(); }
      var fail = function (text) {
        f.saving = false;
        if (hasOwn(openForms, formKey)) { setFormMsg(formKey, text); }
      };
      flushNotes().then(function () { return sendJson(method, path, body === null ? undefined : body); })
        .then(function (res) {
          if (!res.ok) {
            var e = res.j && res.j.error;
            fail(EDIT_ERRORS[e] || 'Could not save: ' + (e || 'failed') + '.');
            if (e === 'locked') { pollClaude(); }
            return null;
          }
          delete openForms[formKey];
          var live = main.querySelector('.req-form[data-key="' + attrSel(formKey) + '"]');
          if (live) { live.remove(); }
          focusOpener(f);
          ownReviewAt = Date.now();
          if (res.j && res.j.demoted) { msgEl.textContent = 'That section was Ready or Built; it is back to Drafting.'; }
          return refetchBook().then(function () { focusOpener(f); });
        })
        .catch(function () { fail('Server unreachable: nothing was saved.'); });
    });
    shown();
    setTimeout(function () { box.querySelectorAll('textarea').forEach(grow); }, 0);
    return box;
  }
  // Writes a message into an open editor (and keeps it with its fields), and syncs its Save button.
  function setFormMsg(formKey, text) {
    var f = hasOwn(openForms, formKey) ? openForms[formKey] : null;
    if (f) { f.msg = text; }
    var live = main.querySelector('.req-form[data-key="' + attrSel(formKey) + '"]');
    if (!live) { return; }
    live.querySelector('.rf-msg').textContent = text;
    if (f && !f.saving) { delete live.dataset.saving; }
    var save = live.querySelector('.rf-save');
    if (save) { save.disabled = reviewBusy() || !!(f && f.saving); }
  }
  // After an editor closes, the cursor goes back to what opened it: the requirement's Edit (or Remove), or ＋ Add.
  function focusOpener(f) {
    var b = null;
    if (f.mode === 'add') {
      b = main.querySelector('.add-req[data-section="' + attrSel(f.section) + '"] .add-req-btn');
      if (b) { b.hidden = state.claude.state !== 'idle'; }
    } else {
      b = main.querySelector('.item-tools[data-key="' + attrSel(f.id) + '"] .rt-' + (f.mode === 'remove' ? 'remove' : 'edit'));
    }
    if (b && !b.hidden) { b.focus({ preventScroll: true }); }
  }
  // ＋ Add requirement, at the end of a section's lists.
  function addRequirement(fullId) {
    var wrap = el('div', { class: 'add-req', 'data-section': fullId });
    var btn = el('button', { type: 'button', class: 'linkbtn add-req-btn edit-ctl' }, '＋ Add requirement');
    btn.hidden = state.claude.state !== 'idle';
    wrap.appendChild(btn);
    var formKey = 'add:' + fullId;
    var place = function () {
      var form = reqForm(formKey);
      wrap.appendChild(form);
      btn.hidden = true;
      return form;
    };
    btn.addEventListener('click', function () {
      // New requirements start as not built yet.
      openForm(formKey, { mode: 'add', section: fullId, text: '', change: 'add', today: '', reason: '', note: '', touched: false });
      var form = place();
      form.querySelector('.rf-cancel').addEventListener('click', function () { btn.hidden = state.claude.state !== 'idle'; });
      form.querySelector('textarea').focus({ preventScroll: true });
    });
    if (hasOwn(openForms, formKey)) {
      var form = place();
      form.querySelector('.rf-cancel').addEventListener('click', function () { btn.hidden = state.claude.state !== 'idle'; });
    }
    return wrap;
  }

  // Changelog -----------------------------------------------------------------------------------------
  // One entry per finished build, newest first: the date, the summary in plain words, and what landed.
  var LANDED = { added: 'added', changed: 'changed', removed: 'removed' };
  function changelogChapter() {
    var list = state.changelog || [];
    if (!list.length) { return null; }
    var sec = el('section', { class: 'chapter changelog', id: 'changelog' }, '<p class="eyebrow">Record</p><h2>Changelog</h2>');
    for (var i = list.length - 1; i >= 0; i--) {
      var e = list[i] || {};
      var div = el('div', { class: 'cl-entry' });
      var h = el('h4', {});
      h.textContent = e.date || shortDate(e.build);
      div.appendChild(h);
      var p = el('p', { class: 'cl-summary' });
      p.textContent = e.summary || 'No summary.';
      if (!e.summary) { p.classList.add('none'); }
      div.appendChild(p);
      var landed = e.landed || [];
      if (landed.length) {
        var ul = el('ul', { class: 'cl-landed' });
        landed.forEach(function (x) {
          var li = el('li', {});
          var id = String((x && x.id) || '');
          // Linked when the requirement is still in the book.
          li.innerHTML = (hasOwn(state.items, id) ? '<a href="#' + esc(id) + '">' + esc(id) + '</a>' : '<span class="sid">' + esc(id) + '</span>') +
            ' <span class="tag' + (hasOwn(LANDED, x && x.kind) ? ' cl-' + LANDED[x.kind] : '') + '">' + esc(hasOwn(LANDED, x && x.kind) ? LANDED[x.kind] : (x && x.kind) || '') + '</span> ' + ((x && x.text) || '');
          ul.appendChild(li);
        });
        div.appendChild(ul);
      }
      sec.appendChild(div);
    }
    return sec;
  }
  // Marks an item's own element as under review, for Changes mode's highlight and Next.
  function markReview(node, key) {
    var r = reviewOf(key);
    if (!r) { return null; }
    node.classList.add('has-rv', 'rv-is-' + r.status);
    return r;
  }
  // The keys of items under review that are no longer in the book, by where they lived: a section's full id, a
  // chapter's id, or '' when that place is gone too.
  function removedByPlace() {
    var out = {};
    var items = state.items || {};
    var where = (state.review && state.review.where) || {};
    Object.keys((state.reviews && state.reviews.byKey) || {}).forEach(function (key) {
      var r = state.reviews.byKey[key];
      if (r.status !== 'removed') { return; }
      var w = r.place || (hasOwn(where, key) ? where[key] : null);
      var place = w && w.section && w.section !== key && hasOwn(items, w.section) ? w.section :
        w && w.chapter && w.chapter !== key && hasOwn(items, w.chapter) ? w.chapter : '';
      (out[place] = out[place] || []).push(key);
    });
    return out;
  }
  // Items gone from the book, each with its review, under the place it left.
  function removedList(keys) {
    var ol = el('ol', { class: 'reqs removed-since' });
    ol.appendChild(el('li', { class: 'reqs-head' }, 'Removed'));
    keys.forEach(function (key) {
      var r = reviewOf(key);
      var v = r.accepted || {};
      var what = r.kind === 'req' ? v.text : r.kind === 'frame' ? 'Screen “' + esc(v.caption || key) + '”' : esc(v.title || key);
      var li = el('li', { id: key, class: 'chg-gone' }, '<span class="rid chg">−</span><div><del class="was">' + (what || '') + '</del> <span class="sid">' + esc(key) + '</span></div>');
      markReview(li, key);
      tgtAttrs(li, key, key + ' (removed)', what || '', key);
      ol.appendChild(li);
      ol.appendChild(itemRow('li', key));
    });
    return ol;
  }
  // The line under the cover in Changes mode: how many reviews are open, and anything removed with its place.
  function diffSummary(rv, orphans) {
    var box = el('div', { class: 'diff-summary', role: 'status' });
    box.innerHTML = rv.count ?
      '<b>' + rv.count + (rv.count === 1 ? ' change' : ' changes') + '</b> to review. Sections with none are hidden; unchanged lines inside a changed section are dimmed. <b>Next</b> steps through them. <b>✓ Accept</b> takes one off the list; to ask for something else, drop a note on it with <b>Comment</b>.' :
      'Nothing to review: every change has been accepted.';
    if (orphans && orphans.length) { box.appendChild(removedList(orphans)); }
    return box;
  }

  function findSection(fullId) {
    var found = null;
    (state.book.chapters || []).forEach(function (ch) {
      (ch.sections || []).forEach(function (s) { if (ch.id + '-' + s.id === fullId) { found = s; } });
    });
    return found;
  }

  // A target is anything a note can be dropped on. Its item is the reviewable item the note goes on (a recording's
  // section, a decision's section); for a requirement, a frame or a heading it is the target itself.
  function tgtAttrs(node, key, label, quote, item) {
    node.classList.add('tgt');
    node.dataset.key = key;
    node.dataset.item = item || key;
    node.dataset.label = label;
    node.dataset.quote = quote || '';
  }

  function mountMockup(host, path) {
    host.dataset.mockup = path;
    var root = host.attachShadow({ mode: 'open' });
    var css = '<style>' + (state.mockupCss || '') + '</style>';
    root.innerHTML = css + (state.mockups[path] || '<p style="color:#c00">Missing mockup ' + esc(path) + '</p>');
  }

  function renderFrameBody(frame, section) {
    var body = el('div', { class: 'frame-body' });
    var shot = screenshotFor(frame, section);
    var showMock = state.view === 'mockup' || state.view === 'both' || (state.view === 'shot' && !shot);
    var showShot = state.view === 'shot' || state.view === 'both';
    if (showMock && frame.mockup) {
      var host = el('div', { class: 'mock' });
      body.appendChild(host);
      mountMockup(host, frame.mockup);
    }
    if (showShot) {
      if (!shot && state.view === 'shot') {
        body.insertBefore(el('p', { class: 'shot-missing' }, 'No screenshot yet, showing the mockup'), body.firstChild);
        body.classList.add('stacked');
      } else if (shot) {
        body.appendChild(el('img', { class: 'shot', src: '/data/' + shot, alt: 'Screenshot: ' + (frame.caption || frame.id) }));
      } else {
        body.appendChild(el('div', { class: 'noshot' }, 'No screenshot yet.<br>Add <code>media/screens/' + esc(frame.id) + '.png</code>'));
      }
    }
    return body;
  }

  // Evidence ------------------------------------------------------------------------------------------
  // evidence.byId[<requirement id>] = { unit: [{ file, title, status }], e2e: [{ chapter, title, video, start, end,
  // status, screenshot, error }] }. A requirement is proven when a test naming it passed.
  function evFor(rid) {
    var by = state.evidence && state.evidence.byId;
    return rid && by && by[rid] ? by[rid] : null;
  }
  function hasEvidence() { return !!(state.evidence && state.evidence.byId); }
  function isPassed(t) { return t.status === 'passed'; }
  function isProven(rid) {
    var e = evFor(rid);
    return !!e && ((e.e2e || []).some(isPassed) || (e.unit || []).some(isPassed));
  }
  function sectionEvidenceShot(section) {
    var reqs = section.requirements || [];
    for (var i = 0; i < reqs.length; i++) {
      var e = typeof reqs[i] === 'string' ? null : evFor(reqs[i].id);
      var runs = e ? (e.e2e || []) : [];
      for (var j = 0; j < runs.length; j++) {
        if (isPassed(runs[j]) && runs[j].screenshot) { return runs[j].screenshot; }
      }
    }
    return null;
  }
  function clock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var r = sec % 60;
    return Math.floor(sec / 60) + ':' + (r < 10 ? '0' : '') + r;
  }
  function coverageOf(section) {
    var reqs = (section.requirements || []).filter(function (r) { return typeof r !== 'string' && r.id; });
    return { proven: reqs.filter(function (r) { return isProven(r.id); }).length, total: reqs.length };
  }

  var lightbox = null;
  function closeLightbox() { if (lightbox) { lightbox.remove(); lightbox = null; } }
  // An e2e screenshot is rewritten in place by every run, under the same name.
  // The evidence's own timestamp changes with each collection, so it tells the
  // browser the picture is new without serving the file differently.
  function evidenceShotUrl(path) {
    var v = state.evidence && state.evidence.generatedAt;
    return '/data/' + path + (v ? '?v=' + encodeURIComponent(v) : '');
  }

  function openLightbox(src, caption, error) {
    closeLightbox();
    lightbox = el('div', { class: 'ev-lightbox', role: 'dialog', 'aria-label': 'Screenshot' });
    var fig = el('figure', {});
    var img = el('img', { src: evidenceShotUrl(src), alt: caption });
    if (error !== undefined) { img.classList.add('failed'); }
    fig.appendChild(img);
    var cap = el('figcaption', {});
    cap.textContent = caption;
    fig.appendChild(cap);
    if (error) { var er = el('pre', { class: 'ev-error' }); er.textContent = error; fig.appendChild(er); }
    lightbox.appendChild(fig);
    lightbox.addEventListener('click', closeLightbox);
    document.body.appendChild(lightbox);
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeLightbox(); } });

  function buildPlayer(host, run) {
    var start = Number(run.start) || 0;
    var limit = typeof run.end === 'number' ? run.end : Infinity;
    var video = el('video', { src: '/data/' + run.video, controls: '', preload: 'metadata', playsinline: '' });
    var frame = 0;
    function watch() {
      if (video.paused) { return; }
      if (video.currentTime >= limit) { video.pause(); video.currentTime = limit; return; }
      frame = requestAnimationFrame(watch);
    }
    function playClip() { video.currentTime = start; video.play().catch(function () { /* autoplay blocked: the controls still work */ }); }
    video.addEventListener('loadedmetadata', playClip);
    video.addEventListener('play', function () {
      if (video.currentTime >= limit) { video.currentTime = start; }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(watch);
    });
    var bar = el('div', { class: 'ev-player-bar' });
    var label = el('span', { class: 'ev-clip' });
    label.textContent = 'Clip ' + clock(start) + (isFinite(limit) ? '–' + clock(limit) : '') + ' · ' + (run.title || run.chapter || '');
    var whole = el('button', { type: 'button', class: 'ev-btn' }, 'Play whole recording');
    whole.addEventListener('click', function () {
      limit = Infinity;
      video.currentTime = 0;
      video.play().catch(function () { /* controls still work */ });
    });
    var again = el('button', { type: 'button', class: 'ev-btn' }, 'Replay clip');
    again.addEventListener('click', function () {
      limit = typeof run.end === 'number' ? run.end : Infinity;
      playClip();
    });
    bar.appendChild(label);
    bar.appendChild(again);
    bar.appendChild(whole);
    host.appendChild(video);
    host.appendChild(bar);
  }

  function buildUnitList(host, tests) {
    var groups = [];
    var byFile = {};
    tests.forEach(function (t) {
      if (!byFile[t.file]) { byFile[t.file] = { file: t.file, tests: [] }; groups.push(byFile[t.file]); }
      byFile[t.file].tests.push(t);
    });
    groups.forEach(function (g) {
      var box = el('div', { class: 'ev-file' });
      var h = el('div', { class: 'ev-file-name' });
      h.textContent = g.file;
      box.appendChild(h);
      var ul = el('ul', {});
      g.tests.forEach(function (t) {
        var li = el('li', { class: t.status });
        li.innerHTML = '<span class="ev-mark">' + (t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '?') + '</span> ';
        var txt = el('span', {});
        txt.textContent = t.title;
        li.appendChild(txt);
        ul.appendChild(li);
      });
      box.appendChild(ul);
      host.appendChild(box);
    });
  }

  function unitLabel(tests) {
    var n = { passed: 0, failed: 0, unknown: 0 };
    tests.forEach(function (t) { n[t.status === 'passed' || t.status === 'failed' ? t.status : 'unknown']++; });
    var parts = [];
    if (n.passed) { parts.push(n.passed + ' ✓'); }
    if (n.failed) { parts.push(n.failed + ' ✗'); }
    if (n.unknown) { parts.push(n.unknown + ' ?'); }
    return { text: 'Unit ' + parts.join(' '), cls: n.failed ? 'failed' : n.passed ? 'passed' : 'unknown' };
  }

  function evidenceRow(rid, ev) {
    var e2e = ev.e2e || [];
    var unit = ev.unit || [];
    if (!e2e.length && !unit.length) { return null; }
    var row = el('div', { class: 'ev' });
    var chips = el('div', { class: 'ev-chips' });
    // Screenshots go in a column of their own to the right of the requirement's text, at the book's screenshot width (settings).
    var shots = el('div', { class: 'ev-shots' });
    var panel = el('div', { class: 'ev-panel' });
    panel.hidden = true;
    var open = null;
    var buttons = {};
    function closePanel() {
      panel.querySelectorAll('video').forEach(function (v) { v.pause(); });
      panel.innerHTML = '';
      panel.hidden = true;
      Object.keys(buttons).forEach(function (k) { buttons[k].setAttribute('aria-expanded', 'false'); });
      open = null;
    }
    function toggle(key, build) {
      var was = open;
      closePanel();
      if (was === key) { return; }
      open = key;
      build(panel);
      panel.hidden = false;
      buttons[key].setAttribute('aria-expanded', 'true');
    }
    function chip(key, cls, text, title, build) {
      var b = el('button', { type: 'button', class: 'ev-chip ' + cls, 'aria-expanded': 'false', title: title });
      b.textContent = text;
      b.addEventListener('click', function () { toggle(key, build); });
      buttons[key] = b;
      chips.appendChild(b);
    }
    var failures = [];
    e2e.forEach(function (run, i) {
      var status = run.status === 'passed' || run.status === 'failed' ? run.status : 'not_run';
      var times = typeof run.start === 'number' ? ' ' + clock(run.start) + (typeof run.end === 'number' ? '–' + clock(run.end) : '') : '';
      if (status === 'not_run') {
        var idle = el('span', { class: 'ev-chip not_run', title: run.title || '' });
        idle.textContent = 'e2e not run';
        chips.appendChild(idle);
      } else if (!run.video) {
        // It ran; there is just no recording to play.
        var still = el('span', { class: 'ev-chip ' + status, title: (run.title || '') + ' (no recording)' });
        still.textContent = 'e2e ' + (status === 'failed' ? '✗' : '✓') + ' no video';
        chips.appendChild(still);
      } else {
        chip('e2e' + i, status, '▶ e2e' + times + (status === 'failed' ? ' ✗' : ''), run.title || 'Play this clip', function (host) { buildPlayer(host, run); });
      }
      if (run.screenshot) {
        var failed = status === 'failed';
        var thumb = el('button', { type: 'button', class: 'ev-thumb' + (failed ? ' failed' : ''), title: failed ? 'Failure screenshot' : 'Enlarge screenshot' });
        thumb.innerHTML = '<span class="ev-cam" aria-hidden="true">📷</span><img alt="' + (failed ? 'Failure screenshot for ' : 'Screenshot for ') + esc(rid) + '" src="' + esc(evidenceShotUrl(run.screenshot)) + '">';
        thumb.addEventListener('click', function () { openLightbox(run.screenshot, (failed ? 'Failed: ' : '') + rid + (run.title ? ' · ' + run.title : ''), failed ? (run.error || '') : undefined); });
        shots.appendChild(thumb);
      }
      if (status === 'failed') { failures.push(run); }
    });
    if (unit.length) {
      var u = unitLabel(unit);
      chip('unit', u.cls, u.text, 'Unit tests naming ' + rid, function (host) { buildUnitList(host, unit); });
    }
    row.appendChild(chips);
    if (shots.firstChild) { row.appendChild(shots); }
    failures.forEach(function (run) {
      if (!run.error) { return; }
      var er = el('pre', { class: 'ev-error' });
      er.textContent = run.error;
      row.appendChild(er);
    });
    row.appendChild(panel);
    return row;
  }

  // The section a note on a decision goes on: the section of the first item its about names, else the first chapter.
  function decisionItem(d, fallback) {
    var about = [].concat((d && d.about) || []);
    for (var i = 0; i < about.length; i++) {
      var it = hasOwn(state.items, about[i]) ? state.items[about[i]] : null;
      if (it) { return it.section || it.chapter; }
    }
    return fallback;
  }

  function render() {
    // An inline editor with the cursor gets it back after the redraw (its text is kept by openEditors).
    var act = document.activeElement;
    var editing = act && /^(TEXTAREA|INPUT|SELECT)$/.test(act.tagName) && act.closest && act.closest('.inline-editor[data-key]');
    var focusKey = editing ? editing.dataset.key : null;
    var focusName = editing ? act.name : '';
    var b = state.book;
    state.items = window.SpecModel.itemsOf(b, state.mockups);
    var rv = computeReviews();
    [openEarlier, openEditors].forEach(function (kept) {
      Object.keys(kept).forEach(function (k) { if (!hasOwn(rv.byKey, k)) { delete kept[k]; } });
    });
    Object.keys(openForms).forEach(function (k) {
      var f = openForms[k];
      if (f.mode === 'add' ? !hasOwn(state.items, f.section) : !findReq(f.id)) { delete openForms[k]; }
    });
    var removed = removedByPlace();
    var firstChapter = ((b.chapters || [])[0] || {}).id || '';
    document.title = b.title || 'Spec book';
    document.getElementById('book-title').textContent = b.title || 'Spec book';
    main.innerHTML = '';
    var toc = document.getElementById('toc');
    toc.innerHTML = '';

    var cover = el('header', { class: 'cover', id: 'top' });
    cover.innerHTML = '<p class="eyebrow">' + esc(b.eyebrow || 'Spec book') + '</p><h1>' + esc(b.title) + '</h1>' +
      (b.lede ? '<p>' + b.lede + '</p>' : '') +
      (b.sources && b.sources.length ? '<p>' + b.sources.map(function (s) { return esc(s.label) + ': <code>' + esc(s.path) + '</code>'; }).join(' · ') + '</p>' : '') +
      '<div class="howto"><b>Making notes:</b> ' +
      'Press <b>Comment</b> in the bar (or <b>C</b>), then click the exact spot you mean: a numbered pin drops there and a box opens to type in. Comment mode stays on until you press it again or Esc, so you can drop several in a row. Each note then stays up as a sticky, with its numbered pin as the arrowhead: click the sticky to edit it, drag it to move it, and click it to edit it (click again to stop editing and move it). Drag a pin to point it at something else. <b>Notes</b> lists them all, with exactly what Claude will receive. Notes are saved with the book. <b>Revise</b> sends them all to Claude, which works through them with you in the terminal. A sent note then shows in <b>Changes</b>, with the review of what it changed, until you accept it. <b>Build</b> builds every section marked Ready.</div>';
    main.appendChild(cover);
    main.appendChild(diffSummary(rv, removed['']));
    updateChangesBar();

    (b.chapters || []).forEach(function (ch, ci) {
      var n = ci + 1;
      var nn = n < 10 ? '0' + n : String(n);
      var chChanged = !!rv.byChapter[ch.id];
      var sec = el('section', { class: 'chapter ' + (chChanged ? 'has-chg' : 'no-chg'), id: ch.id });
      sec.appendChild(el('p', { class: 'eyebrow' }, 'Chapter ' + nn));
      var chStage = window.SpecModel.chapterStage(ch);
      var h2 = el('h2', {}, esc(ch.title) + ' ' + pill(chStage, STAGE_TEXT[chStage]));
      markReview(h2, ch.id);
      tgtAttrs(h2, ch.id, 'Chapter ' + nn + ' ' + ch.title + ' (whole chapter)', '');
      sec.appendChild(h2);
      sec.appendChild(itemRow('div', ch.id));
      if (ch.intro) { sec.appendChild(el('p', { class: 'lede' }, ch.intro)); }
      if (removed[ch.id]) { sec.appendChild(removedList(removed[ch.id])); }
      var tocCh = el('div', { class: 'sb-ch' });
      tocCh.innerHTML = '<a class="sb-chl" href="#' + ch.id + '"><span class="sb-n">' + nn + '</span>' + esc(ch.title) + '</a>';
      var tocSecs = el('div', { class: 'sb-secs' });
      if (chChanged) { tocCh.classList.add('has-chg'); }

      (ch.sections || []).forEach(function (s, si) {
        var num = '§' + n + '.' + (si + 1);
        var fullId = ch.id + '-' + s.id;
        var nChg = rv.bySection[fullId] || 0;
        var box = el('div', { class: 'bk-sec ' + (nChg ? 'has-chg' : 'no-chg'), id: fullId });
        var stage = window.SpecModel.sectionStage(s);
        var sp = window.SpecModel.stagePill(s);
        var cov = hasEvidence() && stage !== 'drafting' ? coverageOf(s) : null;
        var covHtml = cov && cov.total ? ' <span class="cov' + (cov.proven === cov.total ? ' full' : '') + '" title="Requirements with a passing test">' + cov.proven + ' of ' + cov.total + ' proven</span>' : '';
        var h = el('h3', {}, '<span class="bk-num">' + num + '</span> ' + esc(s.title) + ' ' + pill(sp.cls, sp.text) + covHtml);
        var secReview = markReview(h, fullId);
        if (secReview && secReview.status === 'new') { box.classList.add('chg-new-sec'); }
        var stageBtn = stageButton(fullId, stage);
        if (stageBtn) {
          if (stage === 'drafting' && nChg) { stageBtn.title = READY_GATE; }
          h.appendChild(document.createTextNode(' '));
          h.appendChild(stageBtn);
        }
        tgtAttrs(h, fullId, num + ' ' + s.title + ' (whole section)', '');
        box.appendChild(h);
        box.appendChild(itemRow('div', fullId));
        if (s.intro) { box.appendChild(el('p', { class: 'bk-intro' }, s.intro)); }
        var mixed = false;
        if (s.requirements && s.requirements.length) {
          // A section with some changed requirements lists what the app does today, then its changes in their own
          // list. Numbers run on across both lists so a requirement keeps one number.
          var reqs = s.requirements.map(function (r, ri) {
            var o = typeof r === 'string' ? { text: r } : r;
            return { r: o, pos: n + '.' + (si + 1) + '.' + (ri + 1), ri: ri };
          });
          var changes = reqs.filter(function (x) { return !!x.r.change; });
          mixed = changes.length > 0 && changes.length < reqs.length;
          if (mixed) {
            // number in reading order: today's list first, then the changes
            reqs.filter(function (x) { return !x.r.change; }).concat(changes).forEach(function (x, k) {
              x.pos = n + '.' + (si + 1) + '.' + (k + 1);
            });
          }
          // A requirement, then its row (tools and review stack) as the next item of the list.
          var addItem = function (list, x) {
            var rid = x.r.id;
            var kind = x.r.change;
            if (!rid) { console.warn('Requirement without an id in ' + fullId + '; run assign-ids.mjs'); }
            var text = kind === 'remove' ? '<span class="req-removed">' + x.r.text + '</span>' : x.r.text;
            var tag = kind === 'add' ? ' <span class="tag new">New</span>' : kind === 'remove' ? ' <span class="tag removed">Removed</span>' : '';
            var extra = kind === 'change' && x.r.today ? '<div class="today"><span>Today:</span> ' + x.r.today + '</div>' :
              kind === 'remove' && x.r.reason ? '<div class="today why"><span>Why:</span> ' + x.r.reason + '</div>' : '';
            var li = el('li', { id: rid || '' }, '<span class="rid' + (kind ? ' chg' : '') + '">' + x.pos + '</span><div>' + text + tag +
              (rid ? ' <span class="sid" title="Stable id: stays the same when requirements move">' + esc(rid) + '</span>' : '') + extra + '</div>');
            if (!(rid && markReview(li, rid))) { li.classList.add('same'); }
            var ev = evFor(rid);
            var row = ev ? evidenceRow(rid, ev) : null;
            // The evidence pills sit on the line of the id, after it; an opened test list or clip drops below.
            var sidEl = li.querySelector('.sid');
            if (row && sidEl) { sidEl.parentNode.insertBefore(row, sidEl.nextSibling); } else if (row) { li.lastChild.appendChild(row); }
            // Its screenshots take a column of their own on the right, after the text.
            var shotCol = row ? row.querySelector('.ev-shots') : null;
            if (shotCol) { li.appendChild(shotCol); li.classList.add('has-shot'); }
            // In Changes mode the bullet of a requirement under review carries ✓ Accept and ✎ Change.
            var acts = rid ? reviewActions(rid) : null;
            if (acts) { li.lastChild.appendChild(acts); }
            if (hasEvidence() && rid && stage !== 'drafting' && !isProven(rid)) { li.classList.add('unproven'); }
            tgtAttrs(li, rid || (fullId + '-r' + (x.ri + 1)), x.pos + (rid ? ' (' + rid + ')' : '') + ' · ' + num + ' ' + s.title + (kind ? ' · proposed change' : ''), x.r.text, rid || fullId);
            list.appendChild(li);
            if (rid) { list.appendChild(itemRow('li', rid)); }
          };
          var ol = el('ol', { class: 'reqs' });
          if (mixed) { ol.appendChild(el('li', { class: 'reqs-head' }, 'What the app does today')); }
          reqs.forEach(function (x) { if (!mixed || !x.r.change) { addItem(ol, x); } });
          box.appendChild(ol);
          if (mixed) {
            var changeList = el('ol', { class: 'reqs changes' });
            changeList.appendChild(el('li', { class: 'reqs-head' }, 'Changes'));
            changes.forEach(function (x) { addItem(changeList, x); });
            box.appendChild(changeList);
          }
        }
        box.appendChild(addRequirement(fullId));
        if (removed[fullId]) { box.appendChild(removedList(removed[fullId])); }
        if (s.frames && s.frames.length) {
          var frames = el('div', { class: 'frames' });
          s.frames.forEach(function (f) {
            var role = roleInfo(f.role);
            var wrap = el('div', { class: 'frame-item' });
            var fig = el('figure', { class: 'frame' });
            var cap = el('figcaption', {}, (f.role ? '<span class="role" style="background:' + role.color + '">' + esc(role.label) + '</span> ' : '') + esc(f.caption || f.id) +
              (f.state === 'proposed' && mixed ? ' <span class="fstate">shows proposed change</span>' : ''));
            markReview(fig, f.id);
            fig.appendChild(cap);
            fig.appendChild(renderFrameBody(f, s));
            tgtAttrs(fig, f.id, num + ' ' + s.title + ' · screen “' + (f.caption || f.id) + '”', 'Screen: ' + (f.caption || f.id));
            wrap.appendChild(fig);
            wrap.appendChild(itemRow('div', f.id));
            frames.appendChild(wrap);
          });
          box.appendChild(frames);
        }
        var vids = videosFor(fullId, s);
        if (vids.length) {
          var vwrap = el('div', { class: 'videos' });
          vids.forEach(function (v, vi) {
            var fig = el('figure', {});
            fig.appendChild(el('figcaption', {}, '▶ ' + esc(v.caption || v.path)));
            var video = el('video', { src: '/data/' + v.path, controls: '', preload: 'metadata', playsinline: '' });
            fig.appendChild(video);
            tgtAttrs(fig, fullId + '-v' + (vi + 1), num + ' ' + s.title + ' · recording “' + (v.caption || v.path) + '”', 'Recording: ' + (v.caption || v.path), fullId);
            vwrap.appendChild(fig);
          });
          box.appendChild(vwrap);
        }
        var decs = sectionDecisions(s, fullId);
        if (decs.length) {
          var dbox = el('div', { class: 'sec-decisions' }, '<h5>Decisions</h5>');
          decs.forEach(function (d) { dbox.appendChild(el('div', { class: 'dec' }, decisionHtml(d, null))); });
          box.appendChild(dbox);
        }
        sec.appendChild(box);
        tocSecs.appendChild(el('a', { href: '#' + fullId, class: nChg ? 'has-chg' : 'no-chg' }, num + ' ' + esc(s.title) + (nChg ? ' <span class="sb-chg" title="Open reviews">' + nChg + '</span>' : '')));
      });
      tocCh.appendChild(tocSecs);
      toc.appendChild(tocCh);
      main.appendChild(sec);
    });

    if (b.decisions && b.decisions.length) {
      var dec = el('section', { class: 'chapter', id: 'decisions' }, '<p class="eyebrow">Record</p><h2>Decisions and what was rejected</h2>');
      b.decisions.forEach(function (d, i) {
        var did = d.id || 'dec-' + i;
        var div = el('div', { class: 'dec', id: did }, decisionHtml(d, did));
        tgtAttrs(div, did, did + ' · decision: ' + d.title, d.title, decisionItem(d, firstChapter));
        dec.appendChild(div);
      });
      main.appendChild(dec);
      toc.appendChild(el('div', { class: 'sb-ch' }, '<a class="sb-chl" href="#decisions"><span class="sb-n">—</span>Decisions</a>'));
    }
    var log = changelogChapter();
    if (log) {
      main.appendChild(log);
      toc.appendChild(el('div', { class: 'sb-ch' }, '<a class="sb-chl" href="#changelog"><span class="sb-n">—</span>Changelog</a>'));
    }

    var shots = state.media.filter(function (m) { return m.indexOf('media/screens/') === 0; }).length;
    var vids = state.media.filter(function (m) { return m.indexOf('media/videos/') === 0; }).length;
    document.getElementById('media-count').textContent = shots + ' screenshot' + (shots === 1 ? '' : 's') + ', ' + vids + ' recording' + (vids === 1 ? '' : 's') + ' in media/.';
    renderNotes();
    drawSentPins();
    if (focusKey) {
      var sel = '.inline-editor[data-key="' + focusKey.replace(/["\\]/g, '\\$&') + '"] ';
      var back = (focusName ? main.querySelector(sel + '[name="' + focusName + '"]') : null) || main.querySelector(sel + 'textarea');
      if (back && back.getClientRects().length) {
        if (back.tagName === 'TEXTAREA') { grow(back); }
        back.focus({ preventScroll: true });
        if (back.tagName !== 'SELECT') { back.setSelectionRange(back.value.length, back.value.length); }
      }
    }
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) { target.scrollIntoView({ behavior: 'instant', block: 'start' }); }
    }
  }

  // Notes ---------------------------------------------------------------------------------------------
  // Notes live in review.json. The page edits only draft notes; a sent, answered or frozen note shows in its review
  // stack (and, with Show sent notes, as a read-only pin). On the page a draft is { text, item, target, section, rx,
  // ry, dx, dy, el, created }: item is the reviewable item it is on, target the spot it was dropped on (see tgtAttrs).
  // On the server it is { item, text, created, target, section, pin: { rx, ry, dx, dy, element } } (toServer).
  // A note is { text, target, rx, ry }. Its pin sits at (rx, ry): fractions of the target's box, and lives inside
  // the target, so it stays on the spot that was clicked when the layout moves and when the page is printed.
  // Notes are an overlay only: nothing here changes the layout of the book. Comment mode works like Figma's: with
  // it on, a click on the book drops a pin and opens a composer beside it, and the mode stays on. A posted note
  // stays up as a sticky, with an arrow to its pin. The sticky sits at (dx, dy): page pixels from the pin's point,
  // so it travels with the pin; dragging the sticky moves it, and clicking it edits it. Dragging a pin
  // re-aims it (the sticky stays put), and whatever it lands on becomes the note's target. The notes panel lists
  // every note in book order, with exactly what Revise will send. A note also keeps the id of its section, so it
  // still has a place on the page when its target is revised away.
  var SVG = 'http://www.w3.org/2000/svg';
  var layer = el('div', { class: 'note-layer' });
  document.body.appendChild(layer);
  var arrows = document.createElementNS(SVG, 'svg');
  arrows.setAttribute('class', 'note-arrows');
  arrows.setAttribute('aria-hidden', 'true');
  layer.appendChild(arrows);
  var printList = el('section', { class: 'print-notes', 'aria-hidden': 'true' });
  document.body.appendChild(printList);
  var pins = {};
  var stickies = {}; // id -> { box, ta, line }
  var pop = null; // the open composer: { id, kind, box, ta }
  var draft = null; // the id of a note being composed, which has no text until it is posted
  var commenting = false;
  var justDragged = false;
  var hot = null;
  var panel = document.getElementById('notes-panel');
  var notesBtn = document.getElementById('notes-btn');
  // Notes are saved to the server shortly after each change, one save at a time, each based on the revision the last
  // one returned. While Claude is revising, the notes are locked and nothing is saved.
  var saveTimer = 0;
  var saveChain = Promise.resolve();
  var notesDirty = false;
  var synced = {}; // id -> the note as the server last had it (JSON), to tell which notes were changed here
  function notesLocked() { return state.claude.state === 'revising'; }
  // Who is reading: the owner at their desk, or a guest of a shared book (see host.js and guest.js).
  function viewer() { return state.viewer || { guest: false }; }
  // A guest may change only their own notes (the server marks them `mine`); the owner may change any.
  function noteLocked(id) {
    var n = state.notes[id];
    return notesLocked() || !!(viewer().guest && n && !n.mine);
  }
  // Who wrote a note, when it is someone other than the reader: a guest's name, or "Host" for the owner's note on a
  // guest's page.
  function authorOf(n) {
    if (!n) { return ''; }
    var v = viewer();
    if (v.guest) { return n.mine ? '' : (n.author || (state.owner && state.owner.name) || 'Owner'); }
    return n.author || '';
  }
  // On the reader's own note, who else changed it last (the owner may edit a guest's note): their name, or ''.
  function changedByOther(n) {
    if (!n || !n.lastBy) { return ''; }
    // By key, not name: two people may share a name. A guest is told only whether the last change was theirs.
    var mine = viewer().guest ? !!n.mine : !n.authorKey;
    var byMe = viewer().guest ? !!n.lastMine : n.lastByKey === 'owner';
    return mine && !byMe ? n.lastBy : '';
  }
  function saveNotes() {
    if (notesLocked()) { return; }
    notesDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNotes, 150);
  }
  // Sends any change still waiting; resolves once every save so far has been answered, with true when the last one
  // was saved.
  function flushNotes(keepalive) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!notesDirty) { return saveChain; }
    notesDirty = false;
    saveChain = saveChain.then(function () { return putNotes(keepalive); });
    return saveChain;
  }
  function savedNotes() {
    var out = {};
    live().forEach(function (id) {
      var n = state.notes[id], copy = {};
      Object.keys(n).forEach(function (k) { copy[k] = n[k]; });
      out[id] = copy;
    });
    return out;
  }
  function isNum(v) { return typeof v === 'number' && !isNaN(v); }
  function isItemKey(k) { return typeof k === 'string' && (hasOwn(state.items, k) || hasOwn(state.review && state.review.accepted, k)); }
  // The server keeps a draft only on an item it knows: one in the book, or one accepted and since removed. A note
  // whose item went away falls back to its section, then to the first chapter.
  function itemFor(n) {
    if (isItemKey(n.item)) { return n.item; }
    if (isItemKey(n.section)) { return n.section; }
    var first = ((state.book && state.book.chapters) || [])[0];
    return first ? first.id : n.item;
  }
  function toServer(n) {
    var o = { item: itemFor(n), text: n.text };
    if (typeof n.target === 'string') { o.target = n.target; }
    if (typeof n.section === 'string') { o.section = n.section; }
    if (typeof n.created === 'string') { o.created = n.created; }
    o.pin = { rx: isNum(n.rx) ? n.rx : 0, ry: isNum(n.ry) ? n.ry : 0.5 };
    if (isNum(n.dx) && isNum(n.dy)) { o.pin.dx = n.dx; o.pin.dy = n.dy; }
    if (n.el) { o.pin.element = n.el; }
    return o;
  }
  function fromServer(n) {
    var p = n.pin || {};
    var o = { text: n.text || '', item: n.item, target: n.target || n.item, rx: isNum(p.rx) ? p.rx : 0, ry: isNum(p.ry) ? p.ry : 0.5 };
    if (n.section) { o.section = n.section; }
    if (isNum(p.dx) && isNum(p.dy)) { o.dx = p.dx; o.dy = p.dy; }
    if (p.element !== undefined) { o.el = p.element; }
    if (n.created) { o.created = n.created; }
    if (n.author) { o.author = n.author; }
    if (n.authorKey) { o.authorKey = n.authorKey; }
    if (n.mine) { o.mine = true; }
    if (n.lastBy) { o.lastBy = n.lastBy; }
    if (n.lastByKey) { o.lastByKey = n.lastByKey; }
    if (n.lastMine) { o.lastMine = true; }
    return o;
  }
  function draftsOf(review) {
    var all = (review && review.notes) || {};
    var out = {};
    Object.keys(all).forEach(function (id) { if (all[id] && all[id].status === 'draft') { out[id] = fromServer(all[id]); } });
    return out;
  }
  // After a save: review.json now holds these drafts, so the counts of open reviews may have changed.
  function savedDrafts(sent, rev) {
    if (!state.review) { return; }
    var notes = {};
    var old = state.review.notes || {};
    Object.keys(old).forEach(function (id) { if (old[id] && old[id].status !== 'draft') { notes[id] = old[id]; } });
    Object.keys(sent).forEach(function (id) {
      if (!hasOwn(notes, id)) {
        var o = toServer(sent[id]);
        o.status = 'draft';
        // The server keeps what it wrote on a draft (see serve.mjs mergeNotes); so does this copy.
        ['causes', 'closedFor', 'reply', 'from', 'author', 'authorKey', 'mine'].forEach(function (k) { if (old[id] && old[id][k] !== undefined) { o[k] = old[id][k]; } });
        if (sent[id].mine) { o.mine = true; o.author = sent[id].author; }
        notes[id] = o;
      }
    });
    state.review.notes = notes;
    state.review.rev = rev;
    if (!state.book) { return; }
    computeReviews();
    updateChangesBar();
    // A note that opened a review (or closed one), or changed the notes a stack shows, needs it drawn again now.
    var drawn = {};
    main.querySelectorAll('.rv-stack[data-key]').forEach(function (e) { drawn[e.dataset.key] = e.getAttribute('data-sig') || ''; });
    var byKey = state.reviews.byKey;
    var keys = Object.keys(byKey);
    if (keys.length !== Object.keys(drawn).length ||
        keys.some(function (k) { return !hasOwn(drawn, k) || drawn[k] !== notesSig(byKey[k]); })) { redrawSoon(); }
  }
  // Draws the book again where the reader is, once nothing is being written.
  function redrawSoon() {
    setTimeout(function () {
      if (writingNote()) { refetchWaiting = true; return; }
      renderInPlace();
    }, 0);
  }
  // Resolves true only when the server saved the notes; false on a conflict or when the server is unreachable.
  // Only the notes changed here since the server last had them are sent (null deletes one), so a save never undoes
  // what someone else saved meanwhile (live sharing).
  function putNotes(keepalive) {
    var sent = savedNotes();
    var changes = {};
    var any = false;
    Object.keys(sent).forEach(function (id) {
      if (JSON.stringify(sent[id]) !== synced[id]) { changes[id] = toServer(sent[id]); any = true; }
    });
    Object.keys(synced).forEach(function (id) { if (!hasOwn(sent, id)) { changes[id] = null; any = true; } });
    if (!any) { return Promise.resolve(true); }
    var body = JSON.stringify({ changes: changes });
    return fetch('/api/notes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: body, keepalive: !!keepalive })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 200) {
          state.notesRev = res.j.rev;
          markSynced(sent);
          savedDrafts(sent, res.j.rev);
          // A note the server would not take (another's, or no longer a draft) keeps its text under a new id; the
          // server's copy of the old one comes back with the reload.
          var sk = window.SpecModel.rekeySkipped(state.notes, changes, res.j.skipped, newId);
          if (importing) { importing = false; store(state.noteKey, null); }
          if (!sk.unsynced.length) { return true; }
          sk.unsynced.forEach(function (id) { delete synced[id]; });
          state.notes = sk.notes;
          saveNotes();
          return reloadNotes('').then(function () { return false; });
        }
        if (res.status === 409 && res.j.error === 'stale') {
          var own = reviewPending || Date.now() - ownReviewAt < 5000;
          return reloadNotes(own ? '' : 'Notes changed elsewhere; reloaded.').then(function () { return false; });
        }
        if (res.status === 409 && res.j.error === 'locked') { pollClaude(); }
        if (res.status >= 500) { saveAgain(); }
        return false;
      })
      .catch(function () { saveAgain(); return false; /* unreachable, or a guest's connection dropped mid-save */ });
  }
  // A save that did not get through is sent again in a few seconds (the notes stay on the page meanwhile). A guest's
  // save waits for the connection to the host to be back.
  function saveAgain() {
    notesDirty = true;
    if (!saveTimer) { saveTimer = setTimeout(flushNotes, 3000); }
  }
  function markSynced(notes) {
    synced = {};
    Object.keys(notes).forEach(function (id) { synced[id] = JSON.stringify(notes[id]); });
  }
  function setNotes(review) {
    state.notes = draftsOf(review);
    state.notesRev = review && typeof review.rev === 'number' ? review.rev : 0;
    markSynced(state.notes);
  }
  // Takes the server's notes but keeps every note changed here and not yet saved (added, edited or deleted). The
  // server's copy is ignored when it is older than the last save made from this page.
  function mergeNotes(review) {
    var rev = review && typeof review.rev === 'number' ? review.rev : 0;
    if (rev < state.notesRev) { return; }
    var server = draftsOf(review);
    var local = state.notes;
    var ids = {};
    Object.keys(local).concat(Object.keys(synced)).forEach(function (id) { ids[id] = true; });
    var changed = Object.keys(ids).filter(function (id) {
      return (local[id] === undefined ? undefined : JSON.stringify(local[id])) !== synced[id];
    });
    var merged = {};
    Object.keys(server).forEach(function (id) { merged[id] = server[id]; });
    markSynced(server);
    changed.forEach(function (id) {
      if (local[id] === undefined) { delete merged[id]; } else { merged[id] = local[id]; }
    });
    state.notes = merged;
    state.notesRev = rev;
    if (changed.length) { notesDirty = true; saveNotes(); }
  }
  // On a conflict (review.json moved on: an Accept, a Change, Claude), the server's notes are taken and this page's
  // unsaved changes kept on top, then saved again with the new revision.
  function reloadNotes(message) {
    return fetch('/api/book', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.review) { state.review = data.review; }
      mergeNotes(data.review);
      if (state.book) { computeReviews(); updateChangesBar(); }
      // A note started while this was loading is not swept away: the notes are drawn again once it is done.
      if (writingNote()) { refetchWaiting = true; return; }
      renderNotes();
      if (message) { document.getElementById('make-msg').textContent = message; }
    }).catch(function () { /* unreachable: keep what is on the page */ });
  }
  window.addEventListener('pagehide', function () { flushNotes(true); });
  function targets() { return Array.prototype.slice.call(document.querySelectorAll('.tgt')); }
  function byKey(k) {
    var all = document.querySelectorAll('.tgt');
    for (var i = 0; i < all.length; i++) { if (all[i].dataset.key === k) { return all[i]; } }
    return null;
  }
  // The section a target sits in, by the id of its .bk-sec (null for decisions).
  function sectionOf(t) {
    var sec = t && t.closest('.bk-sec');
    return sec ? sec.id : null;
  }
  function setSection(n, t) {
    var sec = sectionOf(t);
    if (sec) { n.section = sec; } else { delete n.section; }
  }
  // Where a note is drawn: its target, else the heading of its section, else nowhere on this page.
  function anchorOf(n) {
    if (!n) { return null; }
    return byKey(n.target) || (n.section ? byKey(n.section) : null);
  }
  function newId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function migrate() {
    Object.keys(state.notes).forEach(function (k) {
      var n = state.notes[k];
      if (typeof n === 'string' || (n && n.target === undefined)) {
        var text = typeof n === 'string' ? n : n.text;
        delete state.notes[k];
        state.notes[newId()] = { text: text, target: k, rx: 0, ry: 0.5 };
        return;
      }
      // The first sticky design kept the sticky at (nx, ny) on the page; stickies now sit relative to their pin.
      delete n.nx; delete n.ny;
      if (typeof n.dx !== 'number' || isNaN(n.dx) || typeof n.dy !== 'number' || isNaN(n.dy)) { delete n.dx; delete n.dy; }
      delete n.min; // stickies used to fold away; now they always show
      if (typeof n.rx !== 'number' || isNaN(n.rx)) { n.rx = 0; }
      if (typeof n.ry !== 'number' || isNaN(n.ry)) { n.ry = 0.5; }
    });
  }
  function live() { return Object.keys(state.notes).filter(function (id) { return (state.notes[id].text || '').trim(); }); }
  function targetAt(clientX, clientY) {
    var stack = document.elementsFromPoint(clientX, clientY);
    for (var i = 0; i < stack.length; i++) {
      var e = stack[i];
      if (e.closest('.note-layer, .pin, .bar, .side, .notes-panel, .ev-lightbox')) { continue; }
      var t = e.closest('.tgt');
      if (t) { return t; }
      // A review stack or an item's tools belong to the item above them.
      var row = e.closest('.item-row[data-key]');
      var owner = row ? byKey(row.dataset.key) : null;
      if (owner && owner.getClientRects().length) { return owner; }
    }
    var secs = document.querySelectorAll('.bk-sec');
    var best = null;
    // Only a section that is drawn: one hidden in Changes mode has an empty box at the top of the page.
    for (var j = 0; j < secs.length; j++) {
      if (!secs[j].getClientRects().length) { continue; }
      var r = secs[j].getBoundingClientRect();
      if (r.top <= clientY) { best = secs[j]; }
    }
    var h = best ? best.querySelector('h3.tgt') : null;
    return h && h.getClientRects().length ? h : null;
  }
  // The mockup element under a point inside a screen, so Claude gets the exact element and not only the screen:
  // { mockup, selector, text, html }. Null outside a mockup (a screenshot is only an image).
  function mockupElementAt(t, clientX, clientY) {
    var hosts = t.querySelectorAll('.mock');
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i], root = host.shadowRoot;
      var r = host.getBoundingClientRect();
      if (!root || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) { continue; }
      var stack = root.elementsFromPoint(clientX, clientY);
      for (var j = 0; j < stack.length; j++) {
        var e = stack[j];
        if (e.getRootNode() === root && e.tagName !== 'STYLE') { return describeElement(e, root, host.dataset.mockup); }
      }
    }
    return null;
  }
  function describeElement(e, root, mockup) {
    var parts = [];
    for (var n = e; n && n.parentNode && n !== root; n = n.parentNode) {
      var sig = n.tagName.toLowerCase() + Array.prototype.map.call(n.classList, function (c) { return '.' + c; }).join('');
      var same = Array.prototype.filter.call(n.parentNode.children, function (c) { return c.tagName === n.tagName && c.className === n.className; });
      if (same.length > 1) { sig += ':nth-child(' + (Array.prototype.indexOf.call(n.parentNode.children, n) + 1) + ')'; }
      parts.unshift(sig);
      if (n.parentNode === root) { break; }
    }
    var clip = function (str, max) { str = str.replace(/\s+/g, ' ').trim(); return str.length > max ? str.slice(0, max - 1) + '…' : str; };
    var text = clip(e.textContent || '', 120);
    // An element with no words of its own (a check, an icon) is named by the nearest text around it.
    for (var a = e.parentNode, k = 0; !text && a && a !== root && k < 3; a = a.parentNode, k++) {
      text = clip(a.textContent || '', 120);
      if (text) { text = 'near: ' + text; }
    }
    return { mockup: mockup, selector: parts.join(' > '), text: text, html: clip(e.outerHTML, 400) };
  }
  // Where on its item a pin sits, as fractions of the item's box. Notes from before drops were clamped can hold a
  // spot outside it; they are drawn on the item's nearest edge, so a pin never sits on a neighbor.
  function clamp01(v) { return typeof v === 'number' && !isNaN(v) ? Math.min(1, Math.max(0, v)) : 0; }
  function anchorFor(t, pageX, pageY) {
    var r = t.getBoundingClientRect();
    return { rx: (pageX - window.scrollX - r.left) / Math.max(1, r.width), ry: (pageY - window.scrollY - r.top) / Math.max(1, r.height) };
  }
  function pointOf(n) {
    var t = anchorOf(n);
    // A target hidden by Changes mode has no box: its note is not drawn until it shows again.
    if (!t || !t.getClientRects().length) { return null; }
    var r = t.getBoundingClientRect();
    return { x: r.left + window.scrollX + clamp01(n.rx) * r.width, y: r.top + window.scrollY + clamp01(n.ry) * r.height };
  }
  function grow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  function barBottom() { var b = document.querySelector('.bar'); return b ? b.offsetHeight + 8 : 0; }
  function labelFor(n) { var t = anchorOf(n); return t ? t.dataset.label : 'Not on this page'; }
  function aboutFor(n) { var t = byKey(n.target); return t ? plain(t.dataset.quote) : ''; }
  // Book order: the order of the targets in the document, then top to bottom (then left to right) within one.
  function ordered(withDraft) {
    var idx = {};
    targets().forEach(function (t, i) { if (idx[t.dataset.key] === undefined) { idx[t.dataset.key] = i; } });
    var ids = live();
    if (withDraft && draft && state.notes[draft] && ids.indexOf(draft) < 0) { ids.push(draft); }
    var missing = Object.keys(idx).length;
    return ids.sort(function (a, b) {
      var na = state.notes[a], nb = state.notes[b];
      var ta = anchorOf(na), tb = anchorOf(nb);
      var ia = ta ? idx[ta.dataset.key] : missing;
      var ib = tb ? idx[tb.dataset.key] : missing;
      if (ia !== ib) { return ia - ib; }
      if (na.ry !== nb.ry) { return na.ry - nb.ry; }
      return na.rx - nb.rx;
    });
  }
  // What Revise sends. The panel's preview is built from this too, so it cannot drift.
  function items() {
    return ordered(false).map(function (id) {
      var n = state.notes[id], t = byKey(n.target), at = anchorOf(n);
      var it = { id: n.target, where: at ? at.dataset.label : n.target, about: t ? plain(t.dataset.quote) : '', note: n.text.trim() };
      it.noteId = id;
      if (n.el) { it.element = n.el; }
      if (n.author) { it.by = n.author; }
      return it;
    });
  }
  function requestBody() { return JSON.stringify({ items: items() }); }

  // Pins
  function buildPin(id) {
    var pin = el('button', { type: 'button', class: 'pin' });
    pins[id] = pin;
    pin.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) { return; }
      e.preventDefault(); e.stopPropagation();
      if (noteLocked(id)) { return; }
      // where the pointer holds the pin, from its point (the spot it marks), whichever way the pin is turned
      var at = pointOf(state.notes[id]) || { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
      var gx = e.clientX - (at.x - window.scrollX), gy = e.clientY - (at.y - window.scrollY);
      var sx = e.clientX, sy = e.clientY, moved = false;
      var turn = pin.dataset.rot ? ' rotate(' + pin.dataset.rot + 'deg)' : '';
      try { pin.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers cannot be captured */ }
      function move(ev) {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) { return; }
        if (!moved) {
          moved = true; closePop(false); pin.classList.add('dragging');
          if (stickies[id]) { stickies[id].line.setAttribute('d', ''); }
        }
        pin.style.transform = 'translate(' + (ev.clientX - sx) + 'px,' + (ev.clientY - sy) + 'px)' + turn;
      }
      function up(ev) {
        pin.removeEventListener('pointermove', move);
        pin.removeEventListener('pointerup', up);
        pin.removeEventListener('pointercancel', up);
        if (!moved) { return; }
        justDragged = true;
        setTimeout(function () { justDragged = false; }, 0);
        pin.classList.remove('dragging');
        pin.style.transform = pin.dataset.rot ? 'rotate(' + pin.dataset.rot + 'deg)' : '';
        targets().forEach(function (tt) { tt.classList.remove('note-hover'); });
        var px = ev.clientX - gx, py = ev.clientY - gy;
        var t = targetAt(px, py);
        var n = state.notes[id];
        if (t && n) {
          // The sticky stays where it is on the page: only the pin, and so the arrow, moves.
          var s = stickies[id];
          var sl = s ? parseFloat(s.box.style.left) : NaN, st = s ? parseFloat(s.box.style.top) : NaN;
          n.target = t.dataset.key;
          n.item = t.dataset.item || t.dataset.key;
          setSection(n, t);
          var a = anchorFor(t, px + window.scrollX, py + window.scrollY);
          // A drop beside an item (on its review stack, say) pins it to the item's nearest edge.
          n.rx = Math.min(1, Math.max(0, a.rx)); n.ry = Math.min(1, Math.max(0, a.ry));
          var me = mockupElementAt(t, px, py);
          if (me) { n.el = me; } else { delete n.el; }
          var np = pointOf(n);
          if (np && !isNaN(sl) && !isNaN(st)) { n.dx = sl - np.x; n.dy = st - np.y; }
          saveNotes();
        }
        refresh();
      }
      pin.addEventListener('pointermove', move);
      pin.addEventListener('pointerup', up);
      pin.addEventListener('pointercancel', up);
    });
    pin.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (justDragged) { justDragged = false; return; }
      if (pop && pop.id === id) { return; }
      // A click on a pin does nothing more: it is there to point, and to drag.
    });
    pin.addEventListener('mouseenter', function () { var t = anchorOf(state.notes[id]); if (t) { t.classList.add('note-hover'); } });
    pin.addEventListener('mouseleave', function () { targets().forEach(function (t) { t.classList.remove('note-hover'); }); });
    return pin;
  }
  function drawAll() {
    var order = ordered(true);
    targets().forEach(function (t) { t.classList.remove('has-pin', 'note-target'); });
    Object.keys(pins).forEach(function (id) {
      var pin = pins[id], n = state.notes[id];
      var t = anchorOf(n);
      if (!t) { pin.remove(); return; }
      if (pin.parentNode !== t) { t.appendChild(pin); }
      t.classList.add('has-pin');
      if (id !== draft) { t.classList.add('note-target'); }
      pin.style.left = (clamp01(n.rx) * 100) + '%';
      pin.style.top = (clamp01(n.ry) * 100) + '%';
      var k = order.indexOf(id);
      if (k >= 0) {
        if (!pin.firstChild) { pin.appendChild(el('span', { class: 'pin-n' })); }
        pin.firstChild.textContent = String(k + 1);
        pin.setAttribute('aria-label', 'Note ' + (k + 1) + ' on ' + t.dataset.label);
        pin.title = 'Note ' + (k + 1) + '. Click to fold or show its note, drag to point it at something else.';
      }
      pin.classList.toggle('open', !!(pop && pop.id === id));
      // A pin with a sticky is turned by its arrow (drawArrow). Otherwise (while its note is being written) a pin that
      // would hang past the window's right edge points from its other corner, so it never adds sideways scroll.
      if (id === draft) { turnPin(id, null); }
      pin.classList.remove('flip');
      if (!pin.dataset.rot && pin.offsetParent && pin.getBoundingClientRect().right > document.documentElement.clientWidth - 2) { pin.classList.add('flip'); }
    });
    drawStickies();
    if (pop) { placePop(); }
  }
  var drawQueued = false;
  function drawSoon() {
    if (drawQueued) { return; }
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; drawAll(); });
  }

  // Stickies: every posted note stays up as a sticky, joined by a line to its numbered pin, which is the arrowhead.
  // A sticky is only its text. Press and drag it to move it; click it to edit (Enter or Esc finishes, emptying it
  // deletes the note). A press while editing ends the edit and moves it.
  function buildSticky(id) {
    var box = el('div', { class: 'sticky', role: 'group' });
    // The hidden copy of the text sizes the sticky to its words (up to a width, then it wraps); the textarea lies
    // over it, so typing grows the sticky as it goes.
    box.innerHTML = '<div class="st-size" aria-hidden="true"></div><textarea rows="1" readonly></textarea>' +
      '<button type="button" class="st-del" title="Delete this note" aria-label="Delete this note">\u00d7</button>';
    var ta = box.querySelector('textarea');
    var del = box.querySelector('.st-del');
    var by = authorOf(state.notes[id]);
    var changedBy = changedByOther(state.notes[id]);
    if (by || changedBy) {
      var tag = el('span', { class: 'st-by' });
      tag.textContent = changedBy ? (by ? by + ' · ' : '') + changedBy + ' changed this note' : by;
      box.appendChild(tag);
    }
    if (viewer().guest && noteLocked(id) && !notesLocked()) { box.classList.add('not-mine'); }
    // Deleting is a press on the ×, not part of a drag.
    del.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    del.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!noteLocked(id) && state.notes[id]) { removeNote(id); }
    });
    var line = document.createElementNS(SVG, 'path');
    arrows.appendChild(line);
    stickies[id] = { box: box, ta: ta, line: line };
    layer.appendChild(box);
    ta.addEventListener('input', function () {
      var n = state.notes[id];
      fitSticky(id);
      if (n && ta.value.trim()) { n.text = ta.value; saveNotes(); refreshSoon(); }
      drawStickies();
      noteInput(id, ta.value);
    });
    ta.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        ta.blur();
      }
    });
    ta.addEventListener('focus', function () {
      if (noteLocked(id)) { ta.blur(); return; }
      ta.readOnly = false;
      box.classList.add('editing');
    });
    ta.addEventListener('blur', function () {
      ta.readOnly = true;
      box.classList.remove('editing');
      if (!ta.value.trim() && state.notes[id]) { removeNote(id); }
    });
    box.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) { return; }
      e.preventDefault();
      if (noteLocked(id)) { return; }
      // A press on a sticky being edited ends the edit (keeping the text) and goes straight to moving it; a click
      // that does not drag leaves it ready to move rather than editing again.
      var wasEditing = box.classList.contains('editing');
      if (wasEditing) { ta.blur(); if (!state.notes[id]) { return; } }
      var sx = e.clientX, sy = e.clientY, moved = false;
      var ox = parseFloat(box.style.left) || 0, oy = parseFloat(box.style.top) || 0;
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers cannot be captured */ }
      function move(ev) {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) { return; }
        if (!moved) { moved = true; box.classList.add('dragging'); }
        box.style.left = (ox + ev.clientX - sx) + 'px';
        box.style.top = (oy + ev.clientY - sy) + 'px';
        drawArrow(id);
        var dn = state.notes[id], dp = dn ? pointOf(dn) : null;
        if (dp) { noteInput(id, dn.text, { dx: (parseFloat(box.style.left) || 0) - dp.x, dy: (parseFloat(box.style.top) || 0) - dp.y }); }
      }
      function up() {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        box.removeEventListener('pointercancel', up);
        if (!moved) { if (!wasEditing) { editSticky(id); } return; }
        box.classList.remove('dragging');
        var n = state.notes[id], p = n ? pointOf(n) : null;
        if (p) {
          n.dx = (parseFloat(box.style.left) || 0) - p.x;
          n.dy = (parseFloat(box.style.top) || 0) - p.y;
          saveNotes();
        }
        drawStickies();
      }
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
      box.addEventListener('pointercancel', up);
    });
    return stickies[id];
  }
  function fitSticky(id) {
    var s = stickies[id];
    if (!s) { return; }
    // a zero-width space keeps a trailing new line from collapsing
    s.box.firstChild.textContent = s.ta.value + '\u200b';
  }
  function editSticky(id) {
    var s = stickies[id];
    if (!s || s.box.hidden || noteLocked(id)) { return; }
    s.ta.focus({ preventScroll: true });
    var end = s.ta.value.length;
    s.ta.setSelectionRange(end, end);
  }
  function dropSticky(id) {
    var s = stickies[id];
    if (!s) { return; }
    turnPin(id, null);
    s.box.remove();
    s.line.remove();
    delete stickies[id];
  }
  // Turns a pin about its point, so its head sits on the line from its sticky and its point aims away from it.
  // Unturned, a pin points down and to the left (135 degrees); its number always stays upright.
  function turnPin(id, deg) {
    var pin = pins[id];
    if (!pin) { return; }
    var rot = deg === null ? '' : deg.toFixed(1);
    if (pin.dataset.rot === rot) { return; }
    pin.dataset.rot = rot;
    if (pin.firstChild) { pin.firstChild.style.transform = rot ? 'rotate(' + (-deg).toFixed(1) + 'deg)' : ''; }
    if (rot) { pin.classList.remove('flip'); }
    if (!pin.classList.contains('dragging')) { pin.style.transform = rot ? 'rotate(' + rot + 'deg)' : ''; }
  }
  // A new sticky goes beside its pin, to the right if it fits, else to the left, and below any sticky it would cover.
  function defaultSpot(p, w, h, taken) {
    var vw = document.documentElement.clientWidth, gap = 8;
    var x = p.x + 90;
    if (x + w > vw - gap) { x = p.x - 90 - w; }
    if (x < gap) { x = Math.max(gap, Math.min(p.x, vw - w - gap)); }
    var y = p.y - 70;
    for (var moved = true, guard = 0; moved && guard < 50; guard++) {
      moved = false;
      for (var i = 0; i < taken.length; i++) {
        var r = taken[i];
        if (x < r.x + r.w + gap && x + w + gap > r.x && y < r.y + r.h + gap && y + h + gap > r.y) {
          y = r.y + r.h + gap;
          moved = true;
        }
      }
    }
    return { x: x, y: y };
  }
  function drawStickies() {
    var order = ordered(false);
    Object.keys(stickies).forEach(function (id) { if (order.indexOf(id) < 0) { dropSticky(id); } });
    var vw = document.documentElement.clientWidth;
    var taken = [];
    var changed = false;
    order.forEach(function (id, k) {
      var n = state.notes[id];
      var p = pins[id] && pins[id].isConnected ? pointOf(n) : null;
      var s = stickies[id] || buildSticky(id);
      if (document.activeElement !== s.ta && s.ta.value !== n.text) { s.ta.value = n.text; }
      fitSticky(id);
      var hide = !p || hasOwn(ghosts, id);
      s.box.hidden = hide;
      if (hide) { s.line.setAttribute('d', ''); return; }
      s.box.setAttribute('aria-label', 'Note ' + (k + 1) + ' on ' + labelFor(n));
      s.ta.setAttribute('aria-label', 'Note ' + (k + 1) + ' text');
      if (s.box.classList.contains('dragging')) { return; }
      var w = s.box.offsetWidth, h = s.box.offsetHeight;
      if (typeof n.dx !== 'number') {
        var spot = defaultSpot(p, w, h, taken);
        n.dx = spot.x - p.x; n.dy = spot.y - p.y;
        changed = true;
      }
      // Kept inside the page's width, so a sticky never adds sideways scroll or hides off screen.
      var x = Math.max(8, Math.min(p.x + n.dx, vw - w - 8));
      var y = Math.max(0, p.y + n.dy);
      s.box.style.left = x + 'px';
      s.box.style.top = y + 'px';
      taken.push({ x: x, y: y, w: w, h: h });
      drawArrow(id);
    });
    if (changed) { saveNotes(); }
    drawGhosts();
  }
  // From the nearest point of the sticky's edge to the pin, which is turned to make the arrowhead: its head sits on
  // the line and its point is on the spot the note is about.
  var PIN_REACH = 19.8; // from a pin's point to the middle of its head (a 28px drop)
  var PIN_HEAD = 11; // the head's radius (14), less a little, so the line runs into the head with no seam
  var STICKY_RADIUS = 12; // the sticky's corner radius (book.css)
  function drawArrow(id) {
    var s = stickies[id], n = state.notes[id];
    var p = n ? pointOf(n) : null;
    if (!s || !p || s.box.hidden) { return; }
    var x = parseFloat(s.box.style.left) || 0, y = parseFloat(s.box.style.top) || 0;
    var w = s.box.offsetWidth, h = s.box.offsetHeight;
    // How far the pin's point is outside the sticky: too close, and there is no line to draw.
    var ox = Math.max(x, Math.min(p.x, x + w)), oy = Math.max(y, Math.min(p.y, y + h));
    var gap = Math.sqrt((p.x - ox) * (p.x - ox) + (p.y - oy) * (p.y - oy));
    // The line starts inside the sticky (in from its rounded corners), so it comes out from under it.
    var r = Math.min(STICKY_RADIUS, w / 2, h / 2);
    var sx = Math.max(x + r, Math.min(p.x, x + w - r)), sy = Math.max(y + r, Math.min(p.y, y + h - r));
    var dx = p.x - sx, dy = p.y - sy, d = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / d, uy = dy / d;
    turnPin(id, Math.atan2(uy, ux) * 180 / Math.PI - 135);
    var back = PIN_REACH + PIN_HEAD;
    if (gap < back + 8 || d < back) { s.line.setAttribute('d', ''); return; }
    var ex = p.x - ux * back, ey = p.y - uy * back;
    s.line.setAttribute('d', 'M' + sx.toFixed(1) + ' ' + sy.toFixed(1) + 'L' + ex.toFixed(1) + ' ' + ey.toFixed(1));
  }
  function flash(id) {
    var pin = pins[id];
    if (!pin) { return; }
    pin.classList.remove('flash');
    void pin.offsetWidth;
    pin.classList.add('flash');
    setTimeout(function () { pin.classList.remove('flash'); }, 900);
  }

  // The composer writes a new note; once posted, the note lives on as a sticky.
  function openComposer(id) {
    closePop(false);
    var n = state.notes[id];
    if (!n || !pins[id]) { return; }
    var box = el('div', { class: 'note-pop composer', role: 'dialog' });
    box.setAttribute('aria-label', 'New note on ' + labelFor(n));
    box.innerHTML = '<p class="pop-head"><span class="pop-label"></span></p>' +
      '<textarea rows="2"></textarea>' +
      '<div class="pop-btns"><span class="pop-hint">Enter to post</span><button type="button" class="ghost pop-cancel">Cancel</button><button type="button" class="pop-post">Post</button></div>';
    box.querySelector('.pop-label').textContent = labelFor(n);
    var ta = box.querySelector('textarea');
    ta.setAttribute('aria-label', 'New note on ' + labelFor(n));
    ta.placeholder = 'Add a note';
    ta.value = n.text || '';
    layer.appendChild(box);
    pop = { id: id, kind: 'composer', box: box, ta: ta };
    grow(ta);
    ta.addEventListener('input', function () {
      grow(ta);
      placePop();
      noteInput(id, ta.value);
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        post();
      }
    });
    box.querySelector('.pop-post').addEventListener('click', post);
    box.querySelector('.pop-cancel').addEventListener('click', function () { discard(); });
    drawAll();
    ta.focus({ preventScroll: true });
    var end = ta.value.length;
    ta.setSelectionRange(end, end);
  }
  // Beside the pin, inside the viewport: to the right, or flipped to the left; level with it, or flipped above.
  function placePop() {
    var pin = pins[pop.id];
    if (!pin || !pin.isConnected) { return; }
    var box = pop.box;
    var r = pin.getBoundingClientRect();
    var vw = document.documentElement.clientWidth - (panel.hidden ? 0 : panel.offsetWidth);
    var vh = window.innerHeight;
    var top = barBottom();
    var w = box.offsetWidth, h = box.offsetHeight, gap = 8;
    var x = r.right + gap, y = r.top;
    if (x + w > vw - gap) { x = r.left - w - gap; }
    if (x < gap) {
      // no room on either side: sit under the pin, or above it
      x = Math.max(gap, Math.min(r.left, vw - w - gap));
      y = r.bottom + gap;
      if (y + h > vh - gap) { y = r.top - h - gap; }
    } else if (y + h > vh - gap) {
      y = r.bottom - h;
    }
    y = Math.max(top, Math.min(y, vh - h - gap));
    box.style.left = (x + window.scrollX) + 'px';
    box.style.top = (y + window.scrollY) + 'px';
  }
  // Closing keeps what was typed: the composer's text is posted. An empty note is removed.
  function closePop(refocus) {
    if (!pop) { return; }
    var p = pop;
    pop = null;
    p.box.remove();
    var n = state.notes[p.id];
    if (n) {
      if (p.ta.value.trim()) { n.text = p.ta.value; } else { n.text = ''; }
      if (p.id === draft) { draft = null; }
      if (!n.text.trim()) { dropNote(p.id); } else { saveNotes(); }
    }
    refresh();
    if (refocus && pins[p.id] && pins[p.id].isConnected) { pins[p.id].focus({ preventScroll: true }); }
    resumeRefetch();
  }
  function post() {
    if (!pop) { return; }
    var id = pop.id;
    closePop(false);
    if (state.notes[id]) { flash(id); }
  }
  function discard() {
    if (!pop) { return; }
    pop.ta.value = '';
    closePop(false);
  }
  function dropNote(id) {
    if (pins[id]) { pins[id].remove(); delete pins[id]; }
    dropSticky(id);
    if (draft === id) { draft = null; }
    delete state.notes[id];
    saveNotes();
  }
  function removeNote(id) {
    if (pop && pop.id === id) { pop.box.remove(); pop = null; }
    dropNote(id);
    refresh();
    resumeRefetch();
  }

  // The toolbar, the panel, the print list
  function refresh() {
    var c = live().length;
    var badge = document.getElementById('notes-count');
    badge.textContent = String(c);
    badge.hidden = c === 0;
    notesBtn.title = 'Requests · R (' + c + ' note' + (c === 1 ? '' : 's') + ')';
    document.getElementById('np-tab-notes').textContent = 'Notes ' + c;
    document.getElementById('np-revise').textContent = '\u2726 Send ' + c + ' note' + (c === 1 ? '' : 's') + ' to Claude';
    drawAll();
    showClaude();
    renderPanel();
    renderPrint();
  }
  var soon = 0;
  function refreshSoon() { clearTimeout(soon); soon = setTimeout(refresh, 120); }
  function renderPanel() {
    var list = document.getElementById('np-list');
    var ids = ordered(false);
    // Never rebuild the list under the reader's cursor: a panel edit only refreshes the preview below it.
    var act = document.activeElement;
    var editing = act && act.tagName === 'TEXTAREA' && list.contains(act);
    if (!editing) {
      var hadFocus = list.contains(act);
      list.innerHTML = '';
      ids.forEach(function (id, i) {
        var n = state.notes[id];
        var li = el('li', { class: 'np-note' });
        li.innerHTML = '<button type="button" class="np-go"><span class="np-num"></span><span class="np-where"></span></button>' +
          '<p class="np-about"></p><textarea rows="2"></textarea><div class="np-row"><button type="button" class="linkbtn np-del">Delete</button></div>';
        li.querySelector('.np-num').textContent = String(i + 1);
        li.querySelector('.np-where').textContent = labelFor(n) + (authorOf(n) ? ' \u00b7 ' + authorOf(n) : '');
        li.querySelector('.np-go').setAttribute('aria-label', 'Go to note ' + (i + 1) + ' on ' + labelFor(n));
        var about = aboutFor(n);
        var ab = li.querySelector('.np-about');
        if (about) { ab.textContent = about; ab.title = about; } else { ab.remove(); }
        var ta = li.querySelector('textarea');
        ta.value = n.text;
        ta.readOnly = noteLocked(id);
        li.querySelector('.np-del').disabled = noteLocked(id);
        ta.setAttribute('aria-label', 'Note ' + (i + 1) + ' text');
        ta.addEventListener('input', function () {
          grow(ta);
          if (ta.value.trim()) { n.text = ta.value; saveNotes(); renderPreview(); renderPrint(); drawStickies(); }
        });
        ta.addEventListener('blur', function () {
          // Leave the list alone here, so a click that moved focus out of this box still lands where it was aimed.
          if (!ta.value.trim() && !noteLocked(id)) { removeNote(id); } else { drawAll(); }
        });
        li.querySelector('.np-go').addEventListener('click', function () { goTo(id); });
        li.querySelector('.np-del').addEventListener('click', function () { if (!noteLocked(id)) { removeNote(id); } });
        list.appendChild(li);
        grow(ta);
      });
      if (hadFocus) { panel.focus({ preventScroll: true }); }
    }
    document.getElementById('np-empty').hidden = ids.length > 0;
    renderPreview();
  }
  function renderPreview() {
    var its = items();
    var send = document.getElementById('np-send');
    send.hidden = its.length === 0;
    var ol = document.getElementById('np-items');
    ol.innerHTML = '';
    its.forEach(function (it) {
      var li = el('li', {});
      li.innerHTML = '<dl><dt>Where</dt><dd class="np-i-where"></dd><dt>About</dt><dd class="np-i-about"></dd>' +
        (it.element ? '<dt>Element</dt><dd class="np-i-el"><code></code><span></span></dd>' : '') + '<dt>Note</dt><dd class="np-i-note"></dd></dl>';
      if (it.element) {
        li.querySelector('.np-i-el code').textContent = it.element.selector;
        li.querySelector('.np-i-el span').textContent = it.element.text ? ' “' + it.element.text + '”' : '';
      }
      li.querySelector('.np-i-where').textContent = it.where;
      li.querySelector('.np-i-about').textContent = it.about || '(the whole of it)';
      li.querySelector('.np-i-note').textContent = it.note;
      ol.appendChild(li);
    });
    document.getElementById('np-json').textContent = requestBody();
  }
  function renderPrint() {
    var its = items();
    printList.innerHTML = '';
    if (!its.length) { return; }
    printList.appendChild(el('h2', {}, 'Notes'));
    var ol = el('ol', {});
    its.forEach(function (it) {
      var li = el('li', {});
      li.appendChild(el('p', { class: 'pn-where' }, esc(it.where)));
      li.appendChild(el('p', { class: 'pn-note' }, esc(it.note)));
      ol.appendChild(li);
    });
    printList.appendChild(ol);
  }
  // Glides to a note over a second or so (instantly when the reader prefers less motion), then flashes its pin and
  // puts the cursor in its sticky.
  function goTo(id) {
    var pin = pins[id], n = state.notes[id];
    if (!pin || !pin.isConnected || !n) { return; }
    glideTo(pin, function () { flash(id); editSticky(id); });
  }
  // Glides a node to the middle of the window below the bar, then calls land. A node already in view is not moved.
  var glide = 0;
  function glideTo(node, land) {
    var r = node.getBoundingClientRect();
    var top = barBottom(), vh = window.innerHeight;
    cancelAnimationFrame(glide);
    if (r.top >= top && r.bottom <= vh - 8) { land(); return; }
    var from = window.scrollY;
    var max = document.documentElement.scrollHeight - vh;
    var to = Math.max(0, Math.min(max, from + r.top - (top + (vh - top) / 2)));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo({ top: to, behavior: 'instant' });
      land();
      return;
    }
    var ms = Math.min(1600, 900 + Math.abs(to - from) / 10), start = 0;
    // A wheel, touch or key from the reader takes over: the glide stops where it is.
    var stop = function () { cancelAnimationFrame(glide); off(); };
    var off = function () { ['wheel', 'touchstart', 'keydown'].forEach(function (t) { window.removeEventListener(t, stop); }); };
    ['wheel', 'touchstart', 'keydown'].forEach(function (t) { window.addEventListener(t, stop, { passive: true, once: true }); });
    var step = function (now) {
      if (!start) { start = now; }
      var t = Math.min(1, (now - start) / ms);
      var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      window.scrollTo({ top: from + (to - from) * e, behavior: 'instant' });
      if (t < 1) { glide = requestAnimationFrame(step); } else { off(); land(); }
    };
    glide = requestAnimationFrame(step);
  }
  function setPanel(open) {
    if (open === !panel.hidden) { return; }
    if (open) { setReviewPanel(false); }
    panel.hidden = !open;
    notesBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      renderPanel();
      panel.focus({ preventScroll: true });
    } else if (panel.contains(document.activeElement) || document.activeElement === document.body) {
      notesBtn.focus({ preventScroll: true });
    }
    if (pop) { placePop(); }
  }
  notesBtn.addEventListener('click', function () { setPanel(panel.hidden); });
  document.getElementById('np-close').addEventListener('click', function () { setPanel(false); });
  document.getElementById('np-revise').addEventListener('click', function () { document.getElementById('revise').click(); });

  function renderNotes() {
    var before = JSON.stringify(state.notes);
    migrate();
    if (pop) { pop.box.remove(); pop = null; }
    draft = null;
    Object.keys(state.notes).forEach(function (id) { if (!(state.notes[id].text || '').trim()) { delete state.notes[id]; } });
    Object.keys(pins).forEach(function (id) { pins[id].remove(); });
    pins = {};
    Object.keys(stickies).forEach(dropSticky);
    live().forEach(buildPin);
    refresh();
    if (JSON.stringify(state.notes) !== before) { saveNotes(); }
  }
  window.addEventListener('resize', drawSoon);
  // Mockups, screenshots and fonts settle after the first draw and move the pins; the stickies follow.
  if (window.ResizeObserver) { new ResizeObserver(drawSoon).observe(main); }

  // Comment mode
  var mode = document.getElementById('mode');
  function setHot(t) {
    if (hot === t) { return; }
    if (hot) { hot.classList.remove('tgt-hot'); }
    hot = t;
    if (hot) { hot.classList.add('tgt-hot'); }
  }
  function setCommenting(on) {
    if (on && notesLocked()) { return; }
    commenting = on;
    mode.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('commenting', on);
    if (!on) { setHot(null); }
  }
  // Clicks on the book itself, not the bar, the contents, the notes, the panels, the build banner or the book's own
  // controls (the stage buttons, an item's row with its tools and review stack).
  function inBook(e) {
    var t = e.target;
    if (!t || !t.closest) { return false; }
    return !t.closest('.bar, .side, .note-layer, .pin, .notes-panel, .ev-lightbox, .out, .build-banner, .stage-btn, .item-row, .add-req, .stage-msg, .rv-acts') && !!t.closest('main');
  }
  mode.addEventListener('click', function () { setCommenting(!commenting); });
  ['pointerdown', 'mousedown'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      // In comment mode a press on the book neither focuses, selects nor starts anything.
      if (commenting && e.button === 0 && inBook(e)) { e.preventDefault(); }
    }, true);
  });
  document.addEventListener('pointermove', function (e) {
    if (!commenting) { return; }
    setHot(inBook(e) ? targetAt(e.clientX, e.clientY) : null);
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (justDragged) { justDragged = false; e.preventDefault(); e.stopPropagation(); return; }
    if (t && t.closest && (t.closest('.note-pop') || t.closest('.pin'))) { return; }
    var book = inBook(e);
    if (pop) {
      // A click elsewhere closes the open composer or card, keeping what was typed. On the book it does nothing else.
      closePop(false);
      if (book && commenting) { e.preventDefault(); e.stopPropagation(); return; }
    }
    if (!commenting || !book) { return; }
    e.preventDefault(); e.stopPropagation();
    var tg = targetAt(e.clientX, e.clientY);
    if (!tg) { return; }
    var a = anchorFor(tg, e.clientX + window.scrollX, e.clientY + window.scrollY);
    var id = newId();
    state.notes[id] = { text: '', item: tg.dataset.item || tg.dataset.key, target: tg.dataset.key, rx: a.rx, ry: a.ry, created: new Date().toISOString() };
    if (viewer().guest) { state.notes[id].author = viewer().name; state.notes[id].mine = true; }
    setSection(state.notes[id], tg);
    var me = mockupElementAt(tg, e.clientX, e.clientY);
    if (me) { state.notes[id].el = me; }
    draft = id;
    buildPin(id);
    drawAll();
    openComposer(id);
  }, true);
  document.addEventListener('keydown', function (e) {
    if (document.querySelector('.ev-lightbox')) { return; }
    if (e.key === 'Escape') {
      if (pop) { e.preventDefault(); discard(); mode.focus({ preventScroll: true }); return; }
      if (!panel.hidden) { e.preventDefault(); setPanel(false); return; }
      if (!reviewPanel.hidden) { e.preventDefault(); setReviewPanel(false); return; }
      if (commenting) { e.preventDefault(); setCommenting(false); }
      return;
    }
    var t = e.target;
    var typing = t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    if (typing || e.ctrlKey || e.metaKey || e.altKey || e.repeat) { return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setCommenting(!commenting); }
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); nextChange(false); }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); prevChange(); }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setDiff(!state.diff); }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setPanel(panel.hidden); }
  });

  // The send message clears itself after a while, or when clicked.
  var msgTimer = 0;
  var msgEl = document.getElementById('make-msg');
  msgEl.addEventListener('click', function () { msgEl.textContent = ''; });
  new MutationObserver(function () {
    clearTimeout(msgTimer);
    if (msgEl.textContent && msgEl.textContent !== 'Sending…') { msgTimer = setTimeout(function () { msgEl.textContent = ''; }, 12000); }
  }).observe(msgEl, { childList: true, characterData: true, subtree: true });

  // The Claude group --------------------------------------------------------------------------------
  // Revise sends every note to Claude; Build builds every section marked Ready. While Claude is busy both are off,
  // and while it is revising the notes are locked. Claude's state is polled: often while it is busy, now and then
  // while it is idle. When it goes back to idle, the book is fetched again, since Claude has changed it.
  var reviseBtn = document.getElementById('revise');
  var buildBtn = document.getElementById('build');
  var claudeStatus = document.getElementById('claude-status');
  var pollTimer = 0;
  function anyReady() {
    return ((state.book && state.book.chapters) || []).some(function (ch) {
      return (ch.sections || []).some(function (s) { return s.stage === 'ready'; });
    });
  }
  function busyText(c) {
    if (c.state === 'revising') { return 'Revising…'; }
    if (c.state !== 'building') { return ''; }
    var task = c.build && c.build.state === 'running' ? c.build.task : null;
    return task ? 'Building · task ' + task.index + ' of ' + task.of : 'Building…';
  }
  function showClaude() {
    var c = state.claude;
    var busy = c.state !== 'idle';
    var locked = notesLocked();
    var wasLocked = document.body.classList.contains('locked-notes');
    reviseBtn.disabled = busy || live().length === 0;
    buildBtn.disabled = busy || !anyReady();
    document.getElementById('np-revise').disabled = reviseBtn.disabled;
    claudeStatus.textContent = busyText(c);
    document.getElementById('claude-busy').textContent = busy ? ' \u00b7 ' + busyText(c) : '';
    document.getElementById('claude-btn').classList.toggle('busy', busy);
    reviseBtn.querySelector('small').textContent = reviseBtn.disabled && !busy ? 'No notes to send yet.' : 'Send your ' + live().length + ' note' + (live().length === 1 ? '' : 's') + '. Claude revises the book and you review each change.';
    buildBtn.querySelector('small').textContent = buildBtn.disabled && !busy ? 'No section is marked Ready.' : 'Build the sections marked Ready, with tests as evidence.';
    document.querySelectorAll('.stage-btn').forEach(function (b) { b.hidden = busy; });
    // The page's edits write the book, which is locked while Claude works.
    document.querySelectorAll('.edit-ctl').forEach(function (b) {
      var formOpen = b.classList.contains('add-req-btn') && !!b.parentNode.querySelector('.req-form');
      b.hidden = busy || formOpen;
    });
    document.querySelectorAll('.rf-save').forEach(function (b) { b.disabled = reviewBusy() || !!b.closest('.req-form').dataset.saving; });
    showReviewButtons();
    mode.disabled = locked;
    document.body.classList.toggle('locked-notes', locked);
    if (locked && !wasLocked) {
      // Anything being written is kept on the page, but the notes cannot change until Claude has worked through them.
      setCommenting(false);
      var act = document.activeElement;
      if (act && act.tagName === 'TEXTAREA' && (layer.contains(act) || panel.contains(act))) { act.blur(); }
      if (pop) { pop.box.remove(); pop = null; }
      if (draft) { dropNote(draft); drawAll(); }
    }
    if (locked !== wasLocked && !panel.hidden) { renderPanel(); }
    showBuild();
  }
  function setClaude(c) {
    var wasBusy = state.claude.state !== 'idle';
    var lastAt = state.bookAt;
    state.claude = c || { state: 'idle' };
    state.bookAt = state.claude.bookAt;
    // Drawn again when Claude finishes, or when the book or a mockup changed on disk since the last poll.
    if ((wasBusy && state.claude.state === 'idle') || (lastAt && state.bookAt && state.bookAt !== lastAt)) {
      refetchBook();
    } else if (typeof state.claude.notesRev === 'number' && state.claude.notesRev > state.notesRev && !writingNote() && !dragging()) {
      // Someone else saved notes (a guest of a shared book, or another tab): take theirs, keeping this page's own.
      reloadNotes('');
    }
    showClaude();
  }
  function dragging() { return !!document.querySelector('.pin.dragging, .sticky.dragging'); }
  // One poll at a time: a poll asked for while one is out runs once that one is answered, and only one timer waits.
  var polling = false;
  var pollAgain = false;
  function pollClaude() {
    clearTimeout(pollTimer);
    if (polling) { pollAgain = true; return; }
    polling = true;
    fetch('/api/claude', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(setClaude)
      .catch(function () { /* unreachable: try again later */ })
      .then(function () {
        polling = false;
        clearTimeout(pollTimer);
        if (pollAgain) { pollAgain = false; pollClaude(); return; }
        pollTimer = setTimeout(pollClaude, state.claude.state === 'idle' ? 5000 : 3000);
      });
  }
  // guest.js asks for a poll at once when the host says the book or its notes changed.
  window.SpecBook = {
    poll: pollClaude,
    // Notes changed on disk (someone saved): loaded now, unless a note is being written here, which waits.
    reloadNotes: function () {
      if (writingNote()) { refetchWaiting = true; return; }
      if (!notesDirty && !saveTimer) { reloadNotes(''); }
    },
    me: function () { var v = viewer(); return { guest: !!v.guest, name: v.name || (state.owner && state.owner.name) || 'Owner' }; },
    noteOf: function (id) { return hasOwn(state.notes, id) ? state.notes[id] : null; },
    onNoteInput: function (fn) { inputWatchers.push(fn); },
    showDraft: showDraft,
    clearDraft: clearDraft,
    anchor: function () { return liveAnchor(); },
    scrollTo: function (a, smooth) { scrollToAnchor(a, smooth); },
    view: function () { return currentView(); },
    setView: function (v, transient) { applyView(v, transient); },
    onUserScroll: function (fn) { scrollWatchers.push(fn); },
  };
  function postJson(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function copyInstead(its) {
    var text = 'Changes requested from the spec book. Work through them with me, then update the book.\n\n```json\n' + JSON.stringify(its, null, 2) + '\n```';
    var o = document.getElementById('out');
    o.value = text; o.classList.add('show'); o.focus({ preventScroll: true }); o.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (ok) { o.classList.remove('show'); }
    msgEl.textContent = ok ? 'Server unreachable: copied instead. Paste it into Claude.' : 'Server unreachable: copy the text in the box and paste it into Claude.';
  }
  reviseBtn.addEventListener('click', function () {
    closePop(false);
    if (reviseBtn.disabled) { return; }
    var its = items();
    var ids = ordered(false);
    msgEl.textContent = 'Sending…';
    var reached = false;
    flushNotes().then(function () { return postJson('/api/revise', { items: its, noteIds: ids }); })
      .then(function (res) {
        reached = true;
        if (!res.ok) { throw new Error(res.j.error || 'failed'); }
        msgEl.textContent = 'Sent ' + res.j.count + ' to Claude (' + res.j.file + ').';
        // The sent notes leave their stickies for the review stacks of their items.
        refetchBook();
        pollClaude();
      })
      .catch(function (e) {
        if (!reached) { copyInstead(its); return; }
        msgEl.textContent = e.message === 'busy' ? 'Claude is busy; try again when it is done.' : 'Could not send: ' + e.message + '.';
        pollClaude();
      });
  });
  buildBtn.addEventListener('click', function () {
    if (buildBtn.disabled) { return; }
    msgEl.textContent = 'Sending…';
    postJson('/api/build')
      .then(function (res) {
        if (!res.ok) {
          msgEl.textContent = res.j.error === 'busy' ? 'Claude is busy; try again when it is done.' :
            res.j.error === 'nothing-ready' ? 'No section is marked Ready.' : 'Could not start the build: ' + (res.j.error || 'failed') + '.';
        } else {
          msgEl.textContent = 'Build sent to Claude (' + res.j.file + ').';
        }
        pollClaude();
      })
      .catch(function () { msgEl.textContent = 'Server unreachable: the build was not sent.'; });
  });

  // The build banner, live requirement status and the review of calls -------------------------------------
  // While a build runs, the banner under the bar follows it, and each requirement it builds is marked with its status.
  // Both are patched on each poll, without drawing the book again. Once the build is over and has calls waiting, the
  // banner opens the review list, where each call is accepted or rejected with a note.
  var banner = document.getElementById('build-banner');
  var reviewPanel = document.getElementById('review-panel');
  var reviewList = document.getElementById('rp-list');
  var LIVE = { queued: '○ queued', in_progress: '◐ in progress', proven: '✓ proven', failed: '✗ failed' };
  var LIVE_CLASSES = Object.keys(LIVE).map(function (k) { return 'live-' + k; });
  var reviewed = []; // the calls the review list shows, in the order they came; decided ones stay to show the outcome
  var rejectDrafts = {}; // call id -> the rejection note being written, kept across redraws
  var reviewKey = '';
  function runningBuild() {
    var b = state.claude.build;
    return b && b.state === 'running' ? b : null;
  }
  // h:mm am/pm, in the reader's own time.
  function timeOfDay(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'am' : 'pm');
  }
  function bannerHtml() {
    var c = state.claude, b = runningBuild();
    if (b) {
      var task = b.task;
      var reqs = b.requirements || {};
      var ids = Object.keys(reqs);
      var proven = ids.filter(function (id) { return reqs[id] && reqs[id].status === 'proven'; }).length;
      var calls = (c.calls || []).filter(function (x) { return x.build === b.id; }).length;
      var html = '<p class="bb-head">Building · started ' + esc(timeOfDay(b.startedAt)) + (task ? ' · task ' + esc(task.index) + ' of ' + esc(task.of) : '') + '</p>';
      if (task) {
        var sec = task.section && state.book ? findSection(task.section) : null;
        html += '<p>Now: ' + esc(sec ? sec.title : task.title) + (task.req ? ' (' + esc(task.req) + ')' : '') + '</p>';
      }
      html += '<p>Proven ' + proven + '/' + ids.length + ' requirements · Calls so far: ' + calls + '</p>';
      if (c.stale) {
        html += '<p class="bb-stale">Build may have stopped <button type="button" class="bb-stop">Mark as stopped</button></p>';
      }
      return html;
    }
    if (c.state === 'building' && c.stale) {
      // A build was asked for, but nothing has been written for it in 10 minutes.
      return '<p class="bb-head">Build requested</p><p class="bb-stale">Build may have stopped <button type="button" class="bb-stop">Mark as stopped</button></p>';
    }
    if (c.review) {
      return '<button type="button" class="bb-review" aria-controls="review-panel" aria-expanded="' + String(!reviewPanel.hidden) + '">Review calls (' + esc(c.review.pending) + ')</button>';
    }
    return '';
  }
  // Only rewritten when it changes, so a press on one of its buttons is never lost to a poll.
  var bannerShown = '';
  function showBanner() {
    var html = bannerHtml();
    if (html !== bannerShown) { banner.innerHTML = html; bannerShown = html; }
    banner.hidden = !html;
    banner.classList.toggle('review', html.indexOf('bb-review') !== -1);
  }
  function showLive() {
    var b = runningBuild();
    var reqs = b ? (b.requirements || {}) : {};
    document.querySelectorAll('.live-mark').forEach(function (m) {
      var li = m.closest('li');
      if (li && reqs[li.id] && LIVE[reqs[li.id].status]) { return; }
      m.remove();
      if (li) { LIVE_CLASSES.forEach(function (k) { li.classList.remove(k); }); }
    });
    Object.keys(reqs).forEach(function (id) {
      var status = reqs[id] && reqs[id].status;
      var li = document.getElementById(id);
      var box = li && li.tagName === 'LI' ? li.querySelector(':scope > div') : null;
      if (!box || !LIVE[status]) { return; }
      var mark = box.querySelector('.live-mark');
      if (!mark) {
        mark = el('span', { class: 'live-mark' });
        box.insertBefore(mark, box.firstChild);
      }
      mark.textContent = LIVE[status];
      LIVE_CLASSES.forEach(function (k) { li.classList.toggle(k, k === 'live-' + status); });
    });
  }
  function showBuild() {
    showBanner();
    showLive();
    if (!reviewPanel.hidden) { renderReview(); }
  }

  // Fails the running build, or, with no build running, files the build request that never got going.
  function markStopped(btn) {
    var b = runningBuild();
    if (btn.disabled || (!b && !state.claude.stale)) { return; }
    btn.disabled = true;
    postJson(b ? '/api/builds/' + encodeURIComponent(b.id) + '/stop' : '/api/builds/pending/cancel')
      .then(function (res) {
        if (!res.ok) {
          btn.disabled = false;
          msgEl.textContent = 'Could not mark the build as stopped: ' + (res.j.error || 'failed') + '.';
        }
        return refetchBook();
      })
      .then(pollClaude)
      .catch(function () { btn.disabled = false; msgEl.textContent = 'Server unreachable: the build was not marked as stopped.'; });
  }
  banner.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) { return; }
    var stop = t.closest('.bb-stop');
    if (stop) { markStopped(stop); return; }
    if (t.closest('.bb-review')) { setReviewPanel(reviewPanel.hidden); }
  });

  // The review list: the pending calls of the builds under review, plus the ones decided here, in arrival order.
  function mergeCalls() {
    var c = state.claude;
    var builds = ((c.review && c.review.builds) || []).map(function (b) { return b.build; });
    var pending = (c.calls || []).filter(function (x) { return builds.indexOf(x.build) !== -1; });
    var ids = pending.map(function (x) { return x.id; });
    reviewed = reviewed.filter(function (x) { return x.status !== 'pending' || ids.indexOf(x.id) !== -1; });
    pending.forEach(function (x) {
      for (var i = 0; i < reviewed.length; i++) {
        if (reviewed[i].id === x.id) {
          if (reviewed[i].status === 'pending') { reviewed[i] = x; }
          return;
        }
      }
      reviewed.push(x);
    });
  }
  function aboutLink(call, rid) {
    var a = el('a', { href: '#' + rid });
    a.textContent = rid;
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var t = document.getElementById(rid) || document.getElementById(call.section);
      if (!t) { return; }
      glideTo(t, function () {
        t.classList.remove('req-flash');
        void t.offsetWidth;
        t.classList.add('req-flash');
        setTimeout(function () { t.classList.remove('req-flash'); }, 1600);
      });
    });
    return a;
  }
  function decide(call, decision, li) {
    var note = decision === 'reject' ? (rejectDrafts[call.id] || '').trim() : '';
    li.querySelectorAll('button, textarea').forEach(function (x) { x.disabled = true; });
    postJson('/api/builds/' + encodeURIComponent(call.build) + '/calls/' + encodeURIComponent(call.id), { decision: decision, note: note })
      .then(function (res) {
        if (res.ok) {
          var done = res.j;
          done.build = call.build;
          reviewed = reviewed.map(function (x) { return x.id === call.id ? done : x; });
          delete rejectDrafts[call.id];
        } else if (res.j.error === 'decided') {
          msgEl.textContent = 'That call was already decided.';
        } else {
          msgEl.textContent = res.j.error === 'note-required' ? 'Say what you want instead before rejecting the call.' :
            res.j.error === 'locked' ? 'Claude is busy; the book is locked until it is done.' : 'Could not review the call: ' + (res.j.error || 'failed') + '.';
          reviewKey = '';
        }
        // The review changes the book (a decision, a reopened requirement) and the notes.
        return refetchBook();
      })
      .then(pollClaude)
      .catch(function () { reviewKey = ''; renderReview(); msgEl.textContent = 'Server unreachable: the call was not reviewed.'; });
  }
  function callItem(call, busy) {
    var li = el('li', { class: 'np-note rp-call ' + call.status });
    var h = el('h3', { class: 'rp-title' });
    h.textContent = call.title || call.id;
    li.appendChild(h);
    var body = el('p', { class: 'rp-body' });
    body.textContent = call.body || '';
    li.appendChild(body);
    var about = el('p', { class: 'rp-about' });
    about.appendChild(document.createTextNode('About '));
    (call.about || []).forEach(function (rid, i) {
      if (i) { about.appendChild(document.createTextNode(', ')); }
      about.appendChild(aboutLink(call, rid));
    });
    li.appendChild(about);
    if (call.status !== 'pending') {
      var out = el('p', { class: 'rp-outcome' });
      out.textContent = call.status === 'accepted' ? 'Accepted' : 'Rejected';
      if (call.status === 'rejected' && call.note) {
        var why = el('span', { class: 'rp-note' });
        why.textContent = ' · ' + call.note;
        out.appendChild(why);
      }
      li.appendChild(out);
      return li;
    }
    var ta = el('textarea', { rows: '2', placeholder: 'To reject it, say what you want instead' });
    ta.setAttribute('aria-label', 'Why reject “' + (call.title || call.id) + '”, and what you want instead');
    ta.value = rejectDrafts[call.id] || '';
    ta.disabled = busy;
    li.appendChild(ta);
    var row = el('div', { class: 'np-row rp-row' });
    var accept = el('button', { type: 'button', class: 'rp-accept' });
    accept.textContent = 'Accept';
    accept.disabled = busy;
    var reject = el('button', { type: 'button', class: 'rp-reject' });
    reject.textContent = 'Reject';
    reject.disabled = busy || !ta.value.trim();
    ta.addEventListener('input', function () {
      grow(ta);
      rejectDrafts[call.id] = ta.value;
      reject.disabled = busy || !ta.value.trim();
    });
    accept.addEventListener('click', function () { if (!accept.disabled) { decide(call, 'accept', li); } });
    reject.addEventListener('click', function () { if (!reject.disabled) { decide(call, 'reject', li); } });
    row.appendChild(accept);
    row.appendChild(reject);
    li.appendChild(row);
    return li;
  }
  // Rebuilt only when what it shows has changed, and never under the reader's cursor.
  function renderReview() {
    mergeCalls();
    // The book is locked while Claude works, and a review writes to it.
    var busy = state.claude.state !== 'idle';
    var key = JSON.stringify([reviewed, busy]);
    var act = document.activeElement;
    if (key === reviewKey || (act && act.tagName === 'TEXTAREA' && reviewList.contains(act))) { return; }
    reviewKey = key;
    var hadFocus = reviewList.contains(act);
    reviewList.innerHTML = '';
    reviewed.forEach(function (call) {
      reviewList.appendChild(callItem(call, busy));
    });
    if (!reviewed.length) { reviewList.appendChild(el('li', { class: 'np-empty' }, 'No calls to review.')); }
    reviewList.querySelectorAll('textarea').forEach(grow);
    if (hadFocus) { reviewPanel.focus({ preventScroll: true }); }
  }
  function setReviewPanel(open) {
    if (open === !reviewPanel.hidden) { return; }
    if (open) { setPanel(false); }
    reviewPanel.hidden = !open;
    if (open) {
      reviewKey = '';
      renderReview();
      reviewPanel.focus({ preventScroll: true });
    } else if (reviewPanel.contains(document.activeElement) || document.activeElement === document.body) {
      var back = banner.querySelector('.bb-review');
      (back || notesBtn).focus({ preventScroll: true });
    }
    showBanner();
    if (pop) { placePop(); }
  }
  document.getElementById('rp-close').addEventListener('click', function () { setReviewPanel(false); });

  // Layout: the sidebar sits under the design bar, whose height changes as it wraps.
  function barHeight() { var b = document.querySelector('.bar'); document.documentElement.style.setProperty('--barh', (b ? b.offsetHeight : 0) + 'px'); }
  window.addEventListener('resize', barHeight);
  // The bar also grows when its own contents change (note counts, the send message), not only on resize.
  if (window.ResizeObserver) { new ResizeObserver(barHeight).observe(document.querySelector('.bar')); }
  barHeight();
  document.getElementById('toc').addEventListener('click', function () { setTimeout(barHeight, 0); });

  // Screens view --------------------------------------------------------------------------------------
  // View: Mockups and Screenshots (both is "both"; one always stays checked), Recordings, Coverage.
  var viewMock = document.getElementById('view-mock');
  var viewShot = document.getElementById('view-shot');
  function viewFromChecks() {
    if (!viewMock.checked && !viewShot.checked) { return null; }
    return viewMock.checked && viewShot.checked ? 'both' : viewShot.checked ? 'shot' : 'mockup';
  }
  [viewMock, viewShot].forEach(function (box) {
    box.addEventListener('change', function () {
      var v = viewFromChecks();
      if (!v) { box.checked = true; return; }
      state.view = v;
      store('spec-book-view', state.view);
      var y = window.scrollY;
      render();
      window.scrollTo(0, y);
    });
  });
  function syncViewControls() {
    viewMock.checked = state.view !== 'shot';
    viewShot.checked = state.view !== 'mockup';
  }
  var cover = document.getElementById('show-coverage');
  cover.addEventListener('change', function () { document.body.classList.toggle('coverage', cover.checked); store('spec-book-coverage', cover.checked ? '1' : '0'); });
  var vid = document.getElementById('show-videos');
  vid.addEventListener('change', function () { document.body.classList.toggle('hide-videos', !vid.checked); store('spec-book-videos', vid.checked ? '1' : '0'); });

  // Fetches the book, with every mockup (and the stylesheet, so it is cached) loaded before drawing, so anchors land
  // where they point.
  // With merge, notes changed on this page and not yet saved are kept (see mergeNotes).
  function fetchBook(merge) {
    return fetch('/api/book', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (data) {
      var paths = [];
      (data.book.chapters || []).forEach(function (ch) { (ch.sections || []).forEach(function (s) { (s.frames || []).forEach(function (f) { if (f.mockup) { paths.push(f.mockup); } }); }); });
      var mockups = {};
      var loads = paths.map(function (p) {
        return fetch('/data/' + p, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (t) { if (t !== null) { mockups[p] = t; } });
      });
      if (data.book.mockupCss) {
        loads.push(fetch('/data/' + data.book.mockupCss, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) { state.mockupCss = t; }));
      }
      var prevClaude = state.claude;
      var review = data.review || { rev: 0, accepted: {}, notes: {}, tries: {}, opened: {}, where: {} };
      var counts = data.historyCounts || {};
      return Promise.all(loads).then(function () {
        // A reversal warning needs the history of the items under review that have any: those are loaded too.
        var under = window.SpecModel.reviews(data.book, mockups, review, null).byKey;
        var items = {};
        var keys = Object.keys(under).filter(function (k) { return hasOwn(counts, k) && counts[k] > 0; });
        return Promise.all(keys.map(function (k) {
          return fetch('/api/history/' + encodeURIComponent(k), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : { entries: [] }; })
            .then(function (j) { items[k] = j.entries || []; })
            .catch(function () { /* no history: no reversal warning for it */ });
        })).then(function () { return items; });
      }).then(function (items) {
        state.book = data.book;
        // Settings in book.json: the width of the screenshot column beside a requirement, in pixels.
        var shotW = data.book && data.book.settings && Number(data.book.settings.screenshotWidth);
        document.documentElement.style.setProperty('--shot-w', (shotW > 0 ? shotW : 100) + 'px');
        state.media = data.media || [];
        state.evidence = data.evidence || {};
        state.mockups = mockups;
        state.review = review;
        state.history = { items: items };
        state.historyCounts = counts;
        state.changelog = data.changelog || [];
        state.noteKey = 'spec-book-notes:' + (data.book.title || 'book');
        state.viewer = data.viewer || { guest: false };
        state.owner = data.owner || { name: 'Owner' };
        document.body.classList.toggle('guest', !!state.viewer.guest);
        if (merge) { mergeNotes(review); } else { setNotes(review); }
        // The book's copy of Claude's state has no calls: the last poll's stand until the next one.
        state.claude = data.claude || { state: 'idle' };
        if (!state.claude.calls) { state.claude.calls = (prevClaude && prevClaude.calls) || []; }
        return data;
      });
    });
  }
  // After Claude has changed the book: draw it again where the reader is. Notes waiting to be saved are sent first,
  // and while a note is being written (a composer, a sticky or a panel box has the cursor) the book is not drawn
  // again: that waits until the writing ends (resumeRefetch).
  var refetchWaiting = false;
  function writingNote() {
    if (pop) { return true; }
    var act = document.activeElement;
    if (act && /^(INPUT|SELECT|TEXTAREA)$/.test(act.tagName) && act.closest && act.closest('.inline-editor')) { return true; }
    return !!(act && act.tagName === 'TEXTAREA' && (layer.contains(act) || panel.contains(act)));
  }
  function refetchBook() {
    if (writingNote()) { refetchWaiting = true; return Promise.resolve(); }
    return flushNotes().then(function () { return fetchBook(true); }).then(function () {
      if (writingNote()) { refetchWaiting = true; return; }
      renderInPlace();
    }).catch(function (e) { console.error(e); });
  }
  function resumeRefetch() {
    // After the event that ended the writing has run, so its own changes to the notes are in.
    setTimeout(function () {
      if (refetchWaiting && !writingNote()) { refetchWaiting = false; refetchBook(); }
    }, 0);
  }
  document.addEventListener('focusout', resumeRefetch, true);
  // Notes drafted before they were kept on the server are moved there once, then dropped from this browser. The
  // browser's copy is dropped only once the server has saved them; otherwise the import is tried again next load.
  var importing = false; // notes from localStorage not yet saved: the key goes once a save of them lands
  function importLocalNotes() {
    var local = store(state.noteKey);
    if (!local || notesLocked()) { return; }
    var parsed;
    try { parsed = JSON.parse(local) || {}; } catch (e) { parsed = {}; }
    if (Object.keys(state.notes).length) {
      // Saved already (a retry, or the save as the last page closed, got them there): the key has done its job.
      if (Object.keys(parsed).every(function (id) { return hasOwn(state.notes, id); })) { store(state.noteKey, null); }
      return;
    }
    state.notes = parsed;
    importing = true;
    renderNotes();
    Object.keys(state.notes).forEach(function (id) {
      var n = state.notes[id];
      var t = byKey(n.target);
      if (t) { setSection(n, t); n.item = t.dataset.item || t.dataset.key; }
      if (!n.created) { n.created = new Date().toISOString(); }
    });
    saveNotes();
    flushNotes();
  }

  // Changes: the open reviews, each with its stack, hiding the sections and chapters that have none.
  var changesBtn = document.getElementById('changes-btn');
  var nextBtn = document.getElementById('next-chg');
  var prevBtn = document.getElementById('prev-chg');
  var sentToggle = document.getElementById('sent-toggle');
  var showSent = document.getElementById('show-sent');
  function updateChangesBar() {
    var n = state.reviews ? state.reviews.count : 0;
    changesBtn.setAttribute('aria-pressed', String(state.diff));
    changesBtn.classList.toggle('has-chg', n > 0);
    changesBtn.title = n ? 'Show only changes · F' : 'Show only changes · F (nothing to review)';
    nextBtn.disabled = n === 0;
    prevBtn.disabled = n === 0;
    document.getElementById('np-tab-changes').textContent = 'Changes ' + n;
    changePosSoon();
    if (!panel.hidden && panelTab === 'changes') { renderChangeList(); }
    sentToggle.hidden = !state.diff;
    document.getElementById('since').textContent = '';
    document.body.classList.toggle('diff-on', state.diff);
  }
  // Sent and answered notes have no sticky: in Changes mode, Show sent notes draws their pins again, read-only.
  function drawSentPins() {
    document.querySelectorAll('.pin-sent').forEach(function (p) { p.remove(); });
    document.querySelectorAll('.has-sent-pin').forEach(function (t) { t.classList.remove('has-sent-pin'); });
    if (!state.diff || !showSent.checked) { return; }
    var notes = (state.review && state.review.notes) || {};
    Object.keys(notes).forEach(function (id) {
      var n = notes[id];
      if (!n || (n.status !== 'sent' && n.status !== 'answered')) { return; }
      var t = byKey(n.target) || byKey(n.item) || (n.section ? byKey(n.section) : null);
      if (!t) { return; }
      var p = n.pin || {};
      var label = (n.status === 'answered' ? 'Answered' : 'Sent') + ' note: ' + (n.text || '');
      var pin = el('span', { class: 'pin pin-sent ' + n.status, role: 'img', 'aria-label': label, title: label });
      pin.style.left = ((isNum(p.rx) ? p.rx : 0) * 100) + '%';
      pin.style.top = ((isNum(p.ry) ? p.ry : 0.5) * 100) + '%';
      t.classList.add('has-sent-pin');
      t.appendChild(pin);
    });
  }
  showSent.addEventListener('change', function () { store('spec-book-sent', showSent.checked ? '1' : '0'); drawSentPins(); });
  if (store('spec-book-sent') === '1') { showSent.checked = true; }
  // Turning Changes on or off hides or shows whole sections, which moves everything; so does drawing the book again
  // after an Accept or a Change. The reader keeps their place: whatever is at the top of the screen stays where it
  // is, or, when it is hidden or gone, the nearest item after it (before it, at the end of the book) takes its place.
  // Items are found again by their key, so this holds across a new render.
  var PLACES = '.chapter > h2.tgt, .bk-sec > h3.tgt, .reqs > li.tgt, figure.frame';
  function placeKey(e) { return e.dataset.key || e.id; }
  function readingAnchor() {
    var top = barBottom();
    var all = [].slice.call(main.querySelectorAll(PLACES));
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.height && r.bottom > top) { return { key: placeKey(all[i]), y: r.top, keys: all.map(placeKey), i: i }; }
    }
    return null;
  }
  function keepPlace(a) {
    if (!a) { return; }
    var now = {};
    [].slice.call(main.querySelectorAll(PLACES)).forEach(function (e) { if (!hasOwn(now, placeKey(e))) { now[placeKey(e)] = e; } });
    var shown = function (k) { var e = hasOwn(now, k) ? now[k] : null; return e && e.getClientRects().length ? e : null; };
    var target = shown(a.key);
    var y = a.y;
    if (!target) {
      y = barBottom() + 12;
      for (var i = a.i + 1; i < a.keys.length && !target; i++) { target = shown(a.keys[i]); }
      for (var j = a.i - 1; j >= 0 && !target; j--) { target = shown(a.keys[j]); }
    }
    if (target) { window.scrollBy({ top: target.getBoundingClientRect().top - y, behavior: 'instant' }); }
  }
  function renderInPlace() {
    var a = readingAnchor();
    render();
    keepPlace(a);
  }
  function setDiff(on) {
    var a = readingAnchor();
    state.diff = on;
    store('spec-book-diff', on ? '1' : '0');
    updateChangesBar();
    keepPlace(a);
    drawSentPins();
    drawSoon();
  }
  // Scrolls to the next item under review below the top of the screen (the first one when `first`), and flashes it.
  function nextChange(first) {
    var all = [].slice.call(main.querySelectorAll('.has-rv'))
      .filter(function (e) { return e.getClientRects().length; });
    if (!all.length) { return; }
    var top = barBottom() + 4;
    var at = first ? all[0] : all.filter(function (e) { return e.getBoundingClientRect().top > top + 2; })[0] || all[0];
    window.scrollTo({ top: at.getBoundingClientRect().top + window.scrollY - top - 12, behavior: 'smooth' });
    at.classList.remove('chg-flash');
    void at.offsetWidth;
    at.classList.add('chg-flash');
  }
  // Live sharing (live.js) ----------------------------------------------------------------------------
  // Where the reader is: the item at the top of the screen, and how far down it the bar's edge falls (0 to 1).
  function liveAnchor() {
    var a = readingAnchor();
    if (!a) { return null; }
    var e = placeEl(a.key);
    if (!e) { return null; }
    var r = e.getBoundingClientRect();
    return { key: a.key, ry: Math.min(1, Math.max(0, (barBottom() - r.top) / Math.max(1, r.height))) };
  }
  function placeEl(key) {
    var all = main.querySelectorAll(PLACES);
    for (var i = 0; i < all.length; i++) { if (placeKey(all[i]) === key && all[i].getClientRects().length) { return all[i]; } }
    return null;
  }
  // Puts that point of that item at the bar's edge: the same place in the book on any screen size.
  function scrollToAnchor(a, smooth) {
    var e = a && placeEl(a.key);
    if (!e) { return; }
    var r = e.getBoundingClientRect();
    var top = r.top + window.scrollY + (Number(a.ry) || 0) * r.height - barBottom();
    // A jump of more than a screen is made at once; a short one glides.
    var far = Math.abs(top - window.scrollY) > window.innerHeight;
    window.scrollTo({ top: Math.max(0, top), behavior: smooth && !far ? 'smooth' : 'instant' });
  }
  function currentView() {
    return { view: state.view, diff: !!state.diff, videos: !!vid.checked, coverage: !!cover.checked };
  }
  // Takes another reader's view (following them); `transient` keeps it out of this browser's saved settings.
  function applyView(v, transient) {
    if (!v) { return; }
    if (typeof v.videos === 'boolean' && v.videos !== vid.checked) { vid.checked = v.videos; document.body.classList.toggle('hide-videos', !vid.checked); if (!transient) { store('spec-book-videos', vid.checked ? '1' : '0'); } }
    if (typeof v.coverage === 'boolean' && v.coverage !== cover.checked) { cover.checked = v.coverage; document.body.classList.toggle('coverage', cover.checked); if (!transient) { store('spec-book-coverage', cover.checked ? '1' : '0'); } }
    var redraw = false;
    if ((v.view === 'mockup' || v.view === 'shot' || v.view === 'both') && v.view !== state.view) {
      state.view = v.view;
      if (!transient) { store('spec-book-view', state.view); }
      syncViewControls();
      redraw = true;
    }
    if (typeof v.diff === 'boolean' && v.diff !== state.diff) {
      state.diff = v.diff;
      if (!transient) { store('spec-book-diff', v.diff ? '1' : '0'); }
      updateChangesBar();
      drawSentPins();
      redraw = true;
    }
    if (redraw) { render(); }
  }
  // Someone typing or moving a note: live.js tells the others (`move` carries the sticky's new offset).
  var inputWatchers = [];
  function noteInput(id, text, move) {
    var n = state.notes[id];
    if (!n) { return; }
    var d = { note: id, item: n.item, target: n.target, rx: n.rx, ry: n.ry, text: String(text || '') };
    if (move) { d.dx = move.dx; d.dy = move.dy; } else if (isNum(n.dx)) { d.dx = n.dx; d.dy = n.dy; }
    inputWatchers.forEach(function (fn) { try { fn(id, d); } catch (e) { /* live.js's problem */ } });
  }
  // Someone else's note as they write it: drawn over (or instead of) the saved one, read-only, until it is saved or
  // they stop.
  var ghosts = {}; // note id -> { d, by, box }
  function showDraft(id, d, by) {
    if (!d || typeof id !== 'string') { return; }
    var g = ghosts[id];
    if (!g) {
      var box = el('div', { class: 'sticky ghost', role: 'status' });
      box.innerHTML = '<div class="gh-text"></div><span class="st-by gh-by"></span><span class="gh-pin" aria-hidden="true"></span>';
      layer.appendChild(box);
      g = ghosts[id] = { box: box };
    }
    g.d = d;
    g.by = by || '';
    g.box.querySelector('.gh-text').textContent = d.text || '\u200b';
    g.box.querySelector('.gh-by').textContent = (by || 'Someone') + ' is typing\u2026';
    drawStickies();
  }
  function clearDraft(id) {
    var g = ghosts[id];
    if (!g) { return; }
    g.box.remove();
    delete ghosts[id];
    drawStickies();
  }
  function drawGhosts() {
    var vw = document.documentElement.clientWidth;
    Object.keys(ghosts).forEach(function (id) {
      var g = ghosts[id], d = g.d;
      var p = pointOf({ target: d.target, item: d.item, rx: d.rx, ry: d.ry });
      g.box.hidden = !p;
      if (!p) { return; }
      var dx = isNum(d.dx) ? d.dx : 24, dy = isNum(d.dy) ? d.dy : 24;
      var w = g.box.offsetWidth;
      g.box.style.left = Math.max(8, Math.min(p.x + dx, vw - w - 8)) + 'px';
      g.box.style.top = Math.max(0, p.y + dy) + 'px';
      var pin = g.box.querySelector('.gh-pin');
      pin.style.left = (p.x - (parseFloat(g.box.style.left) || 0) - 6) + 'px';
      pin.style.top = (p.y - (parseFloat(g.box.style.top) || 0) - 6) + 'px';
    });
  }
  // The reader moving through the book themselves (not a scroll this page made): following someone stops.
  var scrollWatchers = [];
  function userMoved() { scrollWatchers.forEach(function (fn) { try { fn(); } catch (e) { /* live.js's problem */ } }); }
  window.addEventListener('wheel', userMoved, { passive: true });
  window.addEventListener('touchmove', userMoved, { passive: true });
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) { return; }
    if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/.test(e.key)) { userMoved(); }
  });
  document.addEventListener('pointerdown', function (e) { if (inBook(e) || (e.target && e.target.closest && e.target.closest('.side'))) { userMoved(); } }, true);

  // The previous item under review above the top of the screen (the last one from the top).
  function prevChange() {
    var all = changeEls();
    if (!all.length) { return; }
    var top = barBottom() + 4;
    var above = all.filter(function (e) { return e.getBoundingClientRect().top < top - 2; });
    var at = above.length ? above[above.length - 1] : all[all.length - 1];
    window.scrollTo({ top: at.getBoundingClientRect().top + window.scrollY - top - 12, behavior: 'smooth' });
    at.classList.remove('chg-flash');
    void at.offsetWidth;
    at.classList.add('chg-flash');
  }
  function changeEls() { return [].slice.call(main.querySelectorAll('.has-rv')).filter(function (e) { return e.getClientRects().length; }); }
  // "3 / 189": the first change at or below the top of the screen, of all of them.
  var posQueued = false;
  function changePosSoon() {
    if (posQueued) { return; }
    posQueued = true;
    requestAnimationFrame(function () {
      posQueued = false;
      var all = changeEls();
      var top = barBottom();
      var i = 0;
      while (i < all.length && all[i].getBoundingClientRect().bottom < top) { i++; }
      document.getElementById('chg-pos').textContent = (all.length ? Math.min(i + 1, all.length) : 0) + ' / ' + all.length;
    });
  }
  window.addEventListener('scroll', changePosSoon, { passive: true });
  changesBtn.addEventListener('click', function () { setDiff(!state.diff); });
  nextBtn.addEventListener('click', function () { nextChange(false); });
  prevBtn.addEventListener('click', prevChange);
  // The Requests pane's tabs: the notes (what is asked), and every change under review.
  var panelTab = 'notes';
  function setPanelTab(t) {
    panelTab = t;
    document.getElementById('np-tab-notes').setAttribute('aria-selected', String(t === 'notes'));
    document.getElementById('np-tab-changes').setAttribute('aria-selected', String(t === 'changes'));
    panel.classList.toggle('tab-changes', t === 'changes');
    document.getElementById('np-changes').hidden = t !== 'changes';
    if (t === 'changes') { renderChangeList(); }
  }
  document.getElementById('np-tab-notes').addEventListener('click', function () { setPanelTab('notes'); });
  document.getElementById('np-tab-changes').addEventListener('click', function () { setPanelTab('changes'); });
  function renderChangeList() {
    var list = document.getElementById('np-changes');
    list.innerHTML = '';
    var lastSec = null;
    [].slice.call(main.querySelectorAll('.has-rv')).forEach(function (e) {
      var sec = e.closest('.bk-sec');
      var secTitle = sec ? (sec.querySelector('h3') || {}).textContent || '' : '';
      if (sec && sec !== lastSec) {
        lastSec = sec;
        var h = el('li', { class: 'np-chg-sec' });
        h.textContent = secTitle.replace(/\s+/g, ' ').trim();
        list.appendChild(h);
      }
      var li = el('li', { class: 'np-chg' });
      var b = el('button', { type: 'button' });
      var label = (e.dataset.label || '') + (e.dataset.quote ? ': ' + plain(e.dataset.quote) : '');
      var txt = (label || e.textContent || '').replace(/\s+/g, ' ').trim();
      b.textContent = txt.length > 140 ? txt.slice(0, 139) + '\u2026' : txt;
      b.addEventListener('click', function () {
        if (!e.getClientRects().length) { setDiff(true); }
        window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - barBottom() - 12, behavior: 'smooth' });
        e.classList.remove('chg-flash');
        void e.offsetWidth;
        e.classList.add('chg-flash');
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    if (!list.children.length) { list.appendChild(el('li', { class: 'np-empty' })).textContent = 'Nothing to review.'; }
  }

  // The bar's menus: View and Claude. A click elsewhere or Escape closes them.
  function menuToggle(btnId, popId) {
    var btn = document.getElementById(btnId), pop = document.getElementById(popId);
    function set(open) { pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); }
    btn.addEventListener('click', function (e) { e.stopPropagation(); set(pop.hidden); });
    pop.addEventListener('click', function (e) { if (!e.target.closest('button')) { e.stopPropagation(); } });
    document.addEventListener('click', function (e) { if (!pop.hidden && !pop.contains(e.target)) { set(false); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) { set(false); btn.focus(); } });
    return set;
  }
  menuToggle('view-btn', 'view-menu');
  var setClaudeMenu = menuToggle('claude-btn', 'claude-pop');
  ['revise', 'build'].forEach(function (id) { document.getElementById(id).addEventListener('click', function () { setClaudeMenu(false); }); });
  if (store('spec-book-diff') === '1') { state.diff = true; }

  fetchBook().then(function (data) {
    var savedView = store('spec-book-view');
    if (savedView === 'shot' || savedView === 'both') {
      state.view = savedView;
      syncViewControls();
    }
    if (state.evidence.byId) {
      document.getElementById('coverage-group').hidden = false;
      if (store('spec-book-coverage') === '1') { cover.checked = true; document.body.classList.add('coverage'); }
    }
    if (store('spec-book-videos') === '0') { vid.checked = false; document.body.classList.add('hide-videos'); }
    render();
    importLocalNotes();
    // At once, for the calls a build has made, which the book does not carry.
    pollClaude();
    return data;
  }).catch(function (e) {
    console.error(e);
    main.innerHTML = '<p class="loading">Could not load the book: ' + esc(e.message) + '</p><pre class="loading">' + esc(e.stack || '') + '</pre>';
  });
})();
