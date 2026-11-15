# State Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** States become combinations of named state variables (role is one), with computed captions and a coverage
list; the starter and the Tribes book are re-described that way.

**Architecture:** All variable logic is pure functions in `plugin/app/model.js` (ES5, shared by reader and server).
The reader asks the model for captions and coverage. Tribes is converted by a one-off script in the session
scratchpad, then the agreed new pictures are drawn with the design skill.

**Tech Stack:** Node 20+ ESM (`node:test`), ES5 browser JavaScript, Playwright smoke test.

**Spec:** `docs/superpowers/specs/2026-11-15-state-variables-design.md` (and for Task 4,
`docs/superpowers/specs/2026-11-15-tribes-states-proposal.md`).

## Global Constraints

- `plugin/app/*.js` is ES5; all variable logic lives in `plugin/app/model.js`.
- Book `variables`: `[{ id, label, values: [{ id, label }] }]`, first value is the default. `role` is built in; its
  values are the book's `roles` plus `anyone`; it has no default and always shows as the pill.
- Screen `variables`: ordered list of variable ids or inline declarations `{ id, label, values }`.
- State `when`: `{ <variable>: <value> }`; left out = any; `role` may be a list only on `absent` or `sameAs` states.
- Caption: role pill(s), then labels of non-default values in the screen's variable order, joined by ", ". Only the
  role differs → pill alone. `name` overrides the text. A component's caption is all its values' labels.
- Screen `undrawn`: `[{ when, about: [<requirement ids>], note }]`.
- **State ids never change.**
- Every reader screen fits 390px, with a phone-width smoke check.
- Run from `plugin/`: `node --test server/ test/live.test.mjs test/relay.test.mjs`;
  `GLOBAL_ROOT=/opt/homebrew/lib/node_modules/playwright node test/reader.smoke.mjs`. US English.

## Review Focus

- A `when` naming a variable the screen does not list, or a value not declared: validity fails with the culprit named.
- Two drawn states of one screen with the same `when`: validity fails.
- A state with no `when.role` on a screen that uses `role`: it is "any role"; the caption shows no pill and coverage
  counts it for every role.
- A component placed in a screen: its caption never shows a role pill.
- Changing only a variable's label (book-level) changes every caption that uses it, without reopening state reviews
  (labels are not part of a state's reviewed value; the book's `variables` are reviewed nowhere — accepted as is).

---

### Task 1: Variables in the model

**Files:** Modify `plugin/app/model.js`; Test `plugin/server/lib/screens.test.mjs` (and `model.test.mjs` for items).

**Interfaces (Produces, on SpecModel):**
- `variablesOf(book, screenId): Array<{ id, label, values: [{ id, label }], isRole }>` (resolved, in screen order).
- `stateCaption(book, key): { roles: string[], text: string }` (role ids for the pills; text per the constraint).
- `coverage(book, screenId): Array<{ when, kind: 'drawn'|'same'|'absent'|'undrawn', key?: string, about?: string[], note?: string }>`
  (one entry per state and per `undrawn` entry; in screen order then undrawn order).
- `screenProblem` gains the design's validity checks; `missingRoles` is removed (coverage replaces it).
- `itemsOf`: a state's value is `{ when, sameAs, absent, change, reason, also, name, mockup, today }` (defined fields
  only); a screen heading's value gains `variables` and `undrawn`.

- [ ] Write failing tests: captions (pill only; one non-default value; two values in screen order; `name`
      override; component caption; `anyone`; role list on absent); coverage (drawn, same, absent, undrawn with
      about); validity (undeclared variable, undeclared value, `when` key not in the screen's list, duplicate
      `when`, role list on a drawn state, undrawn with unknown requirement id); item values.
- [ ] Run `node --test server/lib/screens.test.mjs server/lib/model.test.mjs` → FAIL.
- [ ] Implement. Replace every use of `missingRoles` and `when.also`-in-caption in model.js.
- [ ] Run `node --test server/` → PASS (update fixtures that relied on `name`/`also`).
- [ ] Commit `feat(model): state variables, computed captions, coverage`.

### Task 2: The starter in variables

