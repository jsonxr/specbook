# Share from the book server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The book server hosts the share over WebRTC. Owner and guests open one link, `/s/<room>`, and the reader they
get is served by the website, never by the host. A pin, saved in the browser and taken out of the address, gives the
owner's powers.

**Architecture:**
- **Book server.** `serve.mjs` gains a host module (`lib/host.mjs`), a port of `app/host.js` to Node on the
  `node-datachannel` polyfill. It holds the broker socket, answers offers, and serves channel requests by calling its
  own HTTP server over loopback (with the guest header for guests, without it for pin holders). It relays live frames
  to and from the owner's `localhost` tabs over the existing event stream.
- **Share server.** It stores each room's reader version. It serves `/s/<room>` from `/r/<version>/share.html` under a
  strict CSP, or today's `guest.html` for protocol 2 rooms. A publish step copies `plugin/app/` into
  `server/public/r/<version>/`.

**Tech Stack:**
- Plain browser JS (no build).
- Node `node:http` and the built-in `WebSocket` client, with `node-datachannel` 0.33.6 (`node-datachannel/polyfill`).
- A Cloudflare Worker with one Durable Object.
- `node:test`.
- Playwright smoke tests: `GLOBAL_ROOT=/opt/homebrew/lib/node_modules/playwright`.

**Spec:** `docs/superpowers/specs/2026-11-15-share-from-the-book-server-design.md`

## Global Constraints

**Versions and ids**
- `PROTOCOL` is 3, in the broker's `rules.mjs`, in `lib/host.mjs` and in `app/share.js`. Protocol 1 and 2 rooms keep
  working through today's `guest.html`/`guest.js` and their signed handshake, unchanged.
- The plugin version goes to `1.4.0` in `plugin/.claude-plugin/plugin.json`. A reader version must match
  `^\d+\.\d+\.\d+$` before it is used in a path.
- New room ids and pins are exactly 22 base-62 characters (`[A-Za-z0-9]{22}`), drawn without bias: reject any random
  byte ≥ 248 and use `byte % 62`. Existing ids that match `^[A-Za-z0-9_-]{16,64}$` still validate.
- The pin is compared in constant time and never logged. The pin link is
  `<broker>/s/<room>#pin=<pin>`. The page saves the pin under `localStorage['specbook-pin:<room>']` and removes it with
  `history.replaceState`, without a reload.

**Security**
- No host-supplied bytes run as code on the website. The reader there loads only scripts from `/r/<version>/`.
- The CSP on `/s/<room>` (protocol 3) and on `/r/*`:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https:; img-src 'self' blob: data: https:; font-src 'self' https: data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- Published `server/public/r/<version>/` folders are never overwritten with different bytes (without `--force`, which
  only tests use).

**Dependencies and tests**
- `node-datachannel` installs into `~/.claude/specbook/deps/<plugin version>/` with `npm install`, never into
  `plugin/`, and only from `serve.mjs --detach` (or a test). Nothing is installed when the plugin loads.
- Tests never touch the public share server or the real `~/.claude/specbook/deps`. Tests set `SPECBOOK_DEPS` to a
  temp folder or a prepared cache.

**Copy (US English, fixed by the spec)**
- "This pin no longer works."
- "Forget pin on this device"
- "Copy pin link"
- "New pin"
- "This book needs a newer share server. Ask its owner to deploy it."
- "This book was updated. Reload this page."

## Review Focus

1. **A pin in a copied address.** After opening the pin link, `location.href` has no `pin=`, and a reload still has
   owner rights. Test: share smoke "the pin leaves the address and is remembered".
2. **A guest calling an owner route through the channel.** `POST /api/requests` (Revise) from a guest connection gets
   403, and from a pin connection it is allowed. Test: host unit "rights follow the pin".
3. **Book HTML with a script or handler on the website.** It never runs. Test: share smoke "a mockup's script and
   onerror never run on the link".
4. **An old (protocol 2) room after the deploy.** Its guests still get today's guest page. Test: rules unit
   `pageFor({ protocol: 2 })` is `legacy`, plus share smoke "a protocol 2 host still works" (run with the 1.3.0 host
   tab from git history, skipped when it is not available).
5. **The book server restarting mid-share.** The guest page reconnects to the same link with the same rights. Test:
   share smoke "a restart keeps the link and the pin".

---

### Task 1: Share server — base-62 ids, reader versions, protocol 3, pages by version

