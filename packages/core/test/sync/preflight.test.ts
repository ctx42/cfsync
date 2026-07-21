// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildConfig } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { pushPreflight } from "../../src/sync/push.ts";
import { QueueHttpClient } from "../support/http-queue.ts";
import { MemFS } from "../support/memfs.ts";

const yaml = { parse };

function cfg() {
    return buildConfig(
        { pages: {}, folders: { wiki: "/wiki/spaces/T" }, spaces: {} },
        { site: "ex", account: "a@b.c", token: "t", syncRoot: "/vault" },
    );
}

function note(pageId: string, version: number): string {
    return (
        "---\n" +
        `title: P\npage_id: "${pageId}"\npage_version: ${version}\n` +
        "cfsync-plugin: pull\n" +
        "---\nbody\n"
    );
}

/** versionsJson is one bulk fetchPageVersions response for the given id/version pairs. */
function versionsJson(...pairs: Array<[string, number]>): string {
    return JSON.stringify({
        results: pairs.map(([id, number]) => ({ id, version: { number } })),
        _links: {},
    });
}

function clientOf(http: QueueHttpClient): ConfluenceClient {
    return new ConfluenceClient(http, {
        host: "https://ex.atlassian.net",
        account: "a@b.c",
        token: "t",
    });
}

describe("pushPreflight", () => {
    it("classifies in-sync, remote-moved, new, and skip", async () => {
        const fs = new MemFS();
        await fs.write("/vault/wiki/A.md", note("101", 5));
        await fs.write("/vault/wiki/B.md", note("102", 5));
        await fs.write("/vault/wiki/New.md", note("", 0));
        await fs.write("/vault/wiki/Bad.md", "no frontmatter here");

        // One bulk call returns both managed pages: A unchanged, B moved ahead.
        const http = new QueueHttpClient().rsp(
            200,
            versionsJson(["101", 5], ["102", 7]),
        );
        const client = clientOf(http);

        const out = await pushPreflight({ client, fs, yaml, config: cfg() }, [
            "/vault/wiki/A.md",
            "/vault/wiki/B.md",
            "/vault/wiki/New.md",
            "/vault/wiki/Bad.md",
        ]);

        expect(http.count).toBe(1); // bulk, not one fetch per page
        const by = Object.fromEntries(out.map((e) => [e.dest, e]));
        expect(by["/vault/wiki/A.md"]?.cls).toBe("in-sync");
        expect(by["/vault/wiki/B.md"]?.cls).toBe("remote-moved");
        expect(by["/vault/wiki/B.md"]?.remoteVersion).toBe(7);
        expect(by["/vault/wiki/New.md"]?.cls).toBe("new");
        expect(by["/vault/wiki/Bad.md"]?.cls).toBe("skip");
    });

    it("preserves the dest order of its input", async () => {
        const fs = new MemFS();
        await fs.write("/vault/wiki/New.md", note("", 0));
        await fs.write("/vault/wiki/A.md", note("101", 5));
        const http = new QueueHttpClient().rsp(200, versionsJson(["101", 5]));

        const out = await pushPreflight(
            { client: clientOf(http), fs, yaml, config: cfg() },
            ["/vault/wiki/New.md", "/vault/wiki/A.md"],
        );

        expect(out.map((e) => e.dest)).toEqual([
            "/vault/wiki/New.md",
            "/vault/wiki/A.md",
        ]);
    });

    it("marks a page missing from the response as skip, not a throw", async () => {
        const fs = new MemFS();
        await fs.write("/vault/wiki/A.md", note("101", 5));
        // The bulk response omits id 101 (deleted or not visible to the account).
        const http = new QueueHttpClient().rsp(200, versionsJson());

        const out = await pushPreflight(
            { client: clientOf(http), fs, yaml, config: cfg() },
            ["/vault/wiki/A.md"],
        );

        expect(out[0]?.cls).toBe("skip");
        expect(out[0]?.reason).toContain("not found");
        expect(out[0]?.localBase).toBe(5);
    });

    it("marks the whole batch skip when the bulk fetch fails, not a throw", async () => {
        const fs = new MemFS();
        await fs.write("/vault/wiki/A.md", note("101", 5));
        const http = new QueueHttpClient().rsp(500, "boom");

        const out = await pushPreflight(
            { client: clientOf(http), fs, yaml, config: cfg() },
            ["/vault/wiki/A.md"],
        );

        expect(out[0]?.cls).toBe("skip");
        expect(out[0]?.reason).toContain("500");
        expect(out[0]?.pageId).toBe("");
        expect(out[0]?.remoteVersion).toBe(0);
        expect(out[0]?.localBase).toBe(5);
    });
});
