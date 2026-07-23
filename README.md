[![CI](https://github.com/ctx42/cfsync/actions/workflows/ci.yml/badge.svg)](https://github.com/ctx42/cfsync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

# cfsync

Edit Atlassian Confluence pages as local Markdown — from your terminal **or**
from inside Obsidian — without ever corrupting the page.

## Overview

Would you rather write in Markdown than fight the Confluence editor? `cfsync`
pulls a page down as clean Markdown, lets you edit it however you like, and
pushes your edits back — on one promise:

> [!IMPORTANT]
> A push either applies exactly what you changed or is safely rejected.
> **It never corrupts the page.**

Confluence stores far more than Markdown can express — panels, macros, table
structure, node ids. `cfsync` keeps all of it: only the blocks you actually
changed are written back, and anything Markdown can't represent stays
read-only, refused with a message rather than guessed. Sync a single page, a
whole folder, or an entire space, mirrored into a local directory tree that
tracks the remote layout.

The round-trip stays lossless through a *retentive lens*: on pull, `cfsync`
caches the original Atlassian Document Format (ADF) alongside the Markdown; on
push, it back-ports your changes onto that cache, recovering everything
Markdown can't carry from the original.

`cfsync` is a ground-up TypeScript rewrite of the author's earlier Go tool of
the same name, which it now supersedes.

## Two ways to use it, one engine

`cfsync` ships **two front ends over one runtime-neutral core**, so a page
pulled by one round-trips cleanly through the other. Pick whichever fits how
you work — or use both against the same vault.

| Surface             | What it is                                               | Reach for it when…                                    |
|---------------------|----------------------------------------------------------|-------------------------------------------------------|
| **CLI**             | A single self-contained binary (`cfsync`).               | You script it, run it in CI, or live in the terminal. |
| **Obsidian plugin** | A control-center panel and settings tab inside Obsidian. | You want pull/push on a click, next to your notes.    |

## Features

- **Lossless round-trip.** Only changed blocks are written back; unexpressible
  content is preserved verbatim, never guessed.
- **Clean Markdown out.** Pages render to readable Markdown with images pulled
  into a shared `_assets/` directory and embedded as Obsidian `![[wikilinks]]`.
- **Whole-tree mirroring.** A folder or space — pages and nested sub-folders —
  maps to a local directory tree; names derive from page titles.
- **Rich formatting survives.** Panels, tables, mentions, status/date/emoji,
  colored and underlined text, and macros all round-trip.
- **Safe concurrent edits.** A three-way merge folds in non-overlapping remote
  changes; a genuine conflict is refused, not clobbered.
- **Cross-page links** rewrite to local `.md` paths on pull and restore on push.
- **Create pages** from a local note and restrict them to you.
- **Housekeeping:** garbage-collect unreferenced assets and prune local files
  deleted upstream.

## Packages

`cfsync` is a [Bun](https://bun.sh) workspace of three packages:

| Package                                               | What it is                                                                                                                     |
|-------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| [`@cfsync/core`](packages/core)                       | Runtime-neutral core: the ADF↔Markdown lens, sync orchestration, and injected I/O ports. Imports no `node:`/`bun:`/`obsidian`. |
| [`@cfsync/cli`](packages/cli)                         | The standalone CLI: Node/Bun port adapters, config + `.env` loading, compiled to one binary.                                   |
| [`@cfsync/obsidian-plugin`](packages/obsidian-plugin) | The Obsidian plugin: adapters, settings tab, control-center panel, indent rendering.                                           |

## Prerequisites

- **[Bun](https://bun.sh) 1.x** to build either front end. The compiled CLI
  binary then runs standalone (Bun embeds its own runtime); Bun stays required
  only if you run the CLI from source.
- An **Atlassian API token** for the account you sync with. Create one at
  <https://id.atlassian.com/manage-profile/security/api-tokens>.
- For the plugin: **Obsidian 1.5.0+**, desktop (the plugin is desktop-only).

## Installation

Clone the repository:

```sh
git clone https://github.com/ctx42/cfsync
cd cfsync
bun install
```

### CLI

The bundled `scripts/install.sh` builds the CLI and installs it as a single
binary. It runs the same from any directory. The install directory mirrors Go's
`GOBIN`: `$TSBIN` when set, otherwise `~/bin`. The command name is `$TSBIN_NAME`
when set, otherwise `cfsync`:

```sh
./scripts/install.sh                        # -> ~/bin/cfsync
TSBIN=/usr/local/bin ./scripts/install.sh   # -> /usr/local/bin/cfsync
```

It warns if the destination isn't on your `PATH`, or if another command of the
same name already resolves elsewhere. Then verify:

```sh
cfsync version
```

Prefer to build by hand? The script just wraps this:

```sh
bun run --filter '@cfsync/cli' build
./packages/cli/dist/cfsync version
```

This compiles a self-contained binary at `packages/cli/dist/cfsync`; symlink or
copy it onto your `PATH` wherever you keep your own executables.

> [!NOTE]
> To run the CLI from source (so it picks up edits without a rebuild), point a
> wrapper at the entry point instead: `bun packages/cli/src/index.ts <args>`.
> Bun must stay installed for that form.

### Obsidian plugin

Install it from the Obsidian community-plugin store — no build required:

1. **Settings → Community plugins**, and turn off Restricted mode if it's on.
2. **Browse**, search for **cfsync**, and click **Install**.
3. **Enable** the plugin.

Then jump to [In Obsidian](#in-obsidian) to connect and start syncing.

> [!NOTE]
> Building from source instead? Compile the bundle and copy its three shipping
> files into your vault:
>
> ```sh
> bun run --filter '@cfsync/obsidian-plugin' build
> mkdir -p /path/to/vault/.obsidian/plugins/cfsync
> cp packages/obsidian-plugin/dist/{main.js,manifest.json,styles.css} \
>    /path/to/vault/.obsidian/plugins/cfsync/
> ```
>
> The repo also has a helper that builds and deploys into a vault in one step
> (and can symlink for a hot-reload dev loop):
>
> ```sh
> bun run deploy:plugin /path/to/vault          # build + copy
> bun run deploy:plugin /path/to/vault --link   # build + symlink (dev)
> ```

## Quickstart

### With the CLI

Two files sit side by side: a committable config that says *what* to sync, and
a git-ignored `.env` that holds the secrets. Create `.cfsync.yaml`:

```yaml
# .cfsync.yaml — what to sync (no secrets here)
timeout: 30s
pages:
  notes/onboarding.md: /wiki/spaces/TEAM/pages/12345/Onboarding
folders:
  glossary: /wiki/spaces/TEAM/folder/67890
spaces:
  team-wiki: /wiki/spaces/TEAM
```

and `.env` beside it:

```sh
# .env — secrets and the sync root (never commit this)
CFSYNC_SITE=your-site
CFSYNC_ACCOUNT=you@example.com
CFSYNC_TOKEN=your-api-token
CFSYNC_ROOT=/absolute/path/to/your/vault
```

`CFSYNC_SITE` is just the subdomain — the part before `.atlassian.net` (for
`https://your-site.atlassian.net`, it is `your-site`). Then:

```sh
cfsync test                     # verify authenticated access to the Site
cfsync pull                     # pull everything configured, to Markdown
cfsync pull notes/onboarding.md # or re-pull one managed page
```

Each configured page — and every page inside a configured folder or space — is
rendered to its `.md` file under the sync root, its images downloaded to
`_assets/`, and the source ADF cached under `.adf_cache/`. Edit the `.md` files
in any editor, then push:

```sh
cfsync push                     # push every edited page
cfsync push notes/onboarding.md # or push one page
```

An unchanged page is skipped. If the remote page moved since you pulled,
`cfsync` three-way merges your edits onto the new version and refuses only when
the same block changed on both sides — re-pull and reapply in that case.

To create a page, add a new `.md` file under a folder or space root with a
title but no `page_id`, then push — `cfsync` prompts, creates it under the
parent derived from the directory, and restricts it to you:

```sh
cfsync push               # prompts: Create team-wiki/release_notes.md? [y/n/a/s]
cfsync push --yes         # create without prompting
```

### In Obsidian

1. Open **Settings → cfsync** and fill in the **Connection** section: your site
   subdomain, account email, and API token. Click **Test** to confirm access.
   The token is stored on this device only, never in the shareable settings.
2. Under **Sync map**, add the pages, folders, and spaces to sync — each row
   maps a vault path to a Confluence link. Already have a `.cfsync.yaml`?
   **Import** it (credentials are never included; **Export** writes one back).
3. Open the **control center** from the ribbon (the up/down-arrow icon) or the
   command palette. It gives you four actions:

   | Action                  | What it does                                   |
   |-------------------------|------------------------------------------------|
   | **Pull → Whole vault**  | Pull every configured page into the vault.     |
   | **Pull → Current note** | Re-pull just the note you're viewing.          |
   | **Push → Whole vault**  | Push all edited notes (shows a preview first). |
   | **Push → Current note** | Push just the current note.                    |

A push always opens a **review screen** first: one selectable row per
candidate, flagging new pages and any whose remote version moved since you
pulled, so you commit only what you mean to. Progress and a per-note result log
stream live in the panel. The same actions are available as commands (search
"cfsync" in the palette) for hotkey binding.

## CLI commands

```text
cfsync <command> [flags] [page]

test            Verify authenticated access to the Atlassian Site.
pull [page]     Pull configured pages, folders, and spaces into the cache.
                With a page path, pull only that one managed page.
push [page]     Push edited Markdown back to Confluence, creating confirmed
                new pages. With a page path, push only that page.
status          List managed pages whose Confluence version has moved ahead
                of your local copy (the pages a pull would update). One bulk
                request, so it is cheap even for a whole space.
gc              List orphaned files in the shared _assets directory. Add
                --prune to delete them.
clean           Remove local files under configured folder and space roots
                that no longer exist in Confluence. Prompts unless --yes.
version         Print the program version and exit.
help [command]  Print help, or help for a command.
```

Every config-reading command accepts these flags after the command name; run
`cfsync help <command>` for a command's own flags:

```text
--config <path>     Configuration file path (default ./.cfsync.yaml).
--env <path>        Path to the .env file (default ./.env). An exported value
                    wins over it.
--sync-root <path>  Folder pages sync under; overrides CFSYNC_ROOT.
--yes               Skip confirmation prompts (push, clean).
--force             Repush pages whose ADF changed even if the Markdown did
                    not (push).
--prune             Delete the orphaned asset files (gc).
-h, --help          Print the command's help and exit.
```

The exit code is `0` on success and `1` on any failure; a partial run (some
pages failed) prints the per-page log and exits `1`.

## Configuration

The Site credentials and the sync root come from the environment (or a `.env`
file), never from the config file — setting any of them in `.cfsync.yaml` is an
error. A value already exported in the environment wins over `.env`.

| Setting   | Source                             | Required | Description                                       |
|-----------|------------------------------------|----------|---------------------------------------------------|
| site      | `CFSYNC_SITE`                      | yes      | Site subdomain, e.g. `your-site`.                 |
| account   | `CFSYNC_ACCOUNT`                   | yes      | Atlassian account email; the Basic-auth username. |
| token     | `CFSYNC_TOKEN`                     | yes      | Atlassian API token; the Basic-auth password.     |
| sync root | `--sync-root` / `CFSYNC_ROOT`      | yes      | Folder every mapped destination resolves under¹.  |

¹ A relative sync root is resolved against the directory of the config file;
`--sync-root` wins over `CFSYNC_ROOT`.

The config file (YAML) holds only what to sync:

| Key               | Required | Description                                                     |
|-------------------|----------|-----------------------------------------------------------------|
| `timeout`         | no       | Per-request HTTP timeout, e.g. `45s` (default `30s`).           |
| `markdown.margin` | no       | Hard-wrap column for Markdown text; `0`/unset = no wrap.        |
| `pages`           | no²      | Map of destination `.md` under the sync root → Confluence path. |
| `folders`         | no²      | Map of destination dir under the sync root → Confluence folder. |
| `spaces`          | no²      | Map of destination dir under the sync root → Confluence space.  |

² `pages`, `folders`, and `spaces` are each optional, but configure at least
one — a config with none has nothing to sync. No single page may be claimed by
more than one entry.

Under the sync root, `cfsync` manages three reserved locations:

| Location      | Contents                                                              |
|---------------|-----------------------------------------------------------------------|
| `_assets/`    | Downloaded images, shared across pages; embedded as `![[name]]`.      |
| `.adf_cache/` | The cached source ADF (`.vN.json`) and the link index (`links.json`). |
| `_index.md`   | A directory's own page, when a folder or space page has children.     |

### What `cfsync` ignores

Not every file under a mapped root is synced. `cfsync` skips:

- **Non-`.md` files** — only Markdown notes are considered; anything else is
  left alone.
- **The `.adf_cache/` directory** — its cached `.md` copies are sync artifacts,
  never your notes, so the maintenance commands (`push`, `gc`, `clean`) never
  walk into it.
- **Notes that aren't managed pages** — a `.md` file with no frontmatter, or
  whose frontmatter has neither a `page_id` nor a `title`, is not a page
  `cfsync` owns and is skipped by `push`.
- **Locally-created notes not yet pushed** — a note marked `cf_local` is
  excluded everywhere until you create it.
- **Notes you explicitly hold back** — add `cfsync-plugin: ignore-push` to a
  note's frontmatter and `push` leaves it out entirely: it is never created,
  updated, or reported by `status` as having moved. Use it to keep an
  in-progress or intentionally-local edit out of Confluence without moving or
  renaming the file. (The marker shares the `cfsync-plugin` key with the
  managed-note `pull` value, so re-pulling the page rewrites it back to `pull`;
  re-add `ignore-push` after a pull if you still want it held back.)

> [!TIP]
> The Obsidian plugin reads and writes the **same `.cfsync.yaml` sync map** —
> Import one you already have, or Export the map you built in settings to share
> it with CLI users. Credentials are never part of it.

The plugin keeps the equivalent settings in its **Settings → cfsync** tab: the
connection fields and Markdown options (flavor, wrap margin, request timeout,
and a vault-relative sync-root subfolder), plus the same page/folder/space
maps. The API token is stored per-device; everything else lives in the vault's
shareable plugin data.

## Markdown dialect

`cfsync` reads and writes an **Obsidian-native** Markdown dialect, so a pulled
page is a first-class Obsidian note. Standard Markdown carries the obvious
things — headings, paragraphs, **bold**/*italic*/~~strikethrough~~/`code`,
links, bullet and numbered lists, fenced code blocks, and GFM tables.
Everything Confluence adds on top round-trips through the small set of
extensions below.

### Inline extensions

- **Images** are Obsidian embeds — `![[onboarding-diagram.png]]` — resolved
  against `_assets/`, not `![alt](path)` links. An externally-hosted image
  stays a plain `![alt](url)`.
- **Underlined and colored text**, which Markdown has no syntax for, use inline
  HTML: `<u>…</u>` for underline and `<span style="color:red">…</span>` for a
  text color.
- **Smart links** (Confluence inline cards) render as bare autolinks —
  `<https://example.com>` — kept distinct from a normal `[label](url)` link so
  they round-trip as cards.
- **Confluence-only inline nodes** round-trip as `` `adf:…` `` code spans, keyed
  by a leading sigil, so they survive an edit untouched and never render as
  broken Markdown:
  - status lozenge — `` `adf:!In progress|color=blue` ``
  - date — `` `adf:#2026-07-19|ts=1768…` ``
  - emoji — `` `adf::smile` ``
  - mention — `` `adf:@Jane Doe` `` (an id is appended when the name is
    ambiguous on the page)
  - any other inline macro — `` `adf:*inlineExtension:…` ``
- **Unsupported inline nodes** freeze as an invisible `%%adf:…%%` comment:
  read-only and preserved verbatim.

### Block extensions

- **Panels** map to GitHub-style alerts — `> [!INFO]`, `> [!WARNING]`, … — the
  uppercased panel type as the tag, with the body quoted below it. A plain
  blockquote (no tag) stays a bare `> ` quote.
- **Expand** blocks become a `> [!EXPAND] Title` alert; the title after the tag
  stays editable.
- **Indented paragraphs** carry their nesting depth as an `N> ` marker on the
  first line — `1> `, `2> `, … The Obsidian plugin renders the marker as a
  visually indented paragraph in both Live Preview and Reading view; without
  the plugin the literal `N> ` marker is shown.
- **Multi-line table cells** join their lines with `<br>`.
- **Blocks Markdown can't express** (macros, an `EXPAND`-type panel, unusual
  tables) are frozen in fenced ` ```adf ` blocks with a YAML body: read-only,
  preserved verbatim, and refused rather than corrupted if you edit inside them.

You freely edit prose, headings, list items, blockquotes, panels, expands, and
table cells, and add paragraphs and images; the frozen ` ```adf ` blocks and
`%%adf:…%%` comments carry everything else through unchanged, and an
`` `adf:…` `` span is safe to move but not to hand-edit. Frontmatter — the
`cfsync-plugin: pull` marker that flags the note as `cfsync`-managed, plus the
identity fields (`title`, `page_id`, `page_version`, `space_id`, …) that track
each note's Confluence page — must be left intact.

## Development

The workspace is driven with Bun. From the repository root:

```sh
bun run typecheck      # tsc -b across all packages
bun run lint           # biome
bun run test           # vitest (the whole suite is hermetic — no network)
bun run build          # build the plugin bundle and the CLI binary
bun run check          # typecheck + lint + test
```

The core is runtime-neutral by contract: it imports nothing from `node:`,
`bun:`, or `obsidian`, and a boundary test fails the suite on any leak. All I/O
— HTTP, filesystem, clock, environment, streams — is injected through ports, so
the same orchestration runs under the CLI's Node adapters, the plugin's
Obsidian adapters, and the tests' in-memory fakes.

## Status

Both front ends cover the full pull / edit / push / create / gc / clean cycle
against a real Confluence Site. The **CLI** ships as a single self-contained
binary; the **Obsidian plugin** is available in the community-plugin store and
drives the same cycle — connect, map, and pull/push from the control center.

## License

[MIT](LICENSE.md) — see the `LICENSE.md` file.
