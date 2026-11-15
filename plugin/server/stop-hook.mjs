#!/usr/bin/env node
// The specbook plugin's PreToolUse hook (hooks/hooks.json). When the user presses Stop in the reader's Claude menu,
// the server raises requests/stop.flag in the book's folder. While it is up (at most an hour), this refuses Claude's
// edits to the book (book.json, mockups, the Revise working copy) and any `git commit`, so a session stops at its very
// next write, subagents included, instead of at its next check. Everything else goes ahead.
// Reads the hook's JSON on stdin; exit 2 with a reason on stderr refuses the tool call, exit 0 lets it run.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HOUR = 60 * 60 * 1000;
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function flagIn(dir) {
  try {
    const flag = JSON.parse(readFileSync(join(dir, 'requests', 'stop.flag'), 'utf8'));
    return Date.now() - Date.parse(flag.at) <= HOUR ? flag : null;
  } catch {
    return null;
  }
}
const isBook = dir => existsSync(join(dir, 'book.json')) && existsSync(join(dir, 'requests'));

// The book folder a path is inside (a working copy's own book.json is passed over), or null.
function bookAbove(path) {
  for (let dir = path; ; dir = dirname(dir)) {
    if (isBook(dir)) {
      return dir;
    }
    if (dirname(dir) === dir) {
      return null;
    }
  }
}

// A book folder for a command run in `cwd`: one it is inside, or docs/specbook in it or above it.
function bookFor(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (isBook(dir)) {
      return dir;
    }
    if (isBook(join(dir, 'docs', 'specbook'))) {
      return join(dir, 'docs', 'specbook');
    }
    if (dirname(dir) === dir) {
      return null;
    }
  }
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const tool = input.tool_name;
const args = input.tool_input ?? {};
const cwd = resolve(input.cwd ?? process.cwd());
let book = null;
if (EDITS.has(tool) && typeof (args.file_path ?? args.notebook_path) === 'string') {
  book = bookAbove(dirname(resolve(cwd, args.file_path ?? args.notebook_path)));
} else if (tool === 'Bash' && typeof args.command === 'string' && /\bgit\b[^;&|\n]*\bcommit\b/.test(args.command)) {
  book = bookFor(cwd);
}
const flag = book ? flagIn(book) : null;
if (!flag) {
  process.exit(0);
}
const what = flag.kind === 'build' ? 'the build' : 'the revise';
console.error(`The user pressed Stop in the spec book reader at ${flag.at}: ${what} is withdrawn. Stop now: change nothing more in the book and commit nothing. ` +
  `Tell the user what you had already done (anything that landed stays in the book for them to review)` +
  (flag.request ? `, then run next-request.mjs --data ${book} --check ${join(book, 'requests', flag.request)} to acknowledge` : '') +
  ' and re-arm the watch.');
process.exit(2);
