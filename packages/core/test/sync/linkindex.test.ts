// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync/links_test.go. Paths are POSIX (Go's ToSlash/FromSlash
// are identities here); the write/load round-trip drives the injected FileSystem
// port (MemFS) instead of a temp dir.

import { describe, expect, it } from "vitest";
import {
    buildLinkIndex,
    DocLinks,
    healLinkIndex,
    LinkIndex,
    loadLinkIndex,
    mergeLinkIndex,
    openLinkIndex,
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

/** note is a managed note whose frontmatter names page `id`. */
function note(id: string): string {
    return `---\ncfsync-plugin: pull\npage_id: "${id}"\npage_version: 1\n---\nbody\n`;
}

/** entry is an index entry for page `id` at `dest`. */
function entry(id: string, dest: string) {
    return {
        id,
        dest,
        url: `/wiki/spaces/X/pages/${id}`,
        title: "",
        spaceKey: "",
    };
}

describe("healLinkIndex", () => {
    it("keeps an entry whose note carries its page id", async () => {
        const fs = new MemFS();
        await fs.write("/wd/a/x.md", note("1"));
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));

        const have = await healLinkIndex(fs, idx);

        expect(have).toEqual([]);
        expect(idx.byID.get("1")?.dest).toBe("a/x.md");
    });

    it("re-points an entry at the note that moved locally", async () => {
        const fs = new MemFS();
        await fs.write("/wd/b/x.md", note("1"));
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));

        const have = await healLinkIndex(fs, idx);

        expect(have).toEqual([
            "link index: page 1 moved locally: a/x.md -> b/x.md\n",
        ]);
        expect(idx.byID.get("1")?.dest).toBe("b/x.md");
        expect(idx.byDest.has("/wd/a/x.md")).toBe(false);
        expect(idx.byDest.get("/wd/b/x.md")?.id).toBe("1");
    });

    it("re-points an entry whose dest now holds another page", async () => {
        const fs = new MemFS();
        await fs.write("/wd/a/x.md", note("2"));
        await fs.write("/wd/b/x.md", note("1"));
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));

        await healLinkIndex(fs, idx);

        expect(idx.byID.get("1")?.dest).toBe("b/x.md");
    });

    it("drops an entry no note carries", async () => {
        const fs = new MemFS();
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));

        const have = await healLinkIndex(fs, idx);

        expect(have).toEqual([
            "link index: dropped page 1 (a/x.md): no local note carries it\n",
        ]);
        expect(idx.byID.size).toBe(0);
        expect(idx.byDest.size).toBe(0);
    });

    it("drops an entry several notes carry", async () => {
        const fs = new MemFS();
        await fs.write("/wd/b/x.md", note("1"));
        await fs.write("/wd/c/x.md", note("1"));
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));

        const have = await healLinkIndex(fs, idx);

        expect(have).toEqual([
            "link index: dropped page 1 (a/x.md): 2 local notes carry it\n",
        ]);
        expect(idx.byID.has("1")).toBe(false);
    });

    it("keeps an entry whose note has no page id", async () => {
        const fs = new MemFS();
        await fs.write("/wd/a/x.md", "no frontmatter\n");
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));

        expect(await healLinkIndex(fs, idx)).toEqual([]);
        expect(idx.byID.get("1")?.dest).toBe("a/x.md");
    });

    it("ignores copies in hidden directories", async () => {
        const fs = new MemFS();
        await fs.write("/wd/.trash/x.md", note("1"));
        await fs.write("/wd/b/x.md", note("1"));
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));

        await healLinkIndex(fs, idx);

        expect(idx.byID.get("1")?.dest).toBe("b/x.md");
    });
});

describe("openLinkIndex", () => {
    const LINKS = "/wd/.adf_cache/links.json";

    it("persists the healed index", async () => {
        const fs = new MemFS();
        await fs.write("/wd/b/x.md", note("1"));
        const idx = new LinkIndex("/wd");
        idx.add(entry("1", "a/x.md"));
        await idx.write(fs, LINKS);

        const have = await openLinkIndex(fs, LINKS, "/wd");

        expect(have.healed).toHaveLength(1);
        expect(have.links?.byID.get("1")?.dest).toBe("b/x.md");
        const reloaded = await loadLinkIndex(fs, LINKS, "/wd");
        expect(reloaded?.byID.get("1")?.dest).toBe("b/x.md");
    });

    it("leaves a sound index file untouched", async () => {
        const fs = new MemFS();
        await fs.write("/wd/a/x.md", note("1"));
        await fs.write(LINKS, '[\n  {"id": "1", "dest": "a/x.md"}\n]\n');

        const have = await openLinkIndex(fs, LINKS, "/wd");

        expect(have.healed).toEqual([]);
        expect(await fs.readText(LINKS)).toBe(
            '[\n  {"id": "1", "dest": "a/x.md"}\n]\n',
        );
    });

    it("resolves to a null index when no file exists", async () => {
        const have = await openLinkIndex(new MemFS(), LINKS, "/wd");
        expect(have).toEqual({ links: null, healed: [] });
    });
});

describe("mergeLinkIndex", () => {
    it("keeps the existing entries the fresh index does not claim", () => {
        const fresh = new LinkIndex("/wd");
        fresh.add(entry("1", "b/x.md"));
        const existing = new LinkIndex("/wd");
        existing.add(entry("1", "a/x.md"));
        existing.add(entry("2", "b/x.md"));
        existing.add(entry("3", "c/z.md"));

        const have = mergeLinkIndex(fresh, existing);

        expect(have.entries().map((e) => `${e.id}=${e.dest}`)).toEqual([
            "1=b/x.md",
            "3=c/z.md",
        ]);
    });

    it("returns the fresh index without an existing one", () => {
        const fresh = new LinkIndex("/wd");
        fresh.add(entry("1", "b/x.md"));
        expect(mergeLinkIndex(fresh, null)).toBe(fresh);
    });
});

describe("DocLinks.unmapped", () => {
    it("records a local .md target that maps to no page", () => {
        const links = docLinks();

        expect(links.toRemote("../wip/gone.md#Passkey")).toBeUndefined();
        expect(links.toRemote("../glossary/bar.md")).toBeDefined();
        expect(links.toRemote("https://x.example/a.md")).toBeUndefined();
        expect(links.toRemote("../_assets/pic.png")).toBeUndefined();

        expect([...links.unmapped]).toEqual(["../wip/gone.md"]);
    });
});