**Files:**
- Modify: `server/src/rules.mjs`, `server/src/worker.mjs`, `server/src/rules.test.mjs`.

**Produces:**
- `rules.mjs`:
  - `newId(bytes = crypto.getRandomValues) -> string`: 22 base-62 characters.
  - `validReader(v) -> boolean`.
  - `PROTOCOL = 3`.
  - `fromGuest(msg, gid, protocol)`: for `protocol >= 3`, `sig` is not required or passed on.
  - `fromHost(msg, protocol)`: for protocol 3, an answer needs no `sig`.
  - `pageFor(room, versions) -> { kind: 'legacy' } | { kind: 'reader', version } | { kind: 'missing', version } | { kind: 'none' }`.
    No room gives `none`; protocol below 3 gives `legacy`; a version not in `versions` gives `missing`.
  - `CSP`, the constraint's string.
- `POST /api/rooms` takes `reader` (stored only when `validReader`). New rooms get `newId()` ids and tokens.
  `GET /api/rooms/<id>` adds `reader`.
- Worker:
  - `/s/<room>` reads the room from the Durable Object and the version list from `/r/versions.json`.
  - It serves by `pageFor`:
    - `legacy`: `guest.html`, as today.
    - `reader`: `/r/<v>/share.html` with `CSP`.
    - `missing` and `none`: the newest version's `share.html` with `CSP`, which shows the message itself.
  - `/r/*` is served from assets with `CSP`, plus `cache-control: public, max-age=31536000, immutable`, except
    `versions.json` (`no-store`).

- [ ] Write tests in `rules.test.mjs`:
  - `newId` gives `/^[A-Za-z0-9]{22}$/` over 1,000 draws. With a byte source that returns 248, then 255, then 0
    repeatedly, the first character is `'A'` (248 and 255 are skipped).
  - `validId` accepts a 22-character base-62 id and a 22-character id with `-`.
  - `validReader('1.4.0')` is true; `'1.4'`, `'../1.4.0'` and `'1.4.0/x'` are false.
  - `fromGuest({type:'offer', sdp:'s', key:'k', name:'n', device:'d'}, 'g', 3)` is non-null with no `sig`; the same
    call with protocol 2 is null.
  - `pageFor`:
    - `pageFor(null, ['1.4.0'])` is `{ kind: 'none' }`.
    - `pageFor({ protocol: 2 }, [])` is `{ kind: 'legacy' }`.
    - `pageFor({ protocol: 3, reader: '1.4.0' }, ['1.4.0'])` is `{ kind: 'reader', version: '1.4.0' }`.
    - `pageFor({ protocol: 3, reader: '1.5.0' }, ['1.4.0'])` is `{ kind: 'missing', version: '1.5.0' }`.
- [ ] Run `node --test server/src/`. Expected: the new tests fail.
- [ ] Implement it. `worker.mjs` passes the room's protocol to `fromGuest`/`fromHost`. `randomId` is used only for
  guest ids.
- [ ] Run `node --test server/src/`. Expected: all pass.
- [ ] Commit `feat(server): base-62 rooms, reader versions, protocol 3 and pages by version`.

### Task 2: Publish the reader

**Files:**
- Create: `server/publish-reader.mjs`, `server/publish-reader.test.mjs`.
- Modify: `server/README.md` (the deploy steps).

**Produces:**
- `node server/publish-reader.mjs [--app <dir>] [--out <dir>] [--version <v>] [--force]`. It defaults to
  `plugin/app`, `server/public/r` and the version in `plugin/.claude-plugin/plugin.json`.
- Exported `publish({ app, out, version, force }) -> { version, wrote: boolean }`.
- Writes `<out>/<version>/`:
  - `book.css`, `book.js`, `model.js`, `live.js`, `relay.js` and `share.js`, copied byte for byte;
  - `share.html`, made from `index.html`. Every `/app/` becomes `/r/<version>/`; the `owner.js` script tag is removed;
    `<script src="/r/<version>/share.js"></script>` goes before the `model.js` tag; and
    `<meta name="specbook-reader" content="<version>">` goes in `<head>`.
- Rewrites `<out>/versions.json` as the sorted (semver) list of version folders.
- Throws `published <v> differs` when the folder exists with different bytes and `force` is false. With equal bytes
  it is a no-op (`wrote: false`).

