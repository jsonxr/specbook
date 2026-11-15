---
name: build
description: Use when the reader pressed Build, when the background watch exits with a request whose kind is "build", when asked to build or prove what a spec book proposes (a chapter or the whole book), link unit or e2e tests to its requirement ids, set up the e2e simulator that proves them, collect test evidence for the book, or add screenshots and recordings (media) to it.
---

# Building and proving a spec book

Build what the book proposes, prove each requirement with tests, and put the proof back in the book. `<dir>` is
the book's data folder (`docs/specbook/` unless the project puts it elsewhere; see `specbook`). The formats named
below (`evidence.json`, the e2e result file, stable ids) are in `${CLAUDE_PLUGIN_ROOT}/reference/book-format.md`.

**Announce at start:** "Using specbook:build to <build | evidence | media>."

## build (from the reader)

Pressing **Build** writes a request, `kind: "build"`, naming the Ready sections (`sections`). It is the user's
approval: there is no plan approval, and **pressing Build counts as asking to commit to a `build/<id>` branch**.
The reader locks the book (draft notes stay writable, in `review.json` only), so `build.mjs` and you are the only writers
of `book.json`. Every `build.mjs` command is `node ${CLAUDE_PLUGIN_ROOT}/server/build.mjs --data <dir> <command>`
and prints one JSON line; an error goes to stderr with exit code 1.

1. **Start.** `build.mjs start` moves every Ready section to Building and prints the build's `id`, its `progress`
   and the `scope`: every requirement with a `change` (`add`, `change`, `remove`), with its section, text, `today`
   and `reason`. It fails with `busy` if a build is running and `nothing-ready` if no section is Ready.
2. **Branch.** `git switch -c build/<id>`, then commit the book (with any earlier uncommitted revise edits) as
   approved.
