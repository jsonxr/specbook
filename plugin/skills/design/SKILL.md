---
name: design
description: Use when writing or revising a spec book's chapters, sections, requirements, screens, components or phone mockups, when asked for the screens of a part of the app for every role, when laying out a new spec book for a whole app, or when a session is asked to add, change or drop a requirement, behavior or UI copy in a project that has a spec book.
---

# Designing a spec book

Write or revise the book with the user: chapters, requirements and the mockups that show them. `<dir>` is the
book's data folder (`docs/specbook/` unless the project puts it elsewhere; see `specbook`).

**Announce at start:** "Using specbook:design to design <topic>."

**REQUIRED SUB-SKILL:** superpowers:brainstorming for anything not already agreed: questions one at a time,
options with one recommendation, the user's approval before writing it down as agreed. Then edit `book.json` and
the mockups. Every edit you make (and every edit the reader makes in the page) stays under review until the reader
accepts it, so edit freely: you never record versions yourself.

**Every change must be accepted.** A change the user asks for in the terminal goes in the book the same way as one
from a note: a pending change (`change` with `today` or `reason`) in `book.json` and the mockups, which the reader
must ✓ Accept. Never touch `review.json` or `history.json`, never write an `accepted` copy, and never change app code
for it: Build does that once it is accepted and Ready. When you finish, tell the user which items now wait in
**Changes (n)** for ✓ Accept. For the shape of `book.json` and the id rules, read `${CLAUDE_PLUGIN_ROOT}/reference/book-format.md`.

**Write at the right level.** Read `${CLAUDE_PLUGIN_ROOT}/reference/level.md` before writing or revising anything:
the book holds what the app does, why, its rules and its proof, never a second copy of the code. When the user asks
for something too detailed (it would change in a refactor that changes no behavior) or too vague (two builders
would build it differently), say so and suggest the right level.

## Survey before drawing

For any part that exists, read the app first (a read-only Explore agent suits a whole app): every screen's visible
text, controls, empty and error states, the header, the tab bar, the boot path. Built sections must show what the
app really renders; changes are marked as changes.

## Order the book by how a person meets the app

Not by code or by tab. For a typical app:

1. *How to read this book*: roles, the stages, what the pills mean.
2. *Onboarding*: landing, sign in, create account, invitations, joining by link or code, no-account-yet and
   error states.
3. *The shell*: the header (with the real logo or name and the profile button), switching
   accounts/workspaces/communities, the tab bar, offline.
4. *Profile and settings.*
5. *Each tab and the major features reached from it*, in tab order (a feature reached from a tab gets its own
   chapter right after it).

## Chapter and section fields

A section has a `stage`: `drafting` (being worked out, including far-future work) or `ready` (the user approved it;
the user sets only these two), then `building` and `built` (set by a build; never write them by hand). An optional
`label` ("Phase 2") is the only extra word on its pill. A chapter's stage is derived from its sections, so it has
none; it has a short `prefix` (`ONB`, `DIR`) used for new ids. New sections are `drafting`.

## Requirements

Short, testable sentences; bold the word carrying the rule; quote fixed UI copy verbatim. A requirement always
states the target behavior.

- A requirement's `change` says what a build will do with it: `add` (new), `change` (the target, with `today`:
  what happens now) or `remove` (with a `reason`). The reader shows each as a pending change; a build drops it.
  A built section that gets a change shows as Drafting, with a pill like "Built · 2 changes drafting". A screen a
  change redraws carries it too (see **Screens and components**).
- In a section that was never built, every requirement carries `change: "add"`.
- **Never delete a built requirement.** Mark it `change: "remove"` with a `reason`; the build deletes it and records
  a `removed` decision.
- Never hide a change inside a sentence ("Change: …").
- Add new ones as plain strings, then run `assign-ids.mjs`, following the stable-id rules in
  `${CLAUDE_PLUGIN_ROOT}/reference/book-format.md` (never edit, renumber or reuse an id).
