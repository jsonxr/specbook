# What the reader looks like

The page `serve` opens, in detail. The `specbook` skill points here.

- **Header** across the top (sticky), left to right. Every dropdown ends in the toolbar's chevron:
  - the book's title (cut short with … when the screen is narrow);
  - **View**: checkboxes for **Mockups**, **Screenshots** (both checked shows both; one always stays checked),
    **Recordings**, **Coverage** (when there is evidence) and, with the filter on, **Show sent notes**, plus the media
    count;
  - the share pill (see "Sharing a book");
  - **✦ Claude**, a menu holding **Revise** and **Build**, each saying what Claude will do (see "The Claude group"),
    with a badge counting the draft notes. While Claude works, the button reads "✦ Claude · Building…".
- **The review toolbar**, at the bottom on every screen, icons with hover text naming each and its key: **Contents**,
  **Comment** (C), previous (K), the position "n / N", next (J) and the filter, **Only what needs you** (F). On a
  desktop it floats, centered under the book. On a phone (under 700 px) it is a full-width strip above the home
  indicator, with every button at least 44 by 44 points (Apple's minimum touch target).
- **Sidebar** on the left: the table of contents only, chapters and their numbered sections, sticky under the header.
  The toolbar's **Contents** hides and shows it (shown by default; the choice is remembered in this browser), and the
  book takes the whole width while it is hidden.

  On a narrow screen (860 px or less) the sidebar is never shown beside the book: **Contents** opens it as a sheet
  from the bottom, as tall as the screen allows (a strip of the book stays in view above it), scrolled to and marking
  the section in view. Tapping an entry jumps there and closes the sheet; the backdrop, Esc or a swipe down closes it
  too.
- **The book**: a cover, then chapters. A chapter has an eyebrow ("Chapter 03"), a title, a status pill and an
  intro. Each section has a § number, title, a stage pill, intro, a list of requirements, then every screen
  ("frame") it describes side by side, each captioned with a colored role tag. Recordings play under their
  section. At the end: **Decisions and what was rejected**, the full list.
- **Stages.** Each section's pill says Drafting, Ready, Building or Built, plus its `label` after a dot
  ("Drafting · Phase 2"). A Built section with changes shows `Built · 1 change drafting` or
  `Built · 3 changes drafting`. A chapter's pill is derived from its sections. While Claude is idle, a Drafting
  section has a **Mark ready** button and a Ready one has **Back to drafting**; Building and Built sections have no
  control. A section none of whose requirements has a `change` cannot be marked Ready (400 `nothing-to-build`), and one with an
  open review (on the section, any of its requirements or frames, or an item removed from it) cannot either (409
  `unreviewed`): the page says "Accept this section's changes before marking it ready." under the heading and in the
  button's tooltip. The controls are hidden while Claude is busy, and a refused change says "Claude is busy; the book is
  locked until it is done."
- **Pending changes.** A section with some changed requirements shows **What the app does today**, then its own
  **Changes** list. Each change is tagged: `add` is **New**; `change` shows the target with **Today:** what happens
  now under it; `remove` is struck through, tagged **Removed**, with **Why:** and its reason. Numbering runs on across
  both lists. A frame that draws a changed screen carries a "shows proposed change" tag. A section that has never
  been built is all Changes.
- **Decisions** appear in the section they are about (a **Decisions** box under its frames, matched by `about`) and
  in the full list at the end. Each has a tag: `by build`, `removed` or `rejected`.
- **Requirements** read like a book: a red position bullet (`2.1.3`, changes as the book changes) and, after the
  sentence, a small gray **stable id** (`ORG-2EV2`, never changes). Each requirement is an anchor (`#ORG-2EV2`).
- **Evidence** under each requirement, once `evidence.json` exists: **▶ e2e 1:02–1:09** plays that slice of the
  chapter's recording (✗ when it failed, "e2e not run" when an earlier block failed, "no video" when it ran
  unrecorded); a 📷 thumbnail of the pass screenshot, or the failure screenshot with the error, opens large; and
  **Unit 3 ✓** lists the unit tests naming the id. A section shows how many of its requirements are proven.
