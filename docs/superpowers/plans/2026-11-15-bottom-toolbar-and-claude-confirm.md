# Bottom Toolbar, One Filter and a Screen Before Claude Acts: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the review toolbar to the bottom on every screen, slim the header, replace the Requests panel with one
filter and a confirmation screen before Revise and Build, and use one chevron for every dropdown.

**Architecture:** All of it is the reader (`plugin/app/`): markup in `index.html`, styles in `book.css`, behavior in
`book.js`, and the Share button's label in `live.js`. No server change: Revise and Build post to the same
`/api/revise` and `/api/build`, only after a confirmation dialog. The published reader copy
(`server/public/r/1.0.0/`) is refreshed at the end.

**Tech Stack:** Plain browser JavaScript (ES5 style: `var`, `function`, no build step), CSS, Node test runner,
Playwright smoke tests.

**Spec:** `docs/mockups/2026-11-15-show-filter-and-carets.html` (the mockup, as agreed in conversation on
2026-11-15). "Show what Claude receives" is set aside: not part of this plan.

## Global Constraints

- Every screen, menu and dialog fits a 390-pixel-wide screen: nothing cut off, nothing scrolling sideways
  (`docs/development.md`). Each new UI gets a phone-width check in `plugin/test/reader.smoke.mjs`.
