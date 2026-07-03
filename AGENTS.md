# AGENTS.md

`cfsync` is a CLI that syncs Confluence pages to local Markdown and back. The
package godoc is the source of truth for design and invariants — read it rather
than duplicating it here. This file lists the commands you need.

## Layout

```
cfsync/
├── cmd/
│   ├── cfsync/    main package; the CLI binary entry point
│   └── install/   installer: builds the CLI with version metadata into GOBIN
├── internal/      install and version helpers, not part of the public API
├── pkg/
│   ├── cfsync/    command implementation: flags, config, HTTP, pull/push/gc/clean
│   ├── adf/       ADF <-> Markdown: parse, render, diff/merge, and the push lens
│   └── textwrap/  single-paragraph reflow to a display width
├── configs/       project configuration
└── dev/           developer notes and tasks
```

## Build

```sh
go build ./...                    # build every package
go build -o cfsync ./cmd/cfsync   # build the CLI binary
```

## Test

```sh
go test ./...                     # full hermetic suite, no credentials
go test ./pkg/adf/                # one package
```

## Format & vet

```sh
gofmt -l .                        # lists files needing formatting (want: empty)
go vet ./...
go vet -tags confluence ./...     # also vet the live-test files
```

## Fuzz (after any parse/render/lens change)

```sh
go test ./pkg/adf/ -run=x -fuzz=FuzzInline   -fuzztime=20s
go test ./pkg/adf/ -run=x -fuzz='^FuzzMerge$' -fuzztime=20s
go test ./pkg/adf/ -run=x -fuzz=FuzzMerge3    -fuzztime=20s
```

## Live tests (mutating, network-bound — confirm before running)

Gated behind the `confluence` build tag; skip unless the `CFSYNC_TEST_*`
variables are set, in the environment or a `.env` file at the repo root (see
`.env.example`). They create and delete throwaway pages in `CFSYNC_TEST_SPACE`.

```sh
cp .env.example .env              # then fill in the CFSYNC_TEST_* values
go test -tags confluence ./pkg/cfsync/
```

## Run the CLI

```sh
cfsync test                       # verify authenticated access to the Site
cfsync pull                       # pull configured pages and folders to .md
cfsync push                       # push every edited page
cfsync push test/page.md          # push one page (work-dir-relative path)
cfsync gc                         # list orphaned files under _assets/
cfsync gc --prune                 # delete them
cfsync clean                      # remove local files deleted in Confluence
cfsync clean --yes                # ... without the prompt
cfsync version
cfsync help
```
