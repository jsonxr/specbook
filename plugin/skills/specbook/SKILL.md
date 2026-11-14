---
name: specbook
description: Use when the user wants a spec book, a scrollable, book-style requirements document for a whole app with every screen for every role as phone mockups (swappable for real e2e screenshots and recordings), where the reader drops numbered comment pins (notes) on exact spots, reviews and accepts every change, then presses Revise to send notes back or Build to build the sections marked Ready. Also for creating one in a project, serving it, stopping it, or explaining how its reader works.
---

# Spec book

A spec book is an app's requirements read like a book. It covers the **whole app, in the order a person meets
it**, every screen for every role side by side, with nothing hidden behind tabs. The reader comments by dropping
numbered pins on exact spots, as in Figma. **Revise** sends the notes back so Claude refines the spec; every change to the
book (by Claude or in the page) stays under review until the reader accepts it; **Build** builds the sections the
user marked Ready.

**Announce at start:** "Using specbook to <command>."

## The reader

A sticky bar (Screens: Mockups · Screenshots · Both; Recordings; Comment; Notes; **Claude**: Revise · Build), a
table of contents, then the book: chapters, numbered sections with their stage (Drafting, Ready, Building, Built),
requirements with their stable ids, pending changes and test evidence, every frame side by side, and the decisions
and the changelog at the end. **Changes (n)** shows what is under review, each with **✓ Accept** (a note on it asks for something else);
**History (n) ▸** shows an item's accepted reviews. When you need how any part looks
or behaves (to explain it, or to check a change to it), read `${CLAUDE_PLUGIN_ROOT}/reference/reader.md`.

## Where things live

The plugin holds the code; **the project holds the data**. Nothing about a project is stored in the plugin.

| Where | What |
| --- | --- |
| `${CLAUDE_PLUGIN_ROOT}/server/init.mjs` | Creates a spec book in a project |
| `${CLAUDE_PLUGIN_ROOT}/server/serve.mjs` | The server: reader from the plugin, data from the project, notes, reviews (`/api/accept`, `/api/change`, `/api/history/<key>`), requirement editing (`/api/requirements`), stages, `POST /api/revise` and `POST /api/build`; `--detach`, `--stop`. It answers only its own page: another `Origin` or `Host` gets 403 `forbidden`, a POST or PUT without `content-type: application/json` gets 415 `json-required`, and `/data/` refuses `requests/`, `builds/`, `revise/`, `notes.json`, `review.json`, `history.json` and dot files with 403 |
| `${CLAUDE_PLUGIN_ROOT}/server/next-request.mjs` | Prints the path of the oldest pending request (revise or build); `--wait` blocks until one arrives; `--done <file>` files it (a revise sets its notes `answered`) |
| `${CLAUDE_PLUGIN_ROOT}/server/migrate-book.mjs` | Moves an old-format `book.json` to stages, requirement changes and one decision list, turns an old `notes.json` and `revise/before.json` into `review.json` and `history.json`, and fixes the git-ignore lines; `--data <dir>` |
| `${CLAUDE_PLUGIN_ROOT}/server/share.mjs` | Shares the live book: asks the open book tab to host it through the share server (`settings.shareBroker`); `--status`, `--stop`, `--check`, `--set-broker`; guests read and keep their own notes only; used by `specbook:share` |
| `${CLAUDE_PLUGIN_ROOT}/server/review.mjs` | Claude's side of a review: `reply --note <id> --text "…"` and `link --note <id> --item <key>…`; used by `specbook:revise` |
| `${CLAUDE_PLUGIN_ROOT}/server/build.mjs` | A build's bookkeeping: `start`, `task`, `req`, `call`, `beat`, `finish` (with `--summary`), `stop`; used by `specbook:build` |
| `${CLAUDE_PLUGIN_ROOT}/server/assign-ids.mjs` | Gives every requirement, decision and call a stable id, once |
| `${CLAUDE_PLUGIN_ROOT}/server/collect-evidence.mjs` | Finds which tests name which requirement and whether they passed; writes `evidence/evidence.json`. Projects run their own copy in `tools/`, never this one |
| `${CLAUDE_PLUGIN_ROOT}/server/install-tools.mjs` | Copies the project-side tools (`collect-evidence.mjs`) into `<dir>/tools/`, or refreshes them after a plugin update; never overwrites a copy edited by hand; `--data <dir>` |
| `${CLAUDE_PLUGIN_ROOT}/server/add-media.mjs` | Copies a screenshot or recording in under the name the reader looks for |
| `${CLAUDE_PLUGIN_ROOT}/reference/e2e/` | What a project copies to prove requirements on a device: `Requirement.ts` (`requirement()` and the result file), `setupBook.ts` (record each chapter file, time its blocks), `chapter.example.test.ts` |
| `${CLAUDE_PLUGIN_ROOT}/reference/book-format.md` | `book.json`, stable ids, `review.json`, `history.json`, requests, `builds/`, the e2e result file, `evidence.json` |
| `${CLAUDE_PLUGIN_ROOT}/app/` | The reader (`index.html`, `book.js`, `book.css`) |
| `${CLAUDE_PLUGIN_ROOT}/starter/` | What `init` copies: an example `book.json` for a standard todo app, the mockup kit `mockups/phone.css`, its mockups |
| `<project>/docs/specbook/book.json` | The book |
| `<project>/docs/specbook/mockups/` | One HTML fragment per frame, `phone.css`, and `assets/` (logos, images) |
| `<project>/docs/specbook/media/screens/`, `media/videos/` | Screenshots and recordings from the app (git-ignored) |
| `<project>/docs/specbook/tools/` | The project's own copy of `collect-evidence.mjs`, committed, so tests and CI run it without the plugin. Stamped with the plugin version; `install-tools.mjs` keeps it current |
| `<project>/docs/specbook/evidence/evidence.json` | Test evidence per requirement, regenerated by `collect-evidence.mjs` |
| `<project>/docs/specbook/review.json` | The review state: accepted versions, the reader's notes, frozen tries (committed) |
| `<project>/docs/specbook/history.json` | Every accepted review per item, and the changelog of builds (committed) |
| `<project>/docs/specbook/requests/` | Requests the page sent (git-ignored); handled ones move to `requests/done/` |
| `<project>/docs/specbook/builds/<build-id>/` | One build's `progress.json`, `calls.json` and `summary.md` (committed with the build) |

