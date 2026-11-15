# Spec book formats

The files a spec book keeps in its data folder (`<dir>`, default `docs/specbook/`), and the rules for the ids that tie
them together. The skills point here at the step that needs each part.

## book.json

```json
{
  "title": "…", "eyebrow": "…", "lede": "HTML",
  "sources": [{ "label": "Spec", "path": "docs/…" }],
  "roles": [{ "id": "signedout", "label": "Signed out", "color": "#c9ccd2" },
            { "id": "member", "label": "Member", "color": "#9cc3ff" }],
  "mockupCss": "mockups/phone.css",
  "settings": { "screenshotWidth": 100 },
  "chapters": [{
    "id": "directory", "prefix": "DIR", "title": "Directory", "intro": "HTML",
    "sections": [{
      "id": "people", "title": "People", "stage": "drafting | ready | building | built", "label": "Phase 2",
      "intro": "HTML",
      "requirements": [{ "id": "DIR-4K7M", "text": "HTML sentence" },
                       { "id": "DIR-9QX2", "text": "new behavior", "change": "add" },
                       { "id": "DIR-2WLA", "text": "target", "change": "change", "today": "what happens now" },
                       { "id": "DIR-5T8N", "text": "old behavior", "change": "remove", "reason": "why it goes" }],
      "frames": [{ "id": "directory-people-1", "role": "member", "caption": "People · member",
                   "mockup": "mockups/directory-people-1.html", "screenshot": "optional media path",
                   "state": "proposed (optional: draws a change to a built screen)" }],
      "videos": [{ "path": "media/videos/…", "caption": "…" }]
    }]
  }],
  "decisions": [{ "id": "DEC-7K2P", "date": "2026-11-12", "about": ["DIR-4K7M"], "by": "user | build",
                  "title": "…", "body": "what was decided, and why", "kind": "decision | removed | rejected" }],
  "usedIds": ["every id ever minted"]
}
```

- **`settings`** (optional) tunes the reader: `screenshotWidth` is the width in pixels of the column of test
  screenshots to the right of a requirement's text (default 100); a requirement without one has no column. `shareBroker` is
  the address of the share server the book shares through, `https://specbook.jasonrowland.com` when absent.
  Set it only to use your own; see `server/` in the plugin's repository. (`share`, which once kept a book from
  sharing itself, is ignored: no book shares until its owner presses **Share**.)
- **`stage`** is one of `drafting`, `ready`, `building`, `built`. The user sets only `drafting` and `ready` (and
  `ready` only on a section with at least one requirement carrying a `change`); a build sets `building` and `built`. A chapter has no stage; the reader derives it from its sections. `label` is optional
  words ("Phase 2") shown after the stage on the section's pill.
- **`change`** says what a build does with a requirement. None: the app meets it. `add`: new, and `change` is
  dropped once built. `change`: the text is the target and `today` says what happens now; both `change` and `today`
  are dropped once built. `remove`: shown struck through with its `reason`; once built it is deleted and a decision
  of kind `removed` records it. Never delete a built requirement by hand.
- **Decisions** are one list: `by` is who decided (`user` or `build`), `about` holds requirement, section or frame
  ids, and `kind` is `decision`, `removed` (a requirement taken out; its id, text and reason) or `rejected` (a build
  call the user turned down). The `DEC` prefix is for new decision ids; a build's calls are `CALL` ids until
  accepted. There is no `calls` list. A decision's `about` names the items it settled (it is how the page links it to
  an item's review and history); write one only when a discussion settled something (see `design`).
- A book in the old format (`status` or `pill` on sections, `proposed` requirements, `calls`) is moved to this one
  by `node ${CLAUDE_PLUGIN_ROOT}/server/migrate-book.mjs --data <dir>`: `proposed` or `phase` becomes `drafting`,
  `proposed` with `today` becomes `change`, `proposed` without it becomes `add`, and `calls` join `decisions`.

The server reads `book.json` and the mockups on every page load: edit, then reload.

## Stable ids

Every requirement, decision and call has a **stable id**: a prefix of capitals, a dash, and four of `0-9A-Z`
(`ONB-S5U2`). A chapter's `prefix` is used for new requirement ids.

- Add new requirements and decisions as plain strings, then run
  `node ${CLAUDE_PLUGIN_ROOT}/server/assign-ids.mjs --data <dir>`. It gives each one an id, once.
- Never edit, renumber or reuse an id. Reordering, inserting and deleting leave every other id alone, and `usedIds`
  remembers deleted ones.
- Rewording keeps the id; splitting keeps it on the part that keeps the meaning.
- Moving a section to another chapter keeps its ids. Prefixes record where an id was born, not where it lives.
- Plans and tests refer to requirements by id.

Frame ids are `<chapter>-<section>-<n>`, unique, and never change.

Notes, reviews, requests and media are keyed by stable ids (requirement, frame, `<chapter>-<section>`), so renaming one
orphans them. A removed requirement's id is never reused; its decision names it.

## review.json

The review state, kept with the book (committed), written through the server and `review.mjs`. Every reviewable item
stays under review until the reader accepts it, however it changed (typed in the page, written by Claude from a prompt
or from a note).

