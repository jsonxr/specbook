// The owner's book tab on localhost while the book server shares the book. The server hosts the share itself
// (server/lib/host.mjs); this tab only follows it: it hears the share's state, the readers' live messages and changes
// on disk on /api/share/events, and passes its own live messages (presence, drafts, following: live.js) to the readers
// through POST /api/live. Opening a tab shares nothing: the share starts when the owner presses Share and Start with a
// 6-digit pin of their choice. The readers' half is the share server's reader.
(function () {
  'use strict';
  if (/^\/s\//.test(location.pathname)) { return; }
  // This tab's id, sent on the events stream.
  var TAB = (function () {
    var bytes = crypto.getRandomValues(new Uint8Array(12));
    var s = '';
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  })();

  function post(path, body, keepalive) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), keepalive: !!keepalive });
  }

  // What the server says of the share: { state: 'off'|'starting'|'live'|'failed', url, pinUrl, expiresAt, guests,
  // error }.
  var view = { state: 'off', url: null, pinUrl: null, expiresAt: null, guests: [], error: null };
  var waiting = true; // no state from the server yet: 'unknown', and the pill shows nothing rather than a guess
  var readers = {}; // id -> { id, name, color, role }: who is reading on the link, from their hello and bye
  var ownerTabs = []; // the ids of the owner's open localhost tabs of this book, this one among them
  var watchers = [];
  function changedState() { watchers.forEach(function (fn) { try { fn(); } catch (e) { /* the page's problem */ } }); }

  function ownerName() { return (window.SpecBook && window.SpecBook.me && window.SpecBook.me().name) || 'Owner'; }
  function hostFace() { return { id: 'host', name: ownerName(), color: window.SpecRelay.colorOf('host'), role: 'owner' }; }
  function people() {
    return [hostFace()].concat(Object.keys(readers).map(function (k) { return readers[k]; }));
  }
  // 'unknown' (not heard yet), 'off', 'starting' or 'live'.
  function state() {
    if (waiting) { return 'unknown'; }
    if (view.state === 'live') { return 'live'; }
    return view.state === 'starting' ? 'starting' : 'off';
  }

  // Live messages from this tab: to every reader, stamped as the host's by the server. Every localhost tab of the book
  // speaks for the owner; a hidden one keeps quiet, so the owner's face follows the tab in front.
  function sendLive(msg) {
    if (view.state !== 'live') { return; }
    if (document.visibilityState === 'hidden' && msg && msg.kind !== 'bye') { return; }
    var m = {};
    Object.keys(msg || {}).forEach(function (k) { m[k] = msg[k]; });
    delete m.t; delete m.from;
    post('/api/live', { msg: m }, m.kind === 'bye').catch(function () { /* the server is away */ });
  }
  // Readers learn this tab is here (it may have opened after them, or come back after closing).
  function sayHello() {
    var me = hostFace();
    sendLive({ kind: 'hello', name: me.name, color: me.color, role: 'owner' });
  }

  function apply(next) {
    if (!next || typeof next.state !== 'string') { return; }
    var was = view.state;
    view = next;
    waiting = false;
    // The share stopped: no faces stay. (While it is live, readers come and go by roster, hello and bye.)
    if (view.state !== 'live') { readers = {}; }
    if (view.state === 'live' && was !== 'live') { sayHello(); }
    changedState();
  }
  function ask(path, body) {
    return post(path, body || {}).then(function (r) {
      return r.json().then(function (j) { apply(j); return r; }, function () { return r; });
    });
  }

  function toLive(msg) { if (window.SpecLive && window.SpecLive.receive) { window.SpecLive.receive(msg); } }
  // A reader's live message, already checked and stamped by the server.
  function onLive(msg) {
    if (!msg || msg.t !== 'live') { return; }
    if (msg.kind !== 'roster' && (typeof msg.from !== 'string' || msg.from === 'host')) { return; }
    if (msg.kind === 'roster') {
      // Who is reading already, sent when this tab connects to the server.
      readers = {};
      (Array.isArray(msg.people) ? msg.people : []).forEach(function (p) {
        if (p && typeof p.id === 'string' && p.id !== 'host') { readers[p.id] = { id: p.id, name: p.name, color: p.color, role: p.role || 'guest' }; }
      });
      changedState();
    } else if (msg.kind === 'hello') {
      readers[msg.from] = { id: msg.from, name: msg.name, color: msg.color, role: msg.role || 'guest' };
      changedState();
    } else if (msg.kind === 'bye' && readers[msg.from]) {
      delete readers[msg.from];
      changedState();
    }
    toLive(msg);
  }
  // The book or its notes changed on disk: this page loads them (the readers hear it from the server).
  function changed() {
    if (window.SpecBook) {
      if (window.SpecBook.reloadNotes) { window.SpecBook.reloadNotes(); }
      if (window.SpecBook.poll) { window.SpecBook.poll(); }
    }
  }

  var events = null;
  // Every localhost tab of the book listens on its own stream (a browser allows six connections to one server over
  // plain http; a few tabs leave plenty).
  function listen() {
    waiting = true;
    changedState();
    events = new EventSource('/api/share/events?tab=' + TAB);
    events.addEventListener('state', function (e) { try { apply(JSON.parse(e.data)); } catch (err) { /* bad event */ } });
    events.addEventListener('live', function (e) { try { onLive(JSON.parse(e.data)); } catch (err) { /* bad event */ } });
    events.addEventListener('changed', changed);
    events.addEventListener('tabs', function (e) {
      try { var t = JSON.parse(e.data).tabs; ownerTabs = Array.isArray(t) ? t : []; changedState(); } catch (err) { /* bad event */ }
    });
    events.onerror = function () {
      // The server went away (stopped, or restarted), and the share with it. The stream reconnects by itself, with the
      // same tab id; one the browser gave up on is opened again.
      readers = {};
      view = { state: 'off', url: null, pinUrl: null, expiresAt: null, guests: [], error: null };
      changedState();
      if (events.readyState === 2) { setTimeout(listen, 5000); }
    };
  }

  // For live.js and the share pill.
  window.SpecHost = {
    send: sendLive,
    people: people,
    link: function () { return state() === 'live' ? view.url : null; },
    error: function () { return view.error; },
    // This tab's id, and every open localhost tab's: the share menu lists each.
    tab: TAB,
    tabs: function () { return ownerTabs.slice(); },
    state: state,
    onChange: function (fn) { watchers.push(fn); },
    stopSharing: function () { return ask('/api/share/stop'); },
    // Starts the share with the owner's 6-digit pin. Resolves with the server's answer (400 for a bad pin).
    startSharing: function (pin) { return ask('/api/share', { pin: pin }); },
  };
  listen();
})();
