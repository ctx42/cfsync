// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildConfig } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import {
    type ActionDeps,
    applyActions,
    type Choice,
    overwrites,
    rowActions,
    type StatusRow,
    statusRows,
} from "../../src/sync/actions.ts";
import { Puller } from "../../src/sync/pull.ts";
import type { PreflightEntry } from "../../src/sync/push.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const config = buildConfig(
    { pages: { "p.md": "/wiki/spaces/X/pages/123/Title" } },
    { site: "ex", account: "a@ex.com", token: "secret", syncRoot: "/vault" },
);
const pageURL =
    "https://ex.atlassian.net/wiki/api/v2/pages/123?body-format=atlas_doc_format";
const pageBody = JSON.stringify({
    id: "123",
    title: "Title",
    spaceId: "9",
    parentId: "",
    version: { number: 3 },
    body: {
        atlas_doc_format: {
            value: JSON.stringify({
                version: 1,
                type: "doc",
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: "hello" }],
                    },
                ],
            }),
        },
    },
});

function depsOf(stub: StubHttpClient, fs: MemFS): ActionDeps {
    return {
        client: new ConfluenceClient(stub, {
            host: config.host,
            account: config.account,
            token: config.token,
        }),
        fs,
        yaml: { parse },
        config,
        reporter: new NoopReporter(),
        cacheDir: "/data/cache",
        assetsDir: "/vault/_cfsync-media",
        linksPath: "/data/cache/links.json",
        mintLocalId: () => "L0",
        flavor: obsidianFlavor,
    };
}

/** pulled pulls p.md once so the vault and cache hold v3. */
async function pulled(stub: StubHttpClient, fs: MemFS): Promise<string> {
    const d = depsOf(stub, fs);
    await new Puller({ ...d, links: null }).pullPages();
    return fs.readText("/vault/p.md");
}

const row = (name: string, kind: StatusRow["kind"]): StatusRow => ({
    dest: `/vault/${name}`,
    name,
    kind,
    detail: "",
});

describe("rowActions", () => {
    it("offers each kind its actions, skip first", () => {
        expect(rowActions("new")).toEqual(["skip", "create", "never"]);
        expect(rowActions("modified")).toEqual(["skip", "push", "overwrite"]);
        expect(rowActions("refused")).toEqual(["skip", "overwrite"]);
        expect(rowActions("remote")).toEqual(["skip", "pull"]);
        expect(rowActions("diverged")).toEqual([
            "skip",
            "push",
            "pull",
            "overwrite",
        ]);
        expect(rowActions("ignored")).toEqual(["skip", "unignore"]);
    });
});

describe("statusRows", () => {
    const entry = (
        name: string,
        cls: PreflightEntry["cls"],
    ): PreflightEntry => ({
        dest: `/vault/${name}`,
        name,
        pageId: "1",
        localBase: 2,
        remoteVersion: 4,
        cls,
        reason: cls === "refused" ? "why" : "",
        resolves: [],
    });

    it("flattens a report into rows in section order", () => {
        const have = statusRows(
            {
                push: [entry("n.md", "new"), entry("r.md", "refused")],
                pull: [entry("b.md", "remote-moved")],
                diverged: [entry("d.md", "diverged")],
                warnings: [entry("w.md", "skip")],
                ignored: ["/vault/i.md"],
            },
            "/vault",
        );

        expect(have.map((r) => [r.name, r.kind, r.detail])).toEqual([
            ["n.md", "new", ""],
            ["r.md", "refused", "why"],
            ["b.md", "remote", "local v2 -> remote v4"],
            ["d.md", "diverged", "local v2 -> remote v4, local edits"],
            ["i.md", "ignored", ""],
        ]);
    });
});

describe("applyActions", () => {
    it("does nothing when every row is skipped", async () => {
        const stub = new StubHttpClient();
        const fs = new MemFS();

        const have = await applyActions(depsOf(stub, fs), [
            { row: row("p.md", "modified"), action: "skip" },
        ]);

        expect(have).toEqual([]);
        expect(stub.requests).toEqual([]);
    });

    it("overwrites a locally edited note with its Confluence version", async () => {
        const stub = new StubHttpClient().on("GET", pageURL, {
            body: pageBody,
        });
        const fs = new MemFS();
        const fresh = await pulled(stub, fs);
        await fs.write("/vault/p.md", fresh.replace("hello", "local edit"));

        const have = await applyActions(depsOf(stub, fs), [
            { row: row("p.md", "modified"), action: "overwrite" },
        ]);

        expect(have).toEqual([
            {
                name: "p.md",
                action: "overwrite",
                ok: true,
                detail: "updated v3",
            },
        ]);
        expect(await fs.readText("/vault/p.md")).toBe(fresh);
    });

    it("runs pulls first, markers next, pushes last, past failures", async () => {
        const stub = new StubHttpClient().on("GET", pageURL, {
            body: pageBody,
        });
        const fs = new MemFS();
        const fresh = await pulled(stub, fs);
        // An edit whose push the stub fails (no PUT route), so it errors.
        await fs.write("/vault/p.md", fresh.replace("hello", "edited"));
        await fs.write("/vault/n.md", "---\ntitle: N\n---\nx\n");
        const choices: Choice[] = [
            { row: row("p.md", "modified"), action: "push" },
            { row: row("n.md", "new"), action: "never" },
            { row: row("gone.md", "remote"), action: "pull" },
        ];

        const have = await applyActions(depsOf(stub, fs), choices);

        expect(have.map((r) => [r.name, r.action, r.ok])).toEqual([
            ["gone.md", "pull", false],
            ["n.md", "never", true],
            ["p.md", "push", false],
        ]);
        expect(await fs.readText("/vault/n.md")).toContain(
            "cfsync-plugin: ignore-push",
        );
    });
});

describe("overwrites", () => {
    it("lists the rows an apply would discard edits in", () => {
        const have = overwrites([
            { row: row("a.md", "modified"), action: "overwrite" },
            { row: row("b.md", "modified"), action: "push" },
        ]);

        expect(have.map((r) => r.name)).toEqual(["a.md"]);
    });
});
