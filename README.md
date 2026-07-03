<img src="doc/cfsync-logo-256.png" align="right" alt="cfsync logo" width="100">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Go Reference](https://pkg.go.dev/badge/github.com/ctx42/cfsync.svg)](https://pkg.go.dev/github.com/ctx42/cfsync)

# cfsync

Edit Atlassian Confluence pages as local Markdown — pull, edit in your own
tools, push back, without ever corrupting the page.

## Overview

Would you rather write in Markdown than in the Confluence editor? `cfsync`
pulls a page down as clean Markdown, lets you edit it however you like, and
pushes your edits back — on one promise: **a push either applies exactly what
you changed or is safely rejected. It never corrupts the page.**

Confluence stores more than Markdown can express — panels, macros, table
structure, node ids. cfsync keeps all of it: only the blocks you actually
changed are written back, and anything Markdown can't represent stays read-only,
refused with a message rather than guessed. Sync a single page, a whole folder,
or an entire space — mirrored into a local directory tree that tracks the remote
layout.

Curious how the round-trip stays lossless? It uses a *retentive lens*: on pull,
cfsync caches the original Atlassian Document Format (ADF) alongside the
Markdown; on push, it back-ports your changes onto that cache, recovering
everything Markdown can't carry from the original.

## Features

- Pull Confluence pages to clean, readable Markdown, with images downloaded to a
  shared `_assets/` directory.
- Mirror a Confluence folder — pages and nested sub-folders — into a local
  directory tree; file and directory names are derived from the page titles.
- Push Markdown edits back, preserving formatting Markdown can't represent
  (panels, tables, mentions, status/date/emoji, colored/underlined text, macros).
- Round-trip-safe by construction: unexpressible content is frozen, not lost.
- Edit prose, headings, list items, panels, blockquotes, and table cells;
  add paragraphs and images.
- Automatic three-way merge when the remote page moved since you pulled —
  non-overlapping edits merge, overlapping ones are refused.
- Rewrite cross-page links to local `.md` paths on pull and restore them on
  push, so links between synced pages stay navigable offline.
- Upload local images on push; orphaned attachments are cleaned up on failure.
- Garbage-collect unreferenced downloaded assets (`gc`), and remove local
  folder files that were deleted in Confluence (`clean`).

## Prerequisites

- **Go 1.26 or newer** (to build from source).
- An **Atlassian API token** for the account you sync with. Create one at
  <https://id.atlassian.com/manage-profile/security/api-tokens>.

## Installation

Install with a single command (requires Go 1.26+):

```sh
curl -fsSL https://raw.githubusercontent.com/ctx42/cfsync/master/install.sh | sh
```

Or install directly with `go install`:

```sh
go install github.com/ctx42/cfsync/cmd/cfsync@latest
```

Or with the project's own installer, which also stamps the build date — and,
from a checkout, the commit hash and working-tree state — into the binary:

```sh
go run github.com/ctx42/cfsync/cmd/install@latest
```

All three compile the latest release of `cfsync` into `$(go env GOBIN)` (or
`$(go env GOPATH)/bin`); add that directory to your `PATH` if it isn't already.
The binary reports the version it was built from, so `cfsync version` names
the release you installed.

Just cut a release and `@latest` still gives you the previous one? The Go
module proxy caches its "latest" list for a while after a tag is pushed, so a
brand-new release can take a bit to show up. Bypass the proxy to read the tags
straight from the repository:

```sh
GOPROXY=direct go install github.com/ctx42/cfsync/cmd/cfsync@latest
```

Or pin the exact version you want — `...@v0.1.1` — which the proxy serves as
soon as it is requested once.

Or run it without installing anything, straight from the module with `go run`:

```sh
go run github.com/ctx42/cfsync/cmd/cfsync@latest version
go run github.com/ctx42/cfsync/cmd/cfsync@latest test
```

Go compiles and caches it on first run; `version` still names the release.
Swap the verb for any command — `pull`, `push`, and the rest work the same.

### From a checkout

Working in a clone? Build straight from source; `version` reports a
git-derived pseudo-version:

```sh
go build -o cfsync ./cmd/cfsync
./cfsync version
```

## Usage

### 1. Configure

Credentials and the config live in two files. Copy the config template and list
the pages, folders, or spaces to sync:

```sh
cp .cfsync.example.yaml .cfsync.yaml
```

Then copy the environment template and fill in your Site, account, and token:

```sh
cp .env.example .env
```

`cfsync` reads `./.cfsync.yaml` and `./.env` by default (both git-ignored, so
credentials are never committed). The config file holds no secrets: the host,
account, and token come from `.env` or the environment, and the work directory
from `--work-dir` or `CFSYNC_WORK_DIR`. See [Configuration](#configuration).

### 2. Verify the connection

```sh
cfsync test
```

On success it prints the Site it connected to and the authenticated account id.

### 3. Pull pages

```sh
cfsync pull                       # pull everything configured
cfsync pull test/root_page_1.md   # pull one managed page (work-dir-relative path)
```

Each configured page — and every page inside a configured folder or space — is
rendered to its `.md` file under `work_dir`, its images downloaded to
`work_dir/_assets/`, and the source ADF cached under `work_dir/.adf_cache/`.

With a page argument, cfsync re-pulls just that one already-managed page — a
work-dir-relative or absolute path to its `.md` file — without walking any
folder or space. The path must name a page already under `pages:` or one pulled
by a previous `pull`; a Confluence link or page id is not accepted.

### 4. Edit and push

Edit the `.md` files in your editor, then push:

```sh
cfsync push                       # push every edited page
cfsync push test/root_page_1.md   # push one page (work-dir-relative path)
```

An unchanged page is skipped. If the remote page moved since you pulled, cfsync
three-way merges your edits onto the new version and refuses only when the same
block changed on both sides — re-pull and reapply in that case.

### Sync folders and spaces

`pull` also downloads the pages of any folder under `folders:` and every page
of any space under `spaces:`. To remove local files whose Confluence pages were
deleted since the last pull:

```sh
cfsync clean         # prompt before deleting stale folder files
cfsync clean --yes   # delete without prompting
```

`clean` only ever touches cfsync-managed `.md` files (those with a `page_id`)
under configured folder and space roots; hand-written files and the ADF cache
are left alone. Without a terminal, run it with `--yes`.

### Manage downloaded assets

```sh
cfsync gc            # list unreferenced files under _assets/
cfsync gc --prune    # delete them
```

### Commands

```text
cfsync <command> [flags] [page]

test            Verify authenticated access to the Atlassian Site.
pull [page]     Pull configured pages, and the pages of configured folders
                and spaces, into the ADF cache. With a page path, pull only
                that one managed page.
push [page]     Push edited Markdown back to Confluence. With a page path,
                push only that page; without it, push every edited page.
gc              List orphaned files in the shared _assets directory. Add
                --prune to delete them.
clean           Remove local files under configured folder and space roots
                that no longer exist in Confluence. Prompts unless --yes.
version         Print the program version and exit.
help [command]  Print help, or help for a command.
```

Every command that reads the configuration accepts these flags after the
command name; run `cfsync help <command>` for a command's own flags:

```text
--config <path>   Configuration file path (default ./.cfsync.yaml).
--env <path>      Path to the .env file (default ./.env). Holds the host,
                  account, and token secrets; an exported value wins over it.
--work-dir <path> Directory pages are written to; overrides CFSYNC_WORK_DIR.
--yes             Skip confirmation prompts (push, clean).
--prune           Delete the orphaned asset files (gc).
-h, --help        Print the command's help and exit.
```

## Configuration

The Site credentials and the work directory come from the environment (or a
`.env` file), never from the config file — setting any of them in
`.cfsync.yaml` is an error. A value already exported in the environment wins
over `.env`.

| Setting  | Source                           | Required | Description                                       |
|----------|----------------------------------|----------|---------------------------------------------------|
| host     | `CFSYNC_HOST`                    | yes      | Site base URL, `https://<id>.atlassian.net`.      |
| account  | `CFSYNC_ACCOUNT`                 | yes      | Atlassian account email; the Basic Auth username. |
| token    | `CFSYNC_TOKEN`                   | yes      | Atlassian API token; the Basic Auth password.     |
| work dir | `--work-dir` / `CFSYNC_WORK_DIR` | yes      | Directory pages are written to¹.                  |

¹ A relative work directory is resolved against the directory of the config
file; `--work-dir` wins over `CFSYNC_WORK_DIR`.

The config file (YAML) holds only what to sync:

| Key       | Required | Description                                                     |
|-----------|----------|-----------------------------------------------------------------|
| `timeout` | no       | Per-request HTTP timeout, e.g. `45s` (default `30s`).           |
| `pages`   | no²      | Map of destination `.md` under the work dir -> Confluence path. |
| `folders` | no²      | Map of destination dir under the work dir -> Confluence folder. |
| `spaces`  | no²      | Map of destination dir under the work dir -> Confluence space.  |

² `pages`, `folders`, and `spaces` are each optional, but configure at least
one — a config with none has nothing to sync.

A minimal `.cfsync.yaml`:

```yaml
pages:
  test/root_page_1.md: /wiki/spaces/TEST/pages/1975222283/Root+Page+1
folders:
  glossary: /wiki/spaces/TEST/folder/1614610446
spaces:
  team-wiki: /wiki/spaces/TEST
```

with the credentials in `.env`:

```sh
CFSYNC_HOST=https://your-site.atlassian.net
CFSYNC_ACCOUNT=you@example.com
CFSYNC_TOKEN=your-api-token
CFSYNC_WORK_DIR=pages
```

A folder's pages and sub-folders are mirrored directly under its key, so a page
titled "Main Glossary" in the folder above lands at `glossary/main_glossary.md`.

A space is mirrored the same way, from its homepage down: the homepage becomes
`team-wiki/_index.md`, a page with children becomes a directory holding its own
`_index.md` plus its children, and a childless page becomes `<name>.md`. The
three keys may be combined, as long as no single page is claimed by two entries.

> [!TIP]
> An exported variable overrides `.env`, so you can keep shared, non-secret
> values in `.env` and override the token per shell with `export CFSYNC_TOKEN=…`.

## Markdown format

The Markdown dialect cfsync reads and writes — frontmatter, block and inline
constructs, the `[[…]]` inline directives for Confluence-only nodes, escaping,
and which edits push versus stay read-only — is specified in
[`doc/markdown-extensions.md`](doc/markdown-extensions.md).

## Running the integration tests

cfsync has two test layers. The default suite is hermetic and needs no
credentials:

```sh
go test ./...
```

The **live integration tests** talk to a real Atlassian Site. They are gated
behind the `confluence` build tag and skip unless the environment supplies a
Site, account, token, and test space, so an ordinary `go test ./...` never runs
them.

To run them, copy the template, fill it in, and pass the build tag:

```sh
cp .env.example .env   # then edit .env
go test -tags confluence ./pkg/cfsync/
```

`.env` is a dotenv file at the repository root. It is git-ignored, and only
fills in variables that are not already exported (an exported value always
wins), so you can also supply everything directly in the environment:

```sh
export CFSYNC_TEST_HOST=https://your-site.atlassian.net
export CFSYNC_TEST_ACCOUNT=you@example.com
export CFSYNC_TEST_TOKEN=your-api-token
export CFSYNC_TEST_SPACE=SANDBOX
go test -tags confluence ./pkg/cfsync/
```

The live tests use their own `CFSYNC_TEST_*` variables, kept separate from the
production `CFSYNC_*` configuration so a test run never touches the Site your
everyday config points at. The tests read:

| Variable                    | Required | Purpose                                                    |
|-----------------------------|----------|------------------------------------------------------------|
| `CFSYNC_TEST_HOST`          | yes      | Site base URL, `https://<id>.atlassian.net`.               |
| `CFSYNC_TEST_ACCOUNT`       | yes      | Atlassian account email (Basic Auth username).             |
| `CFSYNC_TEST_TOKEN`         | yes      | Atlassian API token (Basic Auth password).                 |
| `CFSYNC_TEST_SPACE`         | yes      | Space key the mutating tests create and delete pages in.   |
| `CFSYNC_TEST_FOLDER`        | no       | Parent folder id under the test space; empty = space root. |
| `CFSYNC_TEST_EXPLORE_PAGES` | no       | Comma-separated page ids for the read-only explore probe.  |

The mutating tests create and delete throwaway pages in `CFSYNC_TEST_SPACE`, so
point it at a sandbox space you own and don't mind being written to — never a
production space.

## Resources

Licensed under the MIT License — see [`LICENSE.md`](LICENSE.md).
