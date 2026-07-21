// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the walk halves of pkg/cfsync/folders_test.go and spaces_test.go.
// The walk fetches children through the HttpClient port, so it is driven with the
// StubHttpClient (a canned children response per node URL).

import { describe, expect, it } from "vitest";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import {
    collides,
    deriveName,
    discoverFolders,
    discoverSpaces,
} from "../../src/sync/discover.ts";
import type { DiscoveredPage } from "../../src/sync/linkindex.ts";
import { StubHttpClient } from "../support/http-stub.ts";

const H = "https://ex.atlassian.net";

/** CountReporter counts found() calls so a test can compare it to the pages returned. */
class CountReporter extends NoopReporter {
    found_count = 0;
    override found(): void {
        this.found_count++;
    }
}

const client = (stub: StubHttpClient): ConfluenceClient =>
    new ConfluenceClient(stub, {
        host: H,
        account: "a@ex.com",
        token: "secret",
    });

function config(over: {
    pages?: Record<string, string>;
    folders?: Record<string, string>;
    spaces?: Record<string, string>;
}): Config {
    return buildConfig(over, {
        site: "ex",
        account: "a@ex.com",
        token: "secret",
        syncRoot: "/vault",
    });
}

/** children registers a direct-children response for a folder/page node. */
function children(
    stub: StubHttpClient,
    kind: "folders" | "pages",
    id: string,
    results: Array<{
        id: string;
        type: string;
        title: string;
        status?: string;
    }>,
): StubHttpClient {
    return stub.on("GET", `${H}/wiki/api/v2/${kind}/${id}/direct-children`, {
        body: JSON.stringify({
            results: results.map((r) => ({ status: "current", ...r })),
            _links: {},
        }),
    });
}

describe("deriveName", () => {
    it("lowercases, joins whitespace, and sanitizes", () => {
        expect(deriveName("My Page Title")).toBe("my_page_title");
        expect(deriveName("A/B:C?")).toBe("a_b_c_");
        expect(deriveName(".hidden.")).toBe("_hidden_");
    });
    it("throws for a title that derives to nothing", () => {
        expect(() => deriveName("   ")).toThrow("derives to an empty name");
    });
});

describe("discoverFolders", () => {
    it("derives destinations and recurses sub-folders", async () => {
        const stub = new StubHttpClient();
        children(stub, "folders", "100", [
            { id: "1", type: "page", title: "Alpha Page" },
            { id: "2", type: "folder", title: "Sub" },
        ]);
        children(stub, "folders", "2", [
            { id: "3", type: "page", title: "Beta" },
        ]);
        const cfg = config({ folders: { docs: "/wiki/spaces/X/folder/100" } });

        const { pages, errors } = await discoverFolders(
            client(stub),
            cfg,
            new NoopReporter(),
        );

        expect(errors).toEqual([]);
        expect(pages).toEqual([
            {
                dest: "/vault/docs/alpha_page.md",
                id: "1",
                title: "Alpha Page",
                url: "/wiki/spaces/X/pages/1",
                parentId: "100",
                spaceKey: "",
            },
            {
                dest: "/vault/docs/sub/beta.md",
                id: "3",
                title: "Beta",
                url: "/wiki/spaces/X/pages/3",
                parentId: "2",
                spaceKey: "",
            },
        ]);
    });

    it("records a name collision and skips the duplicate", async () => {
        const stub = new StubHttpClient();
        children(stub, "folders", "100", [
            { id: "1", type: "page", title: "Dup" },
            { id: "2", type: "page", title: "Dup" },
        ]);
        const cfg = config({ folders: { docs: "/wiki/spaces/X/folder/100" } });

        const { pages, errors } = await discoverFolders(
            client(stub),
            cfg,
            new NoopReporter(),
        );

        expect(pages).toHaveLength(1);
        expect(errors[0]).toContain("name collision");
    });
});

