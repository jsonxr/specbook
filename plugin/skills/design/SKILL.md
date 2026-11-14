---
name: design
description: Use when writing or revising a spec book's chapters, sections, requirements, frames or phone mockups, when asked for the screens of a part of the app for every role, or when laying out a new spec book for a whole app.
---

# Designing a spec book

Write or revise the book with the user: chapters, requirements and the mockups that show them. `<dir>` is the
book's data folder (`docs/specbook/` unless the project puts it elsewhere; see `specbook`).

**Announce at start:** "Using specbook:design to design <topic>."

**REQUIRED SUB-SKILL:** superpowers:brainstorming for anything not already agreed: questions one at a time,
options with one recommendation, the user's approval before writing it down as agreed. Then edit `book.json` and
the mockups. Every edit you make (and every edit the reader makes in the page) stays under review until the reader
accepts it, so edit freely: you never record versions yourself. For the shape of `book.json` and the id rules, read `${CLAUDE_PLUGIN_ROOT}/reference/book-format.md`.

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
  Mark a frame that draws the new design `"state": "proposed"`. A built section that gets a change shows as
  Drafting, with a pill like "Built · 2 changes drafting".
- In a section that was never built, every requirement carries `change: "add"`.
- **Never delete a built requirement.** Mark it `change: "remove"` with a `reason`; the build deletes it and records
  a `removed` decision.
- Never hide a change inside a sentence ("Change: …").
- Add new ones as plain strings, then run `assign-ids.mjs`, following the stable-id rules in
  `${CLAUDE_PLUGIN_ROOT}/reference/book-format.md` (never edit, renumber or reuse an id).

## Frames: every screen for every role

A section shows each role that sees something different as its own frame, side by side, captioned
"<Screen> · <role>". A role that sees nothing gets a frame saying so. States that are not roles (signed out, no
account yet) are entries in `roles` too, so they get honest tags. Frame ids follow the rule in `book-format.md`.

## Mockups

HTML fragments in `mockups/<frame-id>.html`, built from the kit classes documented at the top of
`mockups/phone.css`; add project classes at its end. Each renders in its own shadow root, so nothing collides with
the book. A phone shows its whole screen; nothing scrolls inside it.

- **Tab screens start with the app's real header** (`.hdr` with the logo from `mockups/assets/` or the name, and
  the profile button), never an invented page title.
- Use the project's real names, logo and data style; keep the app's fixed words generic where the app is generic.

## Decisions

`calls` are gone. Anything decided without the user, and every option rejected, goes in `decisions`, each with
`by` (`user` or `build`), `about` (the requirement, section or frame ids it concerns) and `kind`, so it is not
proposed again. `about` is what links a decision to the review and history of the items it settled, so always fill it in.
Write a decision when a discussion settled something (the reader changed their mind because of an argument, chose
between options, rejected one, or reversed something); an ordinary edit gets none. Read the whole list before proposing anything. Mark guesses in a caption or as a decision, never
silently.

## The project's written spec

It stays the source of truth where the project has one; the book lists it in `sources`, and the two change in the
same edit.

## Check before saying done

Reload the served page with the Chrome DevTools tools in an isolated context (the user's notes and reviews are
untouched there): every `.mock` has a shadow root containing `.phone`, frame ids are unique, every mockup file exists, and
the changed sections read correctly in a screenshot.
