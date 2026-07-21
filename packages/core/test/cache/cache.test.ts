// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync/cache_test.go. The wrapper JSON is pretty-printed with a
// 2-space indent; `JSON.stringify(_, null, 2)` produces byte-identical output to
// Go's `MarshalIndent` for these envelopes, so the expected strings port verbatim.
// The write test drives the injected FileSystem port (MemFS) instead of a temp
// dir; the invalid-body error keeps its `encoding page <id>` prefix but not Go's
// parser-specific "invalid character" text.

import { describe, expect, it } from "vitest";
import {
    cacheFile,
    cacheFileName,
    marshalPage,
    type Page,
    pageDoc,
    readCachedPage,
    writePage,
} from "../../src/cache/cache.ts";
import { MemFS } from "../support/memfs.ts";

/** page builds a Page with sensible defaults, overridden by `over`. */
function page(over: Partial<Page> = {}): Page {
    return {
        name: "test/root_page_1.md",
        id: "1975222283",
        title: "Test Root Page 1",
        version: 5,
        spaceId: "9",
        parentId: "",
        spaceKey: "",
        domain: "",
        adf: '{"version":1,"type":"doc","content":[]}',
        ...over,
    };
}

const envelope =
    "{\n" +
    '  "name": "test/root_page_1.md",\n' +
    '  "id": "1975222283",\n' +
    '  "title": "Test Root Page 1",\n' +
    '  "version": 5,\n' +
    '  "space_id": "9",\n';
const adfBlock =
    '  "adf": {\n' +
    '    "version": 1,\n' +
    '    "type": "doc",\n' +
    '    "content": []\n' +
    "  }\n" +
    "}";

describe("cacheFile", () => {
    it("mirrors a nested name and appends the version", () => {
        expect(
            cacheFile(page({ name: "test/root_page_1.md", version: 5 })),
        ).toBe("test/root_page_1.v5.json");
    });
    it("handles a flat name", () => {
        expect(cacheFile(page({ name: "root_page_1.md", version: 12 }))).toBe(
            "root_page_1.v12.json",
        );
    });
});

describe("marshalPage", () => {
    it("pretty-prints the envelope", () => {
        expect(marshalPage(page())).toBe(`${envelope}${adfBlock}`);
    });

    it("includes parent_id after space_id when set", () => {
        expect(marshalPage(page({ parentId: "77" }))).toBe(
            `${envelope}  "parent_id": "77",\n${adfBlock}`,
        );
    });

    it("omits parent_id when unset", () => {
        expect(marshalPage(page())).not.toContain("parent_id");
    });

    it("orders parent_id, space_key, cf_domain then adf", () => {
        const out = marshalPage(
            page({
                parentId: "77",
                spaceKey: "TS",
                domain: "ex.atlassian.net",
            }),
        );
        expect(out).toBe(
            `${envelope}` +
                '  "parent_id": "77",\n' +
                '  "space_key": "TS",\n' +
                '  "cf_domain": "ex.atlassian.net",\n' +
                `${adfBlock}`,
        );
    });

    it("throws when the body is not valid JSON", () => {
        expect(() => marshalPage(page({ id: "7", adf: "not-json" }))).toThrow(
            "encoding page 7",
        );
    });
});

describe("writePage", () => {
    it("writes the page with a trailing newline, creating parent dirs", async () => {
        const fs = new MemFS();
        const p = page();
        await writePage(fs, "cache/test/root_page_1.v5.json", p);
        expect(await fs.readText("cache/test/root_page_1.v5.json")).toBe(
            `${marshalPage(p)}\n`,
        );
    });

    it("throws before writing when the body is not valid JSON", async () => {
        const fs = new MemFS();
        await expect(
            writePage(
                fs,
                "cache/x.v5.json",
                page({ id: "7", adf: "not-json" }),
            ),
        ).rejects.toThrow("encoding page 7");
        expect(await fs.exists("cache/x.v5.json")).toBe(false);
    });
});

describe("pageDoc", () => {
    it("parses the page into an ADF document", () => {
        const doc = pageDoc(
            page({ spaceKey: "TS", domain: "ex.atlassian.net" }),
        );
        expect(doc.id).toBe("1975222283");
        expect(doc.title).toBe("Test Root Page 1");
        expect(doc.version).toBe(5);
        expect(doc.spaceId).toBe("9");
        expect(doc.spaceKey).toBe("TS");
        expect(doc.domain).toBe("ex.atlassian.net");
        expect(doc.doc.type).toBe("doc");
    });
});

describe("cacheFileName", () => {
    it("matches cacheFile for the same name and version", () => {
        const p = page({ name: "docs/guide.md", version: 12 });
        expect(cacheFileName(p.name, p.version)).toBe(cacheFile(p));
        expect(cacheFileName("docs/guide.md", 12)).toBe("docs/guide.v12.json");
    });
});

describe("readCachedPage", () => {
    it("round-trips a page written by writePage", async () => {
        const fs = new MemFS();
        const p = page({ spaceKey: "TS", domain: "ex.atlassian.net" });
        const path = `cache/${cacheFile(p)}`;
        await writePage(fs, path, p);

        const got = await readCachedPage(fs, path);

        expect(got).not.toBeNull();
        expect(got?.id).toBe(p.id);
        expect(got?.title).toBe(p.title);
        expect(got?.version).toBe(5);
        expect(got?.spaceId).toBe("9");
        expect(got?.spaceKey).toBe("TS");
        expect(got?.domain).toBe("ex.atlassian.net");
        // The re-serialized ADF parses back to the same document.
        expect(JSON.parse(got?.adf ?? "null")).toEqual(JSON.parse(p.adf));
    });

    it("returns null for an absent file", async () => {
        await expect(
            readCachedPage(new MemFS(), "cache/missing.v1.json"),
        ).resolves.toBeNull();
    });

    it("returns null for a non-wrapper or unparseable file", async () => {
        const fs = new MemFS();
        await fs.write("cache/bad.json", "not json{");
        await fs.write("cache/nowrap.json", '{"no":"adf"}');
        await expect(readCachedPage(fs, "cache/bad.json")).resolves.toBeNull();
        await expect(
            readCachedPage(fs, "cache/nowrap.json"),
        ).resolves.toBeNull();
    });
});
