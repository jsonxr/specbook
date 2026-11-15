# Screens and Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-section `frames` with a book-wide `screens` catalog (screens and components, each drawn once per
state), a Screens view in the reader, and convert the starter and the Tribes book to it.

**Architecture:** The model lives in `book.json` (`screens` beside `chapters`). All screen logic is pure functions
added to `plugin/app/model.js` (shared by the reader and the server, ES5), so the server's review, gate and validity
code and the reader call the same functions. The reader draws section `shows` and the Screens view from those
functions; `<sb-component>` tags are expanded before a mockup is put in its shadow root.

**Tech Stack:** Node 20+ ESM (`node:test`), ES5 browser JavaScript (no build step), Playwright smoke test.

**Spec:** `docs/superpowers/specs/2026-11-15-screens-and-components-design.md` (read it first; it is the source of
every value below).

## Global Constraints

- `plugin/app/*.js` is ES5 on purpose: `var`, `function`, no arrow functions, no `let`/`const`, no template strings.
- All screen logic goes in `plugin/app/model.js` (not a new file): the published reader (`server/publish-reader.mjs`)
  and the server's code hash (`serve.mjs` `CODE`) list its files, and a new file would need both changed.
- Screen and component ids: `SCR-` plus four of `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, minted by `assign-ids.mjs`, never
  edited or reused, kept in `usedIds`. `name` is unique in the book.
- State key: `<screen-id>.<state-id>` (`SCR-4K7M.admin`). Screen heading key: the screen id.
- Every state has exactly one of `mockup`, `sameAs`, `absent`. `when.role: "anyone"` covers every role.
- State pictures: `mockups/screens/<screen-id>/<state-id>.html`; today's picture of a changing state:
  `mockups/screens/<screen-id>/<state-id>.today.html`.
- State screenshots: `media/screens/<screen-id>.<state-id>.png` (or `.jpg`, `.jpeg`, `.webp`).
- Component tag: `<sb-component id="SCR-…" state="…"></sb-component>`; expanded wrapper:
  `<div class="sb-component" data-key="SCR-….state">…</div>`; a highlighted one also has class `sb-hl`; a missing
  component, state or a cycle renders `<div class="sb-missing">Missing component SCR-….state</div>`. The reader adds
  `.sb-component { display: contents }` to every mockup's shadow root (not to a book's `phone.css`) so placing a component never changes layout, and draws a highlight
  by outlining the wrapper's children (`.sb-hl > *`).
- `frames` and a frame's `"state": "proposed"` are gone from the format. `migrate-book.mjs` and
  `lib/migrate-review.mjs` are not extended (no general upgrade path).
- US English in code, comments, docs and UI copy.
- Every screen the reader draws fits a 390px-wide phone, with a phone-width check in `test/reader.smoke.mjs`.
- Run tests from `plugin/`: `node --test server/ test/live.test.mjs test/relay.test.mjs`; smoke:
  `GLOBAL_ROOT=/opt/homebrew/lib/node_modules/playwright node test/reader.smoke.mjs`.

## Review Focus

- A `sameAs` chain or cycle, or a component that places itself (directly or through another): must render the
  red placeholder and fail validity, never hang the page or the server. Test in Task 1.
- A state shown by two sections: one review, shown in both sections, and accepting it in one clears it in both;
  each section's Accept gate sees it. Tests in Tasks 2 and 3.
- A component placed in a shown state is edited after the section was marked Ready: Build must refuse that section
  (`unreviewed`). Test in Task 3.
- A note dropped on a component inside a screen lands on the component's state key, and still records the section
  it was dropped in. Smoke check in Task 6.
- A requirement whose `screens` names a deleted screen or state: validity fails before landing, and the reader
  draws the chip as missing rather than throwing. Tests in Tasks 1 and 6.

---

### Task 1: Screen functions in the shared model

**Files:**
- Modify: `plugin/app/model.js` (new section "Screens", exported on the returned object)
- Test: `plugin/server/lib/screens.test.mjs` (new; `createRequire(import.meta.url)('../../app/model.js')`)

**Interfaces:**
- Produces (all on `SpecModel`):
  - `stateKey(screenId: string, stateId: string): string`
  - `screenIndex(book): { screens: {[id]: screen}, states: {[key]: { screen, state }}, byName: {[name]: id} }`
  - `drawnState(book, key): { screen, state } | null` (follows `sameAs` one step; null when missing)
  - `mockupPaths(book): string[]` (every state `mockup` and `today`, deduplicated)
  - `componentsIn(html: string): Array<{ id: string, state: string }>`
  - `expandMockup(book, mockups: {[path]: string}, html: string, opts?: { highlight?: string }): string`
  - `usedOn(book, mockups): {[componentId]: string[]}` (state keys whose picture, today's included, places it)
  - `shownIn(book): {[stateKey]: string[]}` (section full ids, book order)
  - `gateKeys(book, mockups, fullId): string[]` (shown state keys, followed through `sameAs` and nested
    components, plus their screen ids; deduplicated)
  - `requirementsFor(book, mockups, screenId): Array<{ req, fullId, chapterId, state: string|null, via: string|null }>`
    (book order; `via` is the component id when reached through a component the screen places)
  - `missingRoles(book, screenId): string[]` (book role ids no state's `when.role` covers; `[]` for components and
    when any state has `when.role === "anyone"`)
  - `screenProblem(book, exists: (path) => boolean, mockups): string | null` (the first validity failure in words,
    per the spec's "Validity" list; null when valid)

- [ ] **Step 1: Write the failing tests** in `screens.test.mjs`, on a fixture book with roles `member`, `admin`,
  `visitor`, screen `SCR-HOME` (`HomeScreen`; states `member` mockup, `admin` mockup placing
  `<sb-component id="SCR-CARD" state="waiting">`, `visitor` `sameAs: "member"`), component `SCR-CARD`
  (`VisitorsCard`; states `waiting`, `none`), sections `c-a` showing `SCR-HOME.admin` with `highlight: "SCR-CARD"` and
  `c-b` showing `SCR-HOME.admin` and `SCR-HOME.visitor`, and requirements `R1` (`screens: [{screen:"SCR-CARD"}]`),
  `R2` (`screens: [{screen:"SCR-HOME", state:"admin"}]`). Assert:
  - `expandMockup` on the admin picture contains `data-key="SCR-CARD.waiting"` and the card's markup; with
    `{ highlight: "SCR-CARD" }` the wrapper has class `sb-hl`.
  - A component placing itself, and a missing state, each expand to `sb-missing` with the key named, and return.
  - `usedOn(...)["SCR-CARD"]` is `["SCR-HOME.admin"]`; `shownIn(...)["SCR-HOME.admin"]` is `["c-a", "c-b"]`.
  - `gateKeys(book, mockups, "c-b")` includes `SCR-HOME.admin`, `SCR-HOME.visitor`, `SCR-HOME.member` (via sameAs),
    `SCR-CARD.waiting` and `SCR-HOME`, `SCR-CARD`.
  - `requirementsFor(book, mockups, "SCR-HOME")` lists R2 (`state: "admin"`, `via: null`) and R1 (`via: "SCR-CARD"`).
  - `missingRoles(book, "SCR-HOME")` is `[]`; after deleting the visitor state it is `["visitor"]`.
  - `screenProblem` returns null for the fixture, and a message naming the culprit for each of: duplicate screen id,
    duplicate name, a state with both `mockup` and `sameAs`, a `sameAs` to a `sameAs`, a `sameAs` cycle, an unknown
    `when.role`, a missing mockup file, an `sb-component` naming an unknown component, a requirement `screens` entry
    naming an unknown state, a `shows` entry naming an unknown state, a `highlight` not placed in that state.
- [ ] **Step 2: Run** `node --test server/lib/screens.test.mjs`. Expected: FAIL (`stateKey is not a function`).
- [ ] **Step 3: Implement the functions in `plugin/app/model.js`.** Parse `sb-component` tags with a regex over the
  mockup text (attributes `id` and `state` in either order); `expandMockup` recurses with a set of keys on the
  current path and a depth cap of 8.
- [ ] **Step 4: Run** `node --test server/lib/screens.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(model): screens, components and their states`.

### Task 2: Screens and states as reviewable items

**Files:**
- Modify: `plugin/app/model.js` (`itemsOf`, `REQ_FIELDS`, `reviews`)
- Test: `plugin/server/lib/model.test.mjs`

**Interfaces:**
- Consumes: Task 1's `screenIndex`, `shownIn`.
- Produces: items of kind `screen` (key: screen id; value `{ name, kind, file, intro }`, defined fields only) and
  `state` (key: state key; value `{ name, when, sameAs, absent, change, reason, mockup: <text|null>, today:
  <text|null> }`, defined fields only), both with `section: null, chapter: null, screen: <screen id>`. Requirement
  values gain `screens`. Section values gain `shows`. Frame items are gone. `reviews()` adds
  `byScreen: {[screenId]: number}` and counts a screen or state review toward `bySection`/`byChapter` of every
  section that shows one of its states.

- [ ] **Step 1: Write the failing tests** in `model.test.mjs`: items for the Task 1 fixture (one `screen` item per
  screen, one `state` item per state, the admin state's `mockup` value is the file's text, no `frame` items); a
  changed admin mockup is one review with `byScreen["SCR-HOME"] === 1` and counted once in each of `c-a` and `c-b`;
  a requirement whose `screens` changed is `changed`; a section whose `shows` changed is `changed`. Update existing
  tests that build `frames` fixtures to use screens.
- [ ] **Step 2: Run** `node --test server/lib/model.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** in `itemsOf` and `reviews`; the guessed `kind` for a removed item with `mockup` in its
  accepted value becomes `state`.