- [ ] Write tests on temp folders, with a fixture `app/` holding the files above plus an `index.html` with
  `/app/owner.js` and `/app/model.js` tags:
  - the first publish writes the files and `versions.json` is `["1.4.0"]`;
  - `share.html` has no `owner.js`, has `/r/1.4.0/share.js` before `/r/1.4.0/model.js`, and contains no `/app/`;
  - a second publish of the same bytes gives `wrote: false`;
  - changed bytes throw `published 1.4.0 differs`, and with `force` they are written;
  - publishing `1.10.0` then `1.9.0` gives `["1.4.0","1.9.0","1.10.0"]`;
  - `version: '../x'` throws.
- [ ] Run `node --test server/publish-reader.test.mjs`. Expected: fail (no module).
- [ ] Implement it. Only `node:fs`, `node:path` and `node:crypto`.
- [ ] Run it again. Expected: all pass.
- [ ] Update the README deploy steps: bump the plugin version, run `node server/publish-reader.mjs`, commit
  `server/public/r/<version>/`, then `./wrangler.sh deploy`.
- [ ] Commit `feat(server): publish each plugin version's reader under /r/<version>/`.

### Task 3: The dependency, ids and the pin on the book server

**Files:**
- Create: `plugin/package.json`, `plugin/server/lib/deps.mjs`, `plugin/server/lib/deps.test.mjs`,
  `plugin/server/lib/secret.mjs`, `plugin/server/lib/secret.test.mjs`.
- Modify: `plugin/.claude-plugin/plugin.json` (version `1.4.0`).

**Produces:**
- `plugin/package.json`: `{ "name": "specbook-plugin", "private": true, "type": "module", "dependencies": { "node-datachannel": "0.33.6" } }`.
- `deps.mjs`:
  - `depsDir(version) -> string`: `$SPECBOOK_DEPS/<version>`, or `~/.claude/specbook/deps/<version>`.
  - `ensureDeps({ version, log }) -> { ok: true } | { ok: false, error }`. It copies `plugin/package.json` into the
    folder, runs `npm install --omit=dev --no-audit --no-fund` there when `node_modules/node-datachannel` is missing,
    and logs one line, "Installing the share library (once)…".
  - `loadRtc(version) -> { RTCPeerConnection } | null`, through `createRequire(<dir>/package.json)('node-datachannel/polyfill')`.
- `secret.mjs`: `newId()` (the same rule as Task 1), `sameSecret(a, b) -> boolean` (`timingSafeEqual` over equal
  lengths, false otherwise).

- [ ] Write tests:
  - `newId` gives the shape over 1,000 draws.
  - `sameSecret`: `('a','a')` is true; `('a','b')` and `('a','ab')` are false, as are `(undefined,'a')`.
  - `depsDir('1.4.0')` under `SPECBOOK_DEPS=/x` is `/x/1.4.0`.
  - `ensureDeps` with `SPECBOOK_DEPS` pointing at a folder that already has `1.4.0/node_modules/node-datachannel/`
    returns `ok: true` without running npm. Inject `run` as a parameter and assert it was not called.
  - With a `run` that fails, it returns `{ ok: false, error }`.
- [ ] Run `node --test plugin/server/lib/deps.test.mjs plugin/server/lib/secret.test.mjs`. Expected: fail.
- [ ] Implement it.
- [ ] Run it again. Expected: pass.
- [ ] Commit `feat(plugin): share dependency installed per version, base-62 ids and pins`.

### Task 4: The host in Node

**Files:**
- Create: `plugin/server/lib/channel.mjs`, `plugin/server/lib/channel.test.mjs`, `plugin/server/lib/host.mjs`,
  `plugin/server/lib/host.test.mjs`.

**Interfaces:**
- Consumes: Task 3's `loadRtc`, `newId` and `sameSecret`; `guestMay` and `encodeGuest` from `lib/guest.mjs`; and
  `app/relay.js` rules (`peerIdOf`, `colorOf`, `mayDraft`, `liveFrameOk`, `liveRateOk`), loaded in Node the way
  `plugin/test/relay.test.mjs` loads them.
