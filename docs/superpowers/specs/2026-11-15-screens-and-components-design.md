# Screens and components

Status: design, for approval. The first of three pieces of work: (1) screens and components, then (2) requirement states
(New, Inferred, changed by a note; facts once accepted), then (3) the requirement detail page (source files, tests with
lines, e2e runs, screenshots, recordings). Pieces 2 and 3 get their own designs.

## Intent

A spec book draws the app as frames, and a frame belongs to one section. A real app reuses its screens: Home appears
in three sections of the Tribes book, as identical copies, and "Home · admin", "People" and "Calendar" do the same.
Six screen names appear in two sections each; 78 frames draw what 28 screen files render. Copies drift, and there is
no place to ask "what does this screen do, for everyone?"

The book gets a second way to look at the app, **Screens**. Every screen (and every shared component: card, dialog,
sheet, banner) is listed once, named by its component and file, drawn once per state, and shows every requirement
about it, grouped by the book's chapters and sections. The chapters keep telling the story of how a person meets the
app, but every picture in them is one of those single drawings, never a copy.

## Goals

- Every screen and component is drawn once. Changing a drawing changes it everywhere it is shown.
- A screen's page shows its states, the requirements about it (grouped by chapter, then section), and for a component,
  every screen state that uses it.
- A requirement names the screens or components it is about (a list), each optionally narrowed to one state.
- The model is the same for any app: screens, components, states, conditions. Nothing assumes the app's file naming.
- The Tribes book is converted to it once, keeping its accepted reviews, notes and history.

## Non-goals

- Requirement states (Inferred), the requirement detail page, source links: pieces 2 and 3.
- Finding screens by scanning the code.
- A general upgrade path for other books. No other book has been published; the starter and the Tribes book are
  converted, `migrate-book.mjs` is not extended.
- Splitting the book into one file per screen (option B, rejected below).

## Anti-goals

- Anything drawn twice, in the book or in the converted Tribes book.
- A conversion that loses an accepted review, a note or a history entry, or that puts the 36 built sections of Tribes
  back under review.
- A Screens view that does not fit a 390px phone.

## Approaches

- **A. Screens inside `book.json` (chosen by the user).** A top-level `screens` list beside `chapters`. Review,
  stable ids, Revise's working copy, landing and the Accept gate keep reading one file. Cost: a bigger `book.json`.
- **B. One folder per screen** (`screens/<Screen>/screen.json` with its pictures). Smaller files, edits to different
  screens never collide, but review, the working copy, landing and the conversion would all learn a second place the
  book lives, for a book only one session edits at a time. Rejected.
- **C. Screens found by scanning `*Screen.tsx`.** Dropped: the plugin cannot assume an app's naming, and screens
  not built yet have no file.

## The model

### Screens and components

```json
"screens": [
  { "id": "SCR-4K7M", "name": "HomeScreen", "kind": "screen", "file": "packages/mobile/src/features/messages/HomeScreen/HomeScreen.tsx",
    "intro": "HTML, optional",
    "states": [
      { "id": "member",  "name": "Member",  "when": { "role": "member" },  "mockup": "mockups/screens/HomeScreen/member.html" },
      { "id": "admin",   "name": "Admin",   "when": { "role": "admin" },   "mockup": "mockups/screens/HomeScreen/admin.html" },
      { "id": "visitor", "name": "Visitor", "when": { "role": "visitor" }, "sameAs": "member" },
      { "id": "empty",   "name": "Empty",   "when": { "role": "member", "also": "no messages yet" }, "mockup": "…" },
      { "id": "signedout", "name": "Signed out", "when": { "role": "signedout" }, "absent": "Signed-out people never reach Home." }
    ] },
  { "id": "SCR-9QX2", "name": "VisitorsCard", "kind": "component", "file": "…/VisitorsCard.tsx",
    "states": [
      { "id": "waiting", "name": "3 waiting", "when": { "also": "visitors waiting" }, "mockup": "mockups/screens/VisitorsCard/waiting.html" },
      { "id": "none",    "name": "None waiting", "when": { "also": "nobody waiting" }, "mockup": "…" }
    ] }
]
```

