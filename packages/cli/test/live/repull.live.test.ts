// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live re-pull (merge-path) round-trips against the real Site. A re-pull writes
// an EXISTING note through Puller.mergeIntoNote, which reconciles three states:
// the note on disk (local), the cached render of the note's recorded version
// (base), and the freshly rendered remote. store() renders, merges into the
// note, then refreshes the cached render — in that order, because the merge
// base IS the cached .vN.md and refreshing it first would overwrite the base
// with the new content, so an unchanged-version re-render at the same version
// would be seen as "remote unchanged" and dropped (the comments-toggle bug).
// These tests drive that path end to end: an idempotent re-pull, a preserved
// local edit, and a render that changes at the same version (margin toggled on
// the second pull) that must re-render the note rather than drop it. The
// two-pull pattern seeds a page, pulls, rewrites the config, and pulls again,
// asserting on the pulled note's on-disk contents.
// Run: bun run --filter @cfsync/cli test:live

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import { seedPage } from "./support/roundtrip.ts";

// A short body used where the render is meant to stay stable across pulls.
const SHORT_ADF =
    '{"type":"doc","content":[{"type":"paragraph","content":[' +
    '{"type":"text","text":"A stable paragraph that survives re-pulls."}]}]}';

// A long single-sentence paragraph of short words: at margin 0 it renders as one
// long line; hard-wrapped at column 40 it splits across several lines, so the
// same-version re-render is unmistakable.
const LONG_SENTENCE =
    "The quick brown fox jumps over the lazy dog and then runs back " +
    "across the wide green meadow to rest beneath the old oak tree.";
const LONG_ADF = `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${LONG_SENTENCE}"}]}]}`;

/** body returns a note's Markdown below its `---`-fenced frontmatter. */
function body(md: string): string {
    const m = md.match(/^---\n[\s\S]*?\n---\n?/);
    return m ? md.slice(m[0].length) : md;
}

/** maxLineLen is the longest line length in `text`. */
function maxLineLen(text: string): number {
    return text.split("\n").reduce((n, line) => Math.max(n, line.length), 0);
}

describe.skipIf(!liveConfigured())("live re-pull", () => {
    const env = requireEnv();
    const client = seedClient(env);

    it("re-pull with no edits and an unchanged render leaves the note byte-identical", async () => {
        const seed = await seedPage(env, client, "repull-noop", SHORT_ADF);

        const first = await seed.run(["pull", "--config", seed.cfgPath]);
        expect(first.code, first.err).toBe(0);
        const after1 = await readFile(seed.dest, "utf8");

        const second = await seed.run(["pull", "--config", seed.cfgPath]);
        expect(second.code, second.err).toBe(0);
        const after2 = await readFile(seed.dest, "utf8");

        // The note is untouched, and the second pull reports it as unchanged.
        expect(after2).toBe(after1);
        expect(`${second.out}${second.err}`).toContain("unchanged");
    });

    it("re-pull preserves a local edit when the remote is unchanged", async () => {
        const seed = await seedPage(env, client, "repull-localedit", SHORT_ADF);

        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );

        // Append a body edit below the frontmatter (an unpushed local change).
        const edited = `${await readFile(seed.dest, "utf8")}\nLOCAL-EDIT-SENTINEL\n`;
        await writeFile(seed.dest, edited);

        const second = await seed.run(["pull", "--config", seed.cfgPath]);
        expect(second.code, second.err).toBe(0);

        // The remote never moved, so the merge keeps the local edit intact.
        const md = await readFile(seed.dest, "utf8");
        expect(md).toContain("LOCAL-EDIT-SENTINEL");
        expect(md).toContain("A stable paragraph that survives re-pulls.");
    });

    it("re-pull re-renders the note when the render changes at the same version", async () => {
        // The general form of the comments-toggle bug: nothing on the Site
        // changes, but the render does (margin turned on), so the same-version
        // re-pull must rewrite the note instead of keeping the stale one.
        const seed = await seedPage(env, client, "repull-margin", LONG_ADF);

        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );
        const md1 = await readFile(seed.dest, "utf8");
        // Margin off: the sentence renders as one long, unwrapped line.
        expect(md1).toContain(LONG_SENTENCE);
        expect(maxLineLen(body(md1))).toBeGreaterThan(40);

        // Rewrite the config to hard-wrap at column 40, then re-pull.
        const cfg = await readFile(seed.cfgPath, "utf8");
        await writeFile(seed.cfgPath, `markdown:\n  margin: 40\n${cfg}`);
        const second = await seed.run(["pull", "--config", seed.cfgPath]);
        expect(second.code, second.err).toBe(0);

        const md2 = await readFile(seed.dest, "utf8");
        // The note was re-rendered, not dropped as unchanged: it differs, the
        // paragraph is now wrapped (no line over the margin, so the sentence is
        // no longer contiguous), yet its words are all preserved.
        expect(md2).not.toBe(md1);
        expect(md2).not.toContain(LONG_SENTENCE);
        expect(maxLineLen(body(md2))).toBeLessThanOrEqual(40);
        // De-wrapped, every word survives — the reflow only moved line breaks
        // (a fixed substring like "old oak tree." can straddle a wrap point).
        expect(body(md2).replace(/\n+/g, " ")).toContain(LONG_SENTENCE);
        // The re-render came from cached ADF without a new version.
        expect(`${second.out}${second.err}`).toContain("re-rendered");
    });

    it("re-pull is idempotent: a third identical pull reports unchanged and does not thrash the note", async () => {
        const seed = await seedPage(
            env,
            client,
            "repull-idempotent",
            SHORT_ADF,
        );

        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );
        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );
        const after2 = await readFile(seed.dest, "utf8");

        const third = await seed.run(["pull", "--config", seed.cfgPath]);
        expect(third.code, third.err).toBe(0);
        const after3 = await readFile(seed.dest, "utf8");

        // The third pull writes nothing and reports the note as unchanged.
        expect(after3).toBe(after2);
        expect(`${third.out}${third.err}`).toContain("unchanged");
    });
});