- Produces, in `channel.mjs` (pure, no network):
  - `framesOf(header, bytes, chunk = 12000) -> object[]`, today's format;
  - `assembler({ maxOpen = 8, maxBody = 2*1024*1024 }) -> { push(frame) -> null | { header, body } }`;
  - `rightsOf(hello, pin) -> 'owner' | 'guest'`, where `hello` is `{ t:'hello', protocol, version, pin? }`;
  - `mayCall(rights, method, path) -> boolean`. It is true for the owner except on `/api/share*` (the share is managed
    only from `localhost`), and `guestMay` for a guest.
- Produces, in `host.mjs`, `createHost({ broker, port, version, ownerName, saved, rtc, readNotes, onState })`
  returning:
  - `start()`, `stop({ end })`, `newPin()`, `state() -> 'off'|'starting'|'live'|'failed'`, and
    `links() -> { url, pinUrl } | null`;
  - `people()`, `sendLive(msg)` (from the owner's localhost tab, sent as `from: 'host'`), `changed()`, and
    `onLive(fn)`, which delivers guests' live frames to the localhost tabs.
  - `saved`: `{ room, hostToken, pin, expiresAt } | null`.
  - `onState(view)`: called on every change with `{ state, room, hostToken, pin, expiresAt, guests, error }`, so
    `serve.mjs` can save `.share.json`.
- Wire, protocol 3:
  - The offer is `{ type:'offer', sdp, key, name, device, protocol: 3 }`, unsigned. The answer is
    `{ type:'answer', to, sdp }`.
  - On the channel, the reader's first frame is `hello`. The host answers
    `{ t:'welcome', role, protocol: 3, version, you, ownerName }`, or `{ t:'pin-bad' }` and then treats the connection
    as a guest's.
  - Frames before `hello` are dropped. A `hello` whose `protocol` is not 3 gets
    `{ t:'welcome', protocol: 3, version }` and nothing else.
  - The owner (pin) connection appears in `people()` with `role: 'owner'`, `name: ownerName` and its own peer id.
- Requests: `fetch('http://127.0.0.1:' + port + path)`, with `x-specbook-guest` from `encodeGuest` for guests and no
  header for the owner. The same 403/429/413 answers, limits and chunking as `host.js` (`IN_FLIGHT` 16,
  `SHARE_IN_FLIGHT` 48, `MAX_RESPONSE` 64 MiB, `MAX_GUESTS` 20).
- Room keeping: the same as `host.js` `start`, `openRoom`, `renew` (`RENEW_MS` 6 h, `HOURS` 24) and `gone`. It opens
  with `{ hours, protocol: 3, reader: version }` and keeps the room on 404 and on an unreachable network. It ends the
  room only on `stop({ end: true })`.

- [ ] Write `channel.test.mjs`:
  - `framesOf` then `assembler.push` round-trips 0 bytes, 1 byte and 40,000 bytes;
  - an out-of-order `seq` drops the request;
  - a ninth open request is ignored;
  - a body over `maxBody` is dropped;
  - `rightsOf({ pin: 'P' }, 'P')` is `'owner'`, while `rightsOf({}, 'P')` and `rightsOf({ pin: 'Q' }, 'P')` are
    `'guest'`;
  - `mayCall('guest', 'POST', '/api/requests')` is false, and `mayCall('owner', 'POST', '/api/requests')` is true;
  - `mayCall('owner', 'POST', '/api/share/stop')` is false;
  - `mayCall('guest', 'PUT', '/api/notes')` is true.
- [ ] Write `host.test.mjs` with a fake broker: a `node:http` server on a free port that answers `POST /api/rooms`
  and `GET /api/rooms/<id>`, and records bodies. Inject the WebSocket constructor and `rtc` as parameters.
  - `start()` with `saved: null` posts `{ protocol: 3, reader: '1.4.0', hours: 24 }`, and `links().url` ends with
    `/s/<room>` with no `#`.
  - `links().pinUrl` ends with `#pin=<pin>`, and the pin is 22 base-62 characters.
  - `start()` with a saved room posts `{ room, hostToken }` and keeps the same `url`.
  - `newPin()` changes the pin, keeps the room, and calls `onState` with the new pin.
  - **"rights follow the pin":** with a fake channel, a guest `hello` then `POST /api/requests` is answered 403, and a
    pin `hello` then the same request reaches the loopback server without the guest header. Point `port` at a
    recording `node:http` server.
- [ ] Run `node --test plugin/server/lib/channel.test.mjs plugin/server/lib/host.test.mjs`. Expected: fail.
- [ ] Implement it by porting `app/host.js`. Drop the HMAC, the Web Lock, `pagehide` and `/api/share/*` posts. Read
  notes for `mayDraft` from `readNotes()`.
- [ ] Run it again. Expected: pass.
- [ ] Commit `feat(plugin): the book server hosts the share over WebRTC`.

### Task 5: The book server runs the host

**Files:**
- Modify: `plugin/server/serve.mjs`, `plugin/server/serve.test.mjs`.

**Interfaces:**
- Consumes: Task 4's `createHost`, and Task 3's `ensureDeps`/`loadRtc`.
- Produces, for owner tabs on `localhost` (the guest header is refused on all of these):
  - `GET /api/share`: `{ state, url, pinUrl, expiresAt, guests, error, stopped }`.
  - `POST /api/share`: start, which clears `stopped`.
  - `POST /api/share/stop`: ends the room, keeps `stopped: true` in `.share.json`, and drops the room.
  - `POST /api/share/new-link`: a new room and pin.
  - `POST /api/share/new-pin`.
  - `POST /api/live { msg }`: `host.sendLive`.
  - `GET /api/share/events`: SSE with `state`, `live` (guests' frames) and `changed`. There is no `start` or `stop`
    any more, and no per-tab host election.
- `.share.json` holds `{ room, hostToken, pin, expiresAt, stopped }`. It reads today's format (with `secret`, without
  `pin`) and adds a pin.
- Hosting starts when the server starts, unless `settings.share === false` or `stopped`. A localhost owner tab
  connecting to `/api/share/events` clears `stopped` and starts, as today. A failed dependency install leaves
  `state: 'failed'` with `error` set.
- `--detach` calls `ensureDeps` before spawning. After health, it waits up to 10 s for `state: 'live'`, then prints
  `Share link: <url>`, then `Your pin link (opens with your powers; never send it to anyone): <pinUrl>`. If the share
  is not live by then, it prints `Sharing is starting; Copy link in the bar gives the link.`

- [ ] Write tests in `serve.test.mjs`, with an injected fake host (a `SPECBOOK_TEST_HOST` module path read only by
  tests):
  - a `.share.json` in the old format gains a 22-character pin, and its room is kept;
  - `POST /api/share/new-pin` changes `pinUrl` and keeps `url`;
  - `POST /api/share/stop` persists `stopped: true` across a restart, so no host starts;
  - a guest-header request to `/api/share` gets 403;
  - `--detach` with `SPECBOOK_DEPS` prepared prints the two link lines.
- [ ] Run `node --test plugin/server/serve.test.mjs`. Expected: the new tests fail.
- [ ] Implement it. Remove `shareTabs` hosting, `askToHost`, and the `live`/`failed`/`ended`/`guests` posts.
- [ ] Run `node --test 'plugin/**/*.test.mjs'`. Expected: all pass.
- [ ] Commit `feat(plugin): serve.mjs hosts the share itself and keeps the pin`.

### Task 6: The owner's localhost tab without hosting

**Files:**
- Create: `plugin/app/owner.js`.
- Delete: `plugin/app/host.js`.
- Modify: `plugin/app/index.html`, `plugin/app/live.js`.

**Interfaces:**
- Consumes: Task 5's routes.
- Produces: `window.SpecHost` with today's shape (`send`, `people`, `link`, `state`, `onChange`, `newLink`,
  `stopSharing`, `startSharing`), plus `pinLink()` and `newPin()`. It is backed by `GET /api/share`, the SSE stream
  and `POST /api/live`. On `changed`, it calls `SpecBook.reloadNotes` and `SpecBook.poll`, as today.
