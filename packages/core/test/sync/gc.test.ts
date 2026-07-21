// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync/gc_test.go. gc runs offline over the FileSystem + Yaml
// ports, so it is driven with MemFS and the real `yaml` parser.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import { collectGarbage, type GcDeps } from "../../src/sync/gc.ts";
import { MemFS } from "../support/memfs.ts";

const yaml: Yaml = { parse: (t) => parseYaml(t) };

const config = (over: {
    pages?: Record<string, string>;
    folders?: Record<string, string>;
}): Config =>
    buildConfig(over, {
        site: "ex",
        account: "a@ex.com",
        token: "secret",
        syncRoot: "/vault",
    });

/** note builds a note with a page id and optional `page_images` (localId, file). */
function note(pageId: string, images: Array<[string, string]> = []): string {
    let fm = `---\ntitle: "T"\npage_id: "${pageId}"\npage_version: 1\n`;
    if (images.length > 0) {
        fm += "page_images:\n";
        for (const [localId, file] of images) {
            fm += `  - local_id: ${localId}\n    file: ${file}\n    alt: x\n`;
        }
    }
    return `${fm}---\n\nbody`;
}

function deps(config: Config, fs: MemFS): GcDeps {
    return { fs, yaml, config, assetsDir: "/vault/_cfsync-media" };
}

describe("collectGarbage", () => {
    async function withAssets(): Promise<{ config: Config; fs: MemFS }> {
        const cfg = config({
            pages: { "a.md": "/wiki/spaces/X/pages/1/A" },
            folders: { docs: "/wiki/spaces/X/folder/100" },
        });
        const fs = new MemFS();
        // A configured page and a folder-discovered page each reference an asset.
        await fs.write(
            "/vault/a.md",
            note("1", [["L1", "_cfsync-media/used.png"]]),
        );
        await fs.write(
            "/vault/docs/b.md",
            note("2", [["L2", "../_cfsync-media/folder.png"]]),
        );
        await fs.write("/vault/_cfsync-media/used.png", "A");
        await fs.write("/vault/_cfsync-media/folder.png", "B");
        await fs.write("/vault/_cfsync-media/orphan.png", "C");
        return { config: cfg, fs };
    }

    it("reports orphaned assets no page references", async () => {
        const { config, fs } = await withAssets();
        const res = await collectGarbage(deps(config, fs), false);
        expect(res.orphans).toEqual(["/vault/_cfsync-media/orphan.png"]);
        expect(res.pruned).toBe(0);
        expect(res.report).toContain("orphan.png");
        expect(res.report).not.toContain("used.png");
        expect(res.report).toContain("--prune");
    });

    it("prunes the orphans, keeping referenced assets", async () => {
        const { config, fs } = await withAssets();
        const res = await collectGarbage(deps(config, fs), true);
        expect(res.pruned).toBe(1);
        expect(await fs.exists("/vault/_cfsync-media/orphan.png")).toBe(false);
        expect(await fs.exists("/vault/_cfsync-media/used.png")).toBe(true);
        expect(await fs.exists("/vault/_cfsync-media/folder.png")).toBe(true);
    });

    it("reports no orphans when every asset is referenced", async () => {
        const cfg = config({ pages: { "a.md": "/wiki/spaces/X/pages/1/A" } });
        const fs = new MemFS();
        await fs.write(
            "/vault/a.md",
            note("1", [["L1", "_cfsync-media/used.png"]]),
        );
        await fs.write("/vault/_cfsync-media/used.png", "A");
        const res = await collectGarbage(deps(cfg, fs), false);
        expect(res.orphans).toEqual([]);
        expect(res.report).toContain("no orphaned assets");
    });

    it("refuses to prune when a managed page cannot be read", async () => {
        const cfg = config({
            pages: { "missing.md": "/wiki/spaces/X/pages/9/M" },
        });
        const fs = new MemFS();
        await fs.write("/vault/_cfsync-media/orphan.png", "C"); // note file absent
        await expect(collectGarbage(deps(cfg, fs), true)).rejects.toThrow(
            "refusing to prune",
        );
        expect(await fs.exists("/vault/_cfsync-media/orphan.png")).toBe(true);
    });
});
