---
name: share
description: Use when the user types /specbook:share (with nothing, stop or status), or asks to share the spec book, give someone a link to it, let collaborators read it or leave notes on it, read it from their phone, or stop sharing it. Starts a share of the live book hosted by the owner's open book tab, through the share server the book names.
---

# Share the spec book

**Announce at start:** "Using specbook:share to share the spec book."

`<dir>` is the book's data folder (as in `specbook:open`). `${CLAUDE_PLUGIN_ROOT}` is this plugin's root. You run
the commands below yourself; the user never types one. `SHARE` means
`node ${CLAUDE_PLUGIN_ROOT}/server/share.mjs --data <dir>`.

How it works: the user's open book tab is the host. The book goes from that tab straight to each guest, and closing
the tab ends the share. A share server passes the handshake between them. It is deployed separately, outside this
plugin, and the book names it in `settings.shareBroker`. Only this session starts a share. Guests can read the book
and keep their own notes, nothing else.

## stop, status

- `/specbook:share stop`: run `SHARE --stop`, and say so in one line. Closing the book tab also ends it.
- `/specbook:share status`: run `SHARE --status`, and pass on its line.

## Start (no argument)

1. **The share server.** Run `SHARE --check`. It prints `{ broker, sharing }`.
   - If `sharing` is a link, give the user that link (step 3) and stop.
   - If `broker` is null, ask the user for their share server's address, an `https://…` URL. Save it with
     `SHARE --set-broker <url>`. If they have none, say a share server has to be deployed first, and stop. Do not
     deploy one; it is not part of this plugin.
2. **Start.** Run `SHARE`, adding `--hours <n>` if the user gave a length (8 by default, at most 24). It starts the
   book's server if needed. If an older copy of the plugin started that server, it restarts it, because the older
   copy cannot check guests. If no book tab is open, it opens one in the browser. Then it waits for the tab to host
   and prints the link. If it fails, it prints why: pass that on and stop.
3. **Tell the user** the link in one line, and that:
   - anyone holding the link can read the live book and leave notes under the name they give, so share it only with
     people they mean to;
   - guests cannot Revise, Build or Accept. A guest's notes reach the user with the guest's name, and Revise sends
     them on with `by`;
   - the book tab hosts the share. It shows **Sharing · n guests**, with **Copy link** and **Stop**. Closing that tab
     ends the share, and a new one takes `/specbook:share` again.