- **Notes** work like Figma's comments, as an overlay that never moves the book. **Comment** in the bar (or
  **C**, except while typing) turns comment mode on: the cursor becomes a speech bubble, whatever a note would
  attach to gets a dashed yellow outline, and a click on the book, inside a mockup if need be, drops a numbered
  pin at that exact spot (stored relative to whatever was clicked, so it follows layout changes) and a sticky
  beside it, ready to type in: the sticky is the note's only form. It is saved as it is typed, and others in a shared
  book see it as it is written. Enter or Esc finishes, Shift+Enter makes a new line; finishing with nothing typed
  removes the pin.
  The click never follows links, plays videos or ticks boxes, and the mode stays on so several notes can be dropped
  in a row; a click on the book while a sticky is being written only finishes it, and Esc leaves the mode. A note
  stays up as its **sticky**: a
  rounded yellow callout holding only the note's text, sized to it (up to a width, then it wraps), joined by a
  line to its pin, which turns to make the arrowhead (its head on the line, its point on the spot, its number
  upright). A click selects a sticky (a blue ring); a click on the selected one edits it (Enter or Esc finishes; emptying it deletes the note). **Delete** or Backspace removes the selected note, and Esc or a click elsewhere lets it go; on a touch screen a **long press** deletes a note; a press on a sticky
  being edited ends the edit and moves it instead, so a second click never re-enters editing. Drag a sticky to
  move it; it is stored as an offset from its pin, so it travels with the pin when the layout moves, and is kept
  inside the page's width. A new sticky goes to the right of its pin (left if there is no room), below any sticky
  it would cover. A click on a pin does nothing; stickies always show. The line starts under the sticky and runs
  into the pin's head, with no border between them. Pins are numbered in book order. Drag a pin to re-aim it, and whatever it lands on (requirement, screen, section title,
  call, decision) becomes the note's subject; the sticky stays where it is and only the arrow re-aims. A note on a
  mockup also records the mockup element under its point (file, selector, text, clipped html), re-read when the
  pin is moved, and sends it to Claude as the item's `element`. Dropping a note never scrolls the page.
  **On a narrow screen** (860 px or less, where the contents sidebar hides), the same notes show as cards in a list
  under the item they are on, in book order, each joined by a 1 px line to a 3 px dot on its spot. A tap selects a card and a tap on the selected card edits it; a long press deletes it; nothing is dragged, and a narrow screen never saves where a sticky sits, so
  it ignores and never changes a desktop's placement. Resizing the window switches between the two.
  Pins print with their numbers, followed by a printed list of the notes (the bar, sidebar, stickies and panel do
  not print). Notes, with where their stickies sit, are saved with the book (in `review.json`), not
  in the browser: another browser or a restart still shows them. Only a **draft** note is editable and movable; once
  Revise sends it, it is read-only and moves into its item's review stack (below). Notes an older reader kept in local storage are
  imported once and then dropped from the browser.
- **Notes (N)** opens a panel over the right of the page listing every note in book order: its pin number, where
  it is, a line of what it is attached to, and its text, editable in place, with Delete. Clicking an entry
  glides to its pin over about a second (instantly with reduced motion; a wheel, touch or key stops it), then
  flashes the pin and puts the cursor in its sticky. At the bottom, **What Claude will receive** shows the exact request as
  readable items (where, about, element, note), with **Show JSON** for the literal body, built from the same function that
  sends it.
## The Claude group

The **✦ Claude** menu in the header, with **Revise** and **Build**. Its badge counts the draft notes; a guest has no Claude menu.

| Button | Enabled when |
| --- | --- |
| **Revise** | There is at least one draft note and Claude is idle |
| **Build** | At least one section is Ready and Claude is idle |

