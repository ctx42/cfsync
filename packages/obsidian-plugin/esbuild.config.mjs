// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// esbuild build for the cfsync Obsidian plugin. Obsidian loads a single
// CommonJS `main.js`, so the bundle format is `cjs` and the Obsidian/Electron/
// CodeMirror APIs it provides at runtime are marked external (never bundled).
// Bun runs this script (`bun run dev` / `bun run build`); we keep the official
// sample-plugin shape.

import { copyFileSync, mkdirSync } from "node:fs";
import process from "node:process";

import builtins from "builtin-modules";
import esbuild from "esbuild";

const prod = process.argv.includes("production");
const outdir = "dist";

// APIs Obsidian injects at runtime — external so the bundle references them
// instead of inlining copies.
const external = [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
];

const context = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    target: "es2022",
    platform: "browser",
    logLevel: "info",
    treeShaking: true,
    sourcemap: prod ? false : "inline",
    minify: prod,
    external,
    outfile: `${outdir}/main.js`,
});

// Obsidian expects main.js, manifest.json, and styles.css together in the
// plugin folder; assemble them into dist/ so it can be symlinked into a vault.
mkdirSync(outdir, { recursive: true });
copyFileSync("manifest.json", `${outdir}/manifest.json`);
copyFileSync("styles.css", `${outdir}/styles.css`);

if (prod) {
    await context.rebuild();
    await context.dispose();
} else {
    await context.watch();
}