The data folder (`<dir>` in every command) defaults to `docs/specbook/`. If the project's own documentation rules
put it elsewhere, follow them and pass that folder as `--data` everywhere (including to `init`).

## Commands

| Command | Does |
| --- | --- |
| `open` | Opens the book in the browser, starting the server if needed; offers to create a book when there is none: `specbook:open` |
| (none) or `serve` | Starts the server detached, opens Chrome, starts the watch |
| `stop` | Stops the server and the watch |
| `init` | Creates the book in the current project, then runs `design` for the whole app |
| `design <topic>` | Writes or revises chapters, requirements and mockups with the user: `specbook:design` |
| `build <chapter \| all>`, `evidence`, `media` | Builds what the book proposes and proves it; collects evidence; adds screenshots and recordings: `specbook:build` |
| `share`, `share stop` | Hands out a link to the live book for collaborators (or a phone), or ends it: `specbook:share` |
| `revise` | Works through the pending notes with the user (also what the watch triggers for a revise request): `specbook:revise` |

For `design`, `build`, `evidence`, `media` and `revise`, **REQUIRED SUB-SKILL:** the skill named in the table.

### serve

1. If the book is in the old format (any section has a `status`), run
   `node ${CLAUDE_PLUGIN_ROOT}/server/migrate-book.mjs --data <dir>` first and tell the user. Run
   `node ${CLAUDE_PLUGIN_ROOT}/server/install-tools.mjs --data <dir>` and pass on any line it prints (an installed
   or updated tool is a change for the user to commit). Then
   `node ${CLAUDE_PLUGIN_ROOT}/server/serve.mjs --data <dir> --detach --open` (without `--port` it reuses this folder's
   running server or last port, else the first free port in 4180-4199, so each project's book gets its own). Reused
   if already running for that folder: then it only opens the browser.
   Detached, so it never shows up as a shell in the session.
2. Start the watch with `run_in_background`:
   `node ${CLAUDE_PLUGIN_ROOT}/server/next-request.mjs --data <dir> --wait`. It exits, notifying the session,
   when the reader presses **Revise** or **Build**, and prints the request file. Read that file's `kind`: a
   `revise` goes to `specbook:revise`; a `build` goes to `specbook:build`, under "build (from the reader)". It is
   the only background command the session keeps; never leave any other running, and stop it when the user is done.
3. Tell the user the URL.

### stop

`node ${CLAUDE_PLUGIN_ROOT}/server/serve.mjs --data <dir> --stop`, then TaskStop the watch.

### init

1. `node ${CLAUDE_PLUGIN_ROOT}/server/init.mjs --project <repo root> [--data <dir>] [--title "<App>"]`. It
   copies the starter, creates the media folders, appends the git-ignore lines (`requests/`, `.server.json`,
   captured media and `*.tmp` files under the data folder; each line only if missing) and
   mints ids. It refuses to overwrite an existing book.
2. **REQUIRED SUB-SKILL:** `specbook:design` for the whole app, replacing the starter's example chapters and
   mockups.
3. `serve`.