Neither sends at once. **Revise** opens a screen with every draft note that will go to Claude, grouped by section (the
section's number and title, with **Go to ›** to that note in the book): under each, the requirement it is on (its id
and text, tagged `changed` or `new` when not accepted yet), then the note, and who wrote it when it was not you. The
screen follows the notes while it is open (another tab or a collaborator saving one). **✦ Send to Claude** posts every
draft note, in pin order, as a revise request (the notes become `sent`); **Cancel**, the backdrop or Esc goes back to
the book. **Build** opens the same screen listing the sections marked Ready, and **✦ Build** posts a build request
naming them. Only accepted work is built: if a Ready section was edited since (by Claude or in the page) and has
an open review, the server refuses with 409 `unreviewed` and its `sections`, and the page says "Only accepted changes are
built. Accept every change in “<section>” first, or move it back to Drafting." On a desktop the screen is a dialog over the book; on a phone it is a sheet from the bottom, its buttons
in reach of the thumb. If the server is unreachable, Revise copies the request to the clipboard instead. The session's watch
picks the request up. While Claude is busy, the action it is doing is the menu's running row (`Revising`, or
`Building · task 3 of 9`): what was sent and when, with **Stop** beside it; the other action says "Waiting for Claude to
finish." **Stop** asks once, inside the menu (**Keep going** or **Stop revising** / **Stop the build**), then withdraws
the request (`POST /api/claude/stop`). A stopped Revise puts its notes back to drafts (without any reply or link Claude
had written for them). Revise edits a working copy and lands each section whole, only while its request is pending, so
the sections that landed stay in the book for review and the rest never reach it. A stopped Build that had started
sends its sections back to Drafting and keeps the evidence; one that had not started leaves them Ready (the row says
"requested at" until it starts). A toast says what happened, and the book unlocks at once. Claude stops at its next
write: the plugin's hook (`server/stop-hook.mjs`) refuses its edits to the book and any `git commit` once Stop was
pressed (for an hour, or until the skill acknowledges with `next-request.mjs --check <file>`), and the skills check
before each section or task.

What the user can change depends on what Claude is doing. The server enforces it with 409 answers.

| Claude is… | Notes | The rest of the book |
| --- | --- | --- |
| Idle | Add, edit, delete drafts | Accept, Change, add or edit requirements, mark sections Ready or Drafting |
| Revising | Locked (Comment is disabled) | Locked, including Accept, Change and editing; Claude is editing it with the user |
| Building | Add, edit, delete drafts (they touch `review.json` only) | Locked; only the build writes `book.json` |

When Claude goes back to idle the reader fetches the book again, since Claude has changed it. It saves any note
edit still waiting first, keeps notes changed on the page and not yet saved, and while a note is being written (a
sticky or a Notes panel box has the cursor) it draws the book again only once the writing ends. A revise
sets the notes it was sent to `answered`; drafts added during a build wait for the next Revise.

## Following a build

- **Banner** under the bar while a build runs: `Building · started 2:14 pm · task 3 of 9`, `Now:` the current
  task's section and requirement, `Proven 4/12 requirements · Calls so far: 1`. The page polls every few seconds
  while Claude is busy (every 5 seconds while idle). Each poll also says when `book.json` or a mockup last changed
  on disk, and the page draws the book again when that moves, so edits made in the terminal appear without a reload.
- Each requirement in a Building section shows `○ queued`, `◐ in progress`, `✓ proven` or `✗ failed`, with its unit
  and e2e results as they arrive.
- **Stale build.** If the heartbeat is more than 10 minutes old, the banner adds **Build may have stopped** with a
  **Mark as stopped** button. Marking it fails the build, returns its Building sections to Drafting with their
  changes intact, keeps what was proven, and files the build request, so the book unlocks. A build request that no
  build has picked up (or written to) for 10 minutes shows the same line; **Mark as stopped** then files the
  request (`POST /api/builds/pending/cancel`).
- **Review calls (n).** When the build ends the banner becomes this button, which opens the review panel: each call
  with its title and body, a box for what the user wants instead, **Accept** and **Reject**. Reject needs that note.
  Accept records a decision. Reject reopens the requirement (its `change` returns, `today` is what was built), puts
  its section back in Drafting, leaves the user's note as a note on it, and records a `rejected` decision. Buttons
  are disabled while Claude is busy, and the server refuses a review then (409 `locked`). The banner stays until every
  call is decided.

## Review: every change waits for you

However an item changes (you edit it in the page, Claude edits it from a prompt, or Claude edits it from a note) it
stays **under review** until you accept it. The reviewable items are requirements, frames (screens), section
headings and chapter headings; `book-format.md` has the keys and `review.json`. Section stage, `label`, a frame's
`state` and decisions are not reviewed, and the review is about wording: whether the app does it yet is the
requirement's `change` marker and the stages.

