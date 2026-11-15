# Specbook share server

A Cloudflare Worker that lets the specbook plugin's `/specbook:share` hand out a link to a live spec book. It is
deployed on its own; the plugin only uses it, by the address in a book's `settings.shareBroker`.

The owner's open book tab is the host. This server serves a small guest page (`public/`), and passes the WebRTC
handshake between the host tab and each guest. The book, and the reader itself, then go from the host tab straight to
the guest, encrypted end to end; this server never sees or stores them. The handshake is signed with the key after
`#` in the link, which browsers never send to a server, so this server cannot join a share either. (That holds for this code: the
guest page comes from here, so an altered deployment could read the key. Run your own.) Only a page on the
owner's machine (an `http://localhost` origin) may open a room from a browser. A room lasts until it expires (at most
24 hours) or its host ends it (`POST /api/rooms/<room>/end` with the host token); while the host tab is closed, guests
wait on their socket and hear `host-online` when it opens again. The host tab and the guests also pass live messages
(presence, typing, following) over their own connection, never through this server.

Protocol 2 (plugin 1.3) adds those live messages; a room says its protocol (`GET /api/rooms/<room>`), and the guest page
still speaks protocol 1 to rooms that older plugins open.

One Durable Object holds every room. Its WebSockets hibernate and its keepalive pings are answered without waking
it, so an idle share costs nothing.

## Deploy

From this folder: `wrangler deploy`. It serves at `https://specbook.jasonrowland.com` (the `routes` entry in
`wrangler.jsonc`; change it to deploy under another domain in your own account). The plugin uses
`https://specbook.jasonrowland.com` unless a book names another in `settings.shareBroker`.

On the Workers Free plan this costs nothing at the scale of a few shares: 100,000 requests a day, and Durable Objects
get 100,000 requests and 13,000 GB-s a day (incoming WebSocket messages count 20 to 1; hibernation accrues no
duration).

## TURN (optional)

Without TURN, guests connect directly (STUN), which works on most home and Wi-Fi networks. Some phone carriers and
office networks need a relay. To offer one, create a TURN key in the Cloudflare dashboard (Realtime → TURN) and set:

```sh
wrangler secret put TURN_KEY_ID
wrangler secret put TURN_KEY_API_TOKEN
```

TURN costs $0.05 a GB after the first 1,000 GB a month (shared with the Realtime SFU). `TURN_DAILY_CAP` in
`wrangler.jsonc` (default 200) caps how many relay credentials it hands out a day; past it, guests get STUN only.

## Limits

10 rooms an hour per IP address, 20 guests a room, 64 KB a handshake message, rooms of 1 to 24 hours.

## Develop

`wrangler dev --port 8798` runs it locally; `node --test src/` runs the unit tests; `plugin/test/share.smoke.mjs`
(from the repository root) drives a host tab and a guest through it end to end.
