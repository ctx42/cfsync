// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync/links_test.go. Paths are POSIX (Go's ToSlash/FromSlash
// are identities here); the write/load round-trip drives the injected FileSystem
// port (MemFS) instead of a temp dir.

import { describe, expect, it } from "vitest";
import {
    buildLinkIndex,
    DocLinks,
    LinkIndex,
    loadLinkIndex,
    pageURL,
} from "../../src/sync/linkindex.ts";
import { MemFS } from "../support/memfs.ts";

describe("pageURL", () => {
    it("builds a space page URL", () => {
        expect(pageURL("RZ", "123")).toBe("/wiki/spaces/RZ/pages/123");
    });
    it("falls back to an id-addressable URL without a space", () => {
        expect(pageURL("", "123")).toBe(
            "/wiki/pages/viewpage.action?pageId=123",
        );
    });
});

describe("buildLinkIndex", () => {
    it("indexes configured pages and folder pages", () => {
        const idx = buildLinkIndex(
            "/wd",
            { "/wd/a.md": "/wiki/spaces/X/pages/1/A" },
            [
                {
                    dest: "/wd/docs/b.md",
                    id: "2",
                    title: "B",
                    url: "/wiki/spaces/Y/pages/2",
                    parentId: "",
                    spaceKey: "Y",
                },
            ],
        );
        expect(idx.byID.get("1")?.url).toBe("/wiki/spaces/X/pages/1");
        expect(idx.byID.get("1")?.dest).toBe("a.md");
        expect(idx.byID.get("1")?.spaceKey).toBe("X");
        expect(idx.byID.get("2")?.title).toBe("B");
        expect(idx.byID.get("2")?.dest).toBe("docs/b.md");
        expect(idx.byID.get("2")?.spaceKey).toBe("Y");
    });

    it("canonicalizes a configured page's edit URL to its view URL", () => {
        const idx = buildLinkIndex(
            "/wd",
            { "/wd/a.md": "/wiki/spaces/IFP/pages/edit-v2/2014412813" },
            [],
        );
        expect(idx.byID.get("2014412813")?.url).toBe(
            "/wiki/spaces/IFP/pages/2014412813",
        );
        expect(idx.byID.get("2014412813")?.spaceKey).toBe("IFP");
    });

    it("skips a configured page whose source is not a page", () => {
        const idx = buildLinkIndex(
            "/wd",
            { "/wd/a.md": "/wiki/spaces/X/folder/9" },
            [],
        );
        expect(idx.byID.size).toBe(0);
    });
});

describe("write / load", () => {
    it("round-trips through the cache file", async () => {
        const fs = new MemFS();
        const idx = new LinkIndex("/wd");
        idx.add({
            id: "1",
            dest: "a.md",
            url: "/wiki/x/1",
            title: "A",
            spaceKey: "",
        });

        await idx.write(fs, "/wd/.cache/links.json");
        const loaded = await loadLinkIndex(fs, "/wd/.cache/links.json", "/wd");

        expect(loaded?.byID.get("1")?.url).toBe("/wiki/x/1");
        expect(loaded?.byDest.get("/wd/a.md")?.title).toBe("A");
    });

    it("writes nothing for an empty index", async () => {
        const fs = new MemFS();
        await new LinkIndex("/wd").write(fs, "/wd/.cache/links.json");
        expect(await fs.exists("/wd/.cache/links.json")).toBe(false);
    });

    it("returns null when no file exists", async () => {
        expect(
            await loadLinkIndex(new MemFS(), "/wd/.cache/links.json", "/wd"),
        ).toBeNull();
    });
});

/** linkTestIndex builds a one-entry index: page 456 at glossary/bar.md under /wd. */
function linkTestIndex(): LinkIndex {
    const idx = new LinkIndex("/wd");
    idx.add({
        id: "456",
        dest: "glossary/bar.md",
        url: "/wiki/spaces/X/pages/456",
        title: "Bar",
        spaceKey: "",
    });
    return idx;
}

const docLinks = (
    idx = linkTestIndex(),
    dir = "/wd/docs",
    site = "https://s.atlassian.net",
): DocLinks => new DocLinks(idx, dir, "s.atlassian.net", site);

