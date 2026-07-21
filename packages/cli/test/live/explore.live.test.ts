// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from explore_live_test.go. Fetches each page in CFSYNC_TEST_EXPLORE_PAGES
// and runs the lens over it read-only — a no-op Put plus a probe edit — to harden
// the round-trip against real content. It never pushes.

import {
    marshallMarkdownLinks,
    type Page,
    pageDoc,
    put,
    splitFrontmatter,
} from "@cfsync/core";
import { describe, expect, it } from "vitest";
import {
    liveConfigured,
    loadLiveEnv,
    requireEnv,
    seedClient,
} from "./support/live-env.ts";
import { collectTypes, histogram } from "./support/probe.ts";

/** editFirstParagraph appends a marker to the first plain-paragraph block. */
function editFirstParagraph(body: string): { edited: string; ok: boolean } {
    const blocks = body.split("\n\n");
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i] ?? "";
        const tb = block.trim();
        if (tb === "") {
            continue;
        }
        if ("#|>-!<`*".includes(tb.charAt(0))) {
            continue;
        }
        if (block.includes("\n|") || block.includes("\n>")) {
            continue;
        }
        blocks[i] = `${block} EDITMARKER`;
        return { edited: blocks.join("\n\n"), ok: true };
    }
    return { edited: "", ok: false };
}

/** hasExplorePages reports whether any explore page id is configured. */
function hasExplorePages(): boolean {
    const e = loadLiveEnv()?.explore ?? "";
    return e.split(",").some((s) => s.trim() !== "");
}

describe.skipIf(!liveConfigured())("live explore", () => {
    const env = requireEnv();
    const client = seedClient(env);

    it.skipIf(!hasExplorePages())(
        "runs the lens read-only over the configured pages",
        async () => {
            const pages = env.explore
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s !== "");

            const types: Record<string, number> = {};
            const marks: Record<string, number> = {};
            let noopFails = 0;
            let editOK = 0;
            let editReject = 0;
            let editErr = 0;
            let noEditable = 0;

            for (const id of pages) {
                const data = await client.fetchPage(id);
                const page: Page = {
                    name: "x.md",
                    id: data.id,
                    title: data.title,
                    version: data.version,
                    spaceId: data.spaceId,
                    parentId: data.parentId,
                    spaceKey: "",
                    domain: "",
                    adf: data.adf,
                };
                const doc = pageDoc(page);
                collectTypes(doc.doc, types, marks);

                const md = marshallMarkdownLinks(doc, {}, null, 0);
                const { body } = splitFrontmatter(md);

                // No-op: pushing the baseline unchanged must always hold.
                try {
                    put(doc, body, null, null, null);
                } catch (err) {
                    noopFails++;
                    console.log(`NOOP FAIL ${id}: ${String(err)}`);
                }

                // Edit: append a word to the first plain paragraph and re-run.
                const { edited, ok } = editFirstParagraph(body);
                if (!ok) {
                    noEditable++;
                    continue;
                }
                try {
                    put(doc, edited, null, null, null);
                    editOK++;
                } catch (err) {
                    const msg = String(err);
                    if (
                        msg.includes("did not round-trip") ||
                        msg.includes("cannot edit") ||
                        msg.includes("cannot add or remove") ||
                        msg.includes("cannot change the number of table")
                    ) {
                        editReject++;
                    } else {
                        editErr++;
                        console.log(`EDIT ERR ${id}: ${msg}`);
                    }
                }
            }

            console.log(
                `pages=${pages.length} noopFails=${noopFails} ` +
                    `editOK=${editOK} editReject=${editReject} ` +
                    `editErr=${editErr} noEditable=${noEditable}`,
            );
            console.log(`node types: ${histogram(types)}`);
            console.log(`mark types: ${histogram(marks)}`);

            // The probe's guarantee: the baseline never fails to round-trip.
            expect(noopFails).toBe(0);
        },
    );
});
