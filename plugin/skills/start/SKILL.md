---
name: start
description: Use when the user types /specbook:start (or the old /specbook:open), or asks to start, open, see, view or show the spec book, share it, or get a link to it for someone else or a phone (the book is shared from Share in its bar, with a pin the owner chooses). Opens the project's spec book in the browser, starting its server first if it is not running, and offers to create a book when the project has none.
---

# Start the spec book

**Announce at start:** "Using specbook:start to start the spec book."

`<dir>` is the book's data folder: `docs/specbook/` unless the project's documentation rules (its `CLAUDE.md`, or a
docs README it points to) put it elsewhere. `${CLAUDE_PLUGIN_ROOT}` is this plugin's root.

1. **No book yet.** If `<dir>/book.json` does not exist, ask the user (AskUserQuestion) whether to create a spec book
   for this project, naming the folder it would go in. If yes, follow `init` in the `specbook` skill
   (**REQUIRED SUB-SKILL:** `specbook:specbook`), which ends by serving and opening it; stop here. If no, say how
   to start one later (`/specbook:start` again, or `/specbook init`) and stop.
2. **Keep the book current.** If any section has a `status` (the old format), run
   `node ${CLAUDE_PLUGIN_ROOT}/server/migrate-book.mjs --data <dir>` and tell the user. Run
   `node ${CLAUDE_PLUGIN_ROOT}/server/install-tools.mjs --data <dir>` and pass on any line it prints.
3. **Serve and open.**
   `node ${CLAUDE_PLUGIN_ROOT}/server/serve.mjs --data <dir> --detach --open`. Pass no `--port`: the server
   reuses this folder's running server (and only opens the browser), or its last port, or the first free port in
   4180-4199, so books in different projects never collide. It opens Chrome, or the default browser when Chrome is
   not installed. It always opens the book on `localhost`, shared or not.
4. **The watch.** If this session has not already started it, start it with `run_in_background`:
   `node ${CLAUDE_PLUGIN_ROOT}/server/next-request.mjs --data <dir> --wait`, and handle what it prints as in
   `serve` in the `specbook` skill (a `revise` goes to `specbook:revise`, a `build` to `specbook:build`).
5. **Tell the user** the `localhost` URL it opened, in one line, and that **Changes (n)** in the bar shows every change
   still under review. Each has **✓ Accept** to keep it; to say "not yet", drop a note on it for the next Revise;
   **History (n) ▸** on an item shows what was accepted before.
   **Sharing.** The book is not shared until the user presses **Share** in the bar, types a 6-digit pin of their own
   and presses **Start**; the menu then shows the link to give others, and **Stop sharing** ends it. Say so in one
   line. The pin gives the owner's powers (Revise, Build, Accept) on the link, typed into **Use pin** under
   **Share ▾** on another device: it must never be sent to anyone. If the book was already served and shared,
   `serve.mjs` printed `Share link: <url>` and `Your pin link (opens with your powers; never send it to anyone):
   <pinUrl>`: the user sees only your message, never the command's output, so pass both on exactly, with that
   warning. If it said the share library could not be installed, pass that line on.