describe("discoverSpaces", () => {
    function space(
        stub: StubHttpClient,
        key: string,
        homepageId: string,
    ): void {
        stub.on("GET", `${H}/wiki/api/v2/spaces?keys=${key}`, {
            body: JSON.stringify({ results: [{ id: "S1", homepageId }] }),
        });
    }

    it("places the homepage as _index and walks leaves and containers", async () => {
        const stub = new StubHttpClient();
        space(stub, "TEAM", "H");
        children(stub, "pages", "H", [
            { id: "C1", type: "page", title: "Guide" }, // container (has a child)
            { id: "L1", type: "page", title: "Notes" }, // leaf
        ]);
        children(stub, "pages", "C1", [
            { id: "G1", type: "page", title: "Intro" },
        ]);
        children(stub, "pages", "L1", []);
        children(stub, "pages", "G1", []);
        const cfg = config({ spaces: { team: "/wiki/spaces/TEAM" } });

        const { pages, errors } = await discoverSpaces(
            client(stub),
            cfg,
            new NoopReporter(),
        );

        expect(errors).toEqual([]);
        const byDest = Object.fromEntries(pages.map((p) => [p.dest, p]));
        expect(byDest["/vault/team/_index.md"]?.id).toBe("H");
        expect(byDest["/vault/team/_index.md"]?.parentId).toBe("");
        expect(byDest["/vault/team/guide/_index.md"]?.id).toBe("C1");
        expect(byDest["/vault/team/guide/intro.md"]?.parentId).toBe("C1");
        expect(byDest["/vault/team/notes.md"]?.id).toBe("L1");
        for (const p of pages) {
            expect(p.spaceKey).toBe("TEAM");
        }
    });

    it("drops a name-colliding sibling without counting or fetching its subtree", async () => {
        const stub = new StubHttpClient();
        space(stub, "TEAM", "H");
        // Two sibling container pages derive to the same name; the later one
        // (C2) loses the sibling slot and must be dropped whole.
        children(stub, "pages", "H", [
            { id: "C1", type: "page", title: "Dup" },
            { id: "C2", type: "page", title: "Dup" },
        ]);
        children(stub, "pages", "C1", [
            { id: "G1", type: "page", title: "Win Child" },
        ]);
        children(stub, "pages", "G1", []);
        // C2's own children are fetched to classify it as a container, but its
        // grandchild (G2) must never be walked once C2 is dropped.
        children(stub, "pages", "C2", [
            { id: "G2", type: "page", title: "Lose Child" },
        ]);
        children(stub, "pages", "G2", []);
        const cfg = config({ spaces: { team: "/wiki/spaces/TEAM" } });
        const reporter = new CountReporter();

        const { pages, errors } = await discoverSpaces(
            client(stub),
            cfg,
            reporter,
        );

        // Homepage + C1 container + G1 leaf: the dropped C2 subtree contributes
        // nothing.
        const dests = pages.map((p) => p.dest).sort();
        expect(dests).toEqual([
            "/vault/team/_index.md",
            "/vault/team/dup/_index.md",
            "/vault/team/dup/win_child.md",
        ]);
        expect(errors.some((e) => e.includes("name collision"))).toBe(true);
        // Item 28: found() fires exactly once per returned page, never for the
        // dropped sibling's subtree.
        expect(reporter.found_count).toBe(pages.length);
        // Item 30: the loser's subtree is never fetched over HTTP. Its own
        // classification fetch (C2) happened, but its grandchild (G2) did not.
        const urls = stub.requests.map((r) => r.url);
        expect(urls.some((u) => u.includes("/pages/C2/direct-children"))).toBe(
            true,
        );
        expect(urls.some((u) => u.includes("/pages/G2/direct-children"))).toBe(
            false,
        );
    });

    it("errors when the space has no homepage", async () => {
        const stub = new StubHttpClient();
        space(stub, "TEAM", "");
        const cfg = config({ spaces: { team: "/wiki/spaces/TEAM" } });

        const { errors } = await discoverSpaces(
            client(stub),
            cfg,
            new NoopReporter(),
        );
        expect(errors[0]).toContain("has no homepage");
    });
});

describe("collides", () => {
    const disc = (over: Partial<DiscoveredPage>): DiscoveredPage => ({
        dest: "/vault/a.md",
        id: "1",
        title: "T",
        url: "/wiki/x/1",
        parentId: "",
        spaceKey: "",
        ...over,
    });

    it("passes a non-colliding set", () => {
        const cfg = config({ pages: { "a.md": "/wiki/spaces/X/pages/1/A" } });
        expect(() =>
            collides(cfg, [disc({ dest: "/vault/b.md", id: "2" })]),
        ).not.toThrow();
    });

    it("rejects two entries at the same destination", () => {
        const cfg = config({ pages: { "a.md": "/wiki/spaces/X/pages/1/A" } });
        expect(() =>
            collides(cfg, [disc({ dest: "/vault/a.md", id: "2" })]),
        ).toThrow("claimed by more than one entry");
    });

    it("rejects one page id claimed twice", () => {
        const cfg = config({ pages: { "a.md": "/wiki/spaces/X/pages/1/A" } });
        expect(() =>
            collides(cfg, [disc({ dest: "/vault/b.md", id: "1" })]),
        ).toThrow("page 1 is claimed by more than one entry");
    });
});
