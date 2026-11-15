# Specbook: live presence, following, always-on sharing, and a new top bar

Date: 2026-11-14. Status: ready for the owner's approval.
Builds on: the share feature (`plugin/app/host.js`, `plugin/app/guest.js`, `server/`), designed in
`~/jsonxr/ai/specbook-share/docs/superpowers/specs/2026-11-14-specbook-share-design.md`.

## Intent

A share works, but it feels slow and awkward. A change takes up to five seconds to reach the owner. Starting a share
takes a command. The top bar wraps to two rows and does not say what its buttons do. The owner wants a share to feel
like Figma:

- changes appear in milliseconds;
- everyone sees who is in the book;
- anyone can follow someone else and watch them scroll and type;
- the bar is short, grouped by job, and clear.

## Goals

1. **Live.** A note's text appears for everyone as it is typed. A saved change reaches every screen, the owner's
   included, in well under a second.
2. **Presence.** Everyone in the book, owner and guests, appears as a colored face in the bar. A face shows a small
   pen while that person is typing.
3. **Following.**
   - Clicking a face follows that person:
     - your window scrolls to the same place in the book as theirs, even when your screen is a different size;
     - you see their notes open, move and fill in as they type.
   - Clicking the face again stops following. So does scrolling, clicking into the book or typing yourself.
   - A chip under the bar says "Following Ana · scroll or type to stop".
   - If the leader leaves, following stops and a short line says so.
   - Following someone who follows someone else shows the first person's screen.
