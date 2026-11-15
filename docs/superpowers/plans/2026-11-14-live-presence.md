# Live presence, following, always-on sharing and the new bar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a shared spec book feel live (presence, follow, typing as it happens), share whenever the owner's tab is open with a link that lasts while the local server runs, and replace the bar with the option-B design.

**Architecture:** The owner's book tab stays the WebRTC host. The local server remembers the room so a reloaded tab reuses it. Live messages ride the existing data channels as `{t:'live'}` frames, relayed by the host tab. A new `app/live.js` holds presence, drafts and following for owner and guests alike. It talks to `book.js` through a small `window.SpecBook` API. Saves become per-note changes.

**Tech Stack:** Plain browser JS (no build), Node `node:http` server, Cloudflare Worker with one Durable Object, `node:test`, Playwright smoke tests (global install, `GLOBAL_ROOT=/opt/homebrew/lib/node_modules/playwright`).

**Spec:** `docs/superpowers/specs/2026-11-14-live-presence-design.md`

## Global Constraints

- No packages in `plugin/`. The guest page stays one script.
- Live traffic never goes through the share server. The broker carries only handshakes and `host-online`/`host-offline`/`gone`.
- Guests never reach Revise, Build, Accept, stage changes or direct requirement edits. A guest's `draft` for a note that is not theirs is dropped by the host.
- `PROTOCOL` becomes 2. The guest page still speaks 1 to rooms opened by a v1 host (no live frames, old waiting behavior).
- US English in all copy. Copy fixed by the spec: "Only you", "Copy link", "New link", "Stop sharing", "Following <name> · scroll or type to stop", "The book isn't open right now. This page will reconnect when it is.", "<name> changed this note", "Live sharing runs in your other tab", "The person sharing this book needs to update the specbook plugin."
- Throttles: `where` at most every 100 ms plus once 300 ms after scrolling stops; `draft` at most every 50 ms; `typing` off 2 s after the last input; a draft fades after 10 s without typing or save; change batching 50 ms; the reader's save delay 150 ms.
- `settings.share: false` turns always-on sharing off for a book.

## Review Focus

1. **Owner tab reload mid-share.** Guests reconnect to the same link without a new `/specbook:share`, and the owner's notes survive. Test: share smoke "reloading the owner tab keeps the link".
2. **Guest typing in a note while the owner saves another note.** Neither change is lost. Test: serve test "per-note saves never drop another's change".
3. **Follower on a narrow phone, leader on desktop.** The follower lands on the same requirement. Test: live unit "anchor scroll" plus share smoke "following scrolls to the leader's anchor".
4. **Guest page opened while the owner's tab is closed.** It waits quietly and connects when the tab opens. Test: share smoke "closing the tab shows guests the book isn't open, and reopening reconnects".
5. **A guest forging a draft for the owner's note.** Never shown to anyone. Test: host relay unit "drops drafts for notes the sender does not own".

---

### Task 1: Broker keeps rooms, wakes waiting guests, ends rooms on request

**Files:** Modify `server/src/rules.mjs`, `server/src/worker.mjs`, `server/src/rules.test.mjs`.

**Produces:**
- `GET /api/rooms/:id` → `{ host: boolean, protocol: number }`.
- `POST /api/rooms/:id/end` with `{ token }` → 204, or 403.
- A guest socket on a hostless room is accepted and gets `{type:'host-offline'}`. When the host connects, every guest socket of the room gets `{type:'host-online'}`.
- Rooms no longer end when the host goes. They end at `expiresAt`, on `end` or on `POST …/end`.
- `fromGuest`/`fromHost` pass `protocol` through.
- `roomProtocol(asked) -> 1|2` in rules.

- [ ] Write tests in `rules.test.mjs`:
  - `roomProtocol(2) === 2`, `roomProtocol(undefined) === 1`, `roomProtocol(9) === 2`;
  - `fromGuest({type:'offer', sdp:'s', sig:'g', key:'k', name:'n', protocol:2}, 'id').protocol === 2`.
- [ ] Run `node --test server/src/` and confirm they fail.
- [ ] Implement in `rules.mjs` and `worker.mjs`:
  - **Rooms:** `open()` stores `protocol: roomProtocol(body.protocol)`. Remove `HOST_GRACE_MS` and `hostGoneAt`.
  - **Waiting guests:** the guest socket is accepted when the host is absent, with attachment `waiting: true`. The alarm's idle close skips sockets of hostless rooms. On host connect, send `host-online` to the room's guest sockets and reset their `at`, `iced` and `offered`.
  - **Ending:** add the `end` route (`sameToken`, then `this.close(id)`).
