// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Import-boundary gate. `@cfsync/core` must stay runtime-neutral: it may not
// import from `node:`, `bun:`, `obsidian`, `electron`, `@codemirror/*`, or a
// bare Node built-in. Any such import breaks mobile-readiness and the isomorphic
// contract, so this test fails CI the moment one appears. It is authoritative;
// the Biome `noNodejsModules` override is a redundant early warning.
//
// This test lives outside `src/` and is excluded from the scan, so its own
// `node:` imports (needed to read the source tree) are not a violation.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

// Bare Node built-ins that must be reached via `node:` and are banned here
// regardless of prefix.
const NODE_BUILTINS = [
    "assert",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "timers",
    "tls",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
];

// One matcher per banned import specifier. Each captures the specifier so a
// failure names exactly what leaked. Covers `import ... from "x"`,
// `import "x"`, `export ... from "x"`, dynamic `import("x")`, and
// `require("x")`.
const BANNED_SPECIFIER = new RegExp(
    "\\b(?:node|bun):" + // node:/bun: prefixed
        "|^(?:obsidian|electron)$" + // exact host-only packages
        "|^@codemirror/" + // editor engine
        `|^(?:${NODE_BUILTINS.join("|")})$`, // bare built-ins
);

// Extract every module specifier used by a source file.
const IMPORT_SITE =
    /(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']|(?:^|[^.\w])require\s*\(\s*["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']/gm;

function tsSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...tsSourceFiles(full));
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
            out.push(full);
        }
    }
    return out;
}

function specifiersOf(source: string): string[] {
    const found: string[] = [];
    for (const m of source.matchAll(IMPORT_SITE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (spec) found.push(spec);
    }
    return found;
}

describe("core import boundary", () => {
    const files = tsSourceFiles(SRC_DIR);

    it("finds source files to scan", () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)("%s imports nothing host-bound", (file) => {
        const leaks = specifiersOf(readFileSync(file, "utf8")).filter((spec) =>
            BANNED_SPECIFIER.test(spec),
        );
        expect(leaks, `${file} imports ${leaks.join(", ")}`).toEqual([]);
    });
});