The toolbar's filter, **Only what needs you** (F), turns Changes mode on and off (remembered in this browser). In
Changes mode the page shows only what still needs you: every line not accepted yet (changed or new) and every line
with a note. Chapters and sections with none are hidden, the rest of a shown section is dimmed, and the contents list
shows each section's count. Previous (K) and next (J) scroll to the item under review before or after the top of the screen
and flash it, in either mode; "n / N" says which one is at the top, of how many (they count what
needs you). The full list of notes is the screen before Revise. A **Show sent notes** checkbox in View (Changes mode
only, remembered) draws the pins of sent and answered notes again, read-only.

- **Review stack**, drawn under each item under review, oldest first: the **accepted** version (or **New**, or for a
  removal the accepted version struck through), each **try** with the notes that led to it (older tries sit behind
  `▸ n earlier`), then the **current** version (**Now**, or **Now · unchanged** when only a note opened the review)
  with its open notes. A note shows its status (Draft, Sent, Answered) and Claude's `reply` when it made no change;
  a note that causes this item (written by `review.mjs link`) says "from a note on section …". Wording
  differences are struck through (old) and highlighted (new). A frame shows "Mockup changed" rather than a diff.
- **⚠ This brings back the wording replaced on <date>.** appears when the current value equals what an earlier accepted
  review replaced, with the decisions recorded then.
- **✓ Accept** in the requirement's own bullet (for a frame, section or chapter, at the top
  of its stack). The stack under the item lists what came before the current version, newest first: the tries, then
  **Original**, the version last accepted ("This requirement is new." when nothing was). Accept ends the review: the current
  version becomes the accepted one, and the review (its tries and notes) collapses into one history entry. Accept
  is also how a review whose note led to no change is closed. There is no Change button: to ask for something else, drop a note on the item
  in Comment mode, and Revise sends it to Claude. When it is sent, the version it was about is kept as a try with the
  note, so the stack shows what you asked of and what Claude made of it. Accept is disabled while Claude is busy. There is no accept-everything button.
  A draft note shows as its sticky only; the stack lists a note once it is sent.
  While the item has a note you have not sent, Accept does not show (and nothing takes its place): the note is your answer to that version, so
  edit or delete it, or send it with Revise. An item under review keeps its left bar (green when new) in every mode;
  Changes adds the review stacks.
- **History (n) ▸** sits beside every item that has history, in any mode. It expands to the accepted reviews,
  newest first: the date, the first note (or "Edited", or "Built") as one line, the decisions that settled it (linked
  to the Decisions chapter), and `▸ details` for before, tries, after and notes, all read-only.
- **Adding in the page** works in any mode while Claude is idle, and opens a review like any other change.
  **＋ Add requirement** under each section's lists opens an editor (the marker starts as `add`): the text, a marker
  (none, add, change with **Today**, remove with **Why**) and an optional one-line note, saved as an `answered` note on
  the item. Escape closes it; an open editor survives redraws. To change or remove an existing requirement, drop a
  note on it for the next Revise.
- **Changelog** is the last chapter, after Decisions, when a build has finished: newest first, each with its date, the
  summary in plain words and the requirements that landed (added, changed, removed), linked to their ids while they
  are in the book.

## Sharing a book

A book is not shared until you share it. **Share** in the bar opens a box for a 6-digit pin of your choice; **Start**
shares the book with that pin, so others (or you, from a phone) can read it and leave notes from anywhere, and the same
menu turns at once into the shared one (You shows "connecting" until the share is live), with the link. The book server is the share's host (`server/lib/host.mjs`): it sends the book straight to
each reader over WebRTC, encrypted end to end, and no tab needs to stay open. A share server, `https://specbook.jasonrowland.com` unless the
book names its own in `settings.shareBroker`, passes the handshake and serves the reader's interface.

- **One link.** Everyone, you included, opens the same `https://specbook.jasonrowland.com/s/<room>`. The address bar
  is always a link that can be sent as it is (a `#section` after it still works). **Share** in the bar shows it with
  **Copy**; `/specbook:start` opens the book for you on `localhost`, and prints the link when the book is shared.
