// The reader for a guest of a shared book. The share server's guest page connects to the owner's book tab (host.js)
// and runs this file with window.SpecShare, its connection: { request(method, path, bytes) -> Promise<{ status,
// type, bytes }>, onChanged(fn), status(text, bad), showError(text), me }. This file draws the book from the host:
// it routes the reader's fetches of /api/, /data/ and /app/ over the connection, loads images and recordings the
// same way, then loads index.html, book.css, model.js and book.js from the host, so book.js runs unchanged.
(function () {
  'use strict';
  var share = window.SpecShare;
  if (!share) { return; }
  var realFetch = window.fetch.bind(window);

  function ours(url) {
    return url.origin === location.origin && /^\/(api|data|app)\//.test(url.pathname) && !/^\/api\/rooms\//.test(url.pathname);
  }
  // The host answers a guest's 16th waiting request with 429 busy (IN_FLIGHT in host.js), and a book loads every
  // mockup at once, so requests wait their turn here: at most SENDING at a time.
  var SENDING = 8;
  var sending = 0;
  var waiting = [];
  function next() {
    while (sending < SENDING && waiting.length) {
      var job = waiting.shift();
      sending++;
      share.request(job.method, job.path, job.body).then(job.resolve, job.reject).then(function () {
        sending--;
        next();
      });
    }
  }
  function request(method, path, body) {
    return new Promise(function (resolve, reject) {
      waiting.push({ method: method, path: path, body: body, resolve: resolve, reject: reject });
      next();
    });
  }
  function viaHost(method, path, body) {
    return request(method, path, body).then(function (res) {
      var empty = res.status === 204 || res.status === 304 || res.status < 200;
      return new Response(empty ? null : res.bytes, { status: res.status, headers: { 'content-type': res.type } });
    });
  }
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!ours(url)) { return realFetch(input, init); }
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = init && typeof init.body === 'string' ? new TextEncoder().encode(init.body) : null;
    return viaHost(method, url.pathname + url.search, body);
  };

  // Images and recordings drawn with src="/data/…" (in the page and inside each mockup's shadow root) are not
  // fetches: they are loaded over the connection and shown from a blob URL.
  var media = {};
  var MEDIA = { IMG: ['src'], VIDEO: ['src', 'poster'], SOURCE: ['src'] };
  function mediaUrl(path) {
    if (!media[path]) {
      media[path] = window.fetch(path).then(function (r) {
        if (!r.ok) { throw new Error('not found'); }
        return r.blob();
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
  share.onChanged(function () { if (window.SpecBook && window.SpecBook.poll) { window.SpecBook.poll(); } });

  function text(path) {
    return request('GET', path).then(function (res) {
      if (res.status !== 200) { throw new Error('Could not load ' + path + ' from the host (' + res.status + ').'); }
      return new TextDecoder().decode(res.bytes);
    });
  }
  function runScript(source) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      s.onload = resolve;
      s.onerror = function () { reject(new Error('A script of the book failed to load.')); };
      document.body.appendChild(s);
    });
  }

  // index.html, as the host serves it: its links and styles go in the head (the book's own stylesheet inline), its
  // body replaces this page's, and its scripts run in order, except the host's own.
  text('/index.html').then(function (html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var styles = [];
    Array.prototype.forEach.call(doc.head.children, function (el) {
      var href = el.getAttribute('href') || '';
      if (el.tagName === 'LINK' && /^\/app\//.test(href)) {
        styles.push(text(href).then(function (css) { var st = document.createElement('style'); st.textContent = css; return st; }));
      } else if (el.tagName === 'LINK' || el.tagName === 'STYLE') {
        styles.push(Promise.resolve(document.importNode(el, true)));
      } else if (el.tagName === 'TITLE') {
        document.title = el.textContent;
      }
    });
    var scripts = Array.prototype.map.call(doc.querySelectorAll('script[src]'), function (s) { return s.getAttribute('src'); })
      .filter(function (src) { return /^\/app\//.test(src) && !/\/(host|owner|guest|relay)\.js$/.test(src); });
    Array.prototype.forEach.call(doc.querySelectorAll('script'), function (s) { s.remove(); });
    return Promise.all(styles).then(function (els) {
      els.forEach(function (el) { document.head.appendChild(el); });
      var chip = document.querySelector('.share-chip');
      document.body.innerHTML = doc.body.innerHTML;
      if (chip) { document.body.appendChild(chip); }
      return Promise.all(scripts.map(text));
    }).then(function (sources) {
      return sources.reduce(function (p, src) { return p.then(function () { return runScript(src); }); }, Promise.resolve());
    });
  }).catch(function (err) {
    share.status(err.message, true);
    share.showError(err.message);
  });
})();
