# Future: milestones and building the app a piece at a time

Status: exploration, not agreed. Nothing here is built yet.

## The problem

A spec book covers the whole app, and a real one can grow to ten or more large sections. Most of the time we don't
want to build all of it at once. We want to pick a few sections (or part of one), build them, try the result, and
then pick the next few.

What the book does today:

- Each section has a `stage`. Only sections marked **Ready** are built, and **Build** builds *every* Ready section
  at once.
- Only accepted work is built. A section can't be marked Ready while it has an open review, and Build refuses a
  Ready section that was edited after that (`unreviewed`).
- A section can carry a free-text `label` ("Phase 2"), shown on its pill. Nothing reads it: it doesn't group,
  filter, order or limit anything.

So today the only way to build less is to keep the other sections in Drafting. That works for a small book but falls
short for a large one:

- Ready has two meanings: "this spec is agreed" and "build it next". Agreeing a section's spec early forces it into
  the next build.
- Build has no way to take only part of a section. A large section gets built all at once or not at all.
- Nothing records the plan, such as "M1: sign in and join a community; M2: the directory". That order lives in our
  heads, or in `label` text nothing checks.
- Nothing shows progress toward a release (how much of M1 is built and proven).

## Options, smallest first

### A. Pick sections in the Build dialog

The Build screen already lists the Ready sections. Give each one a checkbox (all checked by default), and have
`POST /api/build` take `sections`. Today `build.mjs start` builds every Ready section, whatever the request names, so it would need a
`--sections` flag that limits it to the request's sections.

- Separates "agreed" from "build now" for one build at a time.
- Very little code: the dialog, the request body, and `start --sections`.
- Doesn't record a plan or slice a section.

### B. Milestones as a first-class list

Add a list of milestones to `book.json`, each naming the sections it covers:

```json
"milestones": [
  { "id": "m1", "title": "Join and sign in", "goal": "A new person can join a community from an invite.",
    "sections": ["onboarding-signin", "onboarding-invite"] },
  { "id": "m2", "title": "Directory", "goal": "Members can find each other.",
    "sections": ["directory-people"] }
]
```

- The order of the list is the build order. It replaces `label`; a migration turns each distinct label into a
  milestone.
- **Build next milestone** builds the first milestone that isn't built yet. Ready keeps one meaning, "the spec is
  agreed"; a milestone builds once all its sections are Ready (accepted).
- The reader gets a milestone filter (Only M1) and a progress strip per milestone: sections Built, requirements
  proven out of total, from `evidence.json`.
- The changelog groups its entries by milestone, which gives release notes for free.
- Milestones are reviewed like everything else: adding, reordering or changing one opens a review to ✓ Accept.

### C. Slice a section across milestones

Let a single requirement carry `"milestone": "m2"`, overriding its section's milestone. A large section such as
"Joining a community" can then ship its core in M1 (enter the code, resend) and its extras in M2 (rate limits,
error copy).

- Build's scope is "the changes in this milestone", not "every change in these sections".
- A section can be partly built. Its pill already handles this case: `Built · 2 changes drafting`. The frames need
  care: a mockup shows the finished design, so the build should note which parts belong to a later milestone.
- This is the most powerful option and the most complex. Tests and evidence already work per requirement, so
  they need no change.

### D. Dependencies between milestones

`"after": ["m1"]` on a milestone. Build refuses to start a milestone whose prerequisites aren't built, and the reader
draws the milestones as a short roadmap. This is probably unnecessary while the list order already says what comes
first; add it only if milestones start being built out of order.

## Recommendation

1. **Do A now.** It's small, solves the immediate problem ("build only these three sections"), and nothing in B or
   C throws it away.
2. **Then B**, when a book has more than a handful of sections. Ready means "agreed", milestones mean "when", and
   Build builds the next milestone. Retire `label`.
3. **C only when a real section needs splitting.** Design it against that case rather than in the abstract.
4. Leave D out unless order alone stops being enough.

## How it fits what exists

- **The Accept gate stays.** Whatever is picked (sections, a milestone or a slice), only accepted items are built.
- **Design** proposes milestones when it lays out a new book: a thin first milestone that runs end to end (sign in,
  one screen, real data) before going wide.
- **Revise** can move items between milestones from notes ("push this to M2"), and the move is reviewed like any
  other change.
- **Build** writes the milestone id into `progress.json` and the changelog entry, and `summary.md` reports the
  milestone's progress, not only the build's own.
- **Evidence** needs no change: it's keyed by requirement id, and a milestone's progress is a rollup.

## Open questions

- Should a milestone be allowed to name a section that's still Drafting, with Build waiting until it's Ready? Or
  should adding a section to a milestone require it to be Ready?
- When a built milestone's section gets a new change, does the change join that milestone again, or the next one
  by default?
- Should guests on a shared book see milestones and progress? Probably yes, read-only.
- Is a milestone also a git boundary (one branch or one PR per milestone) instead of one per build?

# Future: the whole app, built and validated from the book

Why: a project is thousands of details and decisions, and they are very hard to keep track of. The book is where
they live, in any project, so it can guide Claude in building and improving that project. It is not a blueprint for
rebuilding the app from scratch.

The goal: build and validate the entire app from the spec book alone. Today the book holds what the app does
(chapters, requirements, screens). To get there, it also has to hold how the app is built: the layers (database,
api, web, mobile), the data model, each app's structure and conventions. Those would be reviewed and accepted like
requirements and proven by Build like requirements, and requirements would trace through them to source files and
tests.

The planned order:

1. **Screens and components** (`docs/superpowers/specs/2026-11-15-screens-and-components-design.md`).
2. **Requirement states**: New, Inferred (written down from an app that already works), changed by a note; once
   accepted, the facts it has (screens, built, unit and e2e results, screenshots, recordings).
3. **The requirement detail page**: source files (recorded by Build; inferred once for existing code from the code
   and from test coverage), each unit test with its line, e2e runs, screenshots and recordings.
4. **How the app is built**: layers, data model and each app's construction in the book, linked to the source files
   piece 3 records. It goes as deep as Claude needs to change the project correctly: the layers and what belongs in
   each, the data model, the conventions and the decisions behind them, each with a stable id Claude cites. Not a
   full blueprint. Open: what "validated" means for architecture (checks Build runs?), and whether the book replaces
   a project's `ARCHITECTURE.md` and feature specs or imports them. Today the design skill keeps the project's
   written spec as the source of truth; this piece would reverse that.
