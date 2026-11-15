// The owner's book tab as the host of a shared book. The book is shared while an owner tab is open: the tab that
// listens on /api/share/events (one per book) is asked to host. It opens a room on the share server (or reuses the
// one the local server remembers, so the link survives a reload), answers each guest's signed WebRTC offer, and
// serves the guest's calls by making them itself against this server, marked as that guest (x-specbook-guest), so the
// server applies the guest's rights. It also passes live messages (presence, drafts, following: live.js) between
// everyone. Closing the tab drops the guests' connections; they wait, and reconnect when a tab hosts again. The
// guest's half is the share server's guest.js, then this plugin's app/guest.js.
(function () {
  'use strict';
  if (/^\/s\//.test(location.pathname)) { return; }
  var PROTOCOL = 2;
  var CHUNK = 12000;
  var MAX_GUESTS = 20;
  var MAX_OPEN = 8;
  var MAX_BODY = 2 * 1024 * 1024;
  var IN_FLIGHT = 16; // requests one guest may have waiting
  var SHARE_IN_FLIGHT = 48; // and all guests together
  var MAX_RESPONSE = 64 * 1024 * 1024; // the largest file a guest may load (a recording, say)
  var inFlight = 0;
  var TAB = b64url(crypto.getRandomValues(new Uint8Array(12)));

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64(s) {
    var b = atob(s);
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) { out[i] = b.charCodeAt(i); }
    return out;
  }
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) { s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); }
    return btoa(s);
  }
  function fromB64url(s) { return fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); }

  // What a guest may call; the server checks it again (server/lib/guest.mjs guestMay).
  var READS = [/^\/$/, /^\/index\.html$/, /^\/app\/[^?#]*$/, /^\/data\/[^?#]*$/, /^\/api\/book$/, /^\/api\/claude$/, /^\/api\/history\/[^/?#]+$/, /^\/api\/health$/];
  function guestMay(method, path) {
    if (typeof path !== 'string' || path.charAt(0) !== '/') { return false; }
    if (method === 'GET' || method === 'HEAD') { return READS.some(function (re) { return re.test(path); }); }
    return method === 'PUT' && path === '/api/notes';
  }
  function cleanName(name) {
    var s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return s || 'Guest';
  }

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  var share = null; // the share this tab hosts: { room, token, secret, broker, ws, peers, url, expiresAt }
  var hostState = 'starting'; // 'starting' | 'live' | 'off' | 'other-tab', for the share pill (live.js)
  var watchers = [];
  function changedState() { watchers.forEach(function (fn) { try { fn(); } catch (e) { /* the page's problem */ } }); }
  function setState(st) { hostState = st; changedState(); }

  function joinedPeers() {
    if (!share) { return []; }
    return Object.keys(share.peers).map(function (k) { return share.peers[k]; }).filter(function (p) { return p.joined && p.id; });
  }
  function ownerName() { return (window.SpecBook && window.SpecBook.me && window.SpecBook.me().name) || 'Owner'; }
  function people() {
    var R = window.SpecRelay;
    var out = [{ id: 'host', name: ownerName(), color: R.colorOf('host'), role: 'owner' }];
    joinedPeers().forEach(function (p) { out.push({ id: p.id, name: p.name, color: R.colorOf(p.id), role: 'guest' }); });
    return out;
  }
  function reportGuests() {
    if (!share) { return; }
    post('/api/share/guests', { tab: TAB, guests: joinedPeers().map(function (p) { return p.name; }) }).catch(function () {});
    changedState();
  }

  // Live messages: to every guest but `except`, as one frame each.
  function sendLive(msg, except) {
    if (!share) { return; }
    var text = JSON.stringify(msg);
    joinedPeers().forEach(function (p) {
      if (p.id === except || !p.channel || p.channel.readyState !== 'open') { return; }
      try { p.channel.send(text); } catch (e) { /* closing */ }
    });
  }
  function toLive(msg) { if (window.SpecLive && window.SpecLive.receive) { window.SpecLive.receive(msg); } }
  var LIVE_KINDS = { hello: 1, where: 1, draft: 1, typing: 1, follow: 1, bye: 1 };
  // A guest's live message: stamped with who sent it (never trusted from the guest), checked, then passed to the
  // other guests and to this page.
  function onLive(peer, f) {
    if (!peer.id || !LIVE_KINDS[f.kind]) { return; }
    var msg = {};
    Object.keys(f).forEach(function (k) { msg[k] = f[k]; });
    msg.t = 'live';
    msg.from = peer.id;
    if (msg.kind === 'hello') {
      msg.name = peer.name; msg.color = window.SpecRelay.colorOf(peer.id); msg.role = 'guest';
      // The guest's reader has loaded: it hears who is here.
      try { peer.channel.send(JSON.stringify({ t: 'live', kind: 'roster', you: peer.id, people: people() })); } catch (e) { /* closing */ }
    }
    if (msg.kind === 'draft') {
      var id = msg.note;
      var notes = {};
      var n = window.SpecBook && window.SpecBook.noteOf ? window.SpecBook.noteOf(id) : null;
      if (n) { notes[id] = n; }
      if (!window.SpecRelay.mayDraft({ key: peer.key }, id, notes)) { return; }
      msg.author = peer.name;
    }
    if (msg.kind === 'follow' && msg.leader !== null && typeof msg.leader !== 'string') { return; }
    sendLive(msg, peer.id);
    toLive(msg);
  }
  // A newcomer hears who is here; everyone else hears the newcomer.
  function welcome(peer) {
    var R = window.SpecRelay;
    try { peer.channel.send(JSON.stringify({ t: 'live', kind: 'roster', you: peer.id, people: people() })); } catch (e) { /* closing */ }
    var hello = { t: 'live', kind: 'hello', from: peer.id, name: peer.name, color: R.colorOf(peer.id), role: 'guest' };
    sendLive(hello, peer.id);
    toLive(hello);
  }

  function sign(text) {
    return crypto.subtle.importKey('raw', fromB64url(share.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) { return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)); })
      .then(function (sig) { return b64url(new Uint8Array(sig)); });
  }

  // Sends frames as the channel drains (an event, not a timer, so a background tab is not slowed).
  function sendFrames(ch, frames) {
    var i = 0;
    return new Promise(function (resolve) {
      function pump() {
        while (i < frames.length) {
          if (ch.readyState !== 'open') { resolve(); return; }
          if (ch.bufferedAmount > 1000000) { ch.addEventListener('bufferedamountlow', pump, { once: true }); return; }
          try { ch.send(JSON.stringify(frames[i++])); } catch (e) { resolve(); return; }
        }
        resolve();
      }
      ch.bufferedAmountLowThreshold = 256 * 1024;
      pump();
    });
  }
  function framesOf(header, bytes) {
    var all = toB64(bytes || new Uint8Array(0));
    var out = [];
    for (var seq = 0, at = 0; at < all.length || seq === 0; seq++, at += CHUNK) {
      var f = {};
      Object.keys(header).forEach(function (k) { f[k] = header[k]; });
      f.seq = seq; f.last = at + CHUNK >= all.length; f.data = all.slice(at, at + CHUNK);
      out.push(f);
    }
    return out;
  }
  function jsonBytes(o) { return new TextEncoder().encode(JSON.stringify(o)); }

  // One guest request: checked, then made against this server as that guest.
  function answer(peer, header, body) {
    function reply(status, type, bytes) { return sendFrames(peer.channel, framesOf({ t: 'res', id: header.id, status: status, type: type }, bytes)); }
    var method = String(header.method || 'GET').toUpperCase();
    var raw = typeof header.path === 'string' && header.path.length < 2048 ? header.path : '';
    // Parsed against this page's own origin, and refused unless it stays there: a backslash, a tab or a // must not
    // turn the path into another host. What is fetched is the parsed path, never the raw text.
    var u = null;
    var path = '';
    try {
      u = new URL(raw, location.origin);
      path = decodeURIComponent(u.pathname);
    } catch (e) { u = null; }
    if (!u || u.origin !== location.origin || raw.charAt(0) !== '/' || !guestMay(method, path)) { return reply(403, 'application/json', jsonBytes({ error: 'guest' })); }
    if (peer.inFlight >= IN_FLIGHT || inFlight >= SHARE_IN_FLIGHT) { return reply(429, 'application/json', jsonBytes({ error: 'busy' })); }
    peer.inFlight++;
    inFlight++;
    var headers = { 'x-specbook-guest': encodeURIComponent(JSON.stringify({ name: peer.name, key: peer.key })) };
    if (method === 'PUT') { headers['content-type'] = 'application/json'; }
    var done = function () { peer.inFlight--; inFlight--; };
    return fetch(u.pathname + u.search, { method: method, headers: headers, body: method === 'PUT' ? body : undefined, cache: 'no-store' })
      .then(function (r) {
        if (Number(r.headers.get('content-length')) > MAX_RESPONSE) { return reply(413, 'application/json', jsonBytes({ error: 'too-large' })); }
        return r.arrayBuffer().then(function (buf) {
          if (buf.byteLength > MAX_RESPONSE) { return reply(413, 'application/json', jsonBytes({ error: 'too-large' })); }
          return reply(r.status, r.headers.get('content-type') || 'application/octet-stream', new Uint8Array(buf));
        });
      }, function () { return reply(502, 'application/json', jsonBytes({ error: 'unreachable' })); })
      .then(done, done);
  }

  function onChannel(peer, ch) {
    peer.channel = ch;
    var open = {};
    ch.onmessage = function (e) {
      var f;
      try { f = JSON.parse(e.data); } catch (err) { return; }
      if (f && f.t === 'live') { onLive(peer, f); return; }
      if (!f || f.t !== 'req' || typeof f.data !== 'string') { return; }
      var was = open[f.id];
      if (!was) {
        if (Object.keys(open).length >= MAX_OPEN) { return; }
        was = open[f.id] = { header: f, parts: [], size: 0 };
      }
      if (f.seq !== was.parts.length) { delete open[f.id]; return; }
      was.parts.push(f.data);
      was.size += f.data.length;
      if (was.size * 0.75 > MAX_BODY) { delete open[f.id]; return; }
      if (!f.last) { return; }
      delete open[f.id];
      var bytes = fromB64(was.parts.join(''));
      answer(peer, was.header, bytes.length ? bytes : null);
    };
    // A channel the guest opened is often open already by the time it arrives here.
    var joined = function () {
      if (peer.joined) { return; }
      // The same person on a newer connection replaces the older one.
      Object.keys(share.peers).forEach(function (k) {
        var other = share.peers[k];
        if (other !== peer && other.id === peer.id) { drop(k, other); }
      });
      peer.joined = true;
      welcome(peer);
      reportGuests();
    };
    if (ch.readyState === 'open') { joined(); } else { ch.onopen = joined; }
    ch.onclose = function () { drop(peer.from, peer); };
  }

  function drop(from, peer) {
    if (!share || share.peers[from] !== peer) { return; }
    delete share.peers[from];
    clearTimeout(peer.timer);
    try { peer.pc.close(); } catch (e) { /* closed */ }
    if (peer.joined && peer.id) {
      var bye = { t: 'live', kind: 'bye', from: peer.id };
      sendLive(bye, peer.id);
      toLive(bye);
    }
    reportGuests();
  }

  var iceCache = null;
  function iceServers() {
    if (iceCache) { return Promise.resolve(iceCache); }
    return fetch(share.broker + '/api/rooms/' + share.room + '/ice?token=' + encodeURIComponent(share.token))
      .then(function (r) { return r.json(); })
      .then(function (j) { iceCache = j.iceServers; return iceCache; })
      .catch(function () { return [{ urls: 'stun:stun.cloudflare.com:3478' }]; });
  }
  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') { return Promise.resolve(); }
    return new Promise(function (done) {
      var t = setTimeout(done, 5000);
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') { clearTimeout(t); done(); } });
    });
  }

  function onOffer(msg) {
    var s = share;
    var name = cleanName(msg.name);
    function reject(error) { s.ws.send(JSON.stringify({ type: 'reject', to: msg.from, error: error })); }
    if (typeof msg.from !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(msg.key || '') || typeof msg.sdp !== 'string') { reject('bad-signature'); return; }
    sign(['offer', s.room, msg.key, msg.name, msg.sdp].join('\n')).then(function (want) {
      if (share !== s) { return null; }
      if (want !== msg.sig) { reject('bad-signature'); return null; }
      // One connection per guest socket, and the slot is taken before anything waits.
      if (s.peers[msg.from] || Object.keys(s.peers).length >= MAX_GUESTS) { reject('full'); return null; }
      var peer = { from: msg.from, name: name, key: msg.key, id: null, inFlight: 0, joined: false, channel: null, pc: null };
      s.peers[msg.from] = peer;
      peer.timer = setTimeout(function () { if (!peer.joined) { drop(msg.from, peer); } }, 30000);
      return window.SpecRelay.peerIdOf(msg.key).then(function (id) { peer.id = id; return iceServers(); }).then(function (ice) {
        var pc = peer.pc = new RTCPeerConnection({ iceServers: ice });
        pc.ondatachannel = function (e) { onChannel(peer, e.channel); };
        pc.addEventListener('connectionstatechange', function () {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { drop(msg.from, peer); }
        });
        return pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
          .then(function () { return pc.createAnswer(); })
          .then(function (a) { return pc.setLocalDescription(a); })
          .then(function () { return gathered(pc); })
          .then(function () {
            var sdp = pc.localDescription.sdp;
            return sign(['answer', s.room, msg.key, sdp].join('\n')).then(function (sig) {
              s.ws.send(JSON.stringify({ type: 'answer', to: msg.from, sdp: sdp, sig: sig }));
            });
          });
      }).catch(function () { drop(msg.from, peer); });
    }).catch(function () { /* a bad offer: ignored */ });
  }

  function connectBroker(delay) {
    var s = share;
    var ws = new WebSocket(s.broker.replace(/^http/, 'ws') + '/api/rooms/' + s.room + '/host?token=' + encodeURIComponent(s.token));
    s.ws = ws;
    var ping = null;
    ws.onopen = function () {
      delay = 1000;
      ping = setInterval(function () { if (ws.readyState === 1) { ws.send('ping'); } }, 30000);
      if (!s.live) {
        s.live = true;
        // The local server remembers the room, so a reloaded tab reuses it. A share it no longer expects (stopped while
        // starting) ends here.
        post('/api/share/live', { tab: TAB, room: s.room, hostToken: s.token, secret: s.secret, url: s.url, expiresAt: s.expiresAt }).then(function (r) {
          if (!r.ok && share === s) { drop_share(false); }
        }, function () { if (share === s) { drop_share(false); } });
        setState('live');
      }
    };
    ws.onmessage = function (e) {
      if (e.data === 'pong') { return; }
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'offer') { onOffer(msg); }
      if (msg.type === 'gone') { gone(s); }
    };
    ws.onclose = function (e) {
      clearInterval(ping);
      if (share !== s) { return; }
      if (e.code === 4404 || e.code === 4403) { gone(s); return; }
      // A room that is gone answers its address with 404 (which a socket only reports as a failed connection), so
      // that is asked first.
      setTimeout(function () {
        if (share !== s) { return; }
        fetch(s.broker + '/api/rooms/' + s.room).then(function (r) {
          if (share !== s) { return; }
          if (r.status === 404) { gone(s); return; }
          connectBroker(Math.min(delay * 2, 15000));
        }, function () { if (share === s) { connectBroker(Math.min(delay * 2, 15000)); } });
      }, delay);
    };
  }
  // The room expired or was ended elsewhere: the server forgets it, and asks for a new one.
  function gone(s) {
    if (share !== s) { return; }
    drop_share(false);
    post('/api/share/ended', { tab: TAB, why: 'gone' }).catch(function () {});
    setState('off');
  }

  var starting = 0; // which start is current: a stop while a room is being opened cancels it
  function start(req) {
    var broker = String(req.broker || '').replace(/\/+$/, '');
    if (share && share.broker === broker && (!req.room || req.room.room === share.room)) {
      post('/api/share/live', { tab: TAB, room: share.room, hostToken: share.token, secret: share.secret, url: share.url, expiresAt: share.expiresAt });
      return;
    }
    drop_share(false);
    var mine = ++starting;
    setState('starting');
    // The room the local server remembers: the same link as before this tab opened.
    if (req.room && req.room.room) {
      begin({ room: req.room.room, hostToken: req.room.hostToken, expiresAt: req.room.expiresAt }, req.room.secret, broker);
      return;
    }
    fetch(broker + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hours: req.hours, protocol: PROTOCOL }) })
      .then(function (r) {
        if (!r.ok) { return r.text().then(function (t) { throw new Error('The share server refused to open a room (' + r.status + '): ' + t); }); }
        return r.json();
      })
      .then(function (room) {
        if (mine !== starting || share) { return; }
        begin(room, b64url(crypto.getRandomValues(new Uint8Array(32))), broker);
      })
      .catch(function (e) {
        setState('off');
        post('/api/share/failed', { tab: TAB, error: e.message || 'Could not reach the share server at ' + broker });
      });
  }
  function begin(room, secret, broker) {
    share = { room: room.room, token: room.hostToken, expiresAt: room.expiresAt, secret: secret, broker: broker, peers: {}, live: false,
      url: broker + '/s/' + room.room + '#' + secret };
    var s = share;
    var left = Date.parse(room.expiresAt) - Date.now();
    if (left > 0) { s.timer = setTimeout(function () { gone(s); }, Math.min(left, 0x7fffffff)); }
    connectBroker(1000);
  }

  // Lets go of the share in this tab: every guest's connection closes. With `end`, the room ends at the share server
  // too, so the link stops working.
  function drop_share(end) {
    starting++;
    var s = share;
    if (!s) { return; }
    share = null;
    clearTimeout(s.timer);
    if (end) {
      fetch(s.broker + '/api/rooms/' + s.room + '/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: s.token }) }).catch(function () {});
    }
    try { s.ws.close(); } catch (e) { /* closed */ }
    Object.keys(s.peers).forEach(function (k) {
      var p = s.peers[k];
      try { if (p.channel) { p.channel.close(); } p.pc.close(); } catch (e) { /* closed */ }
    });
    changedState();
  }
  function stop() {
    drop_share(true);
    setState('off');
  }

  // Closing or reloading the tab drops the guests' connections at once; the room stays, so they reconnect to the same
  // link when the book is open again.
  window.addEventListener('pagehide', function () { drop_share(false); });
  // The server says the book or its notes changed on disk: this page loads them, and every guest polls at once.
  function changed() {
    if (window.SpecBook) {
      if (window.SpecBook.reloadNotes) { window.SpecBook.reloadNotes(); }
      if (window.SpecBook.poll) { window.SpecBook.poll(); }
    }
    if (!share) { return; }
    Object.keys(share.peers).forEach(function (k) {
      var ch = share.peers[k].channel;
      if (ch && ch.readyState === 'open') { try { ch.send(JSON.stringify({ t: 'changed' })); } catch (e) { /* closing */ } }
    });
  }

  // One tab per book listens (the browser allows few connections to one server, and every open stream holds one): the
  // tab that holds the lock. When it closes, the next tab takes over. Until then, this tab says the share runs in
  // the other one.
  var events = null;
  function listenOnce() {
    if (navigator.locks && navigator.locks.request) {
      var got = false;
      setTimeout(function () { if (!got) { setState('other-tab'); } }, 400);
      navigator.locks.request('specbook-share-host:' + location.host, function () {
        got = true;
        listen();
        return new Promise(function () { /* held until the tab closes */ });
      });
    } else {
      listen();
    }
  }
  function listen() {
    // The server asks a listening tab to host at once, unless the book does not share by itself.
    setState('starting');
    setTimeout(function () { if (hostState === 'starting' && !share) { setState('off'); } }, 1500);
    events = new EventSource('/api/share/events?tab=' + TAB);
    events.addEventListener('start', function (e) { try { start(JSON.parse(e.data)); } catch (err) { /* bad event */ } });
    events.addEventListener('stop', stop);
    events.addEventListener('end-room', function () { drop_share(true); });
    events.addEventListener('changed', changed);
    events.onerror = function () {
      // The server went away (stopped, or restarted): it ended the room as it stopped. The stream reconnects by itself.
      drop_share(false);
      setState('off');
      if (events.readyState === 2) { setTimeout(listen, 5000); }
    };
  }

  // For live.js and the share pill.
  window.SpecHost = {
    send: function (msg) {
      var m = {};
      Object.keys(msg || {}).forEach(function (k) { m[k] = msg[k]; });
      m.t = 'live';
      m.from = 'host';
      sendLive(m, null);
    },
    people: people,
    link: function () { return share && share.live ? share.url : null; },
    state: function () { return hostState; },
    onChange: function (fn) { watchers.push(fn); },
    newLink: function () { return post('/api/share/new-link', {}); },
    stopSharing: function () { return post('/api/share/stop', {}); },
    startSharing: function () { return post('/api/share', {}); },
  };
  listenOnce();
})();