- [ ] Run `node --test server/src/` and confirm it passes.
- [ ] Commit `feat(server): rooms outlive their host; guests wait for host-online; end route`.

### Task 2: Guest page — protocol 2, live frames, quiet waiting

**Files:** Modify `server/public/guest.js` and `server/public/guest.html` (only if the copy needs a slot).

**Produces:** `window.SpecShare` gains:
- `send(obj)`, which sends `{t:'live', ...obj}`;
- `onLive(fn)`;
- `onPeerState(fn)`, called with `'live'`, `'waiting'` or `'ended'`;
- `protocol`, the room's protocol.

Connect flow:
1. `GET /api/rooms/:id` and read `protocol`.
2. If `host` is false, open the guest socket and wait for `host-online` (no polling). Status: "The book isn't open right now. This page will reconnect when it is."
3. Then ask for ICE and send the offer (`protocol` in the offer body).
4. On loss of the data channel, go back to step 2 and keep the page and the reader loaded.

`protocol` 1 rooms keep today's behavior, with no `send`/`onLive`.

- [ ] No unit harness exists for this file; it is covered by the share smoke (Task 9).
- [ ] Implement it, keeping `request` and `onChanged` unchanged.
- [ ] Commit `feat(server): guest page speaks protocol 2 with live frames and waits for the host`.

### Task 3: Local server — remembered room, always-on, per-note saves, owner name

**Files:** Modify `plugin/server/serve.mjs`, `plugin/server/lib/guest.mjs`, `plugin/server/serve.test.mjs`, `plugin/server/lib/guest.test.mjs`.

**Share state:** `share = { state, tab, room?: { room, hostToken, secret, url, expiresAt }, stopped, guests }`.

- **On a new `/api/share/events` connection:**
  - clear `stopped` (a reload counts as reopening);
  - if `readBook().settings?.share !== false` and a broker exists, send `start` to that tab with `{ hours: 24, broker, room: share.room ?? null }`.
- **`POST /api/share/live`** body adds `room`, `hostToken` and `secret`, which are stored. `url` must start with `${broker}/s/${room}#`.
- **`POST /api/share/new-link`** (owner only):
  - send `end-room` to the hosting tab, which ends the room at the broker;
  - forget `share.room`;
  - send `start` with `room: null`;
  - return 202.
- **`POST /api/share/stop`:** send `stop`, set `stopped: true`, forget the room. The tab ends it at the broker.
- **`--stop` and SIGTERM:**
  - if a room is remembered, `POST <broker>/api/rooms/:id/end {token}`;
  - 2 s timeout, best effort;
  - it is a Node fetch, so it needs no CORS.