- Point a requirement at what it is about with `screens`: `[{ "screen": "SCR-…" }]`, narrowed to one state with
  `"state": "admin"` when the rule is about that state only. Name a **component** when the rule is about a reused
  piece (it reaches every screen that places it); name a **screen** when it is about that screen alone.

## Screens and components: drawn once

The book keeps one catalog, `screens`, beside `chapters` (the shape is in `book-format.md`). Every screen of the app
is an entry, and so is every piece placed on several screens. Draw each once; sections only point at the drawing.

- **A screen** is a place a person navigates to; a **component** (`kind`) is a card, dialog, sheet, banner or header
  placed inside screens. Use a component only for a piece that repeats **exactly**: if two copies differ in
  anything a reader would see, they are two states of one component or two components, never near-copies. Give each
  its component `name` (unique in the book) and, when the app has one, its `file`; a screen not built yet has no
  `file` (the build fills it in), and a screen with no app component (a system prompt, a notification) never does.
  Run `assign-ids.mjs` for the `SCR-` ids.
- **Every state is a picture and its conditions.** `when.role` is a book role or `anyone` (it covers every role
  and is always valid, even when `roles` does not list it); `when.also` is words
  for the rest (empty, error, offline, a particular data shape). A role whose picture is exactly another's is
  `"sameAs": "<state id>"` (no picture of its own, no chains); a role that never sees the screen is `"absent":
  "<words>"`, an honest entry instead of silence. States that are not roles (signed out, no account yet) are entries
  in `roles` too.
- **Resolve the missing-role hints** for every screen you draw: the Screens view hints "No state for <role>" for each
  book role no state covers. Give each a state, a `sameAs` or an `absent`, until none remain. Components get none.
- **A section shows states**, in order, as `shows: [{ "state": "SCR-….admin", "highlight": "SCR-…" }]`; `highlight`
  outlines a component placed in that picture. Never type a caption: it is `<screen name> · <state name>`, from the
  catalog. Show each role that sees something different, side by side.
- **A change to a built screen** goes on its state, like a requirement's: `"change": "change"` with `mockup` the
  proposed picture and `today` the path to a copy of today's picture; `"change": "add"` for a new state; `"change": "remove"` with a `reason` for one going away. Never edit a built picture
  in place without keeping `today`. Build drops `change` and `today` once the section is built.
- Anything someone asks to draw that already has a state is a change to that state, not a second drawing.

## Mockups

HTML fragments in `mockups/screens/<screen-id>/<state-id>.html`, built from the kit classes documented at the top
of `mockups/phone.css`; add project classes at its end. Each renders in its own shadow root, so nothing collides with
the book. A phone shows its whole screen; nothing scrolls inside it.

- Place a component with `<sb-component id="SCR-…" state="…"></sb-component>` rather than copying its markup, in
  screens and in other components (never in a cycle). Placing a missing component or state draws a red placeholder.
- **Tab screens start with the app's real header** (`.hdr` with the logo from `mockups/assets/` or the name, and
  the profile button), never an invented page title. Draw the header once as a component and place it.
- Use the project's real names, logo and data style; keep the app's fixed words generic where the app is generic.

## Decisions

`calls` are gone. Anything decided without the user, and every option rejected, goes in `decisions`, each with
`by` (`user` or `build`), `about` (the requirement, section, screen or state ids it concerns) and `kind`, so it is not
proposed again. `about` is what links a decision to the review and history of the items it settled, so always fill it in.
Write a decision when a discussion settled something (the reader changed their mind because of an argument, chose
between options, rejected one, or reversed something); an ordinary edit gets none. Read the whole list before proposing anything. Mark guesses in a caption or as a decision, never
silently.

## The project's written spec

It stays the source of truth where the project has one; the book lists it in `sources`, and the two change in the
same edit.

## Check before saying done

Reload the served page with the Chrome DevTools tools in an isolated context (the user's notes and reviews are
untouched there): every `.mock` has a shadow root containing `.phone`, no red placeholder shows, every state has a picture file or
is `sameAs` or `absent`, the Screens view shows no missing-role hint for the screens you drew, and the changed sections
read correctly in a screenshot.