- **The interface comes from the website, the book from your machine.** The page loads the reader published for your
  plugin's version under `/r/<version>/` on the share server; your book server sends only data: the book's JSON, its
  notes, and the bytes of its images and recordings. Nothing it sends runs as code there: the book's HTML (text and
  mockups) loses `<script>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, every `on…` attribute and `javascript:`
  URLs before it is drawn, and a strict Content-Security-Policy lets only the site's own scripts run. **SVG files in
  the book's media show only on localhost, not on the link** (a security choice: an SVG is a document that can hold
  script). A reader left open while you update the plugin says "This book was updated. Reload this page."; a share
  server that does not have your version yet says "This book needs a newer share server. Ask its owner to deploy it."
- **The pin gives your powers on the link.** Without it a reader is a guest. The pin is the 6 digits you chose at
  **Start**. A guest's **Share** has a box for it (**Use pin**); your pin link is the link with `#pin=<pin>` after
  it, and does the same without typing (`/specbook:start` prints it when the book is shared). **Never send either to
  anyone.** Opened, the page saves the pin in that browser
  (`localStorage`, which never leaves it) and takes it out of the address at once, so the address bar is again the
  plain link; from then on that browser opens the plain link with your powers, and no name is asked. A reader with the
  pin is you: their notes are yours and their face carries your name. A browser whose saved pin is no longer the
  share's (you started it again with another pin) says "This pin no longer works." and goes on as a guest. `localhost`
  needs no pin. **Guessing is slow:** after two wrong pins in a row, every pin, the right one too, waits
  2 seconds, then 4, doubling up to an hour, so trying a million pins takes years; a page that has the right pin
  during a wait says "Too many wrong pins were tried. Your pin works again in …" and opens again by itself. A new
  **Start** ends the wait. Only someone with the link can try a pin at all. A pin you choose is easier to guess than a
  random one: avoid `123456` and the like.
- A guest names themself once; the page remembers the name, and an id for the device, in that browser. The name shows
  on their face in the share pill; notes carry no names.
- **Everyone edits every note.** A guest can write, edit, move and delete any draft note, yours included, as you can
  theirs; a note sent to Claude stays read-only for everyone. A pin points at the same letters for every reader, on any
  screen size.
- **One face per person and device.** A guest who opens the link again in another tab of the same browser is the same
  person: both tabs stay live, as one face. Another device is another face.
- **Live.** Everyone in the book appears as a colored face in the share pill, with a pen while they type. A note being
  typed or moved shows on everyone's screen as it happens, on the note's own sticky with its arrow, and a saved change
  reaches every screen at once.
- **Following.** Click a face to follow that person: your window goes where theirs does (the same item, on any screen
  size) and takes their view (the filter, Mockups or Screenshots, Recordings, Coverage). A chip says
  "Following Ana · scroll or type to stop". Scrolling, clicking into the book, typing, or clicking the face again
  stops it, and your own view comes back. Your face shows how many follow you, and a colored edge runs round your
  window while anyone does.
- While shared, the pill's **Share** on `localhost` holds the link (as text, with **Copy** under it), who is here and what each is doing, and **Stop sharing**. On the website a reader
  with the pin gets the same. A guest gets the link and **Use pin**.
