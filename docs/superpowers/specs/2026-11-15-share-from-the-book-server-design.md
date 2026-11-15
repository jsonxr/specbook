# Share from the book server

2026-11-15. A project; agreed in conversation.

**Changed 2026-11-15, at the owner's request: no sharing by default.** The book server never shares on its own (not
at start, not when a tab opens; `settings.share` is ignored). **Share** in the bar opens a box for a 6-digit pin the
owner chooses; **Start** shares with that pin, and the same menu then shows the link, the `localhost` address and who
is here, with **Stop sharing** as its only button. **New pin**, **New link** and **Copy pin link** are gone (Stop
sharing then Start makes a new link). A restart leaves the book unshared; a Start after it takes up the same room.
Where this section and the rest of the spec disagree, this section wins.

## Why

Three problems with the way a book is shared today, where the owner's open book tab is the host:

- **Guests run code from the host.** The guest page loads `index.html`, `book.js` and the other reader files from the
  host tab and runs them. Whoever controls the host (or a book's HTML, which goes through `innerHTML`) controls the
  guest's page.
- **The share lives in one tab.** Closing it drops every guest.
- **The owner cannot use the shared link.** The owner works on `localhost`; the link guests get is a different page with
  fewer powers, and the owner's phone can reach the book only on the same network.

The owner wants to copy the address bar of any reader's browser, owner or guest, and send it to someone.

## Goals

- **One link.** Owner and guests open the same `https://specbook.jasonrowland.com/s/<room>`. The address bar is
  always a link that can be shared as is; a `#section` anchor after it still works.
- **The website serves the interface.** The reader's HTML, CSS and JS come from the share server. The host sends only
  data: the book's JSON, its notes, and the bytes of its images and recordings. No byte the host sends is ever run as
  code on a reader's page.
- **The book server hosts.** `serve.mjs` holds the room and answers guests over WebRTC. No tab needs to stay open;
  the share lasts while the book server runs, and keeps its room across restarts (as `.share.json` does today).
- **A pin for the owner's powers.** Revise, Build, Accept, Ready and every other change that is not a reader's own
  note need the pin. Without it a reader has today's guest rights: read the book and keep their own notes.
- **No new cost.** Book data goes peer to peer. The share server only passes the handshake, which fits Cloudflare's
  free tier; TURN stays optional and capped, as today.

## Non-goals

- Accounts, logins or passwords.
- Changing what guests can do without the pin.

## Anti-goals

- Any path by which host-supplied HTML or JS runs on a reader's page.
- A pin left in the address bar, where copying the link would give it away.
- Book data relayed through the share server.

## Approaches

- **The book server hosts over WebRTC, with `node-datachannel` (chosen).** One link for everyone, the tab can close,
  and data stays peer to peer at no cost. It costs a native dependency: the plugin has none today.
- **The tab stays the host; the website serves the guest interface.** It fixes security with no dependency. But the tab
  must stay open, and the owner still uses `localhost`, so it is not one link.
- **The book server keeps a WebSocket to the share server, which relays the data.** No dependency and the simplest
  code. Rejected: the relay carries every byte, which costs money.

## Design

### The link

- The link is `https://specbook.jasonrowland.com/s/<room>`. The room id is the only secret a guest needs. It must carry
  at least 128 bits, written in base 62 (`A-Z`, `a-z`, `0-9`): 22 characters, about 131 bits, drawn without bias
  (reject and redraw any random byte of 248 or more). The share server accepts exactly `[A-Za-z0-9]{22}` for a new
  room. A room already saved in `.share.json` under today's format keeps working until New link replaces it.
- The link key after `#` goes away. It kept the handshake honest against the share server, but the share server now
  serves the interface, so it is trusted either way and the key adds nothing. Old links of the form `/s/<room>#<key>`
  still open: the page drops the key.
- **The handshake is no longer signed (my call).** Protocol 3 drops the HMAC on offers and answers, and the share
  server stops requiring a `sig` for protocol 3 rooms. The share server is trusted outright, since it serves the interface.
- The room id is kept in `.share.json` as today. **New link** in the bar's share menu ends the room, and with it
  every copy of the old link.

### The pin

- The pin is a 6-digit number, drawn without bias, made when the room is first opened and kept in `.share.json`
  (git-ignored, never served). It can be typed (a guest's share menu has a box for it) or carried by the pin link.
  (Changed 2026-11-15 at the owner's request: it was 22 base-62 characters, arriving by link only.)
- **Guessing is slow.** Only a reader who has the link can try a pin. After two wrong pins in a row, every pin
  attempt, the right one included, waits: 2 s, doubling, at most an hour. A pin held back gets `pin-wait` (the page
  keeps it and opens again when the wait ends), not `pin-bad`. A right pin or New pin resets the count.
- **The pin link** is `https://specbook.jasonrowland.com/s/<room>#pin=<pin>`. The page reads the pin, saves it in the
  browser for that room, and removes it from the address with `history.replaceState`, with no reload. From then on
  that browser opens the plain link with the owner's powers.
- **Saved in `localStorage`, not a cookie (my call).** The owner asked for a cookie, but a cookie is sent to the
  website with every request, and `localStorage` never leaves the browser. Either gives the same behavior.
- **Where the owner gets it (my call; there is no `/specbook:share` any more).** `/specbook:open` prints the plain
  link and the pin link, the pin link with one line saying never to send it to anyone. The share menu in the bar
  gains **Copy pin link**, on `localhost` only, beside **Copy link**, which copies the plain link.
- On connecting, a reader that has a pin sends it in its first message. The book server compares it in constant time
  and marks that connection as the owner's. An owner connection's calls run with owner rights; any other connection is
  limited by `guestMay`, which is checked on the book server as today. A wrong pin gets guest rights, and the page
  forgets it and says "This pin no longer works."
- **New pin** in the share menu (my call) makes a new pin and keeps the room: guests keep their link, and
  every saved pin stops working. New link makes a new pin too.
- ~~A reader with the pin has **Forget pin on this device** in the bar's menu.~~ (Removed 2026-11-15 at the owner's
  request.)
- `localhost` keeps working, with owner rights and no pin.

### The interface from the website

- **Every published reader stays on the site.** A new plugin never breaks a book served by an older one. The reader of
  each plugin version (`index.html`, `book.css`, `book.js`, `model.js`, `live.js`, `relay.js` and the guest
  connection) lives at `/r/<version>/`. `plugin/app/` stays the one source: a publish step copies it into
  `server/public/r/<version>/` for the plugin's version, as named in its plugin manifest.
- **Published versions are never changed (my call).** The publish step refuses to overwrite a version that is already
  there with different files; a change to the reader needs a new plugin version. The folders are committed, so a
  deploy from any checkout carries every version.
- **The link stays `/s/<room>`.** That page is a small, stable shell. It asks the share server for the room, which
  answers with the reader version its host named when it opened the room. The shell then loads `/r/<version>/`.
  The version must match `^\d+\.\d+\.\d+$` before it goes into a path. A host whose version the site does not
  have gets "This book needs a newer share server. Ask its owner to deploy it." So publishing a plugin version means
  deploying the site too.
- **Today's tab-hosted plugins keep working.** A room whose host speaks protocol 2 gets today's `guest.html` and
  `guest.js`, kept as they are, and the share server still checks their signed handshake. Only protocol 3 rooms load a
  reader from `/r/`.
- The page loads the reader from the site. It does not fetch `index.html` or scripts from the host. The fetch override
  and blob-URL media in today's `plugin/app/guest.js` carry over; `runScript` and the HTML import do not.
- **Book HTML is cleaned before it is drawn.** Book text and mockups go through `innerHTML` (`book.js` and
  `mountMockup`). On the website, that HTML loses `<script>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, every `on*`
  attribute, and `javascript:` URLs before insertion.
- **A strict Content-Security-Policy on the page**, as a second wall: `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src
  'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. (`style-src` allows inline styles, which mockups
  use.) The reader files have no inline handlers or `eval` today; they must stay that way.
- **External images and fonts are allowed (my call).** `img-src` and `font-src` also allow `https:`, and `style-src`
  allows `https:` stylesheets, so a mockup that points at a web font or a hosted image still draws. Scripts never come
  from anywhere but the site.
- **The versions are checked.** The protocol goes to 3. Because each reader is the one its plugin shipped with, the two
  sides always match; the first messages each way still carry the protocol and version, and a mismatch (a reader
  left open while the owner updated the plugin) says "This book was updated. Reload this page." instead of drawing a
  broken book.

### The book server as host

- **When it hosts: as today.** The book is shared whenever its book server runs, unless `settings.share` is `false`.
  **Stop sharing** ends the room and is remembered in `.share.json`; the next owner tab opened on `localhost` shares
  again, as today. The room is kept across restarts, as today.
- **A pinned reader is the owner (my call).** Their calls carry no guest header, exactly like `localhost`: their notes
  are the owner's, and reading on the link counts as the owner having seen the changes. Presence shows them under the
  owner's name.
- It passes live messages (presence, drafts, following) between everyone connected, as `host.js` does. An owner on
  `localhost` still sees and is seen by readers on the link.
- `plugin/app/host.js` goes away, and the book tab no longer hosts. The share pill's **Share ▾** (it was **Copy
  link**, renamed 2026-11-15) opens the menu with the plain link and, on `localhost`, the book's `localhost:<port>`
  address.
- **`/specbook:open` opens `localhost`** (changed 2026-11-15 at the owner's request: it opened the link with the pin).
  It still prints the share link and the pin link.
- The share server's host endpoints take the book server as host. A request from Node carries no browser `Origin`, so
  the host token authenticates it, as it does today.

### The dependency

- The plugin gains a `package.json` pinning `node-datachannel`. Nothing is installed when the plugin loads.
  `serve.mjs --detach` installs it, once per plugin version, before it starts the server (a prebuilt binary, nothing
  compiled), and prints one line while it does.
- **Where it goes (my call).** The plugin folder may be read-only or replaced on update, so the install runs `npm`
  (which ships with Node) into `~/.claude/specbook/deps/<plugin version>/`, and the book server loads it from there.
- If the install fails (offline, or a platform with no prebuilt binary), the server starts without sharing, and the share
  menu says why. Reading the book on `localhost` is untouched; the next `serve.mjs --detach` tries again.

## Left to the builder

- Whether the book server answers channel requests in-process or by calling itself over loopback with the guest
  header.
- How live messages reach `localhost` tabs (today's `/api/share/events` stream is the obvious path).
- Chunk sizes and the sanitizer's code.
- Tests run against a local share server, never the public one, as the share smoke test does today.