3. **Plan and build, scoped to the scope.** **REQUIRED SUB-SKILL:** superpowers:writing-plans, then
   superpowers:subagent-driven-development (steps below). No stop for plan approval.
   - Before each task, check the request was not stopped: `next-request.mjs --data <dir> --check <file>` prints
     `pending` or `stopped`. On `stopped` (the user pressed **Stop** in the reader's Claude menu), the reader has
     already stopped the build and filed the request: stop at once, without `build.mjs stop` or `finish`, commit what
     you have to the branch, tell the user what was done, and re-arm the watch.
   - Before each task: `build.mjs task --build <id> --index <n> --of <m> --title "<title>" [--section <chapter-id>-<section-id>] [--req <ID>]`.
   - As a requirement's state moves: `build.mjs req --build <id> --id <ID> --status queued|in_progress|proven|failed`.
   - At least every 5 minutes during a long step: `build.mjs beat --build <id>`. The reader calls a build stale
     after 10 minutes without a heartbeat or any other write.
4. **Judgment calls.** Where a Ready section does not settle something, make the best call, keep going and record
   it: `build.mjs call --build <id> --about <ID>[,<ID>] --section <chapter-id>-<section-id> --title "<t>" --body "<b>" --before "<the requirement as approved>" --after "<what was built>"`.
   Check the book's `decisions` first and never repeat a call the user rejected.
5. **Commit** the app code and tests to the branch as you go.
6. **Finish.** Run the unit tests and the e2e blocks, then the evidence script (**evidence**, below), then
   `build.mjs finish --build <id> --summary "<plain words for someone who uses the app: how the app changed>"`. Always pass `--summary`: it becomes the changelog entry, with the landed requirements (without it the entry is empty and `finish` warns). Write what a person can now do or will notice, not file names. It applies each proven change (drops `change` and `today`, in the book and in the item's accepted copy, so a build never opens a review by itself; wording a call changed does) and turns a
   section into `built` when all its changes are proven; a section with removals also needs every requirement that
   stays proven, and only then is each removal applied and a `removed` decision written. Any other section goes back
   to `drafting` with its unproven changes and removals intact (`summary.md` lists the unproven ids). It writes
   `builds/<id>/summary.md`. Add the commits to
   `summary.md`, then commit the book and `builds/<id>/` to the branch.
   - A build that cannot continue: `build.mjs stop --build <id> --reason "<why>"` returns the Building sections to
     Drafting and keeps what was proven.
7. **File the request** (`next-request.mjs --data <dir> --done <file>`; if the user pressed **Mark as stopped**,
   the reader has filed it already and this says so), **re-arm the watch**
   (`next-request.mjs --data <dir> --wait`, `run_in_background`) and report in the terminal. The reader then shows
   **Review calls (n)**; the user accepts or rejects each call there.

Any test that names a removed id is deleted or renamed in the same build. Never claim Built for a requirement with
no passing test.

## media

- Screenshot for a frame: `media/screens/<frame-id>.png` (or `.jpg`, `.webp`), or `"screenshot"` on the frame.
  It replaces the mockup in **Screenshots** and sits beside it in **Both**; frames without one keep the mockup
  with a "No screenshot yet" line.
- Recording for a section: `media/videos/<chapter-id>-<section-id>[-anything].mp4` (or `.mov`, `.webm`), or the
  section's `"videos": [{ "path", "caption" }]`.
- `node ${CLAUDE_PLUGIN_ROOT}/server/add-media.mjs --data <dir> --screen <frame-id> <file>` /
  `--video <chapter-id>-<section-id> <file>` copy files in. From an e2e run, map each test's recording and labeled
  screenshots to the sections and frames they show.

## evidence

Requirements are linked to tests by their stable id.

**Unit test titles** start with the id in brackets, several in a row allowed:
`it('[ONB-S5U2] landing shows Join Community and Start Community', …)`, `test('[ONB-S5U2][ONB-GH94] …', …)`. The id
`[PREFIX-XXXX]` must be at the very start of an `it(` or `test(` title (`it.skip` and the like count too). An id
elsewhere in the title is ignored.

**E2E tests**: one test file per chapter, one recording per file. Each proven requirement is one block, in book
order, asserting only that requirement:
`await requirement('<ID>', '<what it proves>', async () => { … }, { screenshot?: boolean })`. The run writes the
e2e result file (`book-format.md`) per chapter.

**Collect** with the project's own copy (installed by `install-tools.mjs`; see `specbook`):
`node <dir>/tools/collect-evidence.mjs --data <dir> --unit <glob>...
[--unit-results <jest.json|vitest.json>...] [--e2e-tests <glob>...] [--e2e <dir of e2e result json>]`.

- Globs are relative to the current directory.
- A test's result is matched by file path and title in a Jest `--json` or Vitest json-reporter file. With no result
  file (missing files are skipped, as is a missing `--e2e` directory) or no match, its status is `unknown`.
- `--e2e-tests` scans e2e test files for `requirement('<ID>'` calls, only so unknown ids there are reported.
- Every run rebuilds `evidence.json` from scratch from the current tests and results, so an id no longer named
  loses its evidence. Produce fresh result files first or statuses stay `unknown`.
- Wrap the whole command in one project script (Tribes, for example, runs
  `yarn specbook:evidence`) and note it in the project's own docs, with the scripts that write the result files.
- A project script never names the plugin's own path (`${CLAUDE_PLUGIN_ROOT}`, `~/.claude/plugins/…` or a
  checkout of the plugin): it runs `node docs/specbook/tools/collect-evidence.mjs …` from the project. If
  `tools/` is missing, run `node ${CLAUDE_PLUGIN_ROOT}/server/install-tools.mjs --data <dir>` first.

For each of `unknownIds`, fix the test or the book. Nothing counts as proven without a passing test naming it: a
failed block stays `failed`.

## build <chapter | all>

For a build the user asks for in the terminal rather than from the reader. The user asking is the authorization;
scope is what they named. The reader's flow is "build (from the reader)", above; steps 1 to 4 here are the same
work.

1. **Set up proof once per project.**
   - Give the tests their own simulator, named for the project ("<App> E2E"), so a run never drives one a person or
     another agent is developing on: clone a *shut-down* stock simulator with simslim
     (`simslim clone <udid> "<App> E2E"`), slim it with a committed profile
     (`simslim on <udid> --profile simslim.json`) that keeps every service the tests touch (`"except": ["photos"]`
     for a photo picker; `simslim doctor <udid> --requires …` checks), and wrap that in one idempotent script.
   - The driver finds the simulator by name and fails without it, never falling back to whichever one is booted;
     give Appium, WebDriverAgent and MJPEG their own ports too, since the defaults are shared.
   - Copy the `.ts` files of `${CLAUDE_PLUGIN_ROOT}/reference/e2e/` (not its `package.json` or `tsconfig.json`, which only
     typecheck the reference) into the project's e2e package: `Requirement.ts` beside its
     driver, `setupBook.ts` as a setup file wired to its screen recorder and screenshot call, chapter files in
     `tests/book/<chapter-id>.test.ts`. Unit tests for `Requirement.ts` come with it.
   - Add the evidence script (**evidence**, above).
   - The recorder is the platform's own (iOS simulator: `xcrun simctl io <udid> recordVideo`); `startedAt` is the
     wall time its first frame was taken, so take it once the recorder says it has started, not when the command
     was launched.
   - Check one chapter end to end: its `.mov` is in `media/e2e/`, a passing and a deliberately failing block both
     show in the reader with their screenshots.
2. **Plan.** **REQUIRED SUB-SKILL:** superpowers:writing-plans, from the book and the project's spec. List every
   requirement id in scope and how it will be proven: an e2e block in its chapter file, unit tests (`[ID]` titles),
   or both. When the user asked for e2e proof, every requirement gets a block except one nothing on a device can
   reach (time passing, another app build); that one is unit-only, the plan says why, and the report names it.
3. **Build.** **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development; a separate reviewer approves each
   task, and checks each e2e block against its requirement's sentence before it counts.
4. **Run** the unit tests with results, every chapter file, then the evidence script. Fix the app, never the
   assertion.
5. **Update the book.** Section `stage` and requirement `change`/`today` are updated by `build.mjs finish` (see
   "build (from the reader)"); in a terminal-asked build, edit them the same way: a proven requirement drops
   `change` and `today`, a section whose changes are all proven becomes `built` (with removals, only when every
   requirement that stays is proven too), and any other stays
   `drafting` with its findings (each id and why) in the plan's notes and the report.
   - A pass screenshot that shows a frame's screen can also replace that frame's mockup:
     `add-media.mjs --data <dir> --screen <frame-id> media/e2e/<ID>.png`.
   - Reword a requirement only to match a decision the user can see in `decisions`.

## A block proves its own sentence

It asserts the requirement's visible outcome, not merely that a screen opened; a block that would pass with the
feature missing is wrong. Blocks run in book order in one recording, so a block may rely on the state the previous
one left, and everything after a failure is `not_run`. A failure in the file's own setup (`beforeAll`) leaves every
block `not_run` with no screenshot, so keep setup to seeding and signing in, and put anything that can fail on
screen inside a block.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Marking a requirement built because a test names it | Built means a passing run in `evidence.json` |
| Test leans on unordered API results ("the first community") | Look the item up by name, or make the API order defined and assert it |
| Driver picks whichever simulator is booted | Its own named simulator, found by name (step 1) |
| A slimmed simulator's picker shows "Unable to Load Items" | Keep that service in the slim profile (`photos`) |
| Long chapter outlives the test account's session | Helpers re-sign-in on expiry |
| A test id holding a path (`photos/abc.jpg`) | Use a plain id; drivers read a path-like selector as a file |
| Scratch data piles up across runs | Stamp names with the run time and sweep them in the global setup |
