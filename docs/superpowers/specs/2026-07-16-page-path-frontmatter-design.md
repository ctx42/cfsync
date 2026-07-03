# page_path frontmatter — design

## Goal

When pulling a page, record its local Markdown path in the frontmatter so a user
can copy it straight into `cfsync push path/to/page`.

## Approach

Render a `page_path` line in the YAML frontmatter, sourced from `ADF.Name` (the
page's destination name relative to the work directory, ending in `.md`). This
is exactly the argument `cfsync push` accepts.

The field is purely informational: `push` already takes the path as a CLI
argument and does not read the frontmatter path back. `splitFrontmatter` parses
frontmatter with non-strict `yaml.Unmarshal`, so the extra key is silently
ignored and no push path changes.

### Rendered shape

```yaml
---
title: "My Page"
page_path: "docs/my-page.md"
page_id: "12345"
page_version: 7
space_id: "98"
---
```

`page_path` sits right after `title`, before the Confluence identity fields
(`page_id`, `page_version`, `space_id`).

## Where `Name` comes from

`ADF.Name` is populated on every render path — pull (`fetchPageByID`),
push-refresh (`refreshAfterPush`), and create — because the page round-trips
through its cache wrapper JSON (`page.doc()`), which carries `name`.

## Changes

1. `pkg/adf/markdown.go` — add `page_path: %q` to `ADF.frontmatter`, fed by
   `adf.Name`.
2. `pkg/adf/adf.go` — update the `Name` doc comment, which currently states it
   is not part of the rendered frontmatter.
3. Update test fixtures and assertions in `pkg/adf` and `pkg/cfsync` that check
   exact frontmatter output.

## Out of scope

- Push reading or validating `page_path` (kept informational).
- Adding `page_path` to `mdMeta`.