- **`id`** is a stable id minted like a requirement's (`SCR-` and four characters, by `assign-ids.mjs`), never
  edited or reused. Everything links to it: requirements, sections, `sb-component` tags, reviews, notes, media. **`name`**
  is the component name, shown everywhere in the reader. Renaming a component changes only `name` and `file` (a
  reviewed change, like any other): no link breaks and nothing else in the book changes. A screen not built yet gets
  the name we choose; Build fills in `file` when it creates it. A screen with no app component (the lock-screen
  notification, the system permission prompt, the splash screen) is an ordinary screen with a chosen name and no
  `file`. Names are unique in the book, so a reader or Claude can look one up.
- **`kind`** is `screen` or `component` (a card, dialog, sheet, banner, header: anything placed on several screens). A screen
  is a component too in React terms; `component` here means one that is placed inside screens rather than navigated to.
- **A state** is one picture and the conditions that produce it. `when.role` names one of the book's `roles` (the one
  condition the reader understands); `when.also` is free words for everything else (data, errors, connection). A
  state's key is `<screen-id>.<state-id>` (`SCR-4K7M.admin`), unique in the book. `when.role: "anyone"` (a role the
  book defines for everyone) covers every role.
- **`sameAs`** names another state of the same screen: the state looks exactly like it and has no picture of its
  own. No chains to a state that is itself `sameAs`, and no cycles.
- **`absent`** says a role never sees the screen, in words; it has no picture. It keeps the role visible as an
  honest empty entry.
- **Missing roles.** For a `screen` (not a component), the Screens view shows a quiet hint for every book role no state
  covers: "No state for Visitor: same as another, or doesn't see it?" It is a hint, not a review. The design skill
  resolves the hints on screens it draws; the conversion invents none.
- **A change to a built screen.** A state can carry a proposed picture beside today's, the way a requirement carries
  its target text and `today`: `"change": "change", "mockup": "<the proposed picture>", "today": "<today's picture
  file>"`. A new state is `"change": "add"`; a state going away is `"change": "remove"` with a `reason`. Wherever the
  state is shown it reads as a pending change, today's picture beside the proposed one. Build drops `today` and
  `change` when it is built, as it does for requirements. This replaces a frame's `"state": "proposed"`.

### Components placed by name

A picture places a component with a tag instead of copying its drawing:

```html
<sb-component id="SCR-9QX2" state="waiting"></sb-component>
```

The reader replaces the tag with that component state's picture before rendering the mockup into its shadow root (components
may place components; a cycle, a missing component or a missing state renders a visible red placeholder naming it). "Used on"
for a component is computed by scanning pictures for its tags, so it is never stored and never drifts.

### Requirements point at screens

```json
{ "id": "SHL-3H7K", "text": "Going offline shows the **Offline** banner",
  "screens": [{ "screen": "SCR-2HD8" }] }
{ "id": "HOM-2P8C", "text": "**Admins** see the Visitors card at the top of Home",
  "screens": [{ "screen": "SCR-4K7M", "state": "admin" }] }
```

`screens` is optional and a list; each entry names a screen or component, optionally narrowed to a state. A requirement on
a component reaches every screen that uses it through "Used on"; list screens only when the rule is about those particular
screens. A requirement still lives in exactly one section.

### Sections show states

`frames` is gone. A section lists the states it shows, in order, optionally outlining a component in them:

```json
"shows": [
  { "state": "SCR-4K7M.member", "highlight": "SCR-7T3N" },
  { "state": "SCR-5W1B.member" }
]
```

The chapter view draws each as today's frame was drawn (caption `<screen name> · <state name>`, from the screen, never
typed again), with the highlighted component outlined. A state shown by several sections is the same drawing in each.

### Reviews, notes and the Accept gate

