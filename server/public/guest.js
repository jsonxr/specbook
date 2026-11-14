// A guest of a shared spec book. On /s/<room>#<key>: asks for a name, connects to the book's host (the owner's open
// book tab) over WebRTC, then loads the reader itself from that tab, over the connection, by running the book's own
// /app/guest.js with window.SpecShare (below). This server never sees the book; it only passes the signed handshake.
//
// Wire format on the data channel (the host is the specbook plugin's app/host.js; keep the two in step):
//   guest -> host  { t: 'req', id, method, path, seq, last, data }   data: base64 of a slice of the body
//   host -> guest  { t: 'res', id, status, type, seq, last, data }
//   host -> guest  { t: 'changed' }
// Handshake: the offer signs "offer\n<room>\n<key>\n<name>\n<sdp>", the answer "answer\n<room>\n<key>\n<sdp>",
// both HMAC-SHA256 under the link's key, base64url.
(function () {
  'use strict';
  var PROTOCOL = 1;
  var m = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  if (!m) { return; }
  var ROOM = m[1];
  var CHUNK = 12000;
  var boot = document.getElementById('share-boot');

  // The link's key (after #) is taken out of the address, so the book's own #anchors work, and a reload still connects.
  // It is kept for this tab only (sessionStorage), so a book shared later on this server cannot read it.
  var SECRET = '';
  try {
    var fromHash = location.hash.slice(1);
    if (/^[A-Za-z0-9_-]{43}$/.test(fromHash)) {
      sessionStorage.setItem('specbook-share:' + ROOM, fromHash);
      history.replaceState(null, '', location.pathname + location.search);
    }
    SECRET = sessionStorage.getItem('specbook-share:' + ROOM) || '';
  } catch (e) {
    SECRET = location.hash.slice(1);
  }

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(s) {
    return fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  }
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) { s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); }
    return btoa(s);
  }
  function fromB64(s) {
    var b = atob(s);
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) { out[i] = b.charCodeAt(i); }
    return out;
  }
  function sign(text) {
    return crypto.subtle.importKey('raw', fromB64url(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) { return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)); })
      .then(function (sig) { return b64url(new Uint8Array(sig)); });
  }

  var chip = document.createElement('div');
  chip.className = 'share-chip';
  chip.setAttribute('role', 'status');
  function status(text, bad) {
    chip.textContent = text;
    chip.classList.toggle('bad', !!bad);
    if (!chip.isConnected) { document.body.appendChild(chip); }
  }
  function showError(text) {
    if (boot && boot.isConnected) { boot.textContent = text; }
    var loading = document.querySelector('#main .loading');
    if (loading) { loading.textContent = text; }
  }

  var me = null;
  function whoAmI() {
    // The name is remembered for every share; the key that makes notes yours is one per share, so one book cannot
    // pose as you in another.
    var name = '';
    var key = '';
    try {
      name = localStorage.getItem('specbook-guest-name') || '';
      key = localStorage.getItem('specbook-guest-key:' + ROOM) || '';
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
        key = b64url(crypto.getRandomValues(new Uint8Array(18)));
        localStorage.setItem('specbook-guest-key:' + ROOM, key);
      }
    } catch (e) {
      key = key || b64url(crypto.getRandomValues(new Uint8Array(18)));
    }
    if (name) { return Promise.resolve({ name: name, key: key }); }
    return new Promise(function (done) {
      var box = document.createElement('div');
      box.className = 'share-join';
      box.innerHTML = '<form><h2>Join this spec book</h2><p>Your name is shown on the notes you leave.</p>' +
        '<input name="name" maxlength="40" autocomplete="name" placeholder="Your name" required>' +
        '<button type="submit">Join</button></form>';
      document.body.appendChild(box);
      var form = box.querySelector('form');
      var input = form.querySelector('input');
      input.focus();
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var typed = input.value.replace(/\s+/g, ' ').trim();
        if (!typed) { return; }
        var who = { name: typed.slice(0, 40), key: key };
        try { localStorage.setItem('specbook-guest-name', who.name); } catch (err) { /* asked again next time */ }
        box.remove();
        done(who);
      });
    });
  }

  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') { return Promise.resolve(); }
    return new Promise(function (done) {
      var t = setTimeout(done, 5000);
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') { clearTimeout(t); done(); } });
    });
  }

  // One attempt: resolves with an open channel, or rejects with a reason a person can read. `final` marks a reason
  // that trying again will not fix.
  function fail(text, final) { var e = new Error(text); e.final = !!final; return e; }
  function connect() {
    return fetch('/api/rooms/' + ROOM).then(function (r) {
      if (r.status === 404) { throw fail('This share has ended. Ask for a new link.', true); }
      return r.ok ? r.json() : { host: true };
    }).then(function (room) {
      if (!room.host) { throw fail('The book\u2019s host is offline right now.'); }
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/rooms/' + ROOM + '/guest');
        var pc = null;
        var ch = null;
        var settled = false;
        var timer = setTimeout(function () { finish(fail('The book\u2019s host did not answer.')); }, 25000);
        function finish(err) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) { /* closed */ }
          if (err) { if (pc) { pc.close(); } reject(err); }
        }
        // The socket first asks for ICE servers (a relay, when the share server offers one), then carries the offer.
        function offer(iceServers) {
          pc = new RTCPeerConnection({ iceServers: iceServers });
          ch = pc.createDataChannel('book', { ordered: true });
          ch.pc = pc;
          ch.onopen = function () { finish(null); resolve(ch); };
          pc.addEventListener('connectionstatechange', function () {
            if (pc.connectionState === 'failed') { finish(fail('Could not connect to the book\u2019s host from this network.')); }
          });
          return pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
            .then(function () { return gathered(pc); })
            .then(function () {
              var sdp = pc.localDescription.sdp;
              return sign(['offer', ROOM, me.key, me.name, sdp].join('\n')).then(function (sig) {
                ws.send(JSON.stringify({ type: 'offer', key: me.key, name: me.name, sdp: sdp, sig: sig, protocol: PROTOCOL }));
              });
            });
        }
        ws.onopen = function () { ws.send(JSON.stringify({ type: 'ice' })); };
        ws.onerror = function () { finish(fail('The book\u2019s host is not sharing right now.')); };
        ws.onclose = function () { if (!settled && !(ch && ch.readyState === 'open')) { finish(fail('The book\u2019s host is not sharing right now.')); } };
        ws.onmessage = function (e) {
          var msg;
          try { msg = JSON.parse(e.data); } catch (err) { return; }
          if (msg.type === 'ice') { offer(msg.iceServers).catch(function (err) { finish(err); }); return; }
          if (msg.type === 'host-offline') { finish(fail('The book\u2019s host is offline right now.')); return; }
          if (msg.type === 'gone') { finish(fail('This share has ended. Ask for a new link.', true)); return; }
          if (msg.type === 'reject') { finish(msg.error === 'full' ? fail('This book has as many guests as it can take.') : fail('This link is not valid for this share.', true)); return; }
          if (msg.type !== 'answer' || !pc) { return; }
          sign(['answer', ROOM, me.key, msg.sdp].join('\n')).then(function (want) {
            if (want !== msg.sig) { throw fail('The handshake was tampered with; not connecting.', true); }
            return pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          }).catch(function (err) { finish(err); });
        };
      });
    });
  }

  // The transport the book's guest.js uses. Calls made while not connected wait; only a final failure fails them.
  var channel = null;
  var terminal = null;
  var openWaiters = [];
  var waiting = {};
  var nextId = 1;
  var changedHandlers = [];
  function whenOpen() {
    if (channel) { return Promise.resolve(channel); }
    if (terminal) { return Promise.reject(terminal); }
    return new Promise(function (resolve, reject) { openWaiters.push({ resolve: resolve, reject: reject }); });
  }
  function settleWaiters(ch, err) {
    var list = openWaiters;
    openWaiters = [];
    list.forEach(function (w) { if (ch) { w.resolve(ch); } else { w.reject(err); } });
  }
  function failAll(why) {
    Object.keys(waiting).forEach(function (id) { waiting[id].reject(new TypeError(why)); });
    waiting = {};
  }
  function onFrame(e) {
    var f;
    try { f = JSON.parse(e.data); } catch (err) { return; }
    if (f.t === 'changed') { changedHandlers.forEach(function (fn) { try { fn(); } catch (err) { /* the page's problem */ } }); return; }
    if (f.t !== 'res' || !waiting[f.id]) { return; }
    var w = waiting[f.id];
    if (!w.header) { w.header = f; }
    w.parts.push(f.data || '');
    if (!f.last) { return; }
    delete waiting[f.id];
    w.resolve({ status: w.header.status, type: w.header.type || 'application/octet-stream', bytes: fromB64(w.parts.join('')) });
  }
  function request(method, path, body) {
    return whenOpen().then(function (ch) {
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        waiting[id] = { resolve: resolve, reject: reject, parts: [], header: null };
        var all = body ? toB64(body) : '';
        for (var seq = 0, at = 0; at < all.length || seq === 0; seq++, at += CHUNK) {
          ch.send(JSON.stringify({ t: 'req', id: id, method: method, path: path, seq: seq, last: at + CHUNK >= all.length, data: all.slice(at, at + CHUNK) }));
        }
      });
    });
  }

  var tries = 0;
  var loaded = false;
  function open() {
    connect().then(function (ch) {
      tries = 0;
      channel = ch;
      ch.onmessage = onFrame;
      var lost = false;
      var onLost = function () {
        if (lost) { return; }
        lost = true;
        if (channel === ch) { channel = null; }
        try { ch.pc.close(); } catch (e) { /* closed */ }
        failAll('The connection to the book’s host closed.');
        status('Reconnecting…', true);
        retry();
      };
      ch.onclose = onLost;
      ch.pc.addEventListener('connectionstatechange', function () {
        // Disconnected is how a host that went away first shows; a new connection is cheap if it was only a blip.
        if (['failed', 'closed', 'disconnected'].indexOf(ch.pc.connectionState) >= 0) { onLost(); }
      });
      status('Live · ' + me.name);
      settleWaiters(ch, null);
      if (loaded) { changedHandlers.forEach(function (fn) { fn(); }); } else { loadBook(); }
    }, function (err) {
      status(err.message, true);
      showError(err.message);
      if (err.final) {
        terminal = err;
        settleWaiters(null, err);
        return;
      }
      retry();
    });
  }
  function retry() {
    tries++;
    setTimeout(open, Math.min(15000, 1000 * Math.pow(2, Math.min(tries, 4))));
  }

  // The reader comes from the host: its guest.js knows how to draw the book from there.
  function loadBook() {
    loaded = true;
    request('GET', '/app/guest.js').then(function (res) {
      if (res.status !== 200) { throw fail('This book’s host is too old to share it; ask them to update the specbook plugin.', true); }
      var s = document.createElement('script');
      s.src = URL.createObjectURL(new Blob([res.bytes], { type: 'text/javascript' }));
      document.body.appendChild(s);
    }).catch(function (err) {
      status(err.message, true);
      showError(err.message);
    });
  }

  window.SpecShare = {
    protocol: PROTOCOL,
    get me() { return me; },
    request: request,
    onChanged: function (fn) { changedHandlers.push(fn); },
    status: status,
    showError: showError,
  };

  function start() {
    if (!SECRET || !window.RTCPeerConnection || !window.crypto || !crypto.subtle) {
      var why = !SECRET ? 'This link is missing its key: copy the whole link, including the part after #.' : 'This browser cannot open a shared book (it needs WebRTC over https).';
      status(why, true);
      showError(why);
      terminal = fail(why, true);
      return;
    }
    whoAmI().then(function (who) { me = who; status('Connecting…'); open(); });
  }
  start();
})();
