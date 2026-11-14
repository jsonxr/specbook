#!/usr/bin/env node
// Drives a build's bookkeeping; every command prints one JSON line.
//   node build.mjs --data <dir> start
//   node build.mjs --data <dir> task --build <id> --index <n> --of <m> --title "<t>" [--section <fullId>] [--req <ID>]
//   node build.mjs --data <dir> req --build <id> --id <ID> --status queued|in_progress|proven|failed
//   node build.mjs --data <dir> call --build <id> --about <ID>[,<ID>] --section <fullId> --title "<t>" --body "<b>" --before "<text>" --after "<text>"
//   node build.mjs --data <dir> beat --build <id>
//   node build.mjs --data <dir> finish --build <id> [--summary "<plain words on how the app changed>"]
//   node build.mjs --data <dir> stop --build <id> --reason "<r>"
// On an error it prints { error, message } to stderr and exits 1.
import { resolve } from 'node:path';
import { readJson } from './lib/json-file.mjs';
import { findRequirement } from './lib/book-model.mjs';
import { startBuild, recordTask, recordRequirement, recordCall, beat, finishBuild, stopBuild } from './lib/builds.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) {
    return undefined;
  }
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// A string flag, or undefined when absent or given without a value.
function text(name) {
  const v = arg(name);
  return typeof v === 'string' ? v : undefined;
}

function required(name) {
  const v = text(name);
  if (v === undefined) {
    throw fail('missing-flag', `--${name} is required`);
  }
  return v;
}

function number(name) {
  const v = Number(required(name));
  if (!Number.isFinite(v)) {
    throw fail('bad-flag', `--${name} must be a number`);
  }
  return v;
}

function scopeOf(data, progress) {
  const book = readJson(resolve(data, 'book.json'), {});
  return Object.keys(progress.requirements).flatMap(id => {
    const found = findRequirement(book, id);
    if (!found) {
      return [];
    }
    const { req, fullId } = found;
    const entry = { id, section: fullId, change: req.change, text: req.text };
    if (req.today !== undefined) {
      entry.today = req.today;
    }
    if (req.reason !== undefined) {
      entry.reason = req.reason;
    }
    return [entry];
  });
}

function run(data, command) {
  switch (command) {
    case 'start': {
      const progress = startBuild(data);
      return { ...progress, scope: scopeOf(data, progress) };
    }
    case 'task': {
      const task = { index: number('index'), of: number('of'), title: required('title') };
      for (const key of ['section', 'req']) {
        if (text(key) !== undefined) {
          task[key] = text(key);
        }
      }
      return recordTask(data, required('build'), task);
    }
    case 'req':
      return recordRequirement(data, required('build'), required('id'), required('status'));
    case 'call':
      return recordCall(data, required('build'), {
        about: required('about').split(',').map(s => s.trim()).filter(Boolean),
        section: required('section'),
        title: text('title'),
        body: required('body'),
        before: text('before'),
        after: text('after'),
      });
    case 'beat':
      return beat(data, required('build'));
    case 'finish': {
      const summary = text('summary');
      if (summary === undefined || summary.trim() === '') {
        console.error('Warning: the changelog entry has no summary (pass --summary "<text>").');
      }
      return finishBuild(data, required('build'), Date.now(), { summary });
    }
    case 'stop':
      return stopBuild(data, required('build'), required('reason'));
    default:
      throw fail('unknown-command', `Unknown command: ${command ?? ''}`);
  }
}

const data = text('data');
if (!data) {
  console.error('Usage: build.mjs --data <dir> <start|task|req|call|beat|finish|stop> [flags]');
  process.exit(2);
}
const command = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && (i === 0 || !all[i - 1].startsWith('--')));
try {
  console.log(JSON.stringify(run(resolve(data), command)));
} catch (err) {
  console.error(JSON.stringify({ error: err.code ?? 'error', message: err.message }));
  process.exit(1);
}
