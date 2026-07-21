// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the disk-derived-placement cases of pkg/cfsync/create_test.go. All
// derivation is offline over the FileSystem + Yaml ports, so it is driven with
// MemFS and the real `yaml` parser. The create execution is covered elsewhere.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Yaml } from "../../src/ports/yaml.ts";
import {
    classifyCreates,
    deSlugTitle,
    rootOf,
    underAnyRoot,
} from "../../src/sync/create.ts";
import { MemFS } from "../support/memfs.ts";

const yaml: Yaml = { parse: (t) => parseYaml(t) };

/** note builds a note's frontmatter+body from the given fields. */
function note(f: {
    title?: string;
    pageId?: string;
    spaceId?: string;
    parentId?: string;
    local?: boolean;
}): string {
    let fm = "---\n";
    if (f.title !== undefined) fm += `title: "${f.title}"\n`;
    if (f.pageId) fm += `page_id: "${f.pageId}"\n`;
    if (f.pageId) fm += "page_version: 1\n";
    if (f.spaceId) fm += `space_id: "${f.spaceId}"\n`;
    if (f.parentId) fm += `parent_id: "${f.parentId}"\n`;
    if (f.local) fm += "cf_local: true\n";
    return `${fm}---\n\nbody`;
}

/** classify writes the given files, then classifies `dests` under `roots`. */
async function classify(
    files: Record<string, string>,
    dests: string[],
    roots: string[],
) {
    const fs = new MemFS();
    for (const [path, content] of Object.entries(files)) {
        await fs.write(path, content);
    }
    return classifyCreates(fs, yaml, dests, roots);
}

describe("deSlugTitle", () => {
    it("un-slugs a directory name into a title", () => {
        expect(deSlugTitle("release_notes")).toBe("Release Notes");
        expect(deSlugTitle("faq")).toBe("Faq");
    });
});

describe("underAnyRoot / rootOf", () => {
    it("detects containment and picks the longest root", () => {
        expect(underAnyRoot("/v/docs/a.md", ["/v/docs"])).toBe(true);
        expect(underAnyRoot("/v/other/a.md", ["/v/docs"])).toBe(false);
        expect(rootOf("/v/docs/sub/a.md", ["/v/docs", "/v/docs/sub"])).toBe(
            "/v/docs/sub",
        );
    });
});

describe("classifyCreates", () => {
    it("skips a note with a page id or no title, and an id-less Pages note with no space", async () => {
        const r = await classify(
            {
                "/v/existing.md": note({ title: "E", pageId: "1" }),
                "/v/notitle.md": note({ spaceId: "9" }),
                "/v/nospace.md": note({ title: "N" }),
            },
            ["/v/existing.md", "/v/notitle.md", "/v/nospace.md"],
            [],
        );
        expect(r.candidates).toEqual([]);
        expect(r.refusals.size).toBe(0);
    });

    it("takes a Pages-mapped note with an explicit space", async () => {
        const r = await classify(
            { "/v/p.md": note({ title: "New", spaceId: "9", parentId: "50" }) },
            ["/v/p.md"],
            ["/v/docs"],
        );
        expect(r.candidates).toEqual([
            {
                dest: "/v/p.md",
                title: "New",
                spaceId: "9",
                parentId: "50",
                folders: [],
            },
        ]);
    });

    it("derives parent and space from the directory _index.md", async () => {
        const r = await classify(
            {
                "/v/docs/_index.md": note({
                    title: "Docs",
                    pageId: "100",
                    spaceId: "9",
                }),
                "/v/docs/new.md": note({ title: "New" }),
            },
            ["/v/docs/new.md"],
            ["/v/docs"],
        );
        expect(r.candidates[0]).toMatchObject({
            parentId: "100",
            spaceId: "9",
            folders: [],
        });
    });

    it("derives from agreeing stamped siblings", async () => {
        const r = await classify(
            {
                "/v/team/a.md": note({
                    title: "A",
                    pageId: "1",
                    parentId: "50",
                    spaceId: "9",
                }),
                "/v/team/new.md": note({ title: "New" }),
            },
            ["/v/team/new.md"],
            ["/v/team"],
        );
        expect(r.candidates[0]).toMatchObject({ parentId: "50", spaceId: "9" });
    });

    it("refuses when siblings disagree on the parent", async () => {
        const r = await classify(
            {
                "/v/team/a.md": note({
                    title: "A",
                    pageId: "1",
                    parentId: "50",
                    spaceId: "9",
                }),
                "/v/team/b.md": note({
                    title: "B",
                    pageId: "2",
                    parentId: "60",
                    spaceId: "9",
                }),
                "/v/team/new.md": note({ title: "New" }),
            },
            ["/v/team/new.md"],
            ["/v/team"],
        );
        expect(r.candidates).toEqual([]);
        expect(r.refusals.get("/v/team/new.md")).toContain(
            "disagrees among siblings",
        );
    });

    it("plans an ancestor folder for an unanchored subdirectory", async () => {
        const r = await classify(
            {
                "/v/space/_index.md": note({
                    title: "Space",
                    pageId: "100",
                    spaceId: "9",
                }),
                "/v/space/release_notes/child.md": note({ title: "Child" }),
            },
            ["/v/space/release_notes/child.md"],
            ["/v/space"],
        );
        const c = r.candidates[0];
        expect(c).toMatchObject({ parentId: "100", spaceId: "9" });
        expect(c?.folders).toEqual([
            { dir: "/v/space/release_notes", title: "Release Notes" },
        ]);
    });

    it("refuses a folder whose title does not round-trip", async () => {
        const r = await classify(
            {
                "/v/space/_index.md": note({
                    title: "Space",
                    pageId: "100",
                    spaceId: "9",
                }),
                "/v/space/MyFolder/child.md": note({ title: "Child" }),
            },
            ["/v/space/MyFolder/child.md"],
            ["/v/space"],
        );
        expect(r.refusals.get("/v/space/MyFolder/child.md")).toContain(
            "does not round-trip",
        );
    });

    it("refuses a page-backed directory index", async () => {
        const r = await classify(
            { "/v/docs/sub/_index.md": note({ title: "Sub" }) },
            ["/v/docs/sub/_index.md"],
            ["/v/docs"],
        );
        expect(r.refusals.get("/v/docs/sub/_index.md")).toContain(
            "page-backed directory index",
        );
    });

    it("ignores cf_local siblings when deriving an anchor", async () => {
        const r = await classify(
            {
                "/v/team/local.md": note({
                    title: "L",
                    spaceId: "9",
                    local: true,
                }),
                "/v/team/new.md": note({ title: "New" }),
            },
            ["/v/team/new.md"],
            ["/v/team"],
        );
        // No real anchor (the local file is excluded), and the dir is the root.
        expect(r.candidates).toEqual([]);
        expect(r.refusals.get("/v/team/new.md")).toContain("cannot derive");
    });
});
