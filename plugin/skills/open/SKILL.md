---
name: open
description: Use when the user types /specbook:open, or asks to open, see, view or show the spec book, share it, or get a link to it for someone else or a phone (a served book is shared: this prints its link and the owner's pin link). Opens the project's spec book in the browser, starting its server first if it is not running, and offers to create a book when the project has none.
---

# Open the spec book

**Announce at start:** "Using specbook:open to open the spec book."

`<dir>` is the book's data folder: `docs/specbook/` unless the project's documentation rules (its `CLAUDE.md`, or a
docs README it points to) put it elsewhere. `${CLAUDE_PLUGIN_ROOT}` is this plugin's root.

1. **No book yet.** If `<dir>/book.json` does not exist, ask the user (AskUserQuestion) whether to create a spec book
   for this project, naming the folder it would go in. If yes, follow `init` in the `specbook` skill
   (**REQUIRED SUB-SKILL:** `specbook:specbook`), which ends by serving and opening it; stop here. If no, say how
   to start one later (`/specbook:open` again, or `/specbook init`) and stop.
2. **Keep the book current.** If any section has a `status` (the old format), run
   `node ${CLAUDE_PLUGIN_ROOT}/server/migrate-book.mjs --data <dir>` and tell the user. Run
   `node ${CLAUDE_PLUGIN_ROOT}/server/install-tools.mjs --data <dir>` and pass on any line it prints.
3. **Serve and open.**
   `node ${CLAUDE_PLUGIN_ROOT}/server/serve.mjs --data <dir> --detach --open`. Pass no `--port`: the server
   reuses this folder's running server (and only opens the browser), or its last port, or the first free port in
   4180-4199, so books in different projects never collide. It opens Chrome, or the default browser when Chrome is
   not installed. When the book is shared it opens the book on its link with the pin, which the page saves and takes
   out of the address; otherwise it opens `localhost`.
4. **The watch.** If this session has not already started it, start it with `run_in_background`:
   `node ${CLAUDE_PLUGIN_ROOT}/server/next-request.mjs --data <dir> --wait`, and handle what it prints as in
   `serve` in the `specbook` skill (a `revise` goes to `specbook:revise`, a `build` to `specbook:build`).
5. **Tell the user** the share link it opened (or the `localhost` URL, when the book is not shared), in one line, and that **Changes (n)** in the bar shows every change
   still under review. Each has **✓ Accept** to keep it; to say "not yet", drop a note on it for the next Revise;
   **History (n) ▸** on an item shows what was accepted before.
   The book is shared while its server runs. Pass on, exactly as printed, the two link lines `serve.mjs` prints:
   `Share link: <url>`, the link to give others so they can read the book and leave notes, and
   `Your pin link (opens with your powers; never send it to anyone): <pinUrl>`, the owner's own link for another
   device of theirs. The user sees only your message, never the command's output, so write both links out in it. Say
   plainly, with the pin link, that it must never be sent to anyone: whoever opens it gets the
   owner's powers (Revise, Build, Accept), until **New pin** in the bar's ▾ replaces it. If it printed
   `Sharing is starting; …` or `Sharing could not start: …` (or that the share library could not be installed) instead,
   pass that line on; **Copy link** and **Copy pin link** in the bar give the links once the share is live.
