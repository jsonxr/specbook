# State variables

Status: approved by the owner on 2026-11-15 ("do it"). Follows the screens and components work
(`2026-11-15-screens-and-components-design.md`). The Tribes-specific review that led here is
`2026-11-15-tribes-states-proposal.md`.

## Intent

A state was named by hand and carried one condition, its role, plus free words. The conversion produced names like
"Member: Member" and "Member: Header" that mean nothing to a reader. The owner's model: **a screen has named state
variables, and `role` is just one of them**, with the values admin, member, visitor and the rest. A screen can have
several variables (connection, data, an open sheet, which view). A picture is one combination of values, and its
caption says only what makes it different.

## Goals

- The book declares shared variables once; a screen or component lists the variables it uses and may add its own.
- A state's `when` is a set of variable = value pairs. A variable left out means **any**.
- The caption is computed: the role pill, then the labels of the values that are not defaults, joined by ", ".
  When only the role differs the caption is **the pill alone**. A typed `name` stays possible as an override for the
  rare case that reads badly, and is normally absent.
- The Screens view shows each screen's variables and a coverage list: every combination that is drawn, same as
  another, absent, or listed as **not drawn** (with the requirements that imply it).
- The Tribes book is re-described this way, with its cards and offline pill as components, and the agreed undrawn
  pictures drawn.

## Non-goals

- Renaming state ids. **Ids never change**; only `when`, `name` and captions do. An id may no longer read like its
  caption (Home's `member` is the member who has not shared yet); that is accepted.
- A general upgrade path for other books (none are published).
- Drawing every implied combination: only the agreed list; the rest are listed as not drawn.

## Anti-goals

- Typing a name that repeats the role or invents a word ("Header", "Default").
- Losing an accepted review, a note or a picture in the re-description.

## Approaches

- **Variables in the book, computed captions (chosen).** Declared once, used everywhere, checked by validity.
- **Keep free-text `also` and only improve names by hand.** Rejected: it is how "Header" happened, and nothing can
  check or show coverage.
- **Variables per screen only, nothing shared.** Rejected: `role`, `connection`, `data` mean the same everywhere and
  the owner reads across screens.

## The format

```json
"variables": [
  { "id": "connection", "label": "Connection",
    "values": [{ "id": "online", "label": "Online" }, { "id": "offline", "label": "Offline" },
               { "id": "unreachable", "label": "Server unreachable" }] },
  { "id": "data", "label": "Data", "values": [{ "id": "some", "label": "Has items" }, { "id": "empty", "label": "Empty" }] }
]
```

- **Book `variables`**: id, label, values in order; **the first value is the default**. `role` is built in: its
  values are the book's `roles` (no default; the role is always shown as the pill).
- **Screen `variables`**: the ids it uses, in caption order, e.g. `["role", "sharing", "connection"]`. A screen may
  declare its own variable inline: `{ "id": "view", "label": "View", "values": [...] }` in the same list. A component
  lists its own (`tab`, `logo`) and has no role.
- **State `when`**: `{ "role": "member", "sharing": "notshared" }`. Left out = any. `when.role` may be a list for an
  `absent` or `sameAs` state ("signed out, visitor and member never reach this").
- **`also`**: optional free words, shown on the screen's page, never in the caption.
- **`name`**: optional override of the computed caption.
- **Screen `undrawn`**: `[{ "when": {...}, "about": ["HOM-G74T"], "note": "No groups yet" }]`, the combinations a
  requirement implies that have no picture.
- **Defaults and checks**: a screen with no `variables` list is validated as if it listed `["role"]` (a component, `[]`); a `variables` that is not a list, or a variable listed twice (an inline one shadowing a book variable included), is invalid.
- **Caption**: role pill (from `when.role`; "Anyone" for `anyone`; several pills for a list), then the labels of the
  non-default values of the screen's other variables, in the screen's variable order. A component's caption is its
  values' labels (all values, defaults included, since a component has no pill).

## Validity (added to `screenProblem`)

Every variable in a screen's list is declared (book or inline); every key in a state's `when` is in its screen's list
(`role` included); every value is one of that variable's values (role values are the book's roles or `anyone`); no
two drawn states of one screen have the same `when`; a list-valued `role` only on `absent` or `sameAs` states;
`undrawn` entries use declared variables and values, and name existing requirement ids.

## Reader

- Captions everywhere (book, Screens list, screen page, chips, review labels) use the computed caption.
- The screen page gains a **Variables** line (each variable and its values) and a **Coverage** list: one line per
  combination that has a picture, is same as another, is absent, or is not drawn (with its requirement ids). It
  replaces the "No state for <Role>" hint.
- Reviews: a state's reviewed value is `when`, `sameAs`, `absent`, `change`, `today`, `reason`, `also`, `name` and the
  pictures. A screen's heading value gains `variables` and `undrawn`.

## Tribes

Apply the proposal (`2026-11-15-tribes-states-proposal.md`) with the owner's answers:
- Pill only when only the role differs; omitted means any; ids kept.
- Home's Public / Members / Private labels are a **planned change**: those pictures carry today's picture (labels
  removed) and the proposed one.
- The share, visitors and attention cards and the offline pill become components now; loading / failed / empty
  becomes one shared component.
- Draw the recommended undrawn combinations **except** "Home, an admin with no visitors waiting" (it shows nothing
  new: the card is simply not there). The rest are recorded as `undrawn`.
- Fix the five wrong roles. The five screens the requirements describe but the catalog lacks are recorded as
  screens with `undrawn` entries (not drawn now).
- Every changed state is a change for the owner to accept; nothing is pre-accepted except where the picture and its
  meaning are unchanged.
