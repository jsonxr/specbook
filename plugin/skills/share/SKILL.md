---
name: share
description: Use when the user types /specbook:share (with nothing, new-link, stop or status), or asks for the link to the spec book, to share it, give someone a link to it, let collaborators read it or leave notes on it, read it from their phone, cut off an old link, or stop sharing it. The book is shared whenever its tab is open; this gives the link and manages it.
---

# Share the spec book

**Announce at start:** "Using specbook:share to share the spec book."

`<dir>` is the book's data folder (as in `specbook:open`). `${CLAUDE_PLUGIN_ROOT}` is this plugin's root. You run
the commands below yourself; the user never types one. `SHARE` means
`node ${CLAUDE_PLUGIN_ROOT}/server/share.mjs --data <dir>`.

How it works: the book is shared whenever the user's book tab is open, and that tab is the host. The book goes from it
straight to each guest, live: everyone sees who is in the book, notes as they are typed, and can follow one another.
A share server passes the handshake between them; the plugin comes set to the public one,
`https://specbook.jasonrowland.com`, and a book may name its own in `settings.shareBroker`. The link lasts as long as
the book's server runs; closing the tab pauses the share until it is open again. Guests can read the book and keep
their own notes, nothing else.

## new-link, stop, status

- `/specbook:share new-link`: run `SHARE --new-link`, and pass on its line (the old link stops working).
- `/specbook:share stop`: run `SHARE --stop`, and say so in one line. Reopening the book shares it again, with a new
  link.
- `/specbook:share status`: run `SHARE --status`, and pass on its line.

## The link (no argument)

1. Run `SHARE`. It starts the book's server if needed (restarting one an older plugin started), opens the book in the
   browser if no book tab is open, and prints the link. If it fails, it prints why: pass that on and stop. Never ask
   the user for a share server. Only if they ask to use their own, save it with `SHARE --set-broker <https url>`;
   they deploy it themselves, never you.
2. **Tell the user** the link in one line, and that:
   - anyone holding the link can read the live book and leave notes under the name they give, so share it only with
     people they mean to; **New link** in the bar's share menu (or `/specbook:share new-link`) cuts off the old one;
   - guests cannot Revise, Build or Accept. A guest's notes reach the user with the guest's name, and Revise sends
     them on with `by`;
   - the faces in the bar are who is here: clicking one follows that person, and **Copy link** copies the link.
