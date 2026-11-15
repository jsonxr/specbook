---
name: stop
description: Use when the user types /specbook:stop, or asks to stop, shut down, close or kill the spec book's server. Stops the project's book server and this session's watch on the book's requests.
---

# Stop the spec book

**Announce at start:** "Using specbook:stop to stop the spec book's server."

`<dir>` is the book's data folder: `docs/specbook/` unless the project's documentation rules (its `CLAUDE.md`, or a
docs README it points to) put it elsewhere. `${CLAUDE_PLUGIN_ROOT}` is this plugin's root.

1. **Stop the server.** `node ${CLAUDE_PLUGIN_ROOT}/server/serve.mjs --data <dir> --stop`. It stops the server
   recorded for this folder, or says none was running.
2. **Stop the watch.** If this session started `next-request.mjs --wait` in the background, stop it with TaskStop.
3. **Tell the user**, in one line, what it printed. If the book was shared, add that its link stops answering while
   the server is down, and that after `/specbook:start` it stays unshared until they press **Share** and **Start**
   again (the same link comes back).
