// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the planning/routing half of pkg/cfsync (planCreates + the create
// branch of pushDests). planCreates classifies disk candidates, asks the injected
// confirm which to create (the prompt UX is the adapter's), and resolves the
// author account once any create is confirmed; pushDests then routes each dest to
// create, skip, or update. Driven through the ports with MemFS + the stub clients.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import type { CreateInput } from "../../src/sync/create.ts";
import { type CreatePlan, Pusher, planCreates } from "../../src/sync/push.ts";
import { QueueHttpClient } from "../support/http-queue.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const H = "https://ex.atlassian.net";
const yaml: Yaml = { parse: (t) => parseYaml(t) };

const config = (): Config =>
    buildConfig(
        { folders: { docs: "/wiki/spaces/X/folder/100" } },
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );

const client = (http: StubHttpClient | QueueHttpClient): ConfluenceClient =>
    new ConfluenceClient(http, {
        host: H,
        account: "a@ex.com",
        token: "secret",
    });

const note = (f: {
    title?: string;
    pageId?: string;
    space?: string;
}): string => {
    let fm = "---\n";
    if (f.title !== undefined) fm += `title: "${f.title}"\n`;
    if (f.pageId) fm += `page_id: "${f.pageId}"\npage_version: 1\n`;
    if (f.space) fm += `space_id: "${f.space}"\n`;
    return `${fm}---\n\nbody`;
};

function pusherFor(http: QueueHttpClient, fs: MemFS): Pusher {
    return new Pusher({
        client: client(http),
        fs,
        yaml,
        config: config(),
        reporter: new NoopReporter(),
        cacheDir: "/data/cache",
        assetsDir: "/vault/_cfsync-media",
        mintLocalId: () => "L0",
        links: null,
        flavor: obsidianFlavor,
        force: false,
    });
}

describe("planCreates", () => {
    it("classifies, confirms, and resolves the author account", async () => {
        const fs = new MemFS();
        await fs.write(
            "/vault/docs/_index.md",
            note({ title: "Docs", pageId: "100", space: "9" }),
        );
        await fs.write("/vault/docs/new.md", note({ title: "New" }));
        const stub = new StubHttpClient().on(
            "GET",
            `${H}/wiki/rest/api/user/current`,
            { body: '{"accountId":"acc-1"}' },
        );
        const deps = { client: client(stub), fs, yaml, config: config() };

        const plan = await planCreates(deps, ["/vault/docs/new.md"], (cands) =>
            Promise.resolve(new Map(cands.map((c) => [c.dest, true]))),
        );

        expect(plan).not.toBeNull();
        expect(plan?.inputs.get("/vault/docs/new.md")).toMatchObject({
            parentId: "100",
            spaceId: "9",
        });
        expect(plan?.decided.get("/vault/docs/new.md")).toBe(true);
        expect(plan?.accountId).toBe("acc-1");
    });

    it("returns null when nothing is to be created or refused", async () => {
        const fs = new MemFS();
        await fs.write("/vault/docs/a.md", note({ title: "A", pageId: "1" }));
        const stub = new StubHttpClient();
        const deps = { client: client(stub), fs, yaml, config: config() };

        const plan = await planCreates(deps, ["/vault/docs/a.md"], () =>
            Promise.resolve(new Map()),
        );

        expect(plan).toBeNull();
        expect(stub.requests).toEqual([]); // no account lookup when no create
    });

    it("skips the account lookup when every candidate is declined", async () => {
        const fs = new MemFS();
        await fs.write(
            "/vault/docs/_index.md",
            note({ title: "Docs", pageId: "100", space: "9" }),
        );
        await fs.write("/vault/docs/new.md", note({ title: "New" }));
        const stub = new StubHttpClient();
        const deps = { client: client(stub), fs, yaml, config: config() };

        const plan = await planCreates(deps, ["/vault/docs/new.md"], (cands) =>
            Promise.resolve(new Map(cands.map((c) => [c.dest, false]))),
        );

        expect(plan?.accountId).toBe("");
        expect(stub.requests).toEqual([]);
    });
});

describe("pushDests — create routing", () => {
    const plan = (over: Partial<CreatePlan>): CreatePlan => ({
        decided: new Map(),
        refused: new Map(),
        inputs: new Map(),
        accountId: "",
        ...over,
    });

    it("reports a refused candidate as a per-page error without any request", async () => {
        const q = new QueueHttpClient();
        const out = await pusherFor(q, new MemFS()).pushDests(
            ["/vault/docs/x.md"],
            plan({ refused: new Map([["/vault/docs/x.md", "cannot place"]]) }),
        );
        expect(out.errors[0]).toContain("cannot place");
        expect(q.count).toBe(0);
    });

    it("skips a declined candidate, leaving it untouched", async () => {
        const q = new QueueHttpClient();
        const out = await pusherFor(q, new MemFS()).pushDests(
            ["/vault/docs/x.md"],
            plan({ decided: new Map([["/vault/docs/x.md", false]]) }),
        );
        expect(out.log).toContain("creating docs/x.md ... skipped");
        expect(out.pushed).toBe(0);
        expect(q.count).toBe(0);
    });

    it("creates a confirmed candidate and logs the new version", async () => {
        const fs = new MemFS();
        const dest = "/vault/docs/new.md";
        await fs.write(dest, note({ title: "New" }));
        const input: CreateInput = {
            dest,
            title: "New",
            spaceId: "9",
            parentId: "77",
            folders: [],
        };
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"555","version":{"number":1}}')
            .rsp(200, "{}");

        const out = await pusherFor(q, fs).pushDests(
            [dest],
            plan({
                decided: new Map([[dest, true]]),
                inputs: new Map([[dest, input]]),
                accountId: "acc-1",
            }),
        );

        expect(out.pushed).toBe(1);
        expect(out.errors).toEqual([]);
        expect(out.log).toContain("creating docs/new.md ... ok (v1)");
        expect(q.requests[0]?.url).toBe(`${H}/wiki/api/v2/pages`);
    });
});
