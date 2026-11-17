# Specbook share server

A Cloudflare Worker that lets the specbook plugin hand out a link to a live spec book. It is
deployed on its own; the plugin only uses it, by the address in a book's `settings.shareBroker`.

The owner's book server (the plugin's `serve.mjs`, through `plugin/server/lib/host.mjs` with `node-datachannel`) is the
host. This server serves the reader's interface and passes the WebRTC handshake between the host and each reader. The
book then goes from the host straight to the reader, encrypted end to end; this server never sees or stores it. Only
data comes from the host (the book's JSON, notes, images and recordings); no byte of it runs as code on the website.

- **`/s/<room>`** is the one link, for the owner and guests alike. It asks the room which reader version its host
  named when it opened the room, and serves that version's `share.html` from `/r/<version>/`, with a strict
  Content-Security-Policy (only this site's scripts run). A version this site does not have gets "This book needs a
  newer share server. Ask its owner to deploy it." The owner's pin, after `#pin=`, never reaches this server: the page
  saves it in the browser and takes it out of the address.
- **`/r/<version>/`** holds every published reader (`share.html`, `book.js`, `book.css`, `model.js`, `live.js`,
  `relay.js`, `share.js`), and `/r/versions.json` lists them. A published folder never changes, so it is cached for
  good. Each plugin version's reader stays, so a book served by an older plugin keeps working.
- **Protocol 1 and 2 rooms** (opened by plugins before 1.4, whose open book tab is the host) still get `guest.html`
  and `guest.js`, kept as they were, with their signed handshake. Protocol 3 rooms (plugin 1.4 on) drop the signature: this server
  serves the interface, so it is trusted either way.

The book server opens its room (`POST /api/rooms`) directly; of browser pages, only one on the owner's machine (an
`http://localhost` origin) may, by CORS. A room lasts until it expires (at most 24 hours) or its host ends it (`POST /api/rooms/<room>/end` with the host
token). Its host keeps the link by opening the room again with `{ room, hostToken }`: a live room is renewed, and one
that expired is opened again under the same id, but only with the token it was held under (the server keeps a hash
of it for 30 days past the room's expiry; another token gets 409 `taken`, and the book server then opens a new room). An ended room never is: for a week its address answers 410, so its
readers are told it ended. While the host is away (its book server stopped), readers wait on their socket and hear
`host-online` when it comes back: only in a room a host has opened, three at most from one address, and for an hour
at most (then the socket closes with 4408 and the page asks for a reload). The host and the readers also pass live
messages (presence, typing, following) over their own connection, never through this server.

One Durable Object holds every room. Its WebSockets hibernate and its keepalive pings are answered without waking
it, so an idle share costs nothing.

## Deploy

Every plugin version that changes the reader is a new reader, and the site must have it before books served by that
plugin can be read on their link:

1. Bump `version` in `plugin/.claude-plugin/plugin.json`.
2. From the repository root, `node server/publish-reader.mjs`. It copies `plugin/app/` into
   `server/public/r/<version>/` (with `share.html`, the reader's page for the website) and rewrites
   `server/public/r/versions.json`. A published version is never overwritten with different bytes: a changed reader
   needs a new version.
3. Commit `server/public/r/<version>/` and `server/public/r/versions.json`, so a deploy from any checkout carries
   every version.
4. From this folder, `./wrangler.sh deploy`.

**During development**, before a real release, keep the version and republish it over itself:
`node server/publish-reader.mjs --force`, then `./wrangler.sh deploy`. `share.html` asks for each file by its content
hash (`book.js?h=…`) and `/s/<room>` is served `no-store`, so every phone loads the new files at its next load, though
`/r/` is cached for good. A tab already open keeps its reader until it is reloaded (the book itself still updates live).

It serves at `https://specbook.jasonrowland.com` (the `routes` entry in `wrangler.jsonc`; change it to deploy under
another domain in your own account). The plugin uses `https://specbook.jasonrowland.com` unless a book names another in
`settings.shareBroker`.

`wrangler.sh` runs wrangler with a Cloudflare token from LastPass. It asks for your LastPass master password on every
run. The first time, it mints a `specbook-provision` token with the master token in `Cloudflare/cloudflare-master`
(override with `SPECBOOK_BOOTSTRAP_NOTE`) and saves it in `Cloudflare/cloudflare-specbook-provision`. Later runs reuse that
token. Put `LPASS_USERNAME=you@example.com` in `server/.env` to skip the username prompt. Run it in a real terminal.

On the Workers Free plan this costs nothing at the scale of a few shares: 100,000 requests a day, and Durable Objects
get 100,000 requests and 13,000 GB-s a day (incoming WebSocket messages count 20 to 1; hibernation accrues no
duration).

## TURN (optional)

Without TURN, guests connect directly (STUN), which works on most home and Wi-Fi networks. Some phone carriers and
office networks need a relay. To offer one, create a TURN key in the Cloudflare dashboard (Realtime → TURN) and set:

```sh
./wrangler.sh secret put TURN_KEY_ID
./wrangler.sh secret put TURN_KEY_API_TOKEN
```

TURN costs $0.05 a GB after the first 1,000 GB a month (shared with the Realtime SFU). `TURN_DAILY_CAP` in
`wrangler.jsonc` (default 200) caps how many relay credentials it hands out a day; past it, guests get STUN only.

## Limits

10 rooms an hour per IP address, 20 guests a room, 64 KB a handshake message, rooms of 1 to 24 hours.

## Develop

`wrangler dev --port 8798` runs it locally; `node --test src/ publish-reader.test.mjs` runs the unit tests;
`plugin/test/share.smoke.mjs` (from the repository root) runs a copy of this folder with the current reader published
into it, a book server as the host, and readers on the link, end to end.
