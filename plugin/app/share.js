// A reader of a shared book, on the share server's website (/s/<room>). The site serves this reader itself, from
// /r/<version>/ (server/publish-reader.mjs), and this file is its connection: it asks for a name (or uses the owner's
// pin), connects to the book's host (the owner's book server, server/lib/host.mjs) over WebRTC, and sets
// window.SpecShare before model.js, book.js and live.js run, so they draw the book from the host. Nothing the host
// sends is ever run as code: its bytes are only data (JSON, the book's HTML, which book.js cleans, and media).
//
// Wire format on the data channel (keep in step with host.mjs and channel.mjs):
//   reader -> host  { t: 'hello', protocol: 3, version, pin? }                the first frame
//   host -> reader  { t: 'pin-bad' }                                          the pin is wrong (a guest welcome follows)
//   host -> reader  { t: 'welcome', role, protocol: 3, version, you, ownerName }
//   reader -> host  { t: 'req', id, method, path, seq, last, data }           data: base64 of a slice of the body
//   host -> reader  { t: 'res', id, status, type, seq, last, data }
//   host -> reader  { t: 'changed' }
//   both ways       { t: 'live', kind, ... }                                  presence, drafts and following (live.js)
// The handshake goes through the share server's socket for this room: { type: 'ice' } asks for ICE servers, then an
// unsigned { type: 'offer', sdp, key, name, device, protocol: 3 } goes to the host, which answers { type: 'answer' }.
// While the host is away the room stays: this page waits on its socket for host-online, without polling.
(function () {
  'use strict';
  // The owner's pin link (#pin=<pin>): taken out of the address first of all, before any check that could stop this
  // file, without a reload, so it is never left in the address bar, the history, or a copied link. It is saved for this
  // room in this browser; localStorage never leaves the browser (a cookie would go to the website with every request).
  var given = /^#pin=(.*)$/.exec(location.hash);
  if (given) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
  }
  var m = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  var PIN_OK = /^[A-Za-z0-9]{22}$/;
  var PIN_KEY = m ? 'specbook-pin:' + m[1] : '';
  var pin = '';
  if (given && m && PIN_OK.test(given[1])) {
    try { localStorage.setItem(PIN_KEY, given[1]); } catch (e) { pin = given[1]; }
  }
  given = null;

  var PROTOCOL = 3;
  var CHUNK = 12000;
  var meta = document.querySelector('meta[name="specbook-reader"]');
  var READER = meta ? meta.getAttribute('content') || '' : '';
  if (!m || !/^\d+\.\d+\.\d+$/.test(READER)) { return; }
  var ROOM = m[1];
  var WAITING = 'The book isn\u2019t open right now. This page will reconnect when it is.';
  var UPDATED = 'This book was updated. Reload this page.';
  var PIN_BAD = 'This pin no longer works.';

  try {
    var saved = localStorage.getItem(PIN_KEY) || '';
    if (PIN_OK.test(saved)) { pin = saved; }
  } catch (e) { /* only this tab has it */ }
  function forgetPin() {
    pin = '';
    try { localStorage.removeItem(PIN_KEY); } catch (e) { /* nothing saved */ }
  }

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  var chip = document.createElement('div');
  chip.className = 'share-chip';
  chip.setAttribute('role', 'status');
  // The chip says what is wrong (or that it is connecting); once the book is live it hides, keeping its text.
  function status(text, bad, quiet) {
    chip.textContent = text;
    chip.hidden = !!quiet;
    chip.classList.toggle('bad', !!bad);
    if (!chip.isConnected) { document.body.appendChild(chip); }
  }
  function showError(text) {
    var loading = document.querySelector('#main .loading');
    if (loading) { loading.textContent = text; }
  }

  // Who this reader is. The name is remembered for every share; the key that makes notes yours is one per share, so
  // one book cannot pose as you in another. The device is this browser, for every share: the same person on the same
  // device is one face in the book. (The same keys as the older guest page, so a person keeps their face and notes.)
  var me = null;
  function identity() {
    var name = '';
    var key = '';
    var device = '';
    var idOk = /^[A-Za-z0-9_-]{8,64}$/;
    try {
      device = localStorage.getItem('specbook-device') || '';
      if (!idOk.test(device)) {
        device = b64url(crypto.getRandomValues(new Uint8Array(18)));
        localStorage.setItem('specbook-device', device);
      }
      name = localStorage.getItem('specbook-guest-name') || '';
      key = localStorage.getItem('specbook-guest-key:' + ROOM) || '';
      if (!idOk.test(key)) {
        key = b64url(crypto.getRandomValues(new Uint8Array(18)));
        localStorage.setItem('specbook-guest-key:' + ROOM, key);
      }
    } catch (e) {
      key = key || b64url(crypto.getRandomValues(new Uint8Array(18)));
      device = device || b64url(crypto.getRandomValues(new Uint8Array(18)));
    }
    return { name: name, key: key, device: device };
  }
  // The name box. `note`, when given, is said first (a pin that no longer works).
  function askName(note, current) {
    return new Promise(function (done) {
      var box = document.createElement('div');
      box.className = 'share-join';
      var form = document.createElement('form');
      var h = document.createElement('h2');
      h.textContent = 'Join this spec book';
      form.appendChild(h);
      if (note) {
        var bad = document.createElement('p');
        bad.className = 'share-join-bad';
        bad.setAttribute('role', 'alert');
        bad.textContent = note;
        form.appendChild(bad);
      }
      var p = document.createElement('p');
      p.textContent = 'Your name is shown on the notes you leave.';
      form.appendChild(p);
      var input = document.createElement('input');
      input.name = 'name';
      input.maxLength = 40;
      input.autocomplete = 'name';
      input.placeholder = 'Your name';
      input.required = true;
      input.value = current || '';
      form.appendChild(input);
      var go = document.createElement('button');
      go.type = 'submit';
      go.textContent = 'Join';
      form.appendChild(go);
      box.appendChild(form);
      document.body.appendChild(box);
      input.focus();
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var typed = input.value.replace(/\s+/g, ' ').trim();
        if (!typed) { return; }
        var name = typed.slice(0, 40);
        try { localStorage.setItem('specbook-guest-name', name); } catch (err) { /* asked again next time */ }
        box.remove();
        done(name);
      });
    });
  }
  // With the pin, no name is asked: the owner's name comes from the host's welcome.
  function whoAmI() {
    var who = identity();
    if (who.name || pin) { return Promise.resolve(who); }
    return askName('', '').then(function (name) { who.name = name; return who; });
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
    return fetch('/api/rooms/' + ROOM, { cache: 'no-store' }).then(function (r) {
      // Ended, or expired while the owner's book server was off (its next start brings the same link back).
      if (r.status === 410) { throw fail('This share has ended. Ask for a new link.', true); }
      if (r.status === 404) { throw fail('This share isn’t open right now. Reload this page once the owner has the book open, or ask for a new link.', true); }
      if (!r.ok) { throw fail('The share server is not answering. Trying again…'); }
      return r.json();
    }).then(function (room) {
      // This page is the reader of one version: a room whose host now speaks another needs the page for that one.
      if (!room || Number(room.protocol) !== PROTOCOL || room.reader !== READER) { throw fail(UPDATED, true); }
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/rooms/' + ROOM + '/guest');
        var pc = null;
        var ch = null;
        var settled = false;
        var timer = null;
        function arm() { clearTimeout(timer); timer = setTimeout(function () { finish(fail('The book’s host did not answer.')); }, 25000); }
        arm();
        function finish(err) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          clearInterval(ping);
          try { ws.close(); } catch (e) { /* closed */ }
          if (err) { if (pc) { pc.close(); } reject(err); }
        }
        // The socket first asks for ICE servers (a relay, when the share server offers one), then carries the offer.
        function offer(iceServers) {
          pc = new RTCPeerConnection({ iceServers: iceServers });
          ch = pc.createDataChannel('book', { ordered: true });
          ch.pc = pc;
          ch.onopen = function () { finish(null); resolve(ch); };
          var mine = pc;
          pc.addEventListener('connectionstatechange', function () {
            if (pc === mine && mine.connectionState === 'failed') { finish(fail('Could not connect to the book’s host from this network.')); }
          });
          return pc.createOffer().then(function (o) { return mine.setLocalDescription(o); })
            .then(function () { return gathered(mine); })
            .then(function () {
              if (pc !== mine || settled) { return; }
              ws.send(JSON.stringify({ type: 'offer', sdp: mine.localDescription.sdp, key: me.key, name: me.name, device: me.device, protocol: PROTOCOL }));
            });
        }
        // A keepalive while waiting for the host; the share server answers it without waking.
        var ping = null;
        ws.onopen = function () {
          ws.send(JSON.stringify({ type: 'ice' }));
          ping = setInterval(function () { if (ws.readyState === 1) { ws.send('ping'); } }, 30000);
        };
        ws.onerror = function () { finish(fail('The book’s host is not sharing right now.')); };
        ws.onclose = function (e) {
          if (settled || (ch && ch.readyState === 'open')) { return; }
          // The share server stops a reader waiting after an hour: trying again is the reader's call, not this page's.
          if (e.code === 4408) { finish(fail('The book was not opened within an hour. Reload this page to try again.', true)); return; }
          finish(fail('The book’s host is not sharing right now.'));
        };
        ws.onmessage = function (e) {
          if (e.data === 'pong') { return; }
          var msg;
          try { msg = JSON.parse(e.data); } catch (err) { return; }
          if (!msg || typeof msg !== 'object') { return; }
          if (msg.type === 'ice') {
            if (pc) { return; }
            offer(Array.isArray(msg.iceServers) ? msg.iceServers : []).catch(function (err) { finish(err); });
            return;
          }
          // The host is away: wait on this socket, without a deadline, until it comes back.
          if (msg.type === 'host-offline') {
            clearTimeout(timer);
            if (pc) { try { pc.close(); } catch (err) { /* closed */ } pc = null; ch = null; }
            peerState('waiting');
            status(WAITING, true);
            showError(WAITING);
            return;
          }
          // The host is back (or reconnected again): any offer in flight went to its old socket, so start afresh.
          if (msg.type === 'host-online') {
            if (pc) { try { pc.close(); } catch (err) { /* closed */ } pc = null; ch = null; }
            arm(); status('Connecting…'); ws.send(JSON.stringify({ type: 'ice' }));
            return;
          }
          if (msg.type === 'gone') { finish(fail('This share has ended. Ask for a new link.', true)); return; }
          if (msg.type === 'reject') { finish(msg.error === 'full' ? fail('This book has as many readers as it can take.') : fail('This link is not valid for this share.', true)); return; }
          if (msg.type !== 'answer' || !pc || typeof msg.sdp !== 'string') { return; }
          pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(function (err) { finish(err); });
        };
      });
    });
  }

  // The first frames on a new channel: hello (with the pin, when this browser has one), then the host's welcome, which
  // says this reader's role. A wrong pin is forgotten here, and the host welcomes the reader as a guest.
  var pinBad = false;
  function greet(ch) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(fail('The book’s host did not answer.')); }, 15000);
      ch.onclose = function () { clearTimeout(t); reject(fail('The connection to the book’s host closed.')); };
      ch.onmessage = function (e) {
        var f;
        try { f = JSON.parse(e.data); } catch (err) { return; }
        if (!f || typeof f !== 'object') { return; }
        if (f.t === 'pin-bad') { pinBad = true; forgetPin(); return; }
        if (f.t !== 'welcome') { return; }
        clearTimeout(t);
        // A host on another protocol welcomes without a role; one on another version serves another reader.
        if (f.protocol !== PROTOCOL || f.version !== READER || (f.role !== 'owner' && f.role !== 'guest')) { reject(fail(UPDATED, true)); return; }
        resolve(f);
      };
      var hello = { t: 'hello', protocol: PROTOCOL, version: READER };
      if (pin) { hello.pin = pin; }
      try { ch.send(JSON.stringify(hello)); } catch (err) { clearTimeout(t); reject(fail('The connection to the book’s host closed.')); }
    });
  }

  // The transport book.js (through the fetch below) and live.js use. Calls made while not connected wait; only a final
  // failure fails them. A channel counts as open once the host has welcomed it.
  var channel = null;
  var terminal = null;
  var openWaiters = [];
  var waiting = {};
  var nextId = 1;
  var changedHandlers = [];
  var liveHandlers = [];
  var stateHandlers = [];
  var role = null;
  var ownerName = '';
  var markReady = null;
  var ready = new Promise(function (resolve) { markReady = resolve; });
  function each(list, arg) { list.forEach(function (fn) { try { fn(arg); } catch (err) { /* the page's problem */ } }); }
  function peerState(st) { each(stateHandlers, st); }
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
    if (!f || typeof f !== 'object') { return; }
    if (f.t === 'changed') { each(changedHandlers); return; }
    if (f.t === 'live') { each(liveHandlers, f); return; }
    if (f.t !== 'res' || !Object.prototype.hasOwnProperty.call(waiting, f.id)) { return; }
    var w = waiting[f.id];
    if (!w.header) { w.header = f; }
    w.parts.push(typeof f.data === 'string' ? f.data : '');
    if (!f.last) { return; }
    delete waiting[f.id];
    var bytes;
    try { bytes = fromB64(w.parts.join('')); } catch (err) { w.reject(new TypeError('The book’s host sent a broken answer.')); return; }
    w.resolve({ status: Number(w.header.status) || 502, type: typeof w.header.type === 'string' ? w.header.type : 'application/octet-stream', bytes: bytes });
  }
  function request(method, path, body) {
    return whenOpen().then(function (ch) {
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        waiting[id] = { resolve: resolve, reject: reject, parts: [], header: null };
        var all = body ? toB64(body) : '';
        try {
          for (var seq = 0, at = 0; at < all.length || seq === 0; seq++, at += CHUNK) {
            ch.send(JSON.stringify({ t: 'req', id: id, method: method, path: path, seq: seq, last: at + CHUNK >= all.length, data: all.slice(at, at + CHUNK) }));
          }
        } catch (err) {
          delete waiting[id];
          reject(new TypeError('The connection to the book’s host closed.'));
        }
      });
    });
  }

  var tries = 0;
  var loaded = false;
  function open() {
    var pending = null;
    connect().then(function (ch) {
      pending = ch;
      return greet(ch).then(function (w) { return { ch: ch, w: w }; });
    }).then(function (got) {
      var ch = got.ch;
      tries = 0;
      role = got.w.role;
      ownerName = typeof got.w.ownerName === 'string' ? got.w.ownerName : '';
      if (role === 'owner' && ownerName) { me.name = ownerName; }
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
        peerState('waiting');
        tries = 0;
        retry();
      };
      ch.onclose = onLost;
      ch.pc.addEventListener('connectionstatechange', function () {
        // Disconnected is how a host that went away first shows; a new connection is cheap if it was only a blip.
        if (['failed', 'closed', 'disconnected'].indexOf(ch.pc.connectionState) >= 0) { onLost(); }
      });
      status('Live · ' + (me.name || 'Guest'), false, true);
      settleWaiters(ch, null);
      peerState('live');
      if (loaded) { each(changedHandlers); } else { loaded = true; markReady(); }
      if (pinBad) { pinBad = false; pinGone(); }
    }, function (err) {
      if (pending) { try { pending.pc.close(); } catch (e) { /* closed */ } }
      status(err.message, true);
      showError(err.message);
      if (err.final) {
        terminal = err;
        peerState('ended');
        settleWaiters(null, err);
        failAll(err.message);
        return;
      }
      retry();
    });
  }
  function retry() {
    tries++;
    setTimeout(open, Math.min(15000, 1000 * Math.pow(2, Math.min(tries, 4))));
  }

  // The pin was wrong (or replaced by a New pin): it is forgotten, and this reader goes on as a guest. The page asks
  // for a name, then reloads, so the book is drawn afresh with a guest's rights and that name.
  var askedAfterPin = false;
  function pinGone() {
    status(PIN_BAD, true);
    if (askedAfterPin) { return; }
    askedAfterPin = true;
    askName(PIN_BAD, identity().name).then(function () { location.reload(); });
  }

  // A live frame for the host to pass on; dropped while not connected, as live state is.
  function send(obj) {
    if (!channel || channel.readyState !== 'open') { return false; }
    var f = {};
    Object.keys(obj || {}).forEach(function (k) { f[k] = obj[k]; });
    f.t = 'live';
    try { channel.send(JSON.stringify(f)); return true; } catch (e) { return false; }
  }

  // The reader's fetches of /api/ and /data/ go to the host over the connection; anything else (the reader's own
  // files under /r/, the share server's /api/rooms/) to this site as usual. The host answers a reader's 17th waiting
  // request with 429 busy (IN_FLIGHT in host.mjs), and a book loads every mockup at once, so requests wait their turn
  // here: at most SENDING at a time.
  var realFetch = window.fetch.bind(window);
  function ours(url) {
    return url.origin === location.origin && /^\/(api|data)\//.test(url.pathname) && !/^\/api\/rooms\//.test(url.pathname);
  }
  var SENDING = 8;
  var sending = 0;
  var queue = [];
  function next() {
    while (sending < SENDING && queue.length) {
      var job = queue.shift();
      sending++;
      request(job.method, job.path, job.body).then(job.resolve, job.reject).then(function () {
        sending--;
        next();
      });
    }
  }
  function queued(method, path, body) {
    return new Promise(function (resolve, reject) {
      queue.push({ method: method, path: path, body: body, resolve: resolve, reject: reject });
      next();
    });
  }
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!ours(url)) { return realFetch(input, init); }
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = init && typeof init.body === 'string' ? new TextEncoder().encode(init.body) : null;
    return queued(method, url.pathname + url.search, body).then(function (res) {
      var empty = res.status === 204 || res.status === 304 || res.status < 200;
      return new Response(empty ? null : res.bytes, { status: res.status < 200 || res.status > 599 ? 502 : res.status, headers: { 'content-type': res.type } });
    });
  };

  // Images and recordings drawn with src="/data/…" (in the page and inside each mockup's shadow root) are not fetches:
  // they are loaded over the connection and shown from a blob URL, typed as media only.
  var media = {};
  var MEDIA = { IMG: ['src'], VIDEO: ['src', 'poster'], SOURCE: ['src'] };
  // Only raster images and plain video and audio keep their type: anything else (an SVG above all, which is a document
  // that can hold script, on this site's origin) is an opaque blob that no browser renders as a page.
  var MEDIA_TYPES = { 'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1, 'image/avif': 1, 'image/bmp': 1,
    'video/mp4': 1, 'video/webm': 1, 'video/quicktime': 1, 'video/ogg': 1, 'audio/mpeg': 1, 'audio/mp4': 1, 'audio/ogg': 1, 'audio/wav': 1, 'audio/webm': 1 };
  function mediaUrl(path) {
    if (!Object.prototype.hasOwnProperty.call(media, path)) {
      media[path] = window.fetch(path).then(function (r) {
        if (!r.ok) { throw new Error('not found'); }
        var type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        return r.arrayBuffer().then(function (buf) { return new Blob([buf], { type: Object.prototype.hasOwnProperty.call(MEDIA_TYPES, type) ? type : 'application/octet-stream' }); });
      }).then(function (b) { return URL.createObjectURL(b); });
      media[path].catch(function () { delete media[path]; });
    }
    return media[path];
  }
  function fixMedia(el) {
    var attrs = MEDIA[el.tagName];
    if (!attrs) { return; }
    attrs.forEach(function (a) {
      var v = el.getAttribute(a);
      if (v && v.indexOf('/data/') === 0) {
        el.setAttribute('data-shared-' + a, v);
        el.removeAttribute(a);
        mediaUrl(v).then(function (u) {
          if (el.getAttribute('data-shared-' + a) === v) { el.setAttribute(a, u); }
        }, function () { /* missing: stays blank, as a broken image would */ });
      }
    });
  }
  function scan(root) {
    if (root.nodeType === 1) { fixMedia(root); }
    if (root.querySelectorAll) { Array.prototype.forEach.call(root.querySelectorAll('img, video, source'), fixMedia); }
  }
  function watchMedia(root) {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'attributes') { fixMedia(r.target); return; }
        Array.prototype.forEach.call(r.addedNodes, scan);
      });
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster'] });
    scan(root);
  }
  var attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    var root = attachShadow.call(this, init);
    watchMedia(root);
    return root;
  };
  watchMedia(document.documentElement);

  // When the host says the book or its notes changed, the reader polls at once.
  changedHandlers.push(function () { if (window.SpecBook && window.SpecBook.poll) { window.SpecBook.poll(); } });

  window.SpecShare = {
    protocol: PROTOCOL,
    get me() { return me; },
    get role() { return role; },
    get ownerName() { return ownerName; },
    ready: ready,
    request: request,
    send: send,
    onLive: function (fn) { liveHandlers.push(fn); },
    onPeerState: function (fn) { stateHandlers.push(fn); },
    onChanged: function (fn) { changedHandlers.push(fn); },
    status: status,
    showError: showError,
    forgetPin: forgetPin,
  };

  function start() {
    if (!window.RTCPeerConnection || !window.crypto || !crypto.getRandomValues) {
      var why = 'This browser cannot open a shared book (it needs WebRTC over https).';
      status(why, true);
      showError(why);
      terminal = fail(why, true);
      return;
    }
    whoAmI().then(function (who) { me = who; status('Connecting…'); open(); });
  }
  start();
})();
