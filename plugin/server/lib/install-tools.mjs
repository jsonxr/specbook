// Copies the plugin's project-side tools into a spec book's folder, so a project never points at the plugin's
// own location. Today that is collect-evidence.mjs, which tests and CI run outside Claude. Each copy carries a
// stamp line with the plugin version and a hash of its body: a copy that matches the plugin is left alone, an
// older one is replaced, and one edited by hand is never overwritten.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(SERVER, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
export const TOOLS = ['collect-evidence.mjs'];
const STAMP = /^\/\/ specbook-tool (\S+) sha256=([0-9a-f]+)\b.*$/;

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Splits a script into its shebang line (or '') and the rest.
function split(text) {
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    return [text.slice(0, nl + 1), text.slice(nl + 1)];
  }
  return ['', text];
}

function render(source) {
  const [shebang, body] = split(source);
  const stamp = `// specbook-tool ${VERSION} sha256=${hash(body)} (copied by the specbook plugin; do not edit, it is replaced on update)\n`;
  return shebang + stamp + body;
}

// Reads an installed copy: its stamped version and hash, and the hash of the body it actually holds.
function inspect(text) {
  const [, rest] = split(text);
  const nl = rest.indexOf('\n');
  const m = STAMP.exec(nl < 0 ? rest : rest.slice(0, nl));
  if (!m) {
    return null;
  }
  return { version: m[1], stamped: m[2], actual: hash(rest.slice(nl + 1)) };
}

// Installs or refreshes every tool in <data>/tools/. Returns one line per tool that changed or was skipped;
// nothing for a copy that is already current.
export function installTools(data) {
  const dir = join(data, 'tools');
  const out = [];
  for (const name of TOOLS) {
    const source = readFileSync(join(SERVER, name), 'utf8');
    const want = render(source);
    const file = join(dir, name);
    const shown = `tools/${name}`;
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, want);
      out.push(`Installed ${shown} (specbook ${VERSION})`);
      continue;
    }
    const have = readFileSync(file, 'utf8');
    if (have === want) {
      continue;
    }
    const info = inspect(have);
    if (!info || info.stamped !== info.actual) {
      out.push(`Left ${shown} alone: it was edited by hand. Delete it and run install-tools.mjs again to get specbook ${VERSION}.`);
      continue;
    }
    writeFileSync(file, want);
    out.push(`Updated ${shown} from specbook ${info.version} to ${VERSION}`);
  }
  return out;
}
