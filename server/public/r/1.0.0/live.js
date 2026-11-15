// Live sharing in the reader, for the owner and guests alike: who is in the book (faces in the share pill), where each
// is, notes as they are typed, and following someone (your window goes where theirs does, and takes their view).
// Messages ride the share's data channels as { t: 'live', kind, from, ... }; the book server, which hosts the share
// (server/lib/host.mjs), stamps `from`, checks them, and passes each on to everyone else. The owner's localhost tab
// reaches it through owner.js. Nothing here touches the share server.
//
//   hello    I am here (the host answers a guest's with a roster, and tells the others)
//   roster   who is here: { you, people: [{ id, name, color, role }] } (host -> one guest)
//   where    { anchor: { key, ry }, view }      at most every 100 ms while scrolling, and once after
//   draft    { note, item, target, rx, ry, ax, ay, ch, cx, cy, dx, dy, text }   a note as it is typed or moved
//   typing   { note, on }
//   follow   { leader }                          whom the sender follows (null: nobody)
//   bye      the sender left
(function () {
  'use strict';

  // Leading and trailing: fires at once, then once more after the burst with the latest arguments.
  function throttle(fn, wait) {
    var last = 0, timer = null, args = null;
    return function () {
      args = arguments;
      var now = Date.now();
      if (now - last >= wait && !timer) {
        last = now;
        fn.apply(null, args);
        return;
      }
      if (!timer) {
        timer = setTimeout(function () { timer = null; last = Date.now(); fn.apply(null, args); }, Math.max(0, wait - (now - last)));
      }
    };
  }
  // Whom this reader follows, after an event: following a face again, scrolling, typing, or the leader leaving stops.
  function followState(st, ev) {
    var leader = st.leader;
    if (ev.type === 'follow') { return { leader: ev.id === leader ? null : ev.id }; }
    if (ev.type === 'leader-left') { return { leader: !ev.id || ev.id === leader ? null : leader }; }
    if (ev.type === 'user-scroll' || ev.type === 'typing' || ev.type === 'unfollow') { return { leader: null }; }
    return { leader: leader };
  }
  var api = { _throttle: throttle, _followState: followState, receive: function () {}, people: function () { return []; }, follow: function () {} };
  window.SpecLive = api;
  if (typeof document === 'undefined' || !window.SpecBook) { return; }

  var Book = window.SpecBook;
  var guest = !!window.SpecShare;
  var Host = guest ? null : window.SpecHost;
  if (!guest && !Host) { return; }

  var myId = guest ? null : 'host';
  var people = {}; // id -> { id, name, color, role, typing, following, where }
  var follow = { leader: null };
  var savedView = null;
  var draftTimers = {};
  var draftBy = {}; // note id -> who the ghost of it is from: only they can fade it

  function send(msg) {
    if (guest) { window.SpecShare.send(msg); } else { Host.send(msg); }
  }

  // Where this reader is, and their view.
  var lastWhere = '';
  function whereNow() { return { anchor: Book.anchor(), view: Book.view() }; }
  function sendWhereNow(force) {
    var w = whereNow();
    var text = JSON.stringify(w);
    if (!force && text === lastWhere) { return; }
    lastWhere = text;
    send({ kind: 'where', anchor: w.anchor, view: w.view });
  }
  var sendWhere = throttle(function () { sendWhereNow(false); }, 100);
  var settle = null;
  function moved() {
    sendWhere();
    clearTimeout(settle);
    settle = setTimeout(function () { sendWhereNow(false); }, 300);
  }
  window.addEventListener('scroll', moved, { passive: true });
  window.addEventListener('resize', moved);
  setInterval(function () { sendWhereNow(false); }, 1000); // a change of view (Show only changes, Screenshots)

  // Notes as they are typed or moved.
  var typingNote = null, typingOff = null;
  var sendDraft = throttle(function (d) { send({ kind: 'draft', note: d.note, item: d.item, target: d.target, rx: d.rx, ry: d.ry, ax: d.ax, ay: d.ay, ch: d.ch, cx: d.cx, cy: d.cy, dx: d.dx, dy: d.dy, text: d.text }); }, 50);
  Book.onNoteInput(function (id, d) {
    if (follow.leader) { setFollow({ type: 'typing' }); }
    sendDraft(d);
    if (typingNote !== id) {
      if (typingNote) { send({ kind: 'typing', note: typingNote, on: false }); }
      typingNote = id;
      send({ kind: 'typing', note: id, on: true });
    }
    clearTimeout(typingOff);
    typingOff = setTimeout(function () { send({ kind: 'typing', note: id, on: false }); typingNote = null; }, 2000);
  });

  // Someone's draft fades once they stop (their save has landed by then), or after 10 s regardless.
  function fadeDraft(id, ms) {
    clearTimeout(draftTimers[id]);
    draftTimers[id] = setTimeout(function () { delete draftTimers[id]; delete draftBy[id]; Book.clearDraft(id); }, ms);
  }

  function receive(msg) {
    if (!msg || msg.from === myId) { return; }
    var p = msg.from && people[msg.from];
    switch (msg.kind) {
      case 'roster':
        myId = msg.you;
        people = {};
        (msg.people || []).forEach(function (q) { people[q.id] = { id: q.id, name: q.name, color: q.color, role: q.role }; });
        sendWhereNow(true);
        break;
      case 'hello':
        people[msg.from] = { id: msg.from, name: msg.name, color: msg.color, role: msg.role || 'guest' };
        // The newcomer learns where everyone is, and whom they follow.
        sendWhereNow(true);
        if (follow.leader) { send({ kind: 'follow', leader: follow.leader }); }
        break;
      case 'where':
        if (!p) { return; }
        p.where = { anchor: msg.anchor, view: msg.view };
        if (follow.leader === msg.from) { applyWhere(p.where); }
        break;
      case 'draft':
        if (!p || typeof msg.note !== 'string') { return; }
        draftBy[msg.note] = msg.from;
        Book.showDraft(msg.note, msg, p.name);
        fadeDraft(msg.note, 10000);
        break;
      case 'typing':
        if (!p) { return; }
        p.typing = !!msg.on;
        if (!msg.on && typeof msg.note === 'string' && draftBy[msg.note] === msg.from) { fadeDraft(msg.note, 1200); }
        break;
      case 'follow':
        if (!p) { return; }
        p.following = typeof msg.leader === 'string' ? msg.leader : null;
        break;
      case 'bye':
        if (!p) { return; }
        delete people[msg.from];
        if (follow.leader === msg.from) { setFollow({ type: 'leader-left', id: msg.from }); flash(p.name + ' left'); }
        break;
      default:
        return;
    }
    render();
  }
  api.receive = receive;
  api.people = function () { return Object.keys(people).map(function (k) { return people[k]; }); };

  // Following ------------------------------------------------------------------------------------------
  function applyWhere(w) {
    if (!w) { return; }
    if (w.view) { Book.setView(w.view, true); }
    requestAnimationFrame(function () { if (w.anchor) { Book.scrollTo(w.anchor, true); } });
  }
  function setFollow(ev) {
    var before = follow.leader;
    follow = followState(follow, ev);
    if (follow.leader === before) { return; }
    if (!before && follow.leader) { savedView = Book.view(); }
    if (before && !follow.leader && savedView) { Book.setView(savedView, true); savedView = null; }
    send({ kind: 'follow', leader: follow.leader });
    if (follow.leader && people[follow.leader]) { applyWhere(people[follow.leader].where); }
    render();
  }
  api.follow = function (id) { setFollow(id ? { type: 'follow', id: id } : { type: 'unfollow' }); };
  Book.onUserScroll(function () { if (follow.leader) { setFollow({ type: 'user-scroll' }); } });

  // The share pill, the follow chip, and the edge while someone follows you ------------------------------------
  var pill = document.createElement('div');
  pill.className = 'share-pill';
  var chip = document.createElement('div');
  chip.className = 'follow-chip';
  chip.setAttribute('role', 'status');
  chip.hidden = true;
  var note = null;
  function flash(text) {
    note = text;
    render();
    setTimeout(function () { if (note === text) { note = null; render(); } }, 3000);
  }
  function place() {
    var bar = document.querySelector('.bar');
    var slot = document.getElementById('share-slot') || document.querySelector('.bar-spacer');
    if (slot && !pill.isConnected) {
      if (slot.id === 'share-slot') { slot.appendChild(pill); } else { slot.parentNode.insertBefore(pill, slot.nextSibling); }
    }
    if (bar && !chip.isConnected) { bar.appendChild(chip); }
  }
  function initials(n) { return (String(n || '?').trim().charAt(0) || '?').toUpperCase(); }
  function hostState() { return guest ? 'live' : Host.state(); }
  // The plain link: it never carries the pin (Copy pin link, for the owner, does).
  function link() {
    if (!guest) { return Host.link(); }
    var m = /^\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname);
    return m ? location.origin + '/s/' + m[1] : null;
  }
  function pinLink() {
    if (guest) { return window.SpecShare.pinLink ? window.SpecShare.pinLink() : null; }
    return Host.pinLink ? Host.pinLink() : null;
  }
  // The owner: the localhost tab, or a reader on the link who opened it with the pin.
  function owner() { return !guest || window.SpecShare.role === 'owner'; }
  function whereLabel(p) {
    var key = p.where && p.where.anchor && p.where.anchor.key;
    if (!key) { return ''; }
    var e = document.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    return e ? (e.dataset.label || '') : '';
  }
  function statusOf(p) {
    if (p.id === myId) { return guest ? 'you' : 'you · host'; }
    if (p.typing) { return 'typing'; }
    if (p.following === myId) { return 'following you'; }
    return whereLabel(p);
  }
  var menuOpen = false;
  function copy(btn, url) {
    if (!url) { return; }
    var done = function () { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1200); };
    if (navigator.clipboard) { navigator.clipboard.writeText(url).then(done, done); } else { done(); }
  }
  function render() {
    place();
    var st = hostState();
    var list = api.people();
    var meP = people[myId] || (guest ? null : { id: 'host', name: Book.me().name, color: (window.SpecRelay ? window.SpecRelay.colorOf('host') : '#3ecf8e'), role: 'owner' });
    if (!guest) { meP.name = Book.me().name; if (!people.host) { people.host = meP; list = api.people(); } }
    var others = list.filter(function (p) { return p.id !== myId; });
    var followers = others.filter(function (p) { return p.following === myId; });
    pill.innerHTML = '';
    pill.className = 'share-pill';
    if (st === 'off') {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'bar-btn share-start'; b.textContent = 'Share';
      var why = Host.error ? Host.error() : null;
      b.title = why ? 'Sharing failed: ' + why : 'Share this book: anyone with the link can read it and leave notes';
      b.addEventListener('click', function () { Host.startSharing(); });
      pill.appendChild(b);
    } else if (st === 'other-tab') {
      pill.innerHTML = '<span class="share-note">Live sharing runs in your other tab</span>';
    } else if (st === 'starting') {
      pill.innerHTML = '<span class="share-note">Sharing…</span>';
    } else {
      var faces = document.createElement('div');
      faces.className = 'faces';
      if (!others.length) {
        var solo = document.createElement('span');
        solo.className = 'share-solo';
        solo.textContent = 'Only you';
        pill.appendChild(solo);
      } else {
        [meP].concat(others).forEach(function (p) {
          if (!p) { return; }
          var f = document.createElement('button');
          f.type = 'button';
          f.className = 'face' + (p.id === myId ? ' me' : '') + (follow.leader === p.id ? ' on' : '');
          f.style.setProperty('--face', p.color || '#888');
          f.textContent = initials(p.name);
          var tip = p.id === myId ? 'You' : p.name + (follow.leader === p.id ? ' · click to stop following' : ' · click to follow');
          f.title = tip;
          f.setAttribute('aria-label', tip);
          if (p.id !== myId) {
            f.setAttribute('aria-pressed', String(follow.leader === p.id));
            f.addEventListener('click', function () { api.follow(p.id); });
          } else {
            f.disabled = true;
          }
          if (p.typing) { var pen = document.createElement('span'); pen.className = 'face-pen'; pen.textContent = '✎'; f.appendChild(pen); }
          if (p.id === myId && followers.length) { var c = document.createElement('span'); c.className = 'face-count'; c.textContent = String(followers.length); f.appendChild(c); }
          faces.appendChild(f);
        });
        pill.appendChild(faces);
      }
      var cp = document.createElement('button');
      cp.type = 'button'; cp.className = 'share-copy'; cp.textContent = 'Copy link';
      cp.title = 'Copy the link: anyone with it can read the book and leave notes';
      cp.addEventListener('click', function () { copy(cp, link()); });
      pill.appendChild(cp);
      var more = document.createElement('button');
      more.type = 'button'; more.className = 'share-more'; more.textContent = '▾';
      more.setAttribute('aria-label', 'Sharing');
      more.setAttribute('aria-expanded', String(menuOpen));
      more.addEventListener('click', function (e) { e.stopPropagation(); menuOpen = !menuOpen; render(); });
      pill.appendChild(more);
      if (menuOpen) { pill.appendChild(menu(list)); }
    }
    // Following and being followed.
    var leader = follow.leader && people[follow.leader];
    if (leader) {
      chip.hidden = false;
      chip.textContent = 'Following ' + leader.name + ' · scroll or type to stop';
      chip.style.background = leader.color || '';
    } else if (note) {
      chip.hidden = false;
      chip.textContent = note;
      chip.style.background = '';
    } else {
      chip.hidden = true;
    }
    document.body.classList.toggle('followed', followers.length > 0);
    document.body.style.setProperty('--follower', followers.length ? (followers[0].color || '#f27aa0') : 'transparent');
    document.body.classList.toggle('following', !!leader);
  }
  function menu(list) {
    var m = document.createElement('div');
    m.className = 'share-menu';
    m.addEventListener('click', function (e) { e.stopPropagation(); });
    var h = document.createElement('p');
    h.className = 'share-menu-head';
    h.textContent = owner() ? 'Shared while the book is served. Anyone with the link can read and leave notes.' : 'Anyone with this link can read and leave notes.';
    m.appendChild(h);
    var row = document.createElement('div');
    row.className = 'share-link-row';
    var input = document.createElement('input');
    input.readOnly = true; input.value = link() || ''; input.className = 'share-link';
    input.setAttribute('aria-label', 'The link');
    var c = document.createElement('button');
    c.type = 'button'; c.className = 'bar-btn'; c.textContent = 'Copy';
    c.addEventListener('click', function () { copy(c, link()); });
    row.appendChild(input); row.appendChild(c);
    m.appendChild(row);
    // On the website, a reader who opened the book with the owner's pin can take it off this browser.
    if (guest && window.SpecShare.role === 'owner' && window.SpecShare.forgetPin) {
      var fp = document.createElement('button');
      fp.type = 'button'; fp.className = 'bar-btn share-forget-pin'; fp.textContent = 'Forget pin on this device';
      fp.title = 'Remove the owner’s pin from this browser; the plain link still opens the book as a guest';
      fp.addEventListener('click', function () { window.SpecShare.forgetPin(); location.reload(); });
      var fpActs = document.createElement('div'); fpActs.className = 'share-acts';
      fpActs.appendChild(fp);
      m.appendChild(fpActs);
    }
    // A guest who has the owner's pin types it here (the pin link does the same).
    if (guest && !owner() && window.SpecShare.usePin) {
      var pf = document.createElement('form');
      pf.className = 'share-link-row share-pin-entry';
      var pi = document.createElement('input');
      pi.type = 'text'; pi.inputMode = 'numeric'; pi.maxLength = 6; pi.autocomplete = 'off'; pi.className = 'share-link';
      pi.placeholder = 'Owner’s pin'; pi.setAttribute('aria-label', 'The owner’s 6-digit pin');
      var pb = document.createElement('button');
      pb.type = 'submit'; pb.className = 'bar-btn'; pb.textContent = 'Use pin';
      var pe = document.createElement('p');
      pe.className = 'share-pin-error'; pe.hidden = true; pe.textContent = 'A pin is 6 digits.';
      pf.addEventListener('submit', function (e) {
        e.preventDefault();
        pe.hidden = window.SpecShare.usePin(pi.value);
      });
      pf.appendChild(pi); pf.appendChild(pb);
      m.appendChild(pf);
      m.appendChild(pe);
    }
    if (owner()) {
      var ul = document.createElement('ul');
      ul.className = 'share-people';
      list.forEach(function (p) {
        var li = document.createElement('li');
        var dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color || '#888';
        var nm = document.createElement('span'); nm.textContent = p.id === myId ? 'You' : p.name;
        var stx = document.createElement('span'); stx.className = 'share-st'; stx.textContent = statusOf(p);
        li.appendChild(dot); li.appendChild(nm); li.appendChild(stx);
        ul.appendChild(li);
      });
      m.appendChild(ul);
      var nl = document.createElement('button');
      nl.type = 'button'; nl.className = 'bar-btn'; nl.textContent = 'New link';
      nl.title = 'Make a new link; the old one stops working';
      nl.addEventListener('click', function () { menuOpen = false; Host.newLink(); render(); });
      // On the link, Stop sharing also closes this page's own connection: it says the book is not open.
      var sharer = guest ? window.SpecShare : Host;
      var stop = document.createElement('button');
      stop.type = 'button'; stop.className = 'bar-btn share-stop'; stop.textContent = 'Stop sharing';
      stop.title = 'Stop sharing until you reopen the book';
      stop.addEventListener('click', function () { menuOpen = false; sharer.stopSharing(); render(); });
      var acts = document.createElement('div'); acts.className = 'share-acts';
      // The pin link opens the book as its owner, on another device of theirs.
      if (pinLink()) {
        var pl = document.createElement('button');
        pl.type = 'button'; pl.className = 'bar-btn share-pin-copy'; pl.textContent = 'Copy pin link';
        pl.title = 'Copy the link with your pin: it opens the book as you, on another device of yours';
        pl.addEventListener('click', function () { copy(pl, pinLink()); });
        acts.appendChild(pl);
      }
      var np = document.createElement('button');
      np.type = 'button'; np.className = 'bar-btn share-new-pin'; np.textContent = 'New pin';
      np.title = 'Make a new pin; the old pin link stops working, the plain link keeps working';
      np.addEventListener('click', function () { sharer.newPin().then(render, render); });
      acts.appendChild(np);
      // New link ends this room, and with it a link page's own connection: it is made on localhost.
      if (!guest) { acts.appendChild(nl); }
      acts.appendChild(stop);
      m.appendChild(acts);
    }
    return m;
  }
  document.addEventListener('click', function () { if (menuOpen) { menuOpen = false; render(); } });

  // Wiring ---------------------------------------------------------------------------------------------------
  if (guest) {
    window.SpecShare.onLive(receive);
    // On every (re)connection: say hello, and the host answers with who is here.
    var hello = function () { send({ kind: 'hello' }); };
    if (window.SpecShare.onPeerState) {
      window.SpecShare.onPeerState(function (st) {
        if (st === 'live') { hello(); } else { people = {}; if (follow.leader) { setFollow({ type: 'leader-left' }); } render(); }
      });
    }
    hello();
  } else {
    Host.onChange(function () {
      // Guests who left without a word (their connection dropped) are gone from the host's list.
      var ids = {};
      Host.people().forEach(function (p) {
        ids[p.id] = true;
        var was = people[p.id] || { id: p.id };
        was.name = p.name; was.color = p.color; was.role = p.role;
        people[p.id] = was;
      });
      Object.keys(people).forEach(function (id) { if (!ids[id]) { delete people[id]; } });
      if (follow.leader && !people[follow.leader]) { setFollow({ type: 'leader-left' }); }
      render();
    });
  }
  window.addEventListener('pagehide', function () { send({ kind: 'bye' }); });
  render();
})();