- **Reviewable items:** a screen heading (key `SCR-4K7M`; value `name`, `kind`, `file`, `intro`), each state (key
  `SCR-4K7M.admin`; value `name`, `when`, `sameAs`, `absent`, `change`, `today`, `reason`, and the mockups' text), requirements as today
  (`screens` joins their value), sections as today plus their `shows` list. Frames as items are gone.
- **The Accept gate** for a section (Ready and Build) covers what it has today plus every state it shows and every
  component state placed in those (followed through `sameAs` and nested components), and the screen headings of those states.
- **Notes** dropped on a shown picture go on the innermost thing under the pin: a component state if the pin is inside a
  placed component, otherwise the shown state. The note's `section` still records where it was dropped. Notes can also be
  dropped in the Screens view.
- **Media:** a state's screenshot is `media/screens/<screen-id>.<state-id>.png` (or `.jpg`, `.webp`). Recordings stay
  per section. Evidence (`evidence.json`) is per requirement and does not change.

### Validity (what `land` and the server check)

The book parses; screen ids are unique; state ids are unique within a screen; every state has exactly one of
`mockup`, `sameAs`, `absent`; every `mockup` exists; `sameAs` targets exist, are not `sameAs` themselves and form no
cycle; `when.role` is a book role; every `sb-component` tag names an existing component and state; every requirement `screens`
entry and every section `shows` entry names an existing screen, component and state; every `highlight` names a component placed
in that state's picture.

## The Screens view

The bar gets a view switch: **Book · Screens**.

```
Screens                                    [ Screens 28 · Components 9 ]
HomeScreen          features/messages/HomeScreen/HomeScreen.tsx
  States    [Member] [Admin] [Visitor = Member] [Empty] [Signed out: never reaches Home]
  Requirements
    Onboarding › Joining a community
      ONB-8KAB  …
    The shell › Home
      HOM-2P8C  Admins see the Visitors card at the top of Home   (Admin)
VisitorsCard (component) features/directory/VisitorsCard.tsx
  States    [3 waiting] [None waiting]
  Requirements  …
  Used on   HomeScreen · Admin [thumb, card outlined]   PeopleScreen · Admin [thumb]
```

- A list of screens, then components, each opening its page; every page and state has its own URL hash so it can be
  linked (`#screen/SCR-4K7M.admin`).
- States in a row, laid out by role when their conditions name one; on a phone they stack.
- Requirements grouped by chapter, then section, in book order, each showing which state it narrows to. A requirement
  reached through a component says so ("via OfflineBanner").
- Reviews, notes and ✓ Accept work here exactly as in the chapter view.
- In the chapter view, each requirement with `screens` shows small chips (`HomeScreen · Admin`) linking to the
  Screens view.

## The Tribes conversion (one-off)

A script in the session's scratch folder, run once, not shipped in the plugin:

1. Group the 78 frames into screens: identical mockup text is one state; frames are mapped to screens by their
   caption and by reading the app's screen files (28 `*Screen.tsx`), with the mapping table shown to the user before
   writing. Branded pictures become states of their normal screens (`when.also: "branded community"`).
2. Components: markup becomes a component only where its copies are byte-identical, so every built picture renders exactly as
   before. This covers the tab bar and header (each version a component state) and the cards and dialogs that repeat
   exactly. Copies that are close but not identical stay separate and are listed for the user to merge later through
   normal review.
3. The 10 frames marked `"state": "proposed"` become states with `change` and `today` where they redraw a built
   screen, or `change: "add"` where they draw a new one.
4. Sections get `shows` in their old frame order; requirements get `screens` where the section's frames make it
   clear (anything unclear is left without, and listed for the user).
5. `review.json`: each old frame key's accepted copy, `opened` and `where` move to its state key (the builder check
   found no notes, tries, history or decisions on frames today). A state made from several identical accepted frames is accepted. Built sections
   must come out with no open review caused by the conversion alone (one frame, `communities-offline-1`, is already
   under review and stays so): the script checks this and stops if not.
6. Media renamed to the state keys. The result is reviewed in the reader before it is committed.

## The plugin changes this touches

- `app/model.js` (items, reviews), `app/book.js` (chapter view drawing from states, the Screens view, chips,
  `sb-component` rendering, notes inside components), `app/book.css` (390px).
- `server/assign-ids.mjs` (`SCR` ids), `server/lib/builds.mjs` (finish drops a state's `today` and `change`),
  `server/lib/work.mjs` (validity), `server/lib/review.mjs` (`sectionsUnderReview` follows shown states and components),
  `server/serve.mjs` (media names), `server/add-media.mjs` (`--screen <screen-id>.<state-id>`).
- `starter/` converted (todo app: screens and one component).
- `reference/book-format.md`, `reference/reader.md`, the `design` and `build` skills (draw screens and components once;
  point requirements at them; resolve missing roles).

## Left to the builder

The exact markup and styling of the Screens view within the reader's existing look; how the highlight outline is
drawn; the URL hash scheme beyond the example; the order of screens in the list (book order of first appearance is a
sensible default).
