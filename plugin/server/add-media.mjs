#!/usr/bin/env node
// Copies a screenshot or recording into a spec book's media folder under the name the reader looks for.
//   node add-media.mjs --data <dir> --screen <screenId>.<stateId> <file.png|jpg|webp>
//   node add-media.mjs --data <dir> --video <chapterId-sectionId>[-<suffix>] <file.mp4|mov|webm>
// A screenshot named for a screen state ("<screen id>.<state id>") replaces that state's mockup in the Screenshots view.
// A recording named with a section's full id (chapter id, "-", section id) appears under that section.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv.slice(i + 1, i + 3);
}

const dataArg = arg('data');
const screen = arg('screen');
const video = arg('video');
if (!dataArg || (!screen && !video)) {
  console.error('Usage: add-media.mjs --data <dir> (--screen <screenId>.<stateId> <file> | --video <sectionFullId> <file>)');
  process.exit(2);
}
const data = resolve(dataArg[0]);
const [name, file] = screen ?? video;
if (!file || !existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}
const ext = extname(file).toLowerCase();
const ok = screen ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.mp4', '.mov', '.webm'];
if (!ok.includes(ext)) {
  console.error(`Expected ${ok.join(', ')}, got ${ext}`);
  process.exit(1);
}
if (screen) {
  let book = null;
  try {
    book = JSON.parse(readFileSync(join(data, 'book.json'), 'utf8'));
  } catch {
    // An unreadable book has no states, so the key below is refused.
  }
  const { screenIndex } = createRequire(import.meta.url)('../app/model.js');
  if (!Object.hasOwn(screenIndex(book ?? {}).states, name)) {
    console.error(`Not a state in the book: ${name}. Use <screen id>.<state id>.`);
    process.exit(1);
  }
}
const dir = join(data, 'media', screen ? 'screens' : 'videos');
mkdirSync(dir, { recursive: true });
const dest = join(dir, `${name}${ext}`);
copyFileSync(file, dest);
console.log(`Copied to ${dest}`);