- [ ] **Step 4: Run** `node --test server/`. Expected: PASS (fix every test that used `frames`).
- [ ] **Step 5: Commit** `feat(model): review screens and states, not frames`.

### Task 3: Server: mockups, the Accept gate, validity, ids

**Files:**
- Modify: `plugin/server/lib/review.mjs` (`readMockups`, `sectionsUnderReview`)
- Modify: `plugin/server/lib/work.mjs` (validity), `plugin/server/lib/ids.mjs` (`collectIds`),
  `plugin/server/assign-ids.mjs` (mint `SCR` ids)
- Test: `plugin/server/lib/review.test.mjs`, `plugin/server/lib/work.test.mjs`, `plugin/server/lib/ids.test.mjs`,
  `plugin/server/serve.test.mjs`

**Interfaces:**
- Consumes: `mockupPaths`, `gateKeys`, `screenProblem`.
- Produces: `readMockups(data, book)` reads every path from `mockupPaths(book)` (same inside-the-data-folder check as
  today). `sectionsUnderReview(data, ids)` also treats a section as under review when any key of
  `gateKeys(book, mockups, id)` is under review. `invalidReason` in `work.mjs` returns `screenProblem(...)` when it is
  not null. `assign-ids.mjs` gives each screen without an `id` one minted with prefix `SCR`; `collectIds` includes
  screen ids.

