# Stop in the Claude Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner stop a Revise or Build from the Claude menu, putting notes back to drafts and unlocking the book.

**Architecture:** The server withdraws the oldest pending request (`stopRequest` in `plugin/server/lib/requests.mjs`,
`POST /api/claude/stop`); the reader shows the running row with Stop and an inline question; the revise and build
skills poll `next-request.mjs --check` and stop when withdrawn.

**Tech Stack:** Node (ESM, `node --test`), plain browser JavaScript (ES5 style), Playwright smoke tests.

**Spec:** `docs/superpowers/specs/2026-11-15-stop-claude-design.md`; mockup `docs/mockups/2026-11-15-claude-stop.html`.

## Global Constraints

- Every menu fits a 390-pixel screen; phone targets at least 44 by 44 points.
- No inline handlers or `eval` (share page CSP `script-src 'self'`); book and note text through `textContent`.
- Guests cannot stop (the server's `guestMay` already refuses guest POSTs; the menu is hidden for guests).
- Copy, verbatim: `Stop`, `Stop revising?`, `Stop the build?`, `Keep going`, `Stop revising`, `Stop the build`,
  `Waiting for Claude to finish.`, toast `Stopped. Your N notes are drafts again.` / `Stopped the build.`
- US English.

## Review Focus

- Stop pressed after Claude already filed the request (race): the server answers 409 `idle`; the reader says
  `Claude had already finished.` and refreshes. Test in Task 1 (server) and Task 2 (reader route stub).
- A revise whose notes were edited by Claude's replies or already answered: only notes still `sent` go back to
  `draft`; `answered` ones stay. Test in Task 1.
- `--done` on a stopped request must not mark its notes answered. Test in Task 1.
- Stop on a stale build request with no build: withdrawn like a pending one. Test in Task 1.
- The question open while Claude finishes on its own: the menu redraws to idle and the question goes away. Task 2.

---

### Task 1: Withdraw a request on the server

**Files:** Modify `plugin/server/lib/requests.mjs`, `plugin/server/lib/claude-state.mjs`, `plugin/server/serve.mjs`,
`plugin/server/next-request.mjs`. Test `plugin/server/lib/requests.test.mjs` (new), `plugin/server/serve.test.mjs`.

**Interfaces — produces:**
- `stopRequest(data, now = Date.now()) -> { stopped: 'revise'|'build', count: number } | null` (null when nothing is
  pending). Revise: notes in `noteIds` with status `sent` → `draft`; drop the last try of each item whose `notes` are
  all in `noteIds`; request `status: 'stopped'`, `stoppedAt`, moved to `requests/done/`. Build: a running build →
  `stopBuild(data, id, 'Stopped in the reader')`; every pending build request filed as `stopped`. `count` = notes put
  back, or sections in the request.
- `fileRequest` leaves a `stopped` request alone (returns false).
- `claudeState(...).sent = { kind, at, count } | null` from the oldest pending request (`count`: `items.length` or
  `sections.length`).
- `POST /api/claude/stop` → 200 `{ stopped, count }`, 409 `{ error: 'idle' }`.
- `next-request.mjs --check <file>` prints `pending` or `stopped` (anything not pending under `requests/`).

- [ ] Tests (requests.test.mjs): `stopRequest puts a revise's sent notes back to drafts and drops their tries`;
  `stopRequest leaves answered notes alone`; `a stopped revise filed with --done keeps its notes drafts`;
  `stopRequest stops a running build and files its request`; `stopRequest withdraws a build request with no build`;
  `stopRequest returns null when nothing is pending`. serve.test.mjs: `POST /api/claude/stop answers 409 idle when
  nothing runs`, `a guest cannot stop`, `/api/claude carries sent`.
- [ ] Run `node --test plugin/server/` — FAIL; implement; PASS. Commit `feat(server): stop a Revise or Build`.

### Task 2: Stop in the Claude menu

**Files:** Modify `plugin/app/index.html`, `plugin/app/book.js` (`showClaude`, the Claude group), `plugin/app/book.css`.
Test `plugin/test/reader.smoke.mjs`.

- [ ] Smoke checks: `while Claude revises, the menu shows Revise running with Stop, and Stop asks before it stops`
  (send 2 notes; menu shows `.claude-act.running` with `Revising` and `.claude-stop`; Build small says
  `Waiting for Claude to finish.`; Stop shows `.claude-ask` with `Stop revising?`; Keep going closes it, nothing
  changes; Stop revising → toast `Stopped. Your 2 notes are drafts again.`, `requests/` has no pending file, both notes
  `draft`, Revise enabled again, notes unlocked); `Stop the build stops a build` (start one with `build.mjs start`,
  Stop the build → progress `failed`, toast `Stopped the build.`); `a stop the server refuses says Claude had already
  finished` (route 409 idle); `on a phone Stop and its answers are 44 points tall`.
- [ ] Run — FAIL; implement (the running row replaces the action's own text while busy; Esc closes the question first);
  PASS. Commit `feat(reader): Stop in the Claude menu`.

### Task 3: The skills notice, docs, republish

**Files:** `plugin/skills/revise/SKILL.md`, `plugin/skills/build/SKILL.md`, `plugin/reference/reader.md`,
`server/public/r/1.0.0/` (via `node server/publish-reader.mjs --force`). Test: the full run.

- [ ] Revise: before step 3's questions end and before each section in step 4, `next-request.mjs --check <file>`; on
  `stopped`, stop, tell the user what was already changed, re-arm the watch. Build: the same before each task; on
  `stopped`, do not call `stop` (the reader did) and do not `finish`.
- [ ] reader.md: the running row, Stop and what it does. Republish; `node --test plugin/server/ server/src/
  server/publish-reader.test.mjs` and both smoke tests pass. Commit `docs: Stop in the Claude menu; republish 1.0.0`.