4. **Being followed.** Your own face carries a small badge while anyone follows you, and a thin colored edge
   (the follower's color) runs around your window.
5. **Always-on sharing.** The book is shared whenever the owner's book tab is open. Nobody runs a command to start.
   - The link lasts as long as the owner's local book server runs. Reloading or reopening the tab keeps the same
     link. When the server stops, the link ends. The next start makes a new one.
   - The link is not saved anywhere. The owner copies it whenever they want to hand it out.
   - **Stop sharing** in the bar's share menu ends the share until the book is reopened. **New link** cuts off
     everyone holding the old link and makes a new one.
6. **A new top bar** (owner, desktop), left to right:

   `Tribes · View ▾ · [💬 | ⌃ 3 / 189 ⌄ | ⏚ | ☰⁴] ········ (J)(A)(R) Copy link ▾ · ✦ Claude ▾`

   - **View ▾**: checkboxes for Mockups, Screenshots, Recordings and Coverage, plus the media count line.
     - It replaces the Mockups/Screenshots/Both control and the Recordings and Coverage checkboxes.
     - At least one of Mockups and Screenshots stays checked; both checked is today's "Both".
   - **The review icon strip**, after Figma. Icons only, each with hover text naming it and its key:
     - Comment · C (today's Comment mode; yellow while on);
     - Previous change · K, a "3 / 189" position, and Next change · J;
     - Show only changes · F (today's Changes mode);
     - Requests · R, with a count badge of open notes. It opens the Requests pane.
   - **The share pill.**
     - It holds the faces of everyone here plus **Copy link ▾**. It has no dot or "Sharing" word: the faces say it.
     - With nobody else here, it reads **Only you · Copy link ▾**.
     - Its menu holds the full link with Copy, who is here and what each is doing ("typing", "§2.3 Passkeys",
       "following you"), **New link**, and **Stop sharing**.
   - **✦ Claude ▾**: Claude's mark and name in Claude's color, as a dropdown.
     - **Revise**: "Send your n notes. Claude revises the book and you review each change."
     - **Build**: "Build the n sections marked Ready, with tests as evidence."
     - While Claude works, the button reads "✦ Claude · Building §2.3… ▾" and the menu says how far along it is.
     - Disabled items say why, as today's buttons do.
   - **The Requests pane** replaces the Notes button and today's notes panel. It is a panel on the right.
     - The **Notes** tab lists every open note by section, with its pin number, its text, and who wrote it ("You",
       "Ana · typing").
     - The owner gets **✦ Send n notes to Claude** at its foot (Revise).
     - The **Changes** tab lists every pending change by section.
     - Clicking an item scrolls to it.
7. **Guests' bar.** The same, without ✦ Claude ▾ and without the share menu's New link and Stop sharing. A guest's
   share menu holds only the link and Copy, so a guest can pass the link on.
8. **Phone.**
   - The top bar holds the book's name, the share pill (its button reads "Link ▾") and a ⋯ menu holding View's
     checkboxes.
   - The review icon strip sits at the bottom of the screen.
   - The Requests pane fills the screen above the strip.

## Non-goals

- Live cursors that show where the pointer is.
- Two people editing the same note's text at once. Each note has one owner. When the owner edits a guest's note
  while the guest is typing, the last save wins, as today.
- Sharing while the owner's tab is closed. Guests who open the link then see "The book isn't open right now".
- Saving the link across server restarts.

## Anti-goals

- Live traffic must not pass through the share server. It would see the book's notes as they are typed, and the
  promise is that the book never touches it.
- Guests still never reach Revise, Build, Accept, stage changes or direct requirement edits. Following someone never
  passes on their actions; it shows only where they are and what they type.
- No packages in the plugin.

## Approaches

1. **A live layer on the existing host connections (chosen).** Each guest already has a WebRTC data channel to the
   owner's tab. New message types go over it. The owner's tab relays each guest's messages to every other guest, and
   it sends its own. Disk stays the saved copy.
2. **Live messages through the share server's WebSocket.** Rejected: the server would see every keystroke, and each
   message counts against Durable Object requests.
3. **A direct mesh between guests.** Rejected: more handshakes and more cellular failures, with no gain at 20 guests.
4. **A sync library (Yjs or similar).** Rejected: it adds packages to solve concurrent editing of one text, which
   cannot happen here.

For the link's life the owner chose: **it lasts while the local server runs, and is not saved.** A lasting link
saved for 30 days was considered and declined.

## Design

### Who holds the share

The owner's book tab still does all the WebRTC, as today. **The local book server only remembers the room**, in
memory, so the link does not change while it runs:

- The first hosting tab creates the room at the broker, as today, and gives `{ room, hostToken, secret }` to the
  local server (`POST /api/share/live`, extended).
- A reloaded or reopened tab gets them back from the local server in the `start` event and reconnects to the same
  room, so the link survives.
- On `--stop`, on a clean shutdown, and on **New link**, the room is ended at the broker with a new endpoint,
  `POST /api/rooms/:id/end` (host token). New link then makes a new room.
- `/specbook:share` keeps `status`, `stop` and `new-link`, plus a plain `/specbook:share` that prints the current
  link.

The broker keeps a room whose host is gone, until its `expiresAt`; today it ends it after 60 seconds.

**When the host's tab closes, guests wait without polling.** A WebRTC connection cannot be resumed once one side is
gone: a reopened tab is a new peer with new network addresses and new keys, so a fresh signed handshake is needed,
and only the broker can carry it to a host behind a home router. So:

- guests drop the dead peer connection and show "The book isn't open right now. This page will reconnect when it
  is.";
- each guest keeps one quiet WebSocket open to the broker. It hibernates, costing nothing while it waits, and does
  not poll;
- when the host's tab connects again, the broker sends `host-online` to the waiting guests, and each makes a new
  signed offer;
- a guest waits an hour at most (decided 2026-11-14, was six), then the page asks for a reload.

**One person per device.** The guest page keeps a device id in its browser; a guest's id in the book is a hash of
their key and that device. When the same person on the same device joins from a newer tab, the host tells the older
tab it was disconnected and lets it go; that tab shows a Disconnected page and reconnects only when clicked.

While the host's tab is open, everything goes over the direct connection. The broker carries only handshakes.

**Stop sharing** ends the room and the hosting tab stops listening until the book tab is reopened. Reopening makes a
new room and a new link.

### Live messages

The guest page on the share server (`server/public/guest.js`) currently knows `req`/`res`/`changed` frames. Make it a
**generic transport**:

- `SpecShare.send(obj)` sends any object with `t: 'live'`.
- `SpecShare.onLive(fn)` receives them.

Then new live message kinds need no redeploy of the share server. Bump `PROTOCOL` to 2. A host speaking 2 refuses a
guest page speaking 1 with a clear "refresh the page" message, and the reverse.

Every live message carries `from`, the sender's peer id. The host assigns peer ids; the owner is `host`. The kinds
are:

| kind | sent when | body |
|---|---|---|
| `hello` | on connect, and to each newcomer | `name`, `color`, `role` (`owner`/`guest`) |
| `where` | on scroll or resize, at most every 100 ms, and once 300 ms after scrolling stops | `anchor` (element id), `ry` (0..1 within it), `view` (Show only changes, Mockups, Screenshots, Recordings, Coverage) |
| `draft` | on input in a note or while dragging it, at most every 50 ms | `note` (id), `item`, `rx`, `ry`, `dx`, `dy`, `text`, `author` |
| `typing` | when typing starts and 2 s after it stops | `note`, `on` |
| `follow` | when you start or stop following | `leader` (peer id or null) |
| `bye` | on pagehide | none |

- **The host relays.** It forwards each guest's live message to every other guest, never back to the sender. It
  stamps `from` itself and never trusts the sender's.
- **The host checks drafts.** It drops a `draft` for a note the sender may not edit: for a guest, notes not their
  own. A rejected draft is never shown.
- **The owner's tab is a peer too.** Its own `where`, `draft`, `typing` and `follow` go to all guests.
- **Scroll anchors.** The anchor is the nearest element with a stable id at the top of the viewport: a
  requirement, frame, section or chapter. This is the same kind of id notes already pin to (`anchorFor`). The
  follower scrolls so that point of that element is at the top of their viewport.
- **Drafts are display only.**
  - A `draft` draws or updates that note's sticky, with the writer's text and "Ana is typing…".
  - Saving stays as today: the writer saves through `PUT /api/notes`. The saved note replaces the draft on the next
    load.
  - A draft with no `typing` or save within 10 s fades back to the saved note.
- **A save reaches everyone at once.**
  - The local server's watch sends `changed` to the hosting tab.
  - The hosting tab now also reloads its own notes on it, which ends the five-second lag.
  - The server's change batching drops from 200 ms to 50 ms, and the reader's save delay from 300 ms to 150 ms.
- **Colors.** A guest's color comes from their per-share key, from a fixed palette of 8 colors that read on the dark
  book. The owner is always the first color.

### Following

**Following changes your view** (the owner's call). While you follow someone, your book takes their view settings:
Show only changes, Mockups, Screenshots, Recordings and Coverage. `where` carries them. Your own settings come back
when you stop following, and are never saved while following.

The follower's tab applies the leader's `where`:

- it scrolls instantly when the jump is over one screen, and smoothly otherwise;
- it opens the leader's open stickies;
- it shows the leader's drafts.

Any of these by the follower stops following:

- wheel, touch-scroll or a keyboard scroll;
- a click inside the book;
- typing.

Scrolls the follower's tab makes itself are not user input and do not count. A face's menu entry and its hover text
say "Ana · click to follow".

Following never runs the leader's actions. A follower sees the leader's notes because the leader's drafts and saves
reach everyone anyway.

### Pieces that change

| Piece | Change |
|---|---|
| `server/src/worker.mjs`, `rules.mjs` | Rooms outlive their host until `expiresAt`. New `POST /api/rooms/:id/end`. Room creation may come from Node (no Origin); the rate limit still applies. |
| `server/public/guest.js` | Generic `live` frames (`send`, `onLive`). The "book isn't open" state and retry. `PROTOCOL` 2. |
| `plugin/server/serve.mjs` | Holds the room, creates it on the first listening tab, sends it in `start`. New link and Stop endpoints. Ends the room on `--stop` and shutdown. Change batching at 50 ms. |
| `plugin/server/share.mjs`, `skills/share/SKILL.md` | No start step. `status`, `stop`, `new-link`, and printing the link. |
| `plugin/app/host.js` | Uses the room it is given. Relays live messages and checks drafts. Assigns peer ids and colors. Reloads its own notes on `changed`. |
| `plugin/app/guest.js` | Wires `SpecShare.onLive` and `send` into the reader. |
| New `plugin/app/live.js` | Presence state, `where` sending and applying, drafts, following, the chip and the colored edge. Used by owner and guests. |
| `plugin/app/index.html`, `book.js`, `book.css` | The new bar, View ▾, the review strip, the share pill and its menu, ✦ Claude ▾, the Requests pane (replacing the notes panel), and the phone layout. |
| `plugin/reference/reader.md` | Describes the new bar, sharing, presence and following. |

### Tests

- **Unit tests.**
  - Live message rules: relay without echo, `from` stamping, refusing drafts for others' notes.
  - Anchor math: the same anchor gives the same element position at two viewport widths.
  - The broker keeps a hostless room, refuses `end` without the token, and ends a room with it.
- **The share smoke test**, extended:
  - a guest's typing shows in the owner's tab before any save;
  - the owner's save shows for the guest in under 1 s;
  - following scrolls the follower to the leader's anchor, and the follower's own scroll stops it;
  - reloading the owner tab keeps the link working, and New link ends the old one;
  - closing the tab shows guests "The book isn't open right now".
- **The reader smoke test**, updated for the new bar: View ▾, the review strip's keys, the Requests pane, and
  Claude ▾.

## Calls made during review (the designer's, for the owner to check)

- **Turning it off.** Sharing is on by default. `settings.share: false` in `book.json` turns it off for a book; the
  share pill then reads **Share** and starts one on click. Tests point `settings.shareBroker` at a local
  `wrangler dev` (as the share smoke does) or set `share: false`, so they never touch the public broker.
- **Saves are queued and merged per note** (the owner's idea). Today an owner `PUT /api/notes` replaces the whole
  map and a stale `rev` gets a 409 and a reload, which would churn constantly with live typing. Instead each save
  carries only the notes it changed and the ids it deleted, with the `rev` each was based on. The local server
  queues saves in arrival order and applies each note change that does not conflict, under its existing rules
  (guests only their own notes, the owner any). A change to a note someone else changed since the writer last saw
  it is a conflict: the later one wins, and the writer whose text was replaced sees "Ana changed this note" on it.
  The queue lives in the local server, not the tab, because the server writes the file and outlives a tab reload.
- **No `notesOpen`.** Every posted note is already a visible sticky, so there is nothing to open. A note being
  written shows through `draft`. "Moving" a note means its sticky offset, so `draft` carries `dx`/`dy` too, and
  dragging sends drafts.
- **The owner's name and face.** The owner's name is git's `user.name` for the project (first name), falling back
  to "Owner". Guests see it on the owner's face and notes instead of "Host".
- **A second owner tab** (another window, same book) is not live: only the hosting tab has the data channels. It
  shows "Live sharing runs in your other tab" in the share pill and refreshes on `changed` as today.
- **Versions.** Guests need nothing installed; only the host runs the plugin. The reader comes from the host's
  tab, so host and guests always run the same reader. The one place versions can differ is the share server's small
  guest page (one deployed version for everyone) against each host's plugin (`host.js`). `protocol` goes into the
  signed offer and answer (in `rules.mjs`) so each side can tell. The guest page keeps speaking every protocol still
  in use; when a host's plugin is too old for it, the guest sees "The person sharing this book needs to update the
  specbook plugin." The owner decided the reader keeps being served from the owner's machine.
- **Builder's own calls, agreed:** peer ids are derived from the guest key and stable across reconnects; a guest's
  name comes from the signed offer, not from `hello`; a brand-new unsaved note belongs to its writer.

## Left to the builder

- How the broker keeps a room past 24 hours, if needed (raise the limit, or let the local server renew).
- The exact palette of 8 colors, and icon drawings in the style of the mockups.
- Throttle values within the limits above.
- Whether the Requests pane is open by default on desktop when notes exist (suggested: yes, remembered per
  browser).
- The mockup that settled the bar is option B of
  `.superpowers/brainstorm/86301-1794704601/content/toolbar-v4.html` (gitignored, in this repo's worktree).