- Every `localhost` tab of a book has the whole **Share** menu and its own stream from the book server, so each sees
  who comes and goes at once; the menu lists each of your open tabs ("this tab", "another tab"). Each speaks for you while it is in front (a hidden tab keeps quiet), and closing one
  tab does not take your face away while another is open. (A browser allows six connections to one server over plain
  http, and each tab's stream holds one: a few tabs are fine.)
- A guest may add, edit, move and delete **their own** notes, and nothing else: no Revise, Build, Accept, stages or
  requirement edits. To ask for new wording, they drop a note saying what it should say; you act on it. The host and
  the book server both refuse everything else (403 `guest`).
- You may still edit or delete any note. A Revise carries a collaborator's notes with `by: <name>`.
- **A restart does not share the book again.** The book server keeps the room, its host token and your pin in
  `.share.json` in the data folder (git-ignored, never served), and renews the room at the share server while it is
  shared. After a restart the book is not shared until you press **Share** and **Start** again; a Start then takes up
  the same room, so the old link works again (with the pin you give this time). Your book tab may close: readers stay
  connected. While the book is not shared, readers see "The book isn't open right now" and reconnect by themselves,
  with the same rights, when it is shared again within an hour (after that, a reload). **Stop sharing** ends the
  link: an ended link says so ("This share has ended") and is never opened again, and the next Start makes a new
  one. Use it to cut off anyone who should no longer have the link or the pin.
- The share library (`node-datachannel`) is installed by `serve.mjs --detach`, once per plugin version, into
  `~/.claude/specbook/deps/<version>/`. When that fails (offline, or a platform it has no build for), the book is
  still served on `localhost`, only not shared, and the next `--detach` tries again.
- Live messages (presence, typing, following) go only between the readers, your localhost tab and the book server,
  which passes each reader's on to the others and drops a draft (or a typing signal) for a note that is not the
  sender's, and any frame over 16 KB or past 40 a second. The share server never sees them.
- A save that does not get through (the connection dropped, or the server did not answer) is sent again a few seconds
  later; the note stays on the page meanwhile. A note the server will not take (another's, or one already sent to
  Claude) keeps its text as a new note.

## The API

The writes that change the book or the review (Accept, Change, `/api/requirements`, `/api/stage`, a build-call review,
and notes while Claude revises) are refused with 409 `locked` while Claude is busy; `/api/revise` and `/api/build` answer
409 `busy` instead. Notes stay writable during a build, and stopping or canceling a build is allowed while it runs. A
POST or PUT that is not JSON gets 415. A call carrying `x-specbook-guest` (a shared book's guest, sent by the share's host)
may only read and `PUT /api/notes`; anything else is 403 `guest`.

| Endpoint | Does |
| --- | --- |
| `GET /api/book` | `{ book, media, evidence, review, changelog, historyCounts, claude, viewer }`; reading stamps `opened`/`where` for new reviews (not while Claude is busy, and never over a write made since it read) |
| `PUT /api/notes { changes }` | Saves only the notes a page changed: `{ id: note }` or `{ id: null }` to delete, applied on the notes stored now, so concurrent saves of different notes all land; anyone in the book may change or delete any draft (a note keeps who started it); a changed note gets `lastBy` (who made the change) and `lastByKey` (never sent to guests, who get `lastMine`); the reply lists `skipped` ids (notes past draft); 400 `bad-note`, 409 `locked` |
| `PUT /api/notes { rev, notes }` | The whole-map save older pages use: the page's **draft** notes replace the stored drafts; stored non-draft notes win; from a guest, only that guest's own drafts change; 400 `bad-note`, 409 `stale` or `locked` |
| `POST /api/accept { key }` | Writes the history entry, sets the accepted copy to the server's current value, clears the key's tries and notes; 404 `not-under-review`, 400 `bad-accept` |
| `POST /api/change { key, note }` | Freezes a try and adds the draft note; 400 `note-required` or `bad-change`, 404 `not-under-review` |
| `GET /api/history/<key>` | `{ entries }` for one item |
| `POST /api/requirements { section, text, change?, today?, reason?, note? }` | Adds a requirement (id minted by the server); 400 `bad-requirement` or `bad-change` (`change` must be add, change or remove), 404 `not-found` |
| `PUT /api/requirements/<id>` | Same body; edits the requirement. A POST, PUT or DELETE in a Ready or Built section sends it back to Drafting (the answer has `demoted: true`) |
| `DELETE /api/requirements/<id>` | Deletes one never accepted; 409 `accepted` otherwise (mark it removed instead) |
| `POST /api/revise` | Sends the draft notes: sets them `sent`, writes the request |
| `POST /api/stage { section, stage }` | Ready: 409 `unreviewed` while the section has an open review |
| `GET /api/share/events?tab=<id>` | The owner tab that holds the book's lock listens here (opening it never starts the share): `state` (as `GET /api/share`), `live` (the readers' live messages, and a `roster` of who is reading) and `changed` |
| `GET /api/share` | `{ state, url, pinUrl, expiresAt, guests, error }`; `state` is `off`, `starting`, `live` or `failed`; `pinUrl` only while live |
| `POST /api/share { pin }` | Starts the share with the owner's 6-digit pin (202); 400 `bad-pin`; 409 `no-broker` (an invalid `settings.shareBroker`) |
| `POST /api/live { msg }` | A live message from the owner's tab, passed to every reader as the host's |
| `POST /api/share/stop` | Ends the room; the book is not shared until the next Start, which opens a new link |

The server, not the page, computes current values for Accept and Change, so the page cannot write a stale or forged
value.