- `live.js`'s share menu gains **Copy pin link** (only when `SpecHost.pinLink()` is set) and **New pin**. `link()` on
  the website is `location.origin + '/s/' + room`.

- [ ] Run the reader smoke first. Expected: it passes before the change (the baseline).
- [ ] Implement it. `index.html` loads `/app/owner.js` where `host.js` was.
- [ ] Run the reader smoke. Expected: it passes, including the share pill checks.
- [ ] Commit `feat(plugin): the owner's tab follows the server's share instead of hosting it`.

### Task 7: The reader on the website

**Files:**
- Create: `plugin/app/share.js`.
- Delete: `plugin/app/guest.js`.
- Modify: `plugin/app/book.js` (the cleaning hook), `plugin/app/live.js` (Forget pin).

**Interfaces:**
- Consumes: the Task 4 wire, and the Task 1 room answer (`reader`, `protocol`).
- Produces: `share.js`, a port of `server/public/guest.js`'s connection plus `plugin/app/guest.js`'s fetch override
  and blob-URL media, without `runScript` or the HTML import.
- The page:
  1. Reads `#pin=` and saves it.
  2. Calls `GET /api/rooms/<room>`:
     - 404 gives "This share isn’t open right now. Reload this page once the owner has the book open, or ask for a
       new link."
     - 410 gives "This share has ended. Ask for a new link."
     - A `reader` other than its own `<meta name="specbook-reader">` gives "This book was updated. Reload this page."
       (for a newer reader the site lacks, the worker already served the missing message).
  3. Asks for the name only without a pin.
  4. Waits on the socket for the host.
  5. Asks for ICE, sends the unsigned offer, then `hello` (`pin` when it has one).
  6. On `pin-bad`, it removes the saved pin and shows "This pin no longer works."
  7. Sets `window.SpecShare` (`request`, `onChanged`, `send`, `onLive`, `onPeerState`, `status`, `me`, `role`,
     `forgetPin`) before `model.js` and `book.js` run. `book.js` starts once `welcome` arrives.
