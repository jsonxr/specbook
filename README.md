# Spec book

A [Claude Code](https://claude.com/claude-code) plugin: your app's requirements as a book of phone mockups you can pin
notes on. Claude revises the spec from your notes, builds the sections you mark Ready, and proves each requirement
with tests. Share a live book with a link. See [specbook.jasonrowland.com](https://specbook.jasonrowland.com).

```
claude plugin marketplace add jsonxr/claude-plugins
claude plugin install specbook@jsonxr
```

In a session the commands are `/specbook`, `/specbook:open`, `/specbook:design`, `/specbook:revise` and `/specbook:build`.
Each also starts on its own when what you ask for matches it. A served book is shared too: `/specbook:open` prints
the link that lets others read it and leave notes, and your own pin link (never send that one to anyone).

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