```json
{
  "rev": 12,
  "accepted": { "ONB-8KAB": { "text": "…" },
                "onboarding-signin-1": { "caption": "…", "role": "signedout", "mockup": "<div…" } },
  "notes": {
    "n1k2": { "item": "ONB-8KAB", "text": "It doesn't say why…", "status": "draft | sent | answered | frozen",
              "created": "ISO", "reply": "Claude's answer when it made no change", "causes": ["DIR-4K7M"],
              "closedFor": ["ONB-8KAB"], "target": "…", "section": "…",
              "pin": { "rx": 0.4, "ry": 0.2, "ax": 120, "ay": 9, "ch": 14, "cx": 3, "cy": 9, "dx": 90, "dy": -70, "element": { "mockup": "…", "selector": "…", "text": "…", "html": "…" } } }
  },
  "tries": { "ONB-8KAB": [ { "value": { "text": "…" }, "frozenAt": "ISO", "notes": ["n1k2"] } ] },
  "opened": { "ONB-8KAB": "ISO time the review opened" },
  "where": { "DIR-9QX2": { "kind": "req", "section": "directory-people", "chapter": "directory" } }
}
```

- **Items and keys.** A requirement is keyed by its stable id (value: `text`, `change`, `today`, `reason`, the fields
  present); a frame by its frame id (`caption`, `role`, and `mockup`, the mockup file's text); a section heading by
  `<chapter-id>-<section-id>` and a chapter heading by `<chapter-id>` (`title`, `intro`). Section stage, `label`, a
  frame's `state` and decisions are not reviewed.
- **`accepted`** is an item's last accepted value. An item with none is new. A key in `accepted` that is gone from the
  book is a pending removal.
- **Under review** means the current value differs from the accepted copy, or the item has a note that is not
  `frozen` (and not `closedFor` it), or it has tries.
- **Note statuses.** `draft`: written, not sent; the page may edit and move it. `sent`: in a Revise request, read-only.
  `answered`: the Revise that carried it was filed; read-only, shown on the review until Change or Accept. `frozen`: kept
  with a try or a history entry; read-only. Only the page's `draft` notes are written by the page; the server keeps
  every other note as stored. A note's `item` is the key it was dropped on; `target`/`section` and `pin` keep its spot. In `pin`, `ch` is
  the letter of the target's shown text it was dropped on, and `cx`, `cy` the pixels from that letter's top-left, so
  the pin stays on that word wherever the line wraps; `ax`, `ay` are the pixels from the target's top-left (exact on
  a mockup); `rx`, `ry`, fractions of the target's box, are the fallback for notes made before them. `dx`, `dy` place
  the sticky from the pin.
- **Causes.** A note dropped on a section or frame is often answered by changes to other items. `causes` lists the
  keys of those items (written by `review.mjs link`); the note shows in the review stack of its own item and of each
  cause. `closedFor` lists keys whose review was accepted while the note was still open on others, so it stops
  showing there. A note is frozen when no key it is open on has a review left.
- **Tries.** Revise keeps, for each item its notes are on, the current value as `{ value, frozenAt, notes }` with the
  ids of those notes (they become `sent` and stay in `notes`). A note listed in one of its item's tries shows with that
  try, not as an open note. The page has no Change button; a note dropped on the item asks for a change. The live book is
  always the newest version. (`POST /api/change`, which freezes a try at once, remains for older pages.)