- `book.js`: when `window.SpecShare` is set, the HTML that goes through `innerHTML` (book text, and `mountMockup`)
  first passes through `clean(html)`. `clean` parses the HTML into a `<template>` and removes `script`, `iframe`,
  `object`, `embed`, `base`, `meta`, `link[rel=import]`, every `on*` attribute, and `href`/`src`/`xlink:href`/`action`
  values that start with `javascript:` (after trimming).
- `live.js`: on the website with `SpecShare.role === 'owner'`, the menu has **Forget pin on this device**, which
  forgets the pin and reloads.

- [ ] Covered by the share smoke (Task 8). No unit harness exists for browser connection code.
- [ ] Implement it.
- [ ] Commit `feat(plugin): the shared reader runs from the website, with the pin`.

### Task 8: Share smoke, docs, and the first published version

**Files:**
- Modify: `plugin/test/share.smoke.mjs`, `plugin/reference/reader.md`, `plugin/skills/open/SKILL.md`,
  `plugin/skills/specbook/SKILL.md`, `server/README.md`.
- Create: `server/public/r/1.4.0/` (with `publish-reader.mjs`) and `server/public/r/versions.json`.

- [ ] Change the smoke:
  - copy `server/` to a temp folder, run `publish-reader.mjs --out <temp>/public/r --force`, then run wrangler dev
    there;
  - prepare `SPECBOOK_DEPS` once in a cache folder outside the repo (`~/.cache/specbook-test-deps`), not
    `~/.claude/specbook`;
  - run `serve.mjs --detach` and read the two links from its output.
- [ ] Smoke checks (each a named step):
  - "a guest on the plain link reads the book and saves a note";
  - "a guest cannot Revise" (the Revise button is absent, and a forced `fetch('/api/requests', {method:'POST'})` in the
    page answers 403);
  - "the pin leaves the address and is remembered" (open the pin link; `location.hash` has no `pin`; reload; Revise
    is present);
  - "Forget pin on this device" (it reloads as a guest);
  - "New pin makes the old pin say: This pin no longer works.";
  - "a mockup's script and onerror never run on the link" (the fixture mockup has
    `<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">`, and `window.__pwned` is undefined);
  - "the page has the CSP header";
  - "the owner tab can close and the guest stays connected";
  - "a restart keeps the link and the pin";
  - "New link ends the old link: This share has ended";
  - the existing live typing and following checks, kept.
- [ ] Run unit tests: `node --test 'plugin/**/*.test.mjs' 'server/src/*.test.mjs' server/publish-reader.test.mjs`.
  Expected: all pass.
- [ ] Run both smokes. Expected: every step `ok`.
- [ ] Update docs:
  - `reader.md`: one link, the pin, and Copy pin link / New pin / Forget pin.
  - The open skill, step 5: pass on the two link lines `serve.mjs` prints, with the warning about the pin link.
  - `specbook/SKILL.md`: the share data in `.share.json`.
  - `server/README.md`: the deploy steps and `/r/`.
- [ ] Run `node server/publish-reader.mjs` for real, to create `server/public/r/1.4.0/`.
- [ ] Commit `feat: one share link served by the website, hosted by the book server`.
