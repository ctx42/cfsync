// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildConfig } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { newADF } from "../../src/models/adf.ts";
import type { PreflightDeps } from "../../src/sync/push.ts";
import { collectStatus, isClean } from "../../src/sync/status.ts";
import { QueueHttpClient } from "../support/http-queue.ts";
import { MemFS } from "../support/memfs.ts";

const cacheDir = "/cache";

const adfDoc = {
    version: 1,
    type: "doc",
    content: [
        {
            type: "paragraph",
            attrs: { localId: "p1" },
            content: [{ type: "text", text: "Body text." }],
        },
    ],
};

/** pulled seeds a note and its cached base as a pull of `name` would. */
async function pulled(
    fs: MemFS,
    name: string,
    id: string,
    version: number,
): Promise<void> {
    const json = JSON.stringify({
        name,
        id,
        title: "P",
        version,
        space_id: "9",
        adf: adfDoc,
    });
    const md = obsidianFlavor.render(newADF(json), {
        assets: {},
        links: null,
    })[0];
    const base = name.slice(0, -".md".length);
    await fs.write(`/vault/${name}`, md);
    await fs.write(`${cacheDir}/${base}.v${version}.json`, json);
    await fs.write(`${cacheDir}/${base}.v${version}.md`, md);
}

/** edited rewrites the note's body text so a push would change the page. */
async function edited(fs: MemFS, path: string): Promise<void> {
    const md = await fs.readText(path);
    await fs.write(path, md.replace("Body text.", "Edited text."));
}

function versionsJson(...pairs: Array<[string, number]>): string {
    return JSON.stringify({
        results: pairs.map(([id, number]) => ({ id, version: { number } })),
        _links: {},
    });
}

function depsOf(http: QueueHttpClient, fs: MemFS): PreflightDeps {
    return {
        client: new ConfluenceClient(http, {
            host: "https://ex.atlassian.net",
            account: "a@b.c",
            token: "t",
        }),
        fs,
        yaml: { parse },
        config: buildConfig(
            { pages: {}, folders: { wiki: "/wiki/spaces/T" }, spaces: {} },
            { site: "ex", account: "a@b.c", token: "t", syncRoot: "/vault" },
        ),
        cacheDir,
        flavor: obsidianFlavor,
        links: null,
    };
}

/** vault seeds one note per section plus an unchanged and an ignored one. */
async function vault(fs: MemFS): Promise<void> {
    await pulled(fs, "wiki/Same.md", "1", 5);
    await pulled(fs, "wiki/eng/Edited.md", "2", 5);
    await edited(fs, "/vault/wiki/eng/Edited.md");
    await pulled(fs, "wiki/Behind.md", "3", 5);
    await pulled(fs, "wiki/Both.md", "4", 5);
    await edited(fs, "/vault/wiki/Both.md");
    await fs.write("/vault/wiki/eng/New.md", "---\ntitle: New\n---\nx\n");
    await fs.write(
        "/vault/wiki/Mine.md",
        "---\ntitle: Mine\ncfsync-plugin: ignore-push\n---\nx\n",
    );
}

describe("collectStatus", () => {
    it("groups notes into push, pull, and diverged, dropping unchanged", async () => {
        const fs = new MemFS();
        await vault(fs);
        const http = new QueueHttpClient().rsp(
            200,
            versionsJson(["1", 5], ["2", 5], ["3", 6], ["4", 6]),
        );

        const have = await collectStatus(depsOf(http, fs));

        expect(have.push.map((e) => [e.cls, e.name])).toEqual([
            ["modified", "wiki/eng/Edited.md"],
            ["new", "wiki/eng/New.md"],
        ]);
        expect(have.pull.map((e) => e.name)).toEqual(["wiki/Behind.md"]);
        expect(have.diverged.map((e) => e.name)).toEqual(["wiki/Both.md"]);
        expect(have.warnings).toEqual([]);
        expect(have.ignored).toEqual([]);
        expect(isClean(have)).toBe(false);
    });

    it("lists ignored notes only when asked", async () => {
        const fs = new MemFS();
        await vault(fs);
        const http = new QueueHttpClient().rsp(
            200,
            versionsJson(["1", 5], ["2", 5], ["3", 5], ["4", 5]),
        );

        const have = await collectStatus(depsOf(http, fs), { ignored: true });

        expect(have.ignored).toEqual(["/vault/wiki/Mine.md"]);
    });

    it("reports only notes under the scope", async () => {
        const fs = new MemFS();
        await vault(fs);
        const http = new QueueHttpClient().rsp(200, versionsJson(["2", 5]));

        const have = await collectStatus(depsOf(http, fs), {
            scope: "/vault/wiki/eng",
        });

        expect(have.push.map((e) => e.name)).toEqual([
            "wiki/eng/Edited.md",
            "wiki/eng/New.md",
        ]);
        expect(have.pull).toEqual([]);
        expect(have.diverged).toEqual([]);
    });

    it("is clean when every note is unchanged", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/Same.md", "1", 5);
        const http = new QueueHttpClient().rsp(200, versionsJson(["1", 5]));

        const have = await collectStatus(depsOf(http, fs));

        expect(isClean(have)).toBe(true);
    });

    it("throws when Confluence cannot be reached", async () => {
        const fs = new MemFS();
        await vault(fs);
        const http = new QueueHttpClient().rsp(503, "down");

        await expect(collectStatus(depsOf(http, fs))).rejects.toThrow("503");
    });
});
