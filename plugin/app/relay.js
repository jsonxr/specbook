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

  // A guest's id among the people in the book: a short hash of their key and their device, so the same person on the
  // same device is one person (a newer tab replaces the older), and on another device another. The key itself makes
  // notes theirs, so it is never shown to anyone else.
  function peerIdOf(key, device) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key) + '\n' + String(device || '')))
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
  // one nobody else has drafted (`claims`, id -> the first drafter's peer id, is kept by the host and filled here).
  // `sender` is { host: true } or { key, id }; `notes` the owner's notes, which carry each guest note's authorKey.
  function mayDraft(sender, id, notes, claims) {
    if (typeof id !== 'string' || id === '__proto__' || !id) { return false; }
    if (sender && sender.host) { return true; }
    var n = Object.prototype.hasOwnProperty.call(notes || {}, id) ? notes[id] : null;
    if (n) { return !!(sender && sender.key && n.authorKey === sender.key); }
    if (!claims) { return true; }
    var who = sender && sender.id;
    if (Object.prototype.hasOwnProperty.call(claims, id) && claims[id] !== who) { return false; }
    claims[id] = who;
    return true;
  }

  // A guest's live frames: none larger than LIVE_MAX characters, and LIVE_BURST a second at most (a reader sends a
  // few a second while typing or scrolling). `bucket` is the guest's own { at, n }, kept by the host.
  var LIVE_MAX = 16384;
  var LIVE_BURST = 40;
  function liveFrameOk(text) { return typeof text === 'string' && text.length <= LIVE_MAX; }
  function liveRateOk(bucket, now) {
    if (!bucket.at || now - bucket.at >= 1000) { bucket.at = now; bucket.n = 0; }
    if (bucket.n >= LIVE_BURST) { return false; }
    bucket.n++;
    return true;
  }

  window.SpecRelay = { LIVE_MAX: LIVE_MAX, LIVE_BURST: LIVE_BURST, liveFrameOk: liveFrameOk, liveRateOk: liveRateOk, PALETTE: PALETTE, peerIdOf: peerIdOf, colorOf: colorOf, relayTargets: relayTargets, mayDraft: mayDraft };
})();
