import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// Where the share library lives for one plugin version: outside the plugin folder.
export function depsDir(version) {
  const base = process.env.SPECBOOK_DEPS || join(homedir(), '.claude', 'specbook', 'deps');
  return join(base, version);
}

function npmInstall(dir) {
  return new Promise(resolve => {
    const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ ok: false, error: e.message }));
    child.on('close', code =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `npm exited with ${code}` }),
    );
  });
}

// Installs node-datachannel into the per-version folder once. `run(dir)` resolves to
// { ok: true } or { ok: false, error }; tests inject it.
export async function ensureDeps({ version, log = () => {}, run = npmInstall } = {}) {
  if (!VERSION_RE.test(String(version))) return { ok: false, error: `Bad version: ${version}` };
  const dir = depsDir(version);
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(PLUGIN_ROOT, 'package.json'), join(dir, 'package.json'));
    if (existsSync(join(dir, 'node_modules', 'node-datachannel'))) return { ok: true };
    log('Installing the share library (once)…');
    const r = await run(dir);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'Install failed' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// The browser-style RTCPeerConnection from node-datachannel, or null when not installed.
export function loadRtc(version) {
  if (!VERSION_RE.test(String(version))) return null;
  try {
    const require = createRequire(join(depsDir(version), 'package.json'));
    const { RTCPeerConnection } = require('node-datachannel/polyfill');
    return RTCPeerConnection ? { RTCPeerConnection } : null;
  } catch {
    return null;
  }
}
