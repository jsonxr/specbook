#!/usr/bin/env node
// Copies the plugin's project-side tools (collect-evidence.mjs) into <data>/tools/, or refreshes them after a
// plugin update. Project scripts then run them from the project, never from the plugin's own location.
//   node install-tools.mjs --data <project>/docs/specbook
import { resolve } from 'node:path';
import { installTools } from './lib/install-tools.mjs';

const i = process.argv.indexOf('--data');
if (i < 0 || !process.argv[i + 1]) {
  console.error('Usage: install-tools.mjs --data <dir>');
  process.exit(2);
}
for (const line of installTools(resolve(process.argv[i + 1]))) {
  console.log(line);
}
