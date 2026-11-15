# Developing the plugin: what works, and what it would cost to make it easier

2026-11-15. Written after trying, and removing, several shortcuts for development. Read this before adding one.

## How to develop today

- **The reader on localhost.** A book's server (`plugin/server/serve.mjs`) serves `plugin/app/` straight from the
  plugin folder at `http://localhost:4180/` (or the book's own port). Load the plugin from this checkout
  (`claude --plugin-dir ./plugin`, or the `specbook-dev` marketplace in `.claude-plugin/`), edit `plugin/app/`, and
  reload the page. After a change under `plugin/server/`, run `/specbook:open`: it sees that the server's code
  changed and restarts it.
- **At phone size.** Chrome's device mode on this Mac, or Safari in the iOS Simulator (Xcode), which shares the Mac's
  network, so `http://localhost:4180/` works there unchanged. The reader smoke test checks phone widths too.
- **The share link, end to end.** `plugin/test/share.smoke.mjs` runs a copy of the share server (`server/`) with
  `wrangler dev`, publishes the current reader into it, and drives a book server and readers on the link. It never
  touches the public share server.
- **Releasing a reader.** Raise the plugin's version, `node server/publish-reader.mjs`, commit, deploy the share
  server (`server/README.md`). That is the only time a reader is published.

`/specbook:open` opens the book on its share link, which runs the **released** reader. To see unreleased work, open
localhost yourself.

## What is hard, and why

The share link is built so that **no code from a book's server ever runs on a reader's page**. The website
(`specbook.jasonrowland.com`) serves the reader; a book server sends only data (the book's JSON, its notes, the bytes
of its media), and that data is cleaned and fenced by a strict Content-Security-Policy. Three facts follow, and every
shortcut below runs into one of them:

1. **The share server is trusted completely.** Whoever serves `/s/<room>` and `/r/<version>/` controls every reader's
   page: what it shows, what it sends back, and the pin a reader types. That is why the handshake is not signed: there
   is nothing to check it against.
2. **The site's storage holds secrets for every book.** A browser keeps, under the site's address, the saved pin of
   every book it opened with a pin, and the key that makes a guest's notes theirs, for every share. Any code that runs
   on the site's address can read all of it.
3. **A published reader version is permanent.** Browsers keep `/r/<version>/` files for good (they are served as
   immutable), and a book server names the version it speaks. Two different files under one version means readers
   with a mix of old and new code.

And on this machine:

4. **localhost is the owner.** The book server listens on `127.0.0.1` only, refuses any request not addressed to
   `localhost` or `127.0.0.1` (so another web page cannot reach it under another name), and gives every request it
   accepts the owner's powers, with no pin. Revise and Build hand work to Claude on this Mac.

So the only gap is **trying an unreleased reader on the share link, or on a real phone**. Everything below was
considered for that gap.

## Shortcuts considered, and their real costs

### Load the reader from the book server instead of the website

A switch in the reader that fetches `book.js` and the rest from the book server and runs them on the site. This is
how the share worked before 2026-11-15, and the reason it was replaced.

- Code from a book server would run on the site's address and could read every pin and guest key the browser holds
  (fact 2). Left on while reading someone else's book, it hands that book's owner your pins to your other books.
- The Content-Security-Policy would have to allow scripts that are not the site's own, which weakens the second wall
  for every reader, not only the ones who turn the switch on.
- Offering it only to a reader with the pin does not make it safe: holding a pin does not mean the book is yours.
- **The safe form** runs the downloaded reader in a sandboxed frame with no access to the site's storage, talking to
  the outer page by messages; the outer page, from the site, keeps the connection and the pin. That is a second way of
  running the reader to build and keep working: a message layer, a policy for the frame, and every part of the reader
  that touches storage or the connection reworked. Worth it only for trying unreleased readers against other people's
  book servers.

### Point book servers at another share server (a local one, or a setting)

A local share server (`wrangler dev` with the working reader in it, republished on every save) and a setting such as
an environment variable, or `metadata` in the development marketplace entry, that makes book servers use it. Built
and removed on 2026-11-15.

- By fact 1, the setting decides who controls every reader's page for that book. Set to the wrong address, or left
  set, it gives that server the book's readers, their notes, and the pin typed on its page.
- Its links work only on this machine, and switching back and forth means restarting book servers (and, for an
  environment variable, Claude sessions). Read from the marketplace, it switched on its own whenever the local server
  ran, so the book in daily use moved to a link no one else could open.
- Claude Code passes nothing from a marketplace entry or plugin manifest to the plugin's scripts at run time (only
  `userConfig` values, into skill text and hooks), so any such setting is a file the plugin reads for itself.
- A development copy of the site at its own address (a second worker environment where versions may be overwritten)
  avoids the "this machine only" limit, but carries the same trust question and is another deployment to keep.

### Overwrite a published reader version

`publish-reader.mjs --force` writes over a version. It is fine for a version that was never deployed. For a deployed
one, by fact 3, readers keep whichever files they already have, and a mixed reader can draw a broken book or refuse
the host. Raise the version instead.

### Reach localhost from a phone on the same network

Serving the book server on the Mac's network address so a phone on the same Wi-Fi can open it.

- By fact 4, everyone on that network would get the owner's powers, including starting Revise and Build, which make
  Claude act on this Mac. It would need the pin on every request that is not from this machine: a sign-in that sets a
  session cookie, with the same slowing of wrong guesses the share link has (`pinWaitMs` in
  `plugin/server/lib/secret.mjs`), and the Host and Origin checks widened only to that address.
- It would need https. Over plain http on a network address the browser is not in a secure context: the reader's
  `crypto.subtle` (guest identity, `app/relay.js`) is missing and the Copy buttons fail. A certificate the phone
  trusts means a self-signed one (warnings; iPhones resist), a local authority such as mkcert installed and trusted on
  every phone, or a real certificate for a name pointed at the Mac's address, renewed by the Mac.
- For layout work, the iOS Simulator already gives a phone browser on localhost, with none of this.

## Before adding a shortcut

Check it against the four facts above. If it lets code from a book server run on the site, changes who serves the
reader, changes a published version, or widens who counts as localhost, it needs its own design and review, and this
document should say what was decided.
