// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Mutating round-trip integration tests against the real Atlassian Site, ported
// from roundtrip_live_test.go. Each seeds a throwaway page, pulls it, edits the
// Markdown, pushes, then fetches the page fresh and asserts on the result. Every
// page is deleted on completion. Run with: bun run --filter @cfsync/cli test:live

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attrStr, type Node } from "@cfsync/core";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import {
    liveConfigured,
    makeRun,
    requireEnv,
    seedClient,
} from "./support/live-env.ts";
import {
    docText,
    firstNode,
    parseDoc,
    textNodeWith,
    uniqueTitle,
    waitForPageVersion,
} from "./support/probe.ts";

// 1x1 transparent PNG, so an uploaded attachment is a real image.
const ONE_PIXEL_PNG = Uint8Array.from(
    atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk" +
            "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
);

describe.skipIf(!liveConfigured())("live round-trip", () => {
    const env = requireEnv();
    const client = seedClient(env);
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfsync-live-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /**
     * liveRoundTrip seeds `initialADF`, pulls it into `dir`, applies `edit` to the
     * pulled Markdown, pushes, and returns the page fetched fresh from the Site.
     */
    async function liveRoundTrip(
        name: string,
        initialADF: string,
        edit: (dir: string, md: string) => Promise<string> | string,
    ): Promise<Node> {
        const run = makeRun(env, dir);
        const spaceId = (await client.resolveSpace(env.space)).id;
        const { id } = await client.createPage({
            spaceId,
            title: uniqueTitle(name),
            parentId: env.folder,
            docJSON: initialADF,
        });
        onTestFinished(async () => {
            await client.deletePage(id).catch(() => {});
        });

        const cfgPath = join(dir, ".cfsync.yaml");
        const src = `/wiki/spaces/${env.space}/pages/${id}/it`;
        await writeFile(cfgPath, `pages:\n  page.md: ${src}\n`);

        const pulled = await run(["pull", "--config", cfgPath]);
        expect(pulled.code, pulled.err).toBe(0);

        const dest = join(dir, "page.md");
        const md = await readFile(dest, "utf8");
        await writeFile(dest, await edit(dir, md));

        const pushed = await run(["push", "--config", cfgPath]);
        expect(pushed.code, pushed.err).toBe(0);

        const fetched = await client.fetchPage(id);
        return parseDoc(fetched.adf);
    }

    it("smoke: create, pull, delete", async () => {
        const doc = await liveRoundTrip(
            "smoke",
            '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello from cfsync"}]}]}',
            (_d, md) => md,
        );
        expect(docText(doc)).toContain("hello from cfsync");
    });

    it("paragraph: in-place text edit", async () => {
        const doc = await liveRoundTrip(
            "para",
            '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"before edit"}]}]}',
            (_d, md) => md.replace("before edit", "after edit"),
        );
        const text = docText(doc);
        expect(text).toContain("after edit");
        expect(text).not.toContain("before edit");
    });

    it("structural insert: appended paragraph", async () => {
        const doc = await liveRoundTrip(
            "insert",
            '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"first para"}]}]}',
            (_d, md) => `${md}\n\nsecond para added`,
        );
        expect(docText(doc)).toContain("second para added");
    });

    it("table cell: edit one cell, structure frozen", async () => {
        const doc = await liveRoundTrip(
            "table",
            '{"type":"doc","content":[{"type":"table","content":[' +
                '{"type":"tableRow","content":[' +
                '{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Key"}]}]},' +
                '{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Val"}]}]}]},' +
                '{"type":"tableRow","content":[' +
                '{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"cellone"}]}]},' +
                '{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"celltwo"}]}]}]}]}]}',
            (_d, md) => md.replace("cellone", "celledited"),
        );
        expect(firstNode(doc, "table")).toBeDefined();
        const text = docText(doc);
        expect(text).toContain("celledited");
        expect(text).toContain("celltwo");
    });

    it("multi-paragraph list: edit one of two paragraphs", async () => {
        const doc = await liveRoundTrip(
            "mplist",
            '{"type":"doc","content":[{"type":"bulletList","content":[' +
                '{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"lead para"}]},' +
                '{"type":"paragraph","content":[{"type":"text","text":"tail para"}]}]}]}]}',
            (_d, md) => md.replace("tail para", "tail edited"),
        );
        const text = docText(doc);
        expect(text).toContain("lead para");
        expect(text).toContain("tail edited");
    });

    it("ordered list: edit one of three items, count frozen", async () => {
        const doc = await liveRoundTrip(
            "olist",
            '{"type":"doc","content":[{"type":"orderedList","attrs":{"order":1},"content":[' +
                '{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item one"}]}]},' +
                '{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item two"}]}]},' +
                '{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item three"}]}]}]}]}',
            (_d, md) => {
                expect(md).toContain("1. item one");
                return md.replace("item two", "item edited");
            },
        );
        const list = firstNode(doc, "orderedList");
        expect(list).toBeDefined();
        expect(list?.content?.length).toBe(3);
        const text = docText(doc);
        expect(text).toContain("item one");
        expect(text).toContain("item edited");
        expect(text).toContain("item three");
        expect(text).not.toContain("item two");
    });

    it("multi-paragraph cell: edit one paragraph of a cell", async () => {
        const doc = await liveRoundTrip(
            "mpcell",
            '{"type":"doc","content":[{"type":"table","content":[' +
                '{"type":"tableRow","content":[' +
                '{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Head"}]}]}]},' +
                '{"type":"tableRow","content":[' +
                '{"type":"tableCell","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"cellone"}]},' +
                '{"type":"paragraph","content":[{"type":"text","text":"celltwo"}]}]}]}]}]}',
            (_d, md) => {
                expect(md).toContain("cellone<br>celltwo");
                return md.replace("cellone", "celledited");
            },
        );
        const cell = firstNode(doc, "tableCell");
        expect(cell).toBeDefined();
        expect(cell?.content?.length).toBe(2);
        const text = docText(doc);
        expect(text).toContain("celledited");
        expect(text).toContain("celltwo");
    });

    it("marks: underline + textColor survive", async () => {
        const doc = await liveRoundTrip(
            "marks",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"keep "},' +
                '{"type":"text","text":"styled","marks":[' +
                '{"type":"underline"},' +
                '{"type":"textColor","attrs":{"color":"#ff0000"}}]}]}]}',
            (_d, md) => {
                expect(md).toContain("<u>styled</u>");
                expect(md).toContain("color:#ff0000");
                return md.replace("keep", "KEEP");
            },
        );
        const styled = textNodeWith(doc, "styled");
        expect(styled).toBeDefined();
        const hasU = (styled?.marks ?? []).some((m) => m.type === "underline");
        const color = (styled?.marks ?? []).find((m) => m.type === "textColor")
            ?.attrs?.["color"];
        expect(hasU).toBe(true);
        expect(color).toBe("#ff0000");
        expect(docText(doc)).toContain("KEEP");
    });

    it("panel: edit body, panelType frozen", async () => {
        const doc = await liveRoundTrip(
            "panel",
            '{"type":"doc","content":[{"type":"panel","attrs":{"panelType":"info"},"content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"note body"}]}]}]}',
            (_d, md) => md.replace("note body", "note revised"),
        );
        const panel = firstNode(doc, "panel");
        expect(panel).toBeDefined();
        expect(attrStr(panel?.attrs, "panelType")).toBe("info");
        expect(docText(doc)).toContain("note revised");
    });

    it("blockquote: edit body, stays a blockquote", async () => {
        const doc = await liveRoundTrip(
            "quote",
            '{"type":"doc","content":[{"type":"blockquote","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"quoted words"}]}]}]}',
            (_d, md) => md.replace("quoted words", "quoted edited"),
        );
        expect(firstNode(doc, "blockquote")).toBeDefined();
        expect(docText(doc)).toContain("quoted edited");
    });

    it("expand: edit body, title frozen", async () => {
        const doc = await liveRoundTrip(
            "expand",
            '{"type":"doc","content":[{"type":"expand","attrs":{"title":"more detail"},"content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"hidden body"}]}]}]}',
            (_d, md) => {
                expect(md).toContain("[!EXPAND] more detail");
                return md.replace("hidden body", "body revised");
            },
        );
        const expand = firstNode(doc, "expand");
        expect(expand).toBeDefined();
        expect(attrStr(expand?.attrs, "title")).toBe("more detail");
        const text = docText(doc);
        expect(text).toContain("body revised");
        expect(text).not.toContain("hidden body");
    });

    it("external media: renders as ![alt](url), no download", async () => {
        // Pull-direction only: no edit; assert on the pulled Markdown.
        const run = makeRun(env, dir);
        const spaceId = (await client.resolveSpace(env.space)).id;
        const { id } = await client.createPage({
            spaceId,
            title: uniqueTitle("external"),
            parentId: env.folder,
            docJSON:
                '{"type":"doc","content":[{"type":"mediaSingle","content":[' +
                '{"type":"media","attrs":{"type":"external","url":"https://example.com/pic.png","alt":"ext pic"}}]}]}',
        });
        onTestFinished(async () => {
            await client.deletePage(id).catch(() => {});
        });
        const cfgPath = join(dir, ".cfsync.yaml");
        await writeFile(
            cfgPath,
            `pages:\n  page.md: /wiki/spaces/${env.space}/pages/${id}/it\n`,
        );
        const pulled = await run(["pull", "--config", cfgPath]);
        expect(pulled.code, pulled.err).toBe(0);
        const md = await readFile(join(dir, "page.md"), "utf8");
        expect(md).toContain("![ext pic](https://example.com/pic.png)");
    });

    it("upload image: a new local image becomes a media node", async () => {
        const doc = await liveRoundTrip(
            "image",
            '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"look below"}]}]}',
            async (d, md) => {
                await writeFile(join(d, "shot.png"), ONE_PIXEL_PNG);
                // cfsync uploads a user-added image written as a lone-block
                // Obsidian embed (`![[file]]`), not a Markdown image link.
                return `${md}\n\n![[shot.png]]`;
            },
        );
        const media = firstNode(doc, "media");
        expect(media).toBeDefined();
        expect(attrStr(media?.attrs, "type")).toBe("file");
        expect(attrStr(media?.attrs, "id")).not.toBe("");
        expect(firstNode(doc, "mediaSingle")).toBeDefined();
    });

    it("media group: two attachments render adjacent, push is a no-op", async () => {
        const run = makeRun(env, dir);
        const spaceId = (await client.resolveSpace(env.space)).id;
        const title = uniqueTitle("group");
        const { id } = await client.createPage({
            spaceId,
            title,
            parentId: env.folder,
            docJSON:
                '{"type":"doc","content":[{"type":"paragraph","content":[]}]}',
        });
        onTestFinished(async () => {
            await client.deletePage(id).catch(() => {});
        });

        const up1 = await client.uploadAttachment(id, "a.png", ONE_PIXEL_PNG);
        const up2 = await client.uploadAttachment(id, "b.png", ONE_PIXEL_PNG);
        const coll = `contentId-${id}`;
        const group =
            '{"type":"doc","content":[{"type":"mediaGroup","content":[' +
            `{"type":"media","attrs":{"type":"file","id":"${up1.fileId}","collection":"${coll}"}},` +
            `{"type":"media","attrs":{"type":"file","id":"${up2.fileId}","collection":"${coll}"}}]}]}`;
        // Seed the body at the next version (page was created at v1).
        await client.updatePage(id, title, 2, group);
        // The content GET can lag the PUT under the full suite's load; wait
        // until v2 is visible on the read path so pull sees the media group and
        // not the pre-update empty body.
        await waitForPageVersion(client, id, 2);

        const cfgPath = join(dir, ".cfsync.yaml");
        await writeFile(
            cfgPath,
            `pages:\n  page.md: /wiki/spaces/${env.space}/pages/${id}/it\n`,
        );
        const pulled = await run(["pull", "--config", cfgPath]);
        expect(pulled.code, pulled.err).toBe(0);

        const md = await readFile(join(dir, "page.md"), "utf8");
        expect(md).toContain(up1.fileId);
        expect(md).toContain(up2.fileId);
        expect((md.match(/!\[/g) ?? []).length).toBe(2);
        // Each file media renders as an Obsidian embed (`![[file]]`); the group
        // puts them on consecutive lines with no blank line between.
        expect(md).toContain("]]\n![[");

        const pushed = await run(["push", "--config", cfgPath]);
        expect(pushed.code, pushed.err).toBe(0);
        expect(pushed.out).toContain("unchanged");
    });
});
