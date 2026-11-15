# Stop in the Claude menu: design (short)

Approved in conversation on 2026-11-15, from the mockup `docs/mockups/2026-11-15-claude-stop.html`.

**Why.** A Revise or Build sent by mistake (it happened: one stray click sent four notes) had no undo from the reader.
The only way back was editing `requests/` and `review.json` by hand.

**What.** While Claude is revising or building, the Claude menu shows that action as the running row: what was sent and
when, with **Stop** beside it. The other action is greyed out ("Waiting for Claude to finish."). Stop asks once, inside
the menu (**Keep going** / **Stop revising** or **Stop the build**). Then:

- **Revise:** the request is withdrawn (status `stopped`, moved to `requests/done/`). Its notes go back to `draft`, and
  the tries that sending them recorded are dropped, so the book looks as it did before Send. Anything Claude already
  changed stays in the book and is reviewed like any other change (the user's choice over undoing it).
- **Build:** a running build is stopped as the build skill's own stop does it (Building sections go back to Drafting;
  evidence already written is kept). A build request with no build started is withdrawn. Both file the request as
  `stopped`.
- The menu closes, a toast says what happened, and the book unlocks at once.
- **Claude's side:** the revise and build skills check, before each section they edit or each build task, whether
  their request was withdrawn (`next-request.mjs --check <file>` prints `pending` or `stopped`). If stopped, they stop
  there and say so in the terminal. `--done` on a stopped request says it was stopped and changes nothing.

**Goals:** undo a mistaken send in two clicks; never lose a note; never leave the book locked.
**Non-goals:** undoing edits Claude already made; stopping from a guest's page (guests have no Claude menu, and the
server refuses them).
**Anti-goals:** a Stop that loses notes, or one that leaves Claude editing a book the reader thinks is idle without the
skill ever finding out.

**Approaches considered.**
1. *Withdraw the request on the server; the skills check for it* (chosen). Works for both kinds, with the existing build
   stop, and needs no channel to the Claude session.
2. *Stop and also undo Claude's edits* (copy the book at Send and restore it). Cleaner after the fact, but heavier and it
   can throw away work the user wanted; the user chose to keep edits for review.
3. *Only a server-side withdraw, no skill change.* Cheapest, but a session already working would keep editing an
   unlocked book.

**Builder's calls.** Endpoint `POST /api/claude/stop` (owner only), answering `{ stopped: 'revise' | 'build', count }`,
409 `idle` when nothing is running. `claudeState` gains `sent: { kind, at, count }` for the running row's text. Phone
targets 44 points; Esc closes the question like the menu.
