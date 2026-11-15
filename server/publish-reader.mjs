// Copies the reader (plugin/app) into server/public/r/<version>/ so the share server can serve it.
// Usage: node server/publish-reader.mjs [--app <dir>] [--out <dir>] [--version <v>] [--force]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validReader } from './src/rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const COPIED = ['book.css', 'book.js', 'model.js', 'live.js', 'relay.js', 'share.js'];

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const semver = v => v.split('.').map(Number);
const bySemver = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

function shareHtml(index, version) {
  const base = `/r/${version}/`;
  let html = index
    .replace(/[ \t]*<script\b[^>]*\bsrc="\/app\/owner\.js"[^>]*><\/script>\r?\n?/g, '')
    .replaceAll('/app/', base);
  const share = `<script src="${base}share.js"></script>\n`;
  const at = html.indexOf(`<script src="${base}model.js"></script>`);
  if (at < 0) throw new Error('index.html has no model.js script tag');
  html = html.slice(0, at) + share + html.slice(at);
  const meta = `<meta name="specbook-reader" content="${version}">`;
  if (!/<head[^>]*>/.test(html)) throw new Error('index.html has no <head>');
  return html.replace(/<head[^>]*>\r?\n?/, m => `${m}${meta}\n`);
}

export function publish({ app, out, version, force = false }) {
  if (typeof version !== 'string' || !validReader(version)) throw new Error(`bad version ${version}`);
  const files = new Map();
  for (const f of COPIED) files.set(f, readFileSync(join(app, f)));
  files.set('share.html', Buffer.from(shareHtml(readFileSync(join(app, 'index.html'), 'utf8'), version)));

  const dir = join(out, version);
  let wrote = true;
  if (existsSync(dir)) {
    const same = [...files].every(([name, bytes]) => {
      const path = join(dir, name);
      return existsSync(path) && sha(readFileSync(path)) === sha(bytes);
    });
    if (same) wrote = false;
    else if (!force) throw new Error(`published ${version} differs`);
  }
  if (wrote) {
    mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
  }
  const all = readdirSync(out, { withFileTypes: true })
    .filter(e => e.isDirectory() && validReader(e.name))
    .map(e => e.name)
    .sort(bySemver);
  writeFileSync(join(out, 'versions.json'), JSON.stringify(all) + '\n');
  return { version, wrote };
}

function main(argv) {
  const opts = { app: resolve(here, '../plugin/app'), out: resolve(here, 'public/r'), force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') opts.force = true;
    else if (['--app', '--out', '--version'].includes(argv[i])) opts[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  opts.version ??= JSON.parse(readFileSync(resolve(here, '../plugin/.claude-plugin/plugin.json'), 'utf8')).version;
  const r = publish(opts);
  console.log(r.wrote ? `published ${r.version}` : `${r.version} already published, unchanged`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
