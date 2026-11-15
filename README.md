# Spec book

A [Claude Code](https://claude.com/claude-code) plugin: your app's requirements as a book of phone mockups you can pin
notes on. Claude revises the spec from your notes, builds the sections you mark Ready, and proves each requirement
with tests. Share a live book with a link. See [specbook.jasonrowland.com](https://specbook.jasonrowland.com).

```
claude plugin marketplace add jsonxr/claude-plugins
claude plugin install specbook@jsonxr
```

In a session the commands are `/specbook`, `/specbook:start`, `/specbook:stop`, `/specbook:design`, `/specbook:revise` and `/specbook:build`.
Each also starts on its own when what you ask for matches it. To share a book, press **Share** in its bar, choose a 6-digit
pin and press **Start**: the menu gives the link that lets others read it and leave notes. The pin gives your own
powers on the link (never send it to anyone).

## This repository

| Folder | What it is |
| --- | --- |
| [`plugin/`](plugin/) | The plugin, as installed: the reader (`app/`), the local server and scripts (`server/`), the skills, the formats (`reference/`) and its tests. The [`jsonxr`](https://github.com/jsonxr/claude-plugins) marketplace installs this folder. |
| [`server/`](server/) | The share server behind a book's share link, and the site at specbook.jasonrowland.com. A Cloudflare Worker deployed on its own (see its README); the plugin only uses it. |

## Releasing

Raise `version` in `plugin/.claude-plugin/plugin.json` and push. Users get it with
`claude plugin update specbook@jsonxr`; without the version change, installed copies stay as they are.

## Developing

Load the plugin from this checkout for one session: `claude --plugin-dir ./plugin`.

Where to try changes (localhost, phone sizes, the share link end to end), and why shortcuts such as loading the reader
from the book server or opening localhost to the network are not taken: [docs/development.md](docs/development.md).

```
claude plugin validate plugin
node --test plugin/server/ server/src/
GLOBAL_ROOT=$(npm root -g)/playwright node plugin/test/reader.smoke.mjs
GLOBAL_ROOT=$(npm root -g)/playwright node plugin/test/share.smoke.mjs
```

## License

[FSL-1.1-MIT](LICENSE.md), the Functional Source License: use, change and share spec book for anything except a
competing commercial product or service, such as repackaging or reselling it. Each release becomes MIT two years after
it is published.
