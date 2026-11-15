// The owner's book tab on localhost while the book server shares the book. The server hosts the share itself
// (server/lib/host.mjs); this tab only follows it: it hears the share's state, the readers' live messages and changes
// on disk on /api/share/events, and passes its own live messages (presence, drafts, following: live.js) to the readers
// through POST /api/live. Opening a tab asks the server to share (unless the book says settings.share: false), as
// closing one no longer stops anything. The readers' half is the share server's reader.
(function () {
  'use strict';
  if (/^\/s\//.test(location.pathname)) { return; }
  // This tab's id, sent on the events stream: a tab open at Stop sharing that only reconnects does not start it again.
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
  // error, stopped }.
  var view = { state: 'starting', url: null, pinUrl: null, expiresAt: null, guests: [], error: null, stopped: false };
  var listening = false; // this tab follows the share
  var lockWait = true; // the lock has not been answered yet (a moment): until then this tab is 'starting', not 'other-tab'
  var waiting = true; // no state from the server yet
  var readers = {}; // id -> { id, name, color, role }: who is reading on the link, from their hello and bye
  var watchers = [];
  function changedState() { watchers.forEach(function (fn) { try { fn(); } catch (e) { /* the page's problem */ } }); }

  function ownerName() { return (window.SpecBook && window.SpecBook.me && window.SpecBook.me().name) || 'Owner'; }
  function hostFace() { return { id: 'host', name: ownerName(), color: window.SpecRelay.colorOf('host'), role: 'owner' }; }
  function people() {
    return [hostFace()].concat(Object.keys(readers).map(function (k) { return readers[k]; }));
  }
  function state() {
    if (!listening) { return lockWait ? 'starting' : 'other-tab'; }
    if (waiting) { return 'starting'; }
    if (view.state === 'live') { return 'live'; }
    return view.state === 'starting' ? 'starting' : 'off';
  }

  // Live messages from this tab: to every reader, stamped as the host's by the server. Only the tab that follows the
  // share speaks for the owner.
  function sendLive(msg) {
    if (!listening || view.state !== 'live') { return; }
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
  function ask(path) {
    return post(path, {}).then(function (r) {
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

  // One tab per book listens (the browser allows few connections to one server, and every open stream holds one): the
  // tab that holds the lock. When it closes, the next tab takes over. Until then, this tab says the share is followed in
  // the other one.
  function listenOnce() {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('specbook-share-host:' + location.host, function () {
        listen();
        return new Promise(function () { /* held until the tab closes */ });
      });
      setTimeout(function () { lockWait = false; changedState(); }, 400);
    } else {
      listen();
    }
  }
  var events = null;
  function listen() {
    listening = true;
    waiting = true;
    changedState();
    events = new EventSource('/api/share/events?tab=' + TAB);
    events.addEventListener('state', function (e) { try { apply(JSON.parse(e.data)); } catch (err) { /* bad event */ } });
    events.addEventListener('live', function (e) { try { onLive(JSON.parse(e.data)); } catch (err) { /* bad event */ } });
    events.addEventListener('changed', changed);
    events.onerror = function () {
      // The server went away (stopped, or restarted), and the share with it. The stream reconnects by itself, with the
      // same tab id; one the browser gave up on is opened again.
      readers = {};
      view = { state: 'off', url: null, pinUrl: null, expiresAt: null, guests: [], error: null, stopped: view.stopped };
      changedState();
      if (events.readyState === 2) { setTimeout(listen, 5000); }
    };
  }

  // For live.js and the share pill.
  window.SpecHost = {
    send: sendLive,
    people: people,
    link: function () { return state() === 'live' ? view.url : null; },
    pinLink: function () { return state() === 'live' ? view.pinUrl : null; },
    error: function () { return view.error; },
    state: state,
    onChange: function (fn) { watchers.push(fn); },
    newLink: function () { return ask('/api/share/new-link'); },
    newPin: function () { return ask('/api/share/new-pin'); },
    stopSharing: function () { return ask('/api/share/stop'); },
    startSharing: function () { return ask('/api/share'); },
  };
  listenOnce();
})();
