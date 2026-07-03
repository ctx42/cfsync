## v0.5.0 (Fri, 17 Jul 2026 08:29:34 UTC)
- feat(pull): skip unchanged pages, stamp cf_domain.
- fix(links): parse page id from edit-v2 URLs.

## v0.4.0 (Fri, 17 Jul 2026 07:15:35 UTC)
- feat(spaces): add space_key to pulled page frontmatter.

## v0.3.0 (Thu, 16 Jul 2026 20:35:17 UTC)
- feat(adf): add page_path to Markdown frontmatter.
- fix(links): allow editing blocks that hold page links.

## v0.2.0 (Thu, 16 Jul 2026 18:05:22 UTC)
- docs(readme): note the proxy-lag workaround for installs.
- docs: specify the Markdown flavor in a dedicated doc.
- feat(pull): pull a single page by path.
- feat(push): create new pages restricted to the author.
- docs: note that space and folder creation is out of scope.
- test: rename live-test page helpers and fix pushSpaces call.
- build(deps): add xflag and upgrade dependencies.
- refactor(cli)!: replace boolean flags with subcommands.
- fix(cfsync): push pages under folders and combined configs.
- fix(cfsync): join delete error when create restrict fails.
- fix(cfsync): stamp page_id before create refresh.
- fix(cfsync): skip non-page markdown under push roots.
- fix(cfsync): resolve children pagination next links.
- fix(cfsync): match missing link index with errors.Is.
- fix(cfsync): read explore page ids through the ring.
- fix(cfsync): drop stale folders-not-supported page error.
- fix(cfsync): honor context cancel during folder and space walks.
- fix(adf): treat ordered list markers as list kind in diff.
- fix(adf): preserve hard breaks in list items and quoted nests.
- docs(adf): align package and Origin docs with the push lens.
- fix(adf): reject ordered list inserts as plain paragraphs.
- fix(install): use first GOPATH entry for goBinPath.
- docs(textwrap): add package README with import path.
- style(cfsync): drop full godoc on tea.Model methods.
- fix(cfsync): say root destination in validateRoot errors.
- fix(cfsync): recognize only http(s) absolute next links.
- refactor(cfsync): move isDigits into helpers.go.
- style(cfsync): capitalize trailing comment in main.
- style(adf): use three-letter receiver on inlineParser.
- fix(adf): clamp heading level to the Markdown range 1-6.
- docs(adf): fold free-floating merge note into Merge3 godoc.
- fix(adf): preserve hard breaks in list and quote rebuild.
- fix(adf): keep NR anchors at baseline holes on cross-kind replace.
- fix(cfsync): map viewpage pageId query hrefs to local paths.
- fix(cfsync): bound each HTTP call with the per-request timeout.
- fix(cfsync): reject folder and space roots that share a path.
- test(cfsync): cover folder and space root path collision.
- fix(cfsync): surface Stat errors when detecting new images.
- fix(cfsync): dedupe managed destinations when scanning assets.
- fix(install): resolve devel builds from the module root.
- fix(install): thread context through toolchain steps.
- test(install,version): cover Main nil and version edge cases.
- fix(adf): align expand kind, bullet markers, and indent Atoi.
- fix(cfsync): say managed pages when prune refuses unreadable files.
- docs(textwrap): avoid a broken markdown wiki link for WrapTokens.

## v0.1.1 (Mon, 13 Jul 2026 13:57:40 UTC)
- doc: add project logo to README.
- fix(discovery): keep walking spaces and folders past a bad page.
- feat(progress): show live progress for long pull and push.
- refactor: reduce complexity and clear linter findings.
- test(progress): cover the display model and extracted helpers.
- feat(config)!: read credentials from .env, not the config file.
- fix(config): find default .env beside the config file.

## v0.1.0 (Fri, 10 Jul 2026 18:37:29 UTC)
- chore: initial project scaffold.
- feat: open-source cfsync.
- ci: add release workflow for cross-platform binaries.

