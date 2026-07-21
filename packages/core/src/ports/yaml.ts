// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The YAML port. The core reads a note's `cfsync:` frontmatter to push it, but
// stays free of any YAML library: the plugin backs this with Obsidian's native
// `parseYaml`, the CLI with the `yaml` package. Core owns splitting the `---`
// fences and mapping the parsed object onto the typed push metadata; the adapter
// owns only the YAML text → object step.

/** Parses a YAML document into a plain value (object, array, or scalar). */
export interface Yaml {
    /** Parse `text` as YAML. Implementations may throw on malformed input. */
    parse(text: string): unknown;
}
