# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cfsync` edits Atlassian Confluence pages as local Markdown — from a CLI **or**
from inside Obsidian — with a hard promise: a push applies exactly what changed
or is safely refused, **never corrupting the page**. Confluence stores far more
than Markdown can express (panels, macros, node ids); the round-trip stays
lossless via a *retentive lens* that caches the original ADF (Atlassian
Document Format) on pull and back-ports only changed blocks onto it on push.

A Bun monorepo with three packages sharing one runtime-neutral engine:

| Package                   | Role                                                                          |
|---------------------------|-------------------------------------------------------------------------------|
| `@cfsync/core`            | The engine: ADF↔Markdown lens, sync orchestration, port interfaces. No I/O.   |
| `@cfsync/cli`             | Standalone CLI. Node/Bun port adapters; compiled to one binary with `bun build`. |
| `@cfsync/obsidian-plugin` | Obsidian plugin. Obsidian port adapters, settings tab, control-center panel.  |

## Commands

Run from the repo root (Bun-driven workspace):

```sh
bun run typecheck       # tsc -b across all packages (src)
bun run typecheck:test  # tsc against each package's test tsconfig
bun run lint            # biome check
bun run lint:fix        # biome check --write
bun run test            # vitest run — the whole default suite is hermetic (no network)
bun run test:watch      # vitest watch
bun run build           # build plugin bundle + CLI binary
bun run check           # typecheck + typecheck:test + lint + test — run before declaring done
```

Single test / focused run (vitest):

```sh
bunx vitest run packages/core/test/sync/merge.test.ts   # one file
bunx vitest run -t 'three-way merge'                    # by test-name pattern
```

CLI from source (picks up edits without a rebuild): `bun packages/cli/src/index.ts <args>`.
Deploy the plugin into a vault: `bun run deploy:plugin /path/to/vault [--link]`.

## Architecture

### Runtime-neutral core (the central contract)

`@cfsync/core` imports **nothing** from `node:`, `bun:`, `obsidian`,
`electron`, or `@codemirror/*`. All I/O — HTTP, filesystem, clock, env,
streams, YAML, progress — is injected through **ports** (`src/ports/`,
interfaces only). The same orchestration runs under three port implementations:

- CLI adapters — `packages/cli/src/adapters/` (real Node/Bun I/O).
- Plugin adapters — `packages/obsidian-plugin/src/adapters/` (Obsidian Vault API).
- Test fakes — `packages/core/test/support/` (in-memory `memfs`, `http-stub`).

This is enforced, not aspirational: `packages/core/test/boundary.test.ts`
scans `src/` and fails CI on any banned import (Biome's `noNodejsModules`
override on `packages/core/src/**` is a redundant early warning). **When adding
to core, reach for a port — never a `node:` module.** If a capability isn't in
a port yet, add it to the port interface and implement it in all adapters + the
fake.

### The retentive lens (`src/adf/lens/`)

The lossless round-trip is a bidirectional lens between cached ADF and Markdown:

- **Get** (render) — `flavor` renders ADF → Markdown; images pulled to
  `_assets/`, cross-page links rewritten to local `.md`. Content Markdown can't
  express is frozen: block macros as fenced ` ```adf ` blocks, inline nodes as
  `` `adf:…` `` code spans or `%%adf:…%%` comments.
- **Put** (`reconstruct.ts`) — diffs edited blocks against a re-rendered
  baseline and back-ports only changed blocks onto a deep clone of the cached
  ADF, copying everything Markdown can't express untouched. Inserted blocks are
  built by `build.ts`.
- **Lens laws** gate every Put: a change that can't be represented losslessly
  is **refused, never guessed**. `parse/selfcheck.ts` decides whether an inline
  run survives a render→parse round trip (and is thus safe to reparse) or must
  stay read-only.
- `merge.ts` — block-level three-way merge folds non-overlapping remote changes
  onto local edits; a block edited on both sides is a `MergeConflictError`.

### Flavor

A `Flavor` (`src/flavor/`) is the pluggable render/reconstruct pair defining the
Markdown dialect (only `obsidian` today). The lens (diff, merge, sourcemap,
cache, pull/push) is flavor-agnostic. The push baseline is a **re-render of the
same flavor that produced the note**, so a flavor's two halves must agree.

### Sync orchestration (`src/sync/`)

`pull.ts` / `push.ts` are the entry points, driven entirely through ports.
`discover.ts` walks folders/spaces; `linkindex.ts` maps cross-page links;
`create.ts` handles new-page creation; `assets.ts`/`images.ts` handle media;
`gc.ts`/`clean.ts` are housekeeping. Under the sync root, three reserved
locations: `_assets/` (shared images), `.adf_cache/` (cached `.vN.json` ADF +
`links.json`), `_index.md` (a directory's own page).

## Conventions

- **Strict TS everywhere** (`tsconfig.base.json`): `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Imports use explicit
  `.ts` extensions (`allowImportingTsExtensions`). tsc emits declarations only;
  esbuild/bun produce runtime JS.
- **Biome format**: 4-space indent, 80-col width, double quotes (2-space for JSON).
- Every source file carries the SPDX header (copyright + MIT).
- Every package must ship at least one test (`passWithNoTests: false`).
- Golden-fixture tests use the `goldkit` shim (`test/support/goldkit.ts`) with
  fixtures under `test/**/testdata/`.

## Gotchas

- **Live tests** (`*.live.test.ts`) hit a real Confluence Site. They are
  excluded from the default suite and run **only** via the CLI package's
  `test:live` script, manually and sequentially — never automatically.
- **Never `git checkout` a file to undo an edit** — it wipes uncommitted work.
- Plans, specs, and process files go in the gitignored `./tmp/`; `./docs/` is
  only for in-depth project documentation.
- Pull is **non-destructive**: it three-way-merges to preserve local edits;
  conflict notes carry the remote version.
- This is a from-scratch TS rewrite of an earlier Go tool. **Parity with the Go
  version is not a goal** — prefer correctness; the many `ported from pkg/…`
  comments are history, not a spec to match.