describe("DocLinks.toLocal", () => {
    it("maps a same-site page href to a relative path", () => {
        expect(
            docLinks().toLocal(
                "https://s.atlassian.net/wiki/spaces/X/pages/456/Bar",
            ),
        ).toEqual({ target: "../glossary/bar.md", label: "Bar" });
    });

    it("preserves a fragment", () => {
        expect(
            docLinks().toLocal("/wiki/spaces/X/pages/456/Bar#intro")?.target,
        ).toBe("../glossary/bar.md#intro");
    });

    it("maps a viewpage pageId query href", () => {
        expect(
            docLinks().toLocal("/wiki/pages/viewpage.action?pageId=456"),
        ).toEqual({ target: "../glossary/bar.md", label: "Bar" });
    });

    it("maps a pageId query with a fragment", () => {
        expect(
            docLinks().toLocal(
                "https://s.atlassian.net/wiki/pages/viewpage.action?pageId=456#top",
            )?.target,
        ).toBe("../glossary/bar.md#top");
    });

    it("ignores a link to another site", () => {
        expect(
            docLinks().toLocal("https://other.example/wiki/pages/456"),
        ).toBeUndefined();
    });

    it("ignores a page not in the index", () => {
        expect(
            docLinks().toLocal("/wiki/spaces/X/pages/999/Nope"),
        ).toBeUndefined();
    });

    it("ignores a non-page href", () => {
        expect(
            docLinks().toLocal("https://s.atlassian.net/wiki/spaces/X"),
        ).toBeUndefined();
    });

    it("falls back to the file name when the entry has no title", () => {
        const idx = new LinkIndex("/wd");
        idx.add({
            id: "9",
            dest: "notes/foo.md",
            url: "/wiki/spaces/X/pages/9",
            title: "",
            spaceKey: "",
        });
        expect(
            docLinks(idx, "/wd").toLocal("/wiki/spaces/X/pages/9")?.label,
        ).toBe("foo");
    });

    it("labels a titleless space homepage with its section, not _index", () => {
        const idx = new LinkIndex("/wd");
        idx.add({
            id: "500",
            dest: "team/_index.md",
            url: "/wiki/spaces/TEAM/pages/500",
            title: "",
            spaceKey: "TEAM",
        });
        expect(
            docLinks(idx, "/wd").toLocal("/wiki/spaces/TEAM/pages/500")?.label,
        ).toBe("team");
    });

    it("falls back to the space key when the homepage sits at the root", () => {
        const idx = new LinkIndex("/wd");
        idx.add({
            id: "500",
            dest: "_index.md",
            url: "/wiki/spaces/TEAM/pages/500",
            title: "",
            spaceKey: "TEAM",
        });
        expect(
            docLinks(idx, "/wd").toLocal("/wiki/spaces/TEAM/pages/500")?.label,
        ).toBe("TEAM");
    });
});

describe("DocLinks.toRemote", () => {
    it("maps a local path back to the absolute page URL with slug", () => {
        expect(docLinks().toRemote("../glossary/bar.md")).toBe(
            "https://s.atlassian.net/wiki/spaces/X/pages/456/Bar",
        );
    });

    it("preserves a fragment", () => {
        expect(docLinks().toRemote("../glossary/bar.md#intro")).toBe(
            "https://s.atlassian.net/wiki/spaces/X/pages/456/Bar#intro",
        );
    });

    it("ignores a path not in the index", () => {
        expect(docLinks().toRemote("../glossary/other.md")).toBeUndefined();
    });

    it("ignores an absolute URL", () => {
        expect(
            docLinks().toRemote(
                "https://s.atlassian.net/wiki/spaces/X/pages/456",
            ),
        ).toBeUndefined();
    });

    it("uses a configured page URL verbatim then absolutizes", () => {
        const idx = new LinkIndex("/wd");
        idx.add({
            id: "7",
            dest: "cfg.md",
            url: "/wiki/spaces/Y/pages/7/Configured",
            title: "",
            spaceKey: "",
        });
        expect(docLinks(idx, "/wd").toRemote("cfg.md")).toBe(
            "https://s.atlassian.net/wiki/spaces/Y/pages/7/Configured",
        );
    });

    it("leaves the URL relative when the site host is unknown", () => {
        expect(
            docLinks(linkTestIndex(), "/wd/docs", "").toRemote(
                "../glossary/bar.md",
            ),
        ).toBe("/wiki/spaces/X/pages/456/Bar");
    });

    it("does not append a title slug to a query-form (viewpage.action) URL", () => {
        const idx = new LinkIndex("/wd");
        idx.add({
            id: "456",
            dest: "glossary/bar.md",
            url: "/wiki/pages/viewpage.action?pageId=456",
            title: "Bar",
            spaceKey: "",
        });
        expect(docLinks(idx, "/wd/docs").toRemote("../glossary/bar.md")).toBe(
            "https://s.atlassian.net/wiki/pages/viewpage.action?pageId=456",
        );
    });

    it("keeps a fragment after a query-form URL's query string", () => {
        const idx = new LinkIndex("/wd");
        idx.add({
            id: "456",
            dest: "glossary/bar.md",
            url: "/wiki/pages/viewpage.action?pageId=456",
            title: "Bar",
            spaceKey: "",
        });
        expect(
            docLinks(idx, "/wd/docs").toRemote("../glossary/bar.md#intro"),
        ).toBe(
            "https://s.atlassian.net/wiki/pages/viewpage.action?pageId=456#intro",
        );
    });
});