- **The watch** sends `changed` to the hosting tab (or, with no share, to every listening tab) for any change. Batching drops to 50 ms, and the "live only" condition goes.
- **`GET /api/share`** adds `room: !!share.room` and `stopped`.
- **`/api/book`** adds `owner: { name }`. The name is the first word of `git config user.name` in the project root, read once at startup with `execFileSync`, with "Owner" as the fallback.
- **`PUT /api/notes`** also accepts `{ changes: { [id]: note|null } }` without `rev`. These are applied per note on the current stored notes:
  - owner: any draft;
  - guest: only drafts with their `authorKey`, plus new ids;
  - a non-draft note is never changed;
  - `null` deletes;
  - each changed note gets `lastBy` (the writer's name: guest name or owner name), added to `SERVER_FIELDS` handling so pages cannot set it;
  - guest limits are checked with `checkGuestNotes`;
  - the reply is `{ rev }`.

  The legacy `{rev, notes}` shape keeps working.
- **Helper:** `applyNoteChanges(stored, changes, writer, keys) -> notes` in `lib/guest.mjs`. Here `writer = { guest: boolean, key?, name }`.

Steps:
- [ ] Write the failing tests:
  - `guest.test.mjs`:
    - `applyNoteChanges` lets a guest add or edit only their own notes and ignores others' ids;
    - the owner edits a guest's note and `lastBy` becomes the owner's name;
    - `null` deletes only what the writer may delete;
    - non-drafts are untouched.
  - `serve.test.mjs`:
    - "per-note saves never drop another's change": two `changes` PUTs for different notes from owner and guest, both kept;
    - "a new events tab is asked to start, with the remembered room";
    - "new-link forgets the room and restarts";
    - "stop sets stopped until a new tab connects";
    - "settings.share false sends no start";
    - `/api/book` has `owner.name`.
- [ ] Run `node --test 'plugin/server/**/*.test.mjs'` and confirm they fail.
- [ ] Implement.
- [ ] Run it again and confirm it passes, with the existing tests still green.
- [ ] Commit `feat(plugin): remembered share room, always-on sharing, per-note saves`.

### Task 4: host.js — reuse the room, end rooms, relay live frames

**Files:** Modify `plugin/app/host.js`. Create `plugin/app/relay.js` (pure functions, loaded by the page before `host.js`) and `plugin/test/relay.test.mjs`. Tests load `relay.js` with `vm` and read `globalThis.SpecRelay`.

**Produces** `window.SpecRelay`:
- `peerIdOf(key) -> Promise<string>`: the first 12 base64url characters of SHA-256 of the key.
- `colorOf(id) -> string`: from an 8-color palette; the owner, `host`, always gets `PALETTE[0]`.
- `PALETTE`.
- `relayTargets(fromId, peerIds) -> string[]`: every id except `fromId`.
- `mayDraft(from, note, notes) -> boolean`:
  - the owner may draft any note;
  - a guest may draft a note that does not exist yet, or one with `mine`/`authorKey` matching that guest;
  - the host passes its own notes map, keyed by id, with `authorKey`.

**host.js changes:**
- **`start(req)`:**
  - if `req.room` is set, reuse it (no `POST /api/rooms`) and reconnect the socket;
  - otherwise create a room with `protocol: 2` and post `live` with `room`, `hostToken`, `secret`, `url` and `expiresAt`.
- **New `end-room` event:** POST `<broker>/api/rooms/:id/end`, then clear the local share without a `stop`.
- **`stop`:** keeps today's behavior and also ends the room at the broker.
- **The pagehide `end` message is removed.** Closing the tab only closes channels, so the room survives for reloads.
- **Peers:**
  - peer id = `await SpecRelay.peerIdOf(key)`;
  - on channel open, send the newcomer `{t:'live', kind:'roster', you, people:[…]}`;
  - broadcast `{t:'live', kind:'hello', from, name, color, role:'guest'}`.
- **Incoming `t:'live'` from a guest:**
  - stamp `from`;
  - drop `draft` unless `mayDraft`;
  - forward to the other peers;
  - hand it to `window.SpecLive.receive(msg)` if loaded.
- **`window.SpecHost`:**
  - `send(msg)` broadcasts from `host`;
  - `people()`;
  - `link()`;
  - `newLink()` (POST `/api/share/new-link`);
  - `stopSharing()` (POST `/api/share/stop`);
  - `startSharing()` (POST `/api/share`);
  - `state()` returns `'live' | 'off' | 'other-tab' | 'starting'`.
- **The old `drawBar` share group is removed.** The pill is drawn by `live.js`.
- **On the `changed` event,** the host also calls `window.SpecBook.poll()` and `window.SpecBook.reloadNotes()`, as well as forwarding to guests.
- **A tab that fails to take the Web Lock** reports `other-tab`.

Steps:
- [ ] Write `relay.test.mjs`:
  - `relayTargets('a', ['a','b','c'])` deep-equals `['b','c']`;
  - `mayDraft('host', {}, {})` is true;
  - `mayDraft('g1', { id:'n1' }, { n1:{ authorKey:'k2' } })` is false when g1's key is `k1`;
  - `colorOf('host') === PALETTE[0]`;
  - `peerIdOf('abc')` resolves to a 12-character string, the same each call.
- [ ] Run `node --test plugin/test/relay.test.mjs` and confirm it fails.
- [ ] Implement `relay.js` and confirm the test passes.
- [ ] Change `host.js`.
- [ ] Add `<script src="/app/relay.js">` before `host.js` in `index.html`. `guest.js` must skip `relay.js`, so update its filter regex to skip `host|guest|relay`.
- [ ] Commit `feat(plugin): host reuses the remembered room and relays live frames`.

### Task 5: book.js API for live, per-note saves, faster refresh

**Files:** Modify `plugin/app/book.js`.

**Produces** `window.SpecBook`:
- `poll()` and `reloadNotes()`;
- `anchor() -> { key, ry } | null`, built from `readingAnchor()`, with `ry` as the fraction of that element's height above the bar's bottom edge;
- `scrollTo({ key, ry }, smooth)`, which finds the element by key, scrolls so that point sits at the bar's bottom, and falls back to the nearest `PLACES` element;
- `view() -> { diff, shots, mocks, videos, coverage }` and `setView(v, transient)`. With `transient` the view is not stored and `store()` is skipped;
- `me() -> { name, guest, key? }`;
- `noteOf(id)`;
- `onNoteInput(fn)`, with `fn(id, note)` called on sticky or composer input and while dragging;
- `showDraft(id, d, by)`, which draws or updates a remote draft's sticky with `d.text` and "<by> is typing…", read-only;
- `clearDraft(id)`;
- `onUserScroll(fn)`, called on wheel, touchmove, keyboard scroll and clicks in the book.

Also:
- **Saves send `changes`.** Only the ids whose JSON differs from `synced` (deleted → `null`), with no `rev`. The response `rev` sets `state.notesRev`. The legacy stale path is kept for 409.
- **Save delay** 300 → 150 ms.
- **Notes with `lastBy`:** when `lastBy` is not the viewer and the note is the viewer's own, the sticky shows "<lastBy> changed this note".
- **Owner name:** `authorOf` uses `state.owner.name` instead of "Host".
- **Changed notes stay visible.** `setClaude` keeps calling `reloadNotes` on a newer `notesRev`. `reloadNotes` is exported so `host.js` can call it on `changed`.

Steps:
- [ ] Implement. This is UI glue; it is exercised by the reader smoke and share smoke.
- [ ] Run `node --test plugin/` (unit) and the reader smoke, and confirm both still pass.
- [ ] Commit `feat(plugin): book.js live API and per-note saves`.

### Task 6: live.js — presence, drafts, following, share pill

**Files:** Create `plugin/app/live.js` (loaded after `book.js`, for owner and guests) and `plugin/test/live.test.mjs` (pure parts, via `vm`).

**Produces** `window.SpecLive`:
- `receive(msg)`;
- `people() -> [{ id, name, color, role, typing, following, where }]`;
- `follow(id|null)`.

The pure helpers, tested, are `SpecLive._throttle` and `SpecLive._followState(state, event) -> state`.

**Transport:**
- the owner uses `SpecHost.send` and receives through `SpecLive.receive`, called by `host.js`;
- a guest uses `SpecShare.send` and `SpecShare.onLive`.

**Behavior:**
- **Sending:**
  - `where` is `{ anchor: SpecBook.anchor(), view: SpecBook.view() }`, throttled to 100 ms plus a 300 ms trailing send;
  - on `onNoteInput`, send `draft` (50 ms throttle) and `typing` on/off (off 2 s after the last input);
  - `follow` when following changes;
  - `bye` on pagehide.
- **Receiving:**
  - `draft` from another person calls `SpecBook.showDraft`;
  - a draft fades with `clearDraft` after 10 s without `typing` or `draft`, or once a `changed` reload brings the saved note.
- **Following:**
  - clicking a face calls `follow(id)`;
  - while following, apply the leader's `view` with `setView(v, true)` and their `anchor` with `scrollTo` (instant if more than one viewport away, smooth otherwise);
  - `onUserScroll` or local typing calls `follow(null)`, which restores the saved view;
  - the leader's `bye`, or their absence for 15 s, stops following with "<name> left";
  - the chip "Following <name> · scroll or type to stop" sits under the bar, in the leader's color.
- **Being followed:**
  - the badge count on your face is the number of people whose `following === me`;
  - `body.followed` draws the edge in the first follower's color.
- **The share pill** goes into `#share-slot`:
  - faces for everyone but you, plus your own face first; or "Only you";
  - then `Copy link ▾`.
  - The menu holds the link and Copy, the people with their state ("typing", the section label of their `where`, "following you"), and, for the owner, **New link** and **Stop sharing**.
  - If `SpecHost.state()` is `'off'`, the pill is a **Share** button. If it is `'other-tab'`, it reads "Live sharing runs in your other tab".
  - Guests get only the link and Copy in the menu.

Steps:
- [ ] Write `live.test.mjs`:
  - `_followState` goes from following to `null` on `'user-scroll'`, `'typing'` and `'leader-left'`;
  - `_throttle` called 10 times in 50 ms with a 100 ms wait fires twice (leading, then trailing).
- [ ] Run it and confirm it fails.
- [ ] Implement, then confirm it passes.
- [ ] Commit `feat(plugin): live presence, drafts and following`.

### Task 7: The new bar, Requests pane and phone layout

**Files:** Modify `plugin/app/index.html`, `plugin/app/book.css`, `plugin/app/book.js`.

- **Bar markup,** in this order:
  - `#book-title`;
  - `View ▾` (a `menu-wrap` holding the `#view-mock`, `#view-shot`, `#show-videos` and `#show-coverage` checkboxes, plus `#media-count`);
  - the `.tools` icon strip:
    - `#mode` (Comment, C);
    - `#prev-chg` (K);
    - `#chg-pos` "n / N";
    - `#next-chg` (J);
    - `#changes-btn` (Show only changes, F);
    - `#notes-btn` (Requests, R, with a badge);
  - `.bar-spacer`;
  - `#share-slot`;
  - `#claude-menu`: a `✦ Claude ▾` button whose menu holds `#revise` and `#build` with their descriptions, plus `#claude-status`.

  Each icon has a `title` and `aria-label` with its key. The old seg3 is gone. The Screenshots and Mockups checkboxes map to `state.view` as `mockup`, `shot` or `both`, and unchecking both is not allowed.
- **Keys** C, J, K, F and R, the same as the hover text. Ignored while typing, as C is today.
- **Requests pane:** `#notes-panel` gains tabs "Notes n" and "Changes N". Changes lists each open review by section (from `state.reviews.byKey` and its labels), and clicking one scrolls to it. The send area becomes the "✦ Send n notes to Claude" button for the owner.
- **`#chg-pos`** shows the index of the change nearest the top of the screen and the total. Prev and next step through `.has-rv`.
- **Phone, under 700 px:** the `.tools` strip is fixed at the bottom of the screen, View moves into a `⋯` menu, and the Requests pane fills the screen above the strip.
- **Guests:** `#claude-menu` is hidden, as `.bar-group.claude` is today.

Steps:
- [ ] Update `plugin/test/reader.smoke.mjs` to the new controls:
  - the View checkboxes switch screens;
  - F toggles changes-only;
  - J moves to the next change;
  - R opens Requests;
  - Claude ▾ shows Revise and Build.
- [ ] Implement.
- [ ] Run the reader smoke (`GLOBAL_ROOT=/opt/homebrew/lib/node_modules/playwright node plugin/test/reader.smoke.mjs`) and confirm it passes.
- [ ] Look at a screenshot at 1440 px and at 390 px.
- [ ] Commit `feat(plugin): new bar, Requests pane, phone layout`.

### Task 8: share CLI, skill and docs

**Files:** Modify `plugin/server/share.mjs`, `plugin/skills/share/SKILL.md`, `plugin/skills/specbook/SKILL.md`, `plugin/reference/reader.md`, `plugin/reference/book-format.md` (`settings.share`), `server/README.md` (protocol 2, waiting guests), and `plugin/.claude-plugin/plugin.json` (version 1.3.0).

- **`share.mjs`:**
  - a plain call prints the current link, starting the server and opening the book if needed and waiting for `live`;
  - `--new-link`;
  - `--stop`;
  - `--status`.
- **The skill** describes always-on sharing.

Steps:
- [ ] Implement.
- [ ] Run `node plugin/server/share.mjs --data <tmp book> --status` against a test server.
- [ ] Commit `docs(plugin): always-on sharing and live presence`.

### Task 9: Share smoke, end to end

**Files:** Modify `plugin/test/share.smoke.mjs`.

**Checks**, added to today's:
1. Opening the owner tab shares by itself, and `share.mjs` prints a link.
2. A guest's typing appears in the owner's sticky before any save, labeled "is typing…".
3. The owner's saved note reaches the guest in under 1 s.
4. The guest follows the owner. The owner scrolls to a requirement, and the guest's matching element is within 40 px of the bar. The guest's own wheel scroll stops following, and the chip goes.
5. Reloading the owner tab keeps the same link, and the guest reconnects.
6. Closing the owner tab shows the guest "The book isn't open right now"; reopening reconnects without reloading the guest.
7. New link ends the old link: the guest shows "This share has ended".
8. A forged `draft` for the owner's note, sent over the guest's channel, never shows in the owner's page.

Steps:
- [ ] Write the checks.
- [ ] Run the smoke (`GLOBAL_ROOT=/opt/homebrew/lib/node_modules/playwright node plugin/test/share.smoke.mjs`).
- [ ] Fix until all checks pass.
- [ ] Run every unit test (`node --test 'plugin/**/*.test.mjs' 'server/src/*.test.mjs'`) and both smokes.
- [ ] Commit `test(plugin): share smoke covers live presence, following and always-on sharing`.