- [ ] **Step 1: Write the failing tests:**
  - `review.test.mjs`: with every item accepted, editing the card's `waiting` picture makes
    `sectionsUnderReview(data, ["c-a","c-b"])` return both; editing only `SCR-HOME.member` returns `["c-b"]` (via
    visitor's sameAs) and not `c-a`.
  - `work.test.mjs`: a working book whose requirement names an unknown state does not land, with the message from
    `screenProblem`; a state whose mockup file is missing does not land.
  - `ids.test.mjs`: `assign-ids` mints `SCR-XXXX` for a screen without an id and keeps an existing one.
  - `serve.test.mjs`: after Ready, editing a component placed in a shown state makes `POST /api/build` answer 409
    `{ error: "unreviewed", sections: [...] }`.
- [ ] **Step 2: Run** `node --test server/`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the four changes; remove the frame loop from `work.mjs` (its check moves into
  `screenProblem`).
- [ ] **Step 4: Run** `node --test server/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): screens in reviews, the Accept gate, validity and ids`.

### Task 4: Build lands state changes; media under state keys

**Files:**
- Modify: `plugin/server/lib/builds.mjs` (`finishBuild`), `plugin/server/add-media.mjs`
- Test: `plugin/server/lib/builds.test.mjs`, `plugin/server/add-media.test.mjs` (new)

**Interfaces:**
- Consumes: `shownIn`, `drawnState`.
- Produces: when `finishBuild` marks a section `built`, every state it shows that carries `change` is applied: `add`
  drops `change`; `change` drops `change` and `today` and deletes the `.today.html` file; `remove` deletes the state
  (and its picture file) and records a `removed` decision with `about: [<state key>]`. Each applied state's accepted
  copy is updated (markers dropped, `today` gone) through the same `setAccepted` and `recordBuild` path requirements
  use, and appears in the changelog's `landed` as `{ id: <state key>, kind, text: <state name> }`. A state shown by a
  section that goes back to drafting keeps its markers. `add-media.mjs --screen <screen-id>.<state-id> <file>` copies
  to `media/screens/<screen-id>.<state-id>.<ext>` and fails with a message when the key is not a state in the book.

- [ ] **Step 1: Write the failing tests:** a built section applies its shown state's `change` (book, accepted copy,
  `today` file deleted, changelog entry); a drafting section leaves it; `add-media` copies under the state key and
  refuses an unknown key.
