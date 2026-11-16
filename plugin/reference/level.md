# The right level for a spec book

The book is the project's memory and guide: what the app does, why, the rules it follows, and the proof that it
works. It is not a second copy of the code. Use this page whenever you write or revise the book, and say so when
something someone asks for belongs at another level.

## The two tests

- **The newcomer test (does it belong?).** Would Claude, or a sharp engineer new to the project, get this wrong
  without being told? Then it goes in the book. If the code answers it plainly, the book links to the code instead.
- **The refactor test (is it too detailed?).** If a refactor that changes no behavior would force an edit to the
  book, the book is too detailed there. Move that detail back into the code.

A third test catches the opposite mistake. **The two-builders test (is it too vague?):** if two careful builders
could read it and build things a user would tell apart, it needs more detail.

## What each part of the book holds

| Part | Write | Never write |
| --- | --- | --- |
| Requirement | What a person (or another system) can observe: the rule, its numbers ("30 seconds"), its fixed words quoted exactly, who it applies to | Function, variable or type names; the steps the code takes; library calls |
| Screen, component | Its name and file, the variables that change its picture (role, data, filter), how each combination looks, the combinations its requirements imply that are not drawn | Its props, its hooks, how it fetches data; a variable that is code state, not something a person sees |
| Decision | What was settled, why, and what was rejected | The diff that carried it out |
| Architecture (future) | The layers and what may call what ("the mobile app never talks to the database"), the conventions a newcomer would break | Folder-by-folder structure, class diagrams, anything a tool can draw from the code |
| Data model (future) | The things the app keeps, what they mean, who owns them, the rules they always obey ("an invite is used once") | Columns, types, indexes, migrations |
| Proof | Generated: tests, screenshots, recordings, source files. Linked, never written by hand | |

## Warning signs

**Too detailed (writing code in prose):** sequences ("first…, then…, then…"); names of internal functions, classes or
tables; types and fields; anything that reads like pseudocode; describing how something works when only what it
does matters.

**Too vague:** words like "properly", "quickly", "user-friendly", "handles errors"; no number where a number matters;
no role where roles see different things; a rule no test could check.

## Where to write more

A few areas deserve more detail than the tests above ask for, because a mistake there is costly and a passing test
is not enough: **who can see or do what** (permissions), **personal data**, **money**, and **deleting or losing
things**. Spell these out fully, and mark them so the user reviews them in person.

## What is generated, not written

Anything a tool can produce from the code is generated, not written, so it can never drift: which files implement a
requirement, which tests prove it, the data model drawn from the schema, which screen calls which endpoint. Build
regenerates these. The book stores only what people decide.