**Files:** Modify `plugin/starter/book.json`; Test `plugin/server/init.test.mjs`.

- [ ] Declare book variables the starter needs (`data`: some/empty, `filter`: all/active, `edit`: none/editing/swiped
      or similar — the implementer chooses names that read well) and give TodosScreen and FiltersBar their
      variables; express each state's `when`; remove `name` from every state; add one `undrawn` entry tied to a
      requirement. Assert in init.test: no state has `name`, `screenProblem` is null, every caption is non-empty or
      pill-only by design.
- [ ] Run `node --test server/` → PASS. Commit `feat(starter): states as variables`.

### Task 3: Reader captions, variables and coverage

**Files:** Modify `plugin/app/book.js`, `plugin/app/book.css`; Test `plugin/test/reader.smoke.mjs`.

- [ ] Every caption (book figures, Screens list, screen page, chips, review labels, Used on) uses `stateCaption`:
      role pills then text; several pills for a role list. Remove the "No state for <Role>" hint.
- [ ] Screen page: a **Variables** line (`Role: Visitor · Member · Admin`, `Connection: Online · Offline`) and a
      **Coverage** list: one row per `coverage` entry — drawn (links to the state), same as (names it), absent
      (its words), not drawn (its note and requirement ids as links).
- [ ] Smoke checks: a pill-only caption; a value caption; the Variables line; a not-drawn coverage row with its
      requirement link; 390px fit for the screen page.
- [ ] Run both suites → PASS. Commit `feat(reader): computed captions, variables and coverage`.

### Task 4: Formats, docs and skills

**Files:** `plugin/reference/book-format.md`, `plugin/reference/reader.md`, `plugin/skills/design/SKILL.md`,
`plugin/skills/build/SKILL.md` (if it names states), `plugin/reference/level.md` (screen row).

- [ ] Document the format and validity exactly as built; replace the "Member: Member" example; the design skill's
      rule: declare variables, express states as combinations, never type a name that repeats the role, record
      implied combinations as `undrawn`, components own their variables.
- [ ] Grep for `also`, `missingRoles`, `No state for` in reference and skills; only intentional hits remain.
- [ ] Commit `docs: state variables in the format, reader and skills`.

### Task 5: Re-describe the Tribes book (one-off, Tribes repo)

Uses `docs/superpowers/specs/2026-11-15-tribes-states-proposal.md` with the owner's answers (design, "Tribes").
Script in the session scratchpad; the Tribes book server stopped while writing; nothing committed in Tribes.

- [ ] Declare the book variables and each screen's; set every state's `when`, remove role-repeating `name`s; fix
      the five wrong roles; role lists for multi-role absent states.
- [ ] Components: ShareCard, VisitorsCard, the People attention card, SharePlaceholder, OfflinePill, and one
      QueryState (loading / could not load / empty) — cut from the pictures where their markup is byte-identical,
      placed by `sb-component`; requirements that are about them point at them.
- [ ] Home's Public / Members / Private labels: the pictures that show them become `change: "change"` states with
      `today` = the same picture without the labels.
- [ ] Record every implied combination the proposal lists, except the ones drawn in Task 6, as `undrawn` with its
      requirement ids; the five missing screens get catalog entries with `undrawn` only.
- [ ] Verify: `screenProblem` null; every picture renders as before (byte-equal after component wrappers removed),
      except the deliberate Home label change; no note, try or accepted copy lost (accepted copies keep their keys).
- [ ] Serve the book and check it at desktop and 390px; report what opened for review.

### Task 6: Draw the agreed new pictures (Tribes)

Draw, as `change: "add"` states, with the design skill: Home member with no groups yet; AcceptInvite when the person
already has an account; JoinCommunity community not found, and already a member; find-a-community handle found;
Calendar with no upcoming events; ShareInDirectory, GroupDetail and Listing as a visitor; a person's page for a
waiting visitor and for someone who opted out of invites; Notifications allowed; the TabStack header for a community with no logo (its name in bold). (Not: Home admin with no visitors.)
Each from the app's real code and copy; each removed from `undrawn`; validity null; checked in the reader.