- [ ] **Step 2: Run** `node --test server/`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test server/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(build): land screen state changes; media by state key`.

### Task 5: The starter book in the new format

**Files:**
- Modify: `plugin/starter/book.json`; move `plugin/starter/mockups/*.html` (not `phone.css`) to
  `plugin/starter/mockups/screens/<id>/<state>.html`
- Test: `plugin/server/init.test.mjs` (asserts the starter has `screens` and no `frames`, and `screenProblem` is null)

**Interfaces:**
- Produces: screens `TodosScreen` (states `list`, `empty`, `typing`, `alldone`, `editing`, `swiped`, `activeonly`;
  `when.role: "user"`) and component `FiltersBar` (states `all`, `active`) placed by tag in `list` and `activeonly`;
  each section's `shows` lists the states its old frames drew, in the same order; `filters-bar`'s old proposed frame
  becomes `activeonly` with `change: "add"`; ids minted with `assign-ids.mjs`. The smoke test and later tasks use
  this book.

- [ ] **Step 1: Write the failing assertions** in `init.test.mjs`.
- [ ] **Step 2: Run** `node --test server/init.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Convert the starter by hand**, cutting the filter bar's markup into `FiltersBar` pictures.
- [ ] **Step 4: Run** `node --test server/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(starter): screens and a component`.

### Task 6: Reader: sections draw states

**Files:**
- Modify: `plugin/app/book.js` (loading mockups, `renderFrameBody`, the section's frames block, `screenshotFor`,
  `sectionDecisions`, review labels for kinds `screen` and `state`, `PLACES`, notes on mockups), `plugin/app/book.css`
- Test: `plugin/test/reader.smoke.mjs`

**Interfaces:**
- Consumes: `mockupPaths`, `expandMockup`, `drawnState`, `screenIndex`, `requirementsFor`.
- Produces: each `shows` entry draws as `figure.state` with `data-key` = the state key, caption
  `<screen name> · <state name>` and the role chip from `when.role`; `sameAs` draws the target's picture with
  "Same as <state name>" in the caption; `absent` draws its words in place of a picture; a state with `change:
  "change"` draws the proposed picture with today's beside it (labeled "Today" and "Proposed"; stacked on a phone),
  and `change: "add"` is tagged "New". Requirements with `screens` show chips `<name> · <state name>` linking to
  `#screen/<key>` (Task 7); a chip naming a missing screen or state renders as "missing" and does not throw. A note
  dropped inside a `.sb-component` goes on that component's `data-key` (its `section` is still where it was dropped).
  Screenshots are looked up as `media/screens/<state key>.<ext>`.

- [ ] **Step 1: Write the failing smoke checks** in `reader.smoke.mjs` against the converted starter: the `todos-list`
  section has a `figure.state[data-key="<TodosScreen id>.list"]` whose shadow root contains `.sb-component`; the
  FiltersBar state is drawn once per showing (no copy in the book's files); a note dropped on the filter bar inside
  the list picture is saved with `item` = the FiltersBar state key; a requirement chip is present; at 390px no
  `figure.state` is wider than the viewport.
- [ ] **Step 2: Run** the smoke test. Expected: FAIL on the new checks.
- [ ] **Step 3: Implement**; delete the frame-only code paths.
- [ ] **Step 4: Run** the smoke test and `node --test server/ test/live.test.mjs test/relay.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reader): sections draw screen states`.

### Task 7: Reader: the Screens view

**Files:**
- Modify: `plugin/app/book.js`, `plugin/app/book.css`, `plugin/app/index.html` (the view switch in the bar)
- Test: `plugin/test/reader.smoke.mjs`

**Interfaces:**
- Consumes: `screenIndex`, `usedOn`, `requirementsFor`, `missingRoles`, `expandMockup`, reviews' `byScreen`.
- Produces: a **Book · Screens** switch in the bar. Screens view: a list of screens then components (headings
  "Screens <n>" and "Components <n>", book order of first appearance), each with its name, `file` (or "No file yet"),
  and its open-review count. A screen page (`#screen/<id>`; a state anchor `#screen/<key>` scrolls to and outlines
  that state) shows its states (laid out in a row by role where `when.role` is set; stacked at 390px), the quiet
  hint `No state for <Role>: same as another, or doesn't see it?` per missing role, its requirements grouped by
  chapter then section in book order with the state they narrow to or `via <component name>`, and for a component
  **Used on** with a thumbnail of each placing state, the component outlined (`sb-hl`). Review stacks, ✓ Accept and
  notes work on screen headings and states here as in the chapter view.

- [ ] **Step 1: Write the failing smoke checks:** the switch opens the Screens view listing `TodosScreen` and
  `FiltersBar`; `#screen/<FiltersBar id>` shows Used on with the two placing states; a changed state shows its review
  and ✓ Accept clears it; at 390px the view, a screen page and Used on fit without sideways scroll.
- [ ] **Step 2: Run** the smoke test. Expected: FAIL on the new checks.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the smoke test and the unit tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reader): the Screens view`.

### Task 8: Formats, reader docs and skills

**Files:**
- Modify: `plugin/reference/book-format.md` (the `screens` model, keys, `shows`, requirement `screens`, media names,
  review items; remove `frames`), `plugin/reference/reader.md` (chapter view drawing, chips, the Screens view),
  `plugin/skills/design/SKILL.md` (replace "Frames: every screen for every role" and "Mockups" with: screens and
  components drawn once, states with conditions, `sameAs`/`absent`, missing-role hints resolved, components only for
  exactly repeated pieces, a changing built state carries `change`/`today`, requirements point at components for
  reused pieces and at screens otherwise), `plugin/skills/build/SKILL.md` (media by state key; finish lands state
  changes; fill in a screen's `file` when the build creates the component), `plugin/skills/specbook/SKILL.md` (add-media row)
- Test: none (docs); `grep -rn "frames\|frame id" plugin/reference plugin/skills` returns only intentional mentions.

- [ ] **Step 1: Edit the five files** to match Tasks 1-7 exactly (names, keys, paths).
- [ ] **Step 2: Run** the grep above and read each hit. Expected: no stale frame instructions.
- [ ] **Step 3: Commit** `docs: screens and components in the format, reader and skills`.

### Task 9: Convert the Tribes book (one-off)

Runs in the Tribes repo (`~/jsonxr/tribes/main/docs/specbook`), with the book server stopped and the user
present for Step 2. The script lives in the session scratchpad, never in either repo.

**Files:**
- Create: `<scratchpad>/convert-tribes.mjs`
- Modify (Tribes): `docs/specbook/book.json`, `docs/specbook/review.json`, `docs/specbook/mockups/` (to
  `mockups/screens/…`), `docs/specbook/media/screens/` (renamed)

**Interfaces:**
- Consumes: the plugin's `assign-ids.mjs`, `SpecModel.screenProblem`, `SpecModel.reviews`, `SpecModel.gateKeys`.

- [ ] **Step 1: Write the script's mapping pass** (no writes): group the 78 frames by identical mockup text; propose
  a screen for each group from captions and the 28 `packages/mobile/**/*Screen.tsx` files (system pictures and the
  splash screen get chosen names, no `file`; branded pictures become states with `when.also: "branded community"`);
  find markup repeated byte-identically across pictures (tab bar and header versions, cards, dialogs) as component
  candidates; list near-identical copies separately; map the 10 `"state": "proposed"` frames to `change`/`today`
  states or `change: "add"`. Print the table.
- [ ] **Step 2: Show the user the mapping table** (screens, states, components, near-duplicates left alone,
  requirements that get `screens`, ones left without) and apply their corrections. Do not continue without their OK.
- [ ] **Step 3: Write pass:** write `screens`, `shows` and requirement `screens`; move pictures; replace repeated
  markup with `sb-component` tags; run `assign-ids.mjs`; move each frame key's `accepted`, `opened` and `where` in
  `review.json` to its state key (identical accepted frames make one accepted state) and bump `rev`; rename media.
- [ ] **Step 4: Verify:** `screenProblem` is null; every built section has no open review that was not open before
  the conversion (`communities-offline-1`'s existing review maps to its state and stays); each state's expanded
  picture, with the `sb-component` wrapper tags removed, equals its old frame's mockup text byte for byte. Stop and restore from git if any check fails.
- [ ] **Step 5: Serve the book and check it in the reader** (chapter view and Screens view, desktop and 390px), then
  show the user. Commit in the Tribes repo only when the user asks.

## Execution notes

- The share link serves the released reader, which knows only `frames`: after the Tribes book is converted, guests on
  its share link see no pictures until a new reader is released (`docs/development.md`, "Releasing a reader"). That
  release is a separate step for the user.