- Phone touch targets in the bottom toolbar stay at least 44 by 44 points.
- No inline event handlers, no `eval`: the share page's CSP is `script-src 'self'`.
- No new dependencies.
- US English in code, comments and copy.
- Keys: **C** comment, **J**/**K** next/previous, **F** the filter, **Esc** closes the top-most thing. **R** goes
  away (it opened the Requests panel).
- The chevron is the toolbar's down arrow: `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`, 18 px, stroke
  2, round caps and joins, in the button's own color.
- A guest on a shared link has no Claude menu (as today), so no Revise or Build dialog and no notes count on it.

## Review Focus

- **A guest on the share link** (`server/public/r/1.0.0/share.html`): the bottom toolbar must show and work there too
  (comment, previous/next, filter, contents), and nothing Claude-related may show. Test in Task 5.
- **Revise pressed while Claude is busy or with no notes:** the dialog must not open (Revise is disabled), and a send
  that the server refuses (`busy`) shows today's message. Test in Task 4.
- **Notes changed while the Revise dialog is open** (a collaborator, another tab): the dialog lists the notes at the
  moment it was drawn, and Send sends `items()` as they are at Send. The dialog is drawn again on `refresh()` while
  open, so the two never differ. Test in Task 4.
- **Resizing across the 860 px line** with the contents hidden on a desktop or the sheet open on a phone: the sheet
  closes on going wide (as today), and the desktop's hidden sidebar stays hidden on coming back. Test in Task 1.
- **The toast and the share chip** (`.bar-msg`, `.share-chip`, both bottom-left) must not sit under the desktop's
  floating toolbar. Test in Task 1.

---

### Task 1: The header and the bottom toolbar

**Files:**
- Modify: `plugin/app/index.html` (the `header.bar` block)
- Modify: `plugin/app/book.css` (the bar, `.tools`, the 700 px and 860 px media blocks, `.bar-msg`, `.share-chip`)
- Modify: `plugin/app/book.js` (`showWhere`, `setToc`, the `#where` wiring near line 3239)
- Test: `plugin/test/reader.smoke.mjs`

**Interfaces:**
- Produces: `#review-tools` (the toolbar `div.tools`, now a child of `body` after `.layout`, not of the header);
  `body.toc-hidden` (desktop contents hidden); `store('spec-book-toc')` holding `'hidden'` or `'shown'`.
- Removes: `#where`, `#where-text`, `.bar-where`, and `showWhere()`'s label update (the sheet's `.sb-here` marking
  stays: the sheet still scrolls to where you are).

- [ ] **Step 1: Write the failing smoke checks**

  Replace the check "on a phone the bar says where you are, and it opens the contents as a sheet that jumps and closes"
  with two checks:

  `'the review toolbar sits at the bottom on a desktop, and its Contents button hides and shows the contents'`:
  at 1400 by 900, `#review-tools` is not inside `header.bar`; its bounding box's bottom is within 40 px of the
  window's bottom and its center within 2 px of the book column's center (`main`'s center); `#where` does not exist;
  the header holds `#book-title`, `#view-btn`, `#share-slot`, `#claude-btn` and no `.tool`. Clicking `#toc-btn` adds
  `body.toc-hidden`, makes `.side` not visible, and makes `main`'s left edge less than 40 px; a reload keeps it
  hidden; clicking again shows it. At 390 wide `body.toc-hidden` has no effect on the sheet, and on going back to 1400
  the sidebar is still hidden. The toast: set `#make-msg` text and check its box does not overlap `#review-tools`.

  `'on a phone the Contents button opens the contents as a tall sheet that jumps and closes'`: at 390 by 844, the
  header shows `#book-title`; `#toc-btn` opens `body.toc-open .side`; the sheet's top is at most 70 px from the
  window's top when the contents are longer than the screen; `.side .sb-here` marks the section in view; clicking
  `.side a[href="#filters-bar"]` closes it; `#toc-btn` again then **Esc** closes it.

- [ ] **Step 2: Run them to see them fail**

  Run: `GLOBAL_ROOT=<playwright> node plugin/test/reader.smoke.mjs`
  Expected: both new checks FAIL (the toolbar is in the header; `#where` exists).

- [ ] **Step 3: Move the toolbar and slim the header**

  - `index.html`: move `div.tools` out of `header.bar` to just after `div.layout`, give it `id="review-tools"`; delete
    the `#where` button; keep `#toc-btn` (drop its `toc-tool` class so it shows at every width) and its separator.
  - `book.css`: `.tools` becomes `position: fixed; z-index: 70;` on every screen. Wide (over 700 px): floating,
    `bottom: 16px`, centered on the book column (`left: calc(50% + 135px)` with the 270 px sidebar shown, `50%` with
    `body.toc-hidden`; `transform: translateX(-50%)`), `border-radius: 12px`, a shadow. The phone rules in the 700 px
    block stay as they are (full-width strip). `body.toc-hidden .layout { grid-template-columns: minmax(0, 1fr); }`
    and `body.toc-hidden .side { display: none; }` inside a `(min-width: 861px)` query. The header shows
    `.bar-title` at every width (delete its hiding in the 860 px block; give it `min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap`). `.bar-msg` and `.share-chip` sit above the floating toolbar
    on a desktop (`bottom: 80px`).
  - `book.js`: `tocBtn` click: on a narrow screen `setToc(!tocOpen())` as today; on a wide one toggle
    `body.toc-hidden`, set `aria-pressed` to whether the contents show, and `store('spec-book-toc', …)`. Read the
    stored value at start. `showWhere()` keeps marking `.sb-here` but no longer writes a label; drop the
    `whereBtn` lines.

- [ ] **Step 4: Run the smoke test**

  Run: `GLOBAL_ROOT=<playwright> node plugin/test/reader.smoke.mjs`
  Expected: the two new checks PASS; fix any older check that clicked `#where` or expected the toolbar in the bar
  (`'on a phone every menu in the bar fits on the screen…'` drops `['#where', '#toc-nav']` and opens the sheet with
  `#toc-btn` instead).

- [ ] **Step 5: Commit**

  `git commit -m "feat(reader): the review toolbar at the bottom everywhere; the header keeps title, View, Share, Claude"`

### Task 2: One chevron for every dropdown

**Files:**
- Modify: `plugin/app/index.html` (`#view-btn`, `#claude-btn`)
- Modify: `plugin/app/live.js` (the `share-more` button, `'Share ▾'`)
- Modify: `plugin/app/book.css`
- Test: `plugin/test/reader.smoke.mjs`

**Interfaces:**
- Produces: `span.chev` holding the chevron SVG; `live.js` builds the same markup with DOM calls (no `innerHTML` of
  user text).

- [ ] **Step 1: Write the failing smoke check** `'every dropdown in the header ends in the toolbar\'s chevron'`:
  `#view-btn`, `#claude-btn` and `.share-pill .share-more` each contain one `svg path[d="M6 9l6 6 6-6"]` whose box is
  18 by 18, and none of their text contains `▾`. Update the share check that expects the label `'Share ▾'` to expect
  `textContent.trim() === 'Share'` plus the chevron.
- [ ] **Step 2: Run it to see it fail.** Expected: FAIL (the buttons end in `▾`).
- [ ] **Step 3: Replace the glyphs.** `index.html`: `View` and `Claude` end in
  `<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 9l6 6 6-6"/></svg></span>`.
  `live.js`: the `Share` button appends the same, made with `document.createElementNS`. `book.css`:
  `.chev svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }`;
  the buttons become `display: inline-flex; align-items: center; gap: 4px`; the chevron is `var(--muted)` in View and
  Share, the Claude color in Claude.
- [ ] **Step 4: Run the smoke test.** Expected: PASS, including the phone check that every header menu fits.
- [ ] **Step 5: Commit** `feat(reader): every dropdown ends in the toolbar's chevron`

### Task 3: The filter shows what still needs you; the Requests panel goes

**Files:**
- Modify: `plugin/app/index.html` (delete `#notes-btn` and `aside#notes-panel`; keep `aside#review-panel`)
- Modify: `plugin/app/book.js` (`refresh`, `renderPanel`, `setPanel`, `setPanelTab`, `renderChangeList`,
  `updateChangesBar`, the **R** key, `#np-revise` wiring)
- Modify: `plugin/app/book.css` (drop `.np-tabs`, `.np-send`, `.np-items`, `.np-json` rules; keep `.notes-panel`
  and `.np-*` rules that `#review-panel` uses)
- Test: `plugin/test/reader.smoke.mjs`

**Interfaces:**
- Produces: `#claude-count` (a `span.tool-badge` inside `#claude-btn`, the number of draft notes, hidden at 0 and for
  guests); the Revise item's `small` says `Review your N notes, then send them.`; `#chg-pos` stays the count of what
  needs you (`"i / N"`).
- Removes: `setPanel`, `panelTab`, `renderPanel`, `renderChangeList`, `renderPreview`, `requestBody`, `#notes-count`.
  `renderPrint()` and `items()` stay.

- [ ] **Step 1: Write the failing smoke checks.**
  `'the filter shows only what still needs you: changes not accepted and lines with a note'`: with a draft note on an
  accepted requirement (no change), pressing `#changes-btn` keeps that requirement's section shown and the
  requirement not dimmed (`opacity` 1), hides a section with neither, and `#chg-pos`'s total equals the number of
  `.has-rv` elements. `'there is no Requests panel; the notes count is on Claude'`: `#notes-btn` and `#notes-panel`
  do not exist; pressing **R** changes nothing; with 2 draft notes `#claude-count` reads `2` and `#revise small`
  starts `Review your 2 notes`. Rewrite the two checks that read `#np-tab-changes` to read the total from
  `#chg-pos` instead, and drop the **R** / `#np-changes` lines from the keyboard check.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL (`#notes-btn` exists; the badge is missing). If the first
  check already passes (a draft note already makes its item `noted` in `model.js`), keep it as a guard.
- [ ] **Step 3: Remove the panel and move the count.** Delete the markup and the functions listed above and every
  caller; `refresh()` sets `#claude-count` and the Revise line instead of the panel. Rename `#changes-btn`'s title
  to `Only what needs you · F` and the diff summary's copy to `N to look at: changes not accepted yet and notes.
  Sections with none are hidden.`
- [ ] **Step 4: Run the smoke test and the unit tests.** Run: `node --test plugin/server/ server/src/` and the smoke
  test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reader): one filter for what needs you; the notes count moves to Claude`

### Task 4: A screen before Revise and Build

**Files:**
- Modify: `plugin/app/index.html` (add `div#claude-confirm`)
- Modify: `plugin/app/book.js` (the Claude group near line 2470: `reviseBtn` and `buildBtn` open the dialog; the
  existing send code moves to `sendRevise()` and `sendBuild()`)
- Modify: `plugin/app/book.css`
- Test: `plugin/test/reader.smoke.mjs`

**Interfaces:**
- Consumes: `items()` (each `{ id, where, about, note, noteId, by?, element? }`), `state.notes[noteId].section` (a
  section's full id), `reviewOf(key)` (`.status` is `new`, `changed`, `removed` or `noted`), `goTo(noteId)`.
- Produces: `openConfirm(kind)` with `kind` `'revise'` or `'build'`; `closeConfirm()`; `#claude-confirm` with
  `.cc-list`, `.cc-send`, `.cc-cancel`; `body.confirm-open`.

- [ ] **Step 1: Write the failing smoke checks.**
  `'Revise opens a screen with every note under its requirement, and sends only on Send'`: with 2 draft notes in two
  sections, `#claude-btn` then `#revise` shows `#claude-confirm` with heading `Revise: 2 notes to send`; it has one
  `.cc-group` per section, each with the section's number and title and a `Go to ›` button; each `.cc-item` shows the
  requirement's id and text (`about`), a `changed` tag when `reviewOf(id).status` is `changed`, and the note's text;
  no file appears in `requests/` yet. `Cancel` closes it and still nothing is in `requests/`. Open again, `Go to ›`
  closes the dialog and flashes that note's pin. Open again, `Send to Claude` writes one request with both notes and
  the status shows `Revising…`. **Esc** closes it.
  `'Build opens a screen with the sections marked Ready'`: with one section marked Ready, `#build` shows
  `Build: 1 section marked Ready` listing it; `Cancel` sends nothing; `Build` posts as today.
  `'the Revise screen fits a phone'`: at 390 by 844 the dialog is a sheet whose box is inside the screen, its list
  scrolls, and `Cancel` and `Send` are each at least 44 px tall.
  `'the Revise screen follows the notes while it is open'`: with the dialog open on 2 notes, a third saved through
  `PUT /api/notes` (as another tab would) appears in the list within 3 seconds and the heading says `3 notes`.
  `'a refused Send says why'`: with the server answering `/api/revise` with 409 `busy` (route it with
  `page.route`), Send shows `Claude is busy; try again when it is done.` and closes the dialog.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL (`#claude-confirm` does not exist; Revise sends at once).
- [ ] **Step 3: Build the dialog.** `index.html`: `div#claude-confirm.cc` with `role="dialog"`, `aria-modal="true"`,
  `aria-labelledby="cc-title"`, holding `h2#cc-title`, `p.cc-sub`, `div.cc-list`, and a footer with `button.cc-cancel`
  and `button.cc-send`, plus `div#cc-backdrop`. `book.js`: `reviseBtn` and `buildBtn` clicks call
  `openConfirm('revise' | 'build')` after closing the Claude menu; `openConfirm` fills the list with DOM calls (all
  note and book text through `textContent`), shows it, focuses `.cc-send`; Revise groups `items()` by
  `state.notes[noteId].section` in book order, heading from that section's `h3` (`.bk-num` and title); Build lists
  sections with `stage === 'ready'`. `.cc-send` runs `sendRevise()` or `sendBuild()` (today's click bodies, unchanged)
  then `closeConfirm()`. `refresh()` redraws the list while the dialog is open. Esc in the existing keydown handler
  closes it first. `book.css`: wide, a centered dialog `width: min(560px, calc(100vw - 32px))`,
  `max-height: min(80vh, 640px)`; at 700 px or less, a sheet from the bottom with `top: 56px`, its footer buttons
  `flex: 1; min-height: 44px`, padding for `env(safe-area-inset-bottom)`; the list scrolls inside.
- [ ] **Step 4: Run the smoke test.** Expected: PASS; the earlier checks that clicked `#revise` (`'revise locks
  notes'` and the review-stack check) now also click `.cc-send`.
- [ ] **Step 5: Commit** `feat(reader): Revise and Build show what they will do before they do it`

### Task 5: Documentation, the published reader, and the whole run

**Files:**
- Modify: `plugin/reference/reader.md` (the bar, the toolbar, the filter, Revise and Build, the keys; drop the
  Requests panel and **R**)
- Modify: `plugin/skills/start/SKILL.md` (step 5: "**Changes (n)** in the bar" becomes the filter in the toolbar)
- Modify: `server/public/index.html` only where it names the Requests panel or **R** (check with grep)
- Regenerate: `server/public/r/1.0.0/` with `node server/publish-reader.mjs --force` (only while 1.0.0 is not
  deployed; otherwise raise the plugin version and publish that)
- Test: `plugin/test/share.smoke.mjs`

- [ ] **Step 1: Add a guest check to the share smoke test** `'a guest has the bottom toolbar and no Claude'`: on the
  share link, `#review-tools` is visible at the bottom with `#mode`, `#prev-chg`, `#next-chg`, `#changes-btn` and
  `#toc-btn`; `#claude-btn`, `#claude-count` and `#claude-confirm` are not visible.
- [ ] **Step 2: Update the docs**, then `grep -rn "Requests\|notes-btn\| R \|Changes (n)" plugin/reference
  plugin/skills server/public/index.html README.md` shows nothing stale.
- [ ] **Step 3: Republish and run everything.**
  Run: `node server/publish-reader.mjs --force && node --test plugin/server/ server/src/ server/publish-reader.test.mjs`
  then both smoke tests. Expected: every unit test passes; both smoke tests print no `FAIL`.
- [ ] **Step 4: Look at it.** Screenshots at 1400 by 900 and 390 by 844 of: the book, the filter on, the contents
  hidden (desktop) and the sheet (phone), the Revise dialog. Compare with the mockup.
- [ ] **Step 5: Commit** `docs(reader): the bottom toolbar, the filter and the Revise screen; republish 1.0.0`
