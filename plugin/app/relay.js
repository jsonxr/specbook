// Rules for live sharing that the owner's tab (host.js) and live.js share, kept apart so node:test can run them.
// A live message is presence, a draft, or following (see live.js); the host passes each guest's on to the others.
(function () {
  'use strict';
  // Colors that read on the book's dark page; the owner always has the first.
  var PALETTE = ['#3ecf8e', '#f27aa0', '#b394ff', '#6aa8ff', '#ffb454', '#4fd1c5', '#ff7a6b', '#c3e86b'];

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // A guest's id among the people in the book: a short hash of their key, the same across reconnects. The key itself
  // makes notes theirs, so it is never shown to anyone else.
  function peerIdOf(key) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)))
      .then(function (h) { return b64url(new Uint8Array(h)).slice(0, 12); });
  }

  function colorOf(id) {
    if (id === 'host') { return PALETTE[0]; }
    var h = 0;
    for (var i = 0; i < String(id).length; i++) { h = (h * 31 + String(id).charCodeAt(i)) >>> 0; }
    return PALETTE[1 + (h % (PALETTE.length - 1))];
  }

  function relayTargets(from, ids) {
    return ids.filter(function (id) { return id !== from; });
  }

  // Whether a sender may show others a draft of this note: the owner any note; a guest a note of their own, or a new
  // one. `sender` is { host: true } or { key }; `notes` the owner's notes, which carry each guest note's authorKey.
  function mayDraft(sender, id, notes) {
    if (typeof id !== 'string' || id === '__proto__' || !id) { return false; }
    if (sender && sender.host) { return true; }
    var n = Object.prototype.hasOwnProperty.call(notes || {}, id) ? notes[id] : null;
    if (!n) { return true; }
    return !!(sender && sender.key && n.authorKey === sender.key);
  }

  window.SpecRelay = { PALETTE: PALETTE, peerIdOf: peerIdOf, colorOf: colorOf, relayTargets: relayTargets, mayDraft: mayDraft };
})();
