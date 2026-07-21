// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { buildConfig, ConfluenceClient } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { QueueHttpClient } from "../../../core/test/support/http-queue.ts";
import { MemFS } from "../../../core/test/support/memfs.ts";
import type { PluginRuntime } from "../../src/runtime.ts";
import { runtimeDirs } from "../../src/runtime-dirs.ts";
import { preflight, toDest } from "../../src/ui/operations.ts";

/** versionsJson is one bulk fetchPageVersions response for the given id/version. */
function versionsJson(id: string, version: number): string {
    return JSON.stringify({
        results: [{ id, version: { number: version } }],
        _links: {},
    });
}
function note(id: string, v: number): string {
    return `---\ntitle: P\npage_id: "${id}"\npage_version: ${v}\ncfsync-plugin: pull\n---\nbody\n`;
}

async function runtime(
    http: QueueHttpClient,
    fs: MemFS,
): Promise<PluginRuntime> {
    const config = buildConfig(
        { pages: { "wiki/A.md": "/wiki/1" }, folders: {}, spaces: {} },
        { site: "ex", account: "a@b.c", token: "t", syncRoot: "." },
    );
    return {
        client: new ConfluenceClient(http, {
            host: "https://ex.atlassian.net",
            account: "a@b.c",
            token: "t",
        }),
        fs,
        yaml: { parse },
        config,
        dirs: runtimeDirs(config),
        mintLocalId: () => "id",
    };
}

describe("operations", () => {
    it("toDest cleans an active-file path", () => {
        expect(toDest("./wiki/A.md")).toBe("wiki/A.md");
    });

    it("preflight over the current note classifies against remote", async () => {
        const fs = new MemFS();
        await fs.write("wiki/A.md", note("1", 3));
        const http = new QueueHttpClient().rsp(200, versionsJson("1", 9));
        const rt = await runtime(http, fs);
        const out = await preflight(rt, "current", "wiki/A.md");
        expect(out).toHaveLength(1);
        expect(out[0]?.cls).toBe("remote-moved");
        expect(out[0]?.remoteVersion).toBe(9);
    });

    it("preflight over the current note rejects a non-managed note", async () => {
        const fs = new MemFS();
        const rt = await runtime(new QueueHttpClient(), fs);
        await expect(
            preflight(rt, "current", "not/managed.md"),
        ).rejects.toThrow(/managed/);
    });
});
