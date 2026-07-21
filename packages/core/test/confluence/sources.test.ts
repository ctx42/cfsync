// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync's pull_test.go (Test_pageID_tabular / _error_tabular).

import { describe, expect, it } from "vitest";
import {
    folderID,
    isDigits,
    pageID,
    spaceKeyOf,
    spaceLinkKey,
    tryPageID,
} from "../../src/confluence/sources.ts";

describe("pageID", () => {
    const ok: Array<{ name: string; src: string; want: string }> = [
        {
            name: "page",
            src: "/wiki/spaces/TEST/pages/1975222283/Title",
            want: "1975222283",
        },
        {
            name: "page trailing",
            src: "/wiki/spaces/TEST/pages/42",
            want: "42",
        },
        {
            name: "page with query",
            src: "/wiki/spaces/TEST/pages/7/Title?draft=1",
            want: "7",
        },
        {
            name: "edit-v2 form",
            src: "/wiki/spaces/TEST/pages/edit-v2/1975222283",
            want: "1975222283",
        },
        {
            name: "edit-v2 with fragment",
            src: "/wiki/spaces/TEST/pages/edit-v2/42#Heading",
            want: "42",
        },
    ];
    for (const tc of ok) {
        it(`extracts the id from a ${tc.name}`, () => {
            expect(pageID(tc.src)).toBe(tc.want);
        });
    }

    const errs: Array<{ name: string; src: string }> = [
        { name: "folder source", src: "/wiki/spaces/TEST/folder/" },
        { name: "no id segment", src: "/wiki/spaces/TEST/pages/" },
        { name: "non-numeric id", src: "/wiki/spaces/TEST/pages/abc/Title" },
    ];
    for (const tc of errs) {
        it(`rejects a ${tc.name}`, () => {
            expect(() => pageID(tc.src)).toThrow("not a single page");
        });
    }

    it("tryPageID returns undefined instead of throwing", () => {
        expect(tryPageID("/wiki/spaces/TEST/folder/")).toBeUndefined();
        expect(tryPageID("/wiki/spaces/TEST/pages/42")).toBe("42");
    });
});

describe("isDigits", () => {
    it("reports non-empty all-digit strings", () => {
        expect(isDigits("42")).toBe(true);
        expect(isDigits("")).toBe(false);
        expect(isDigits("4a")).toBe(false);
        expect(isDigits("-1")).toBe(false);
    });
});

describe("folderID", () => {
    it("extracts the id after a folder segment", () => {
        expect(folderID("/wiki/spaces/X/folder/100")).toBe("100");
        expect(folderID("/wiki/spaces/X/folder/42?x=1")).toBe("42");
    });
    it("rejects a non-folder source", () => {
        expect(() => folderID("/wiki/spaces/X/pages/1/Title")).toThrow(
            "is not a folder",
        );
    });
});

describe("spaceLinkKey", () => {
    it("extracts a space-root key", () => {
        expect(spaceLinkKey("/wiki/spaces/TEAM")).toBe("TEAM");
        expect(spaceLinkKey("/wiki/spaces/TEAM/overview")).toBe("TEAM");
        expect(spaceLinkKey("/wiki/spaces/TEAM?x=1#f")).toBe("TEAM");
    });
    it("rejects a page or folder link", () => {
        expect(() => spaceLinkKey("/wiki/spaces/TEAM/pages/1/T")).toThrow(
            "is not a space root",
        );
    });
});

describe("spaceKeyOf", () => {
    it("returns the space key or empty", () => {
        expect(spaceKeyOf("/wiki/spaces/X/folder/100")).toBe("X");
        expect(spaceKeyOf("/no/spaces/here-ish")).toBe("here-ish");
        expect(spaceKeyOf("/wiki/pages/1")).toBe("");
    });
});
