// A share server on this machine, for working on the reader (plugin/app) and the share server without publishing or
// deploying. It serves this checkout's reader under the plugin's version, again after every save, uncached.
//
//   node server/dev.mjs [--port 8787]
//
// Then serve a book through it: SPECBOOK_SHARE_BROKER=http://127.0.0.1:8787 in the environment of the book server
// (serve.mjs restarts a book's server that was started for another share server). Its links work on this machine
// only. Changes to server/src reload by themselves (wrangler dev); reload the book's page after a change to the reader.
// Rooms are kept in server/.dev/state, never at the public share server.
import { cpSync, mkdirSync, readFileSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from './publish-reader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', 'plugin', 'app');
const manifest = join(here, '..', 'plugin', '.claude-plugin', 'plugin.json');
const dev = join(here, '.dev');
const site = join(dev, 'public');
const at = process.argv.indexOf('--port');
const port = at > 0 ? Number(process.argv[at + 1]) : 8787;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: node server/dev.mjs [--port 8787]');
  process.exit(1);
}

// The site's own files, then this checkout's reader, published over whatever that version held.
function build() {
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
  mkdirSync(site, { recursive: true });
  cpSync(join(here, 'public'), site, { recursive: true });
  publish({ app, out: join(site, 'r'), version, force: true });
  return version;
}

let version = build();
let timer = null;
const rebuild = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      version = build();
      console.log(`[dev] reader ${version} updated; reload the book's page.`);
    } catch (e) {
      console.log(`[dev] the reader could not be published: ${e.message}`);
    }
  }, 150);
};
for (const dir of [app, join(here, 'public'), dirname(manifest)]) {
  watch(dir, { recursive: true }, rebuild);
}

const broker = `http://127.0.0.1:${port}`;
const wrangler = spawn('wrangler', ['dev', '--port', String(port), '--ip', '127.0.0.1', '--assets', site,
  '--persist-to', join(dev, 'state'), '--var', 'DEBUG_NO_CACHE:1', '--show-interactive-dev-session=false'], { cwd: here, stdio: 'inherit' });
wrangler.on('error', e => {
  console.error(`wrangler could not start (${e.message}). It must be on the PATH (mise install, in server/).`);
  process.exit(1);
});
wrangler.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => wrangler.kill(sig));
}
console.log(`[dev] share server for development at ${broker}, reader ${version} from plugin/app.`);
console.log(`[dev] serve a book through it with SPECBOOK_SHARE_BROKER=${broker}`);