- **`opened`** is the time the server first saw the item under review (or a note's `created`). **`where`** records the
  section and chapter of each item under review so a removed one can still be placed.
- A note whose item and causes are in neither the book nor `accepted` (a never-accepted requirement Claude deleted) still
  shows: it is a review on its section (`where`, else the note's `section`, else its chapter), and Accept settles it.
- `rev` goes up on every write. A write names the `rev` it was based on and is refused as stale if that is not current.
- Notes are writable while Claude is idle or building and locked while it revises. A revise sets its notes `sent`, and
  filing it (`next-request.mjs --done`) sets them `answered`; Accept settles the notes shown on an item (deleting them once every item they touch is accepted). Revise keeps them
  with a try of the version they were about. The page's Save drops the draft notes it no longer holds, and deleting a
  never-accepted requirement forgets the notes on it.

## history.json

Every accepted review, by item key, and the changelog of builds (committed). Entries are only appended; keys are
sorted and the file is pretty-printed so one Accept is one small diff. The page loads one item's entries on demand
(`GET /api/history/<key>`); the file is never sent whole.

```json
{ "items": { "ONB-8KAB": [ { "acceptedAt": "ISO", "opened": "ISO", "kind": "review | built",
                             "before": { "text": "…" }, "after": { "text": "…" },
                             "tries": [{ "value": { "text": "…" }, "frozenAt": "ISO", "notes": [{ "text": "…" }] }],
                             "notes": [{ "text": "…", "created": "ISO", "reply": "…" }],
                             "decisions": ["DEC-7K2P"] } ] },
  "changelog": [ { "build": "2026-11-14T15-02-11Z", "date": "2026-11-14", "summary": "plain words",
                   "sections": ["onboarding-passkeys"],
                   "landed": [{ "id": "ONB-G9F9", "kind": "added | changed | removed", "text": "…" }],
                   "commits": ["abc1234"] } ] }
```

- `before: null` means the item was new; `after: null` means it was removed. A `built` entry (written by
  `build.mjs finish` for each requirement it lands) has no tries, notes or decisions.
- `decisions` are the ids of decisions whose `about` names the item and whose `date` is on or after the day the
  review opened. They are linked, never copied. When an item's current value equals the `before` of an entry, its
  review warns that it brings back replaced wording and shows those decisions.
- **Changelog.** Every finished build appends one entry (a failed or stopped build adds none; the build id guards
  against a double append). `landed` and `sections` come from `build.mjs finish`; `commits` stays `[]` (`finish` has no flag to record them, and the
  page does not show them); `summary` is the
  `--summary` text, plain words for someone who uses the app.

## requests/

One JSON file per request (git-ignored), named by time, with `status: "pending"` until it is filed.

| `kind` | Written by | Holds |
| --- | --- | --- |
| `revise` | **Revise** | `items` (every note: `noteId`, `id`, `where`, `about`, `note`, optional `element`) and `noteIds` |
| `build` | **Build** | `sections`: the `<chapter-id>-<section-id>` of every Ready section |

A file without a `kind` is a revise. `next-request.mjs --done <file>` sets `status: "handled"` and moves it to
`requests/done/`; for a revise it also sets the notes in `noteIds` to `answered` in `review.json`.

## builds/<build-id>/

One folder per build; the id is its start time. Written by `build.mjs`, read by the reader, and committed with the
build.

- `progress.json`: `id`, `startedAt`, `heartbeat`, `state` (`running | done | failed`), `reason` (when stopped),
  `sections`, `task` (`{ index, of, title, section?, req? }`) and `requirements`, keyed by id, each
  `{ status: queued | in_progress | proven | failed, section }`. At the finish a removal is `proven` when it was
  applied and `failed` when it was held back.
- `calls.json`: `{ "calls": [{ id, about, section, title, body, before, after, status: pending | accepted | rejected,
  note }] }`. `before` is the requirement as approved and `after` is what was built. Accepting a call writes a
  decision (`by: "build"`). Rejecting one needs a note: the requirement gets `change` again with `before` as its
  text and `after` as `today`, its section goes back to `drafting`, the note becomes a `draft` note on the requirement in `review.json`, and
  a `rejected` decision is written (the note HTML-escaped in its body).
- `summary.md`: what was built, what went back to drafting and why, and the commits made.

A build is stale when its heartbeat is more than 10 minutes old while `state` is `running`. A pending build request
with no running build is stale when 10 minutes have passed since it was written and since the last heartbeat of any
build started after it. **Mark as stopped** in the reader fails a running build and files every pending build
request (`requests/done/`); `next-request.mjs --done` on a request already filed that way says so and succeeds.

## Older files

A book from before the review flow has `notes.json` and `revise/before.json`. The server (on start) and
`migrate-book.mjs` turn them into `review.json` and `history.json` and delete them: the baseline's items become
`accepted` (including marks accepted one at a time), so everything still marked becomes an open review, and every note
becomes a `draft` note. The git-ignore lines for them are removed. The `*.tmp` files atomic writes leave for a moment
stay git-ignored.

## E2E result file

A chapter's e2e run writes one result file per chapter into a directory of JSON files:

```json
{ "chapter": "onboarding", "video": "media/e2e/onboarding.mov", "runAt": "ISO time",
  "blocks": [{ "id": "ONB-GH94", "title": "what it proves", "start": 1.5, "end": 4,
               "status": "passed | failed | not_run", "screenshot": "media/e2e/ONB-GH94.png", "error": null }] }
```

- `video` and `screenshot` are paths relative to the data folder (`media/e2e/onboarding.mov`,
  `media/e2e/ONB-GH94.png` or `media/e2e/ONB-GH94.failed.png`).
- `start`/`end` are seconds from the start of the video.
- `error` is a string or null.

Blocks are linked to requirements through these files, not through scanning.

## evidence/evidence.json

Written by `collect-evidence.mjs`. `GET /api/book` returns its contents as `evidence` (`{}` when the file does not
exist).

```json
{
  "generatedAt": "ISO time",
  "unknownIds": [{ "id": "ZZZ-9999", "file": "path", "title": "test title" }],
  "byId": {
    "ONB-S5U2": {
      "unit": [{ "file": "path", "title": "[ONB-S5U2] …", "status": "passed | failed | unknown" }],
      "e2e": [{ "chapter": "onboarding", "title": "…", "video": "media/e2e/onboarding.mov", "start": 1.5, "end": 4,
                "status": "passed | failed | not_run", "screenshot": "media/e2e/ONB-S5U2.png", "error": null }]
    }
  }
}
```

`unknownIds` are ids found in tests (or e2e result files) that are not a requirement, decision or call id in
`book.json`. A requirement is proven when any unit or e2e result naming it has `status: "passed"`.
