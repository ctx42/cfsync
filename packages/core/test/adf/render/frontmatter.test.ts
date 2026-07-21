// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/markdown_test.go (Test_ADF_frontmatter_*, Test_ADF_mentions),
// pkg/adf/adf_test.go (Test_ADF_MarshallMarkdown), and example_test.go
// (ExampleADF_MarshallMarkdown). Frontmatter fields are dialect-stable and port
// 1:1; bodies that contain mentions/media/TOC are re-baselined to the Obsidian
// dialect. The `root_page_1.v5.json` input is reused verbatim; its rendered
// golden is re-baselined via `toMatchFileSnapshot` and reviewed by hand.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { marshallMarkdownAssets } from "../../../src/adf/lens/sourcemap.ts";
import { newADF } from "../../../src/models/adf.ts";

const render = (data: string, assets: Record<string, string> = {}): string =>
    marshallMarkdownAssets(newADF(data), assets);

const here = fileURLToPath(new URL(".", import.meta.url));

describe("frontmatter", () => {
    it("renders the page path from the name", () => {
        const data = `{
           "name": "docs/my-page.md",
           "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: "My Page"\npage_path: "docs/my-page.md"\n' +
                'page_id: ""\npage_version: 0\nspace_id: ""\n---\n',
        );
    });

    it("renders the space key after the space id when set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "space_id": "42", "space_key": "RZTST",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: "My Page"\npage_path: "docs/my-page.md"\n' +
                'page_id: ""\npage_version: 0\nspace_id: "42"\nspace_key: "RZTST"\n---\n',
        );
    });

    it("omits the space key when unset", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).not.toContain("space_key");
    });

    it("renders parent_id after space_id when set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "space_id": "42", "parent_id": "77",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: "My Page"\npage_path: "docs/my-page.md"\n' +
                'page_id: ""\npage_version: 0\nspace_id: "42"\nparent_id: "77"\n---\n',
        );
    });

    it("renders parent_id before space_key when both are set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "space_id": "42", "parent_id": "77", "space_key": "RZTST",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: "My Page"\npage_path: "docs/my-page.md"\n' +
                'page_id: ""\npage_version: 0\nspace_id: "42"\n' +
                'parent_id: "77"\nspace_key: "RZTST"\n---\n',
        );
    });

    it("omits parent_id when unset", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).not.toContain("parent_id");
    });

    it("renders the domain when set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "cf_domain": "ex.atlassian.net",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: "My Page"\npage_path: "docs/my-page.md"\n' +
                'page_id: ""\npage_version: 0\nspace_id: ""\n' +
                'cf_domain: "ex.atlassian.net"\n---\n',
        );
    });

    it("omits the domain when unset", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).not.toContain("cf_domain");
    });

    it("stamps cfsync-plugin: pull as the first field", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data).startsWith("---\ncfsync-plugin: pull\n")).toBe(
            true,
        );
    });
});

describe("mentions", () => {
    it("distinct names populate the frontmatter map", () => {
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "content": [
                 { "type": "mention", "attrs": { "id": "A", "text": "@Ann" } },
                 { "type": "text", "text": " " },
                 { "type": "mention", "attrs": { "id": "B", "text": "@Bob" } }
              ] }
           ] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: ""\npage_path: ""\npage_id: ""\npage_version: 0\n' +
                'space_id: ""\nmentions:\n  "Ann": "A"\n  "Bob": "B"\n---\n' +
                "\n`adf:@Ann` `adf:@Bob`\n",
        );
    });

    it("a colliding name is inline-only, off the map", () => {
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "content": [
                 { "type": "mention", "attrs": { "id": "S1", "text": "@Sam" } },
                 { "type": "text", "text": " " },
                 { "type": "mention", "attrs": { "id": "S2", "text": "@Sam" } },
                 { "type": "text", "text": " " },
                 { "type": "mention", "attrs": { "id": "A",  "text": "@Ann" } }
              ] }
           ] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: ""\npage_path: ""\npage_id: ""\npage_version: 0\n' +
                'space_id: ""\nmentions:\n  "Ann": "A"\n---\n' +
                "\n`adf:@Sam|id=S1` `adf:@Sam|id=S2` `adf:@Ann`\n",
        );
    });
});

describe("MarshallMarkdown media", () => {
    it("renders images and page_images from assets", () => {
        const data = `{
           "title": "T", "id": "1", "version": 2, "space_id": "9",
           "adf": { "type": "doc", "content": [
              { "type": "mediaSingle", "attrs": { "layout": "center" }, "content": [
                 { "type": "media", "attrs": {
                    "type": "file", "id": "F1", "localId": "L1", "alt": "pic.jpg" } }
              ] }
           ] }
        }`;
        expect(render(data, { L1: "../_cfsync-media/F1-L1.jpg" })).toBe(
            '---\ncfsync-plugin: pull\ntitle: "T"\npage_path: ""\npage_id: "1"\npage_version: 2\n' +
                'space_id: "9"\npage_images:\n  - local_id: "L1"\n' +
                '    file: "../_cfsync-media/F1-L1.jpg"\n    alt: "pic.jpg"\n---\n' +
                "\n![[F1-L1.jpg]]\n",
        );
    });

    it("renders a mediaGroup as one embed per line", () => {
        const data = `{
           "title": "T", "id": "1", "version": 2, "space_id": "9",
           "adf": { "type": "doc", "content": [
              { "type": "mediaGroup", "content": [
                 { "type": "media", "attrs": {
                    "type": "file", "id": "F1", "localId": "L1", "alt": "a.png" } },
                 { "type": "media", "attrs": {
                    "type": "file", "id": "F2", "localId": "L2", "alt": "b.png" } }
              ] }
           ] }
        }`;
        expect(
            render(data, {
                L1: "../_cfsync-media/F1-L1.png",
                L2: "../_cfsync-media/F2-L2.png",
            }),
        ).toBe(
            '---\ncfsync-plugin: pull\ntitle: "T"\npage_path: ""\npage_id: "1"\npage_version: 2\n' +
                'space_id: "9"\npage_images:\n' +
                '  - local_id: "L1"\n    file: "../_cfsync-media/F1-L1.png"\n    alt: "a.png"\n' +
                '  - local_id: "L2"\n    file: "../_cfsync-media/F2-L2.png"\n    alt: "b.png"\n' +
                "---\n\n![[F1-L1.png]]\n![[F2-L2.png]]\n",
        );
    });
});

describe("MarshallMarkdown example", () => {
    it("renders the doc example from the Go example test", () => {
        const data = `{
           "name": "demo.md", "title": "Demo", "id": "1", "version": 1, "space_id": "2",
           "adf": { "type": "doc", "content": [
              { "type": "heading", "attrs": { "level": 1 },
                "content": [ { "type": "text", "text": "Hello" } ] },
              { "type": "paragraph", "content": [
                 { "type": "text", "text": "Bold", "marks": [ { "type": "strong" } ] },
                 { "type": "text", "text": " and plain." }
              ] }
           ] }
        }`;
        expect(render(data)).toBe(
            '---\ncfsync-plugin: pull\ntitle: "Demo"\npage_path: "demo.md"\npage_id: "1"\n' +
                'page_version: 1\nspace_id: "2"\n---\n\n' +
                "# Hello\n\n**Bold** and plain.\n",
        );
    });

    it("errors when the root node is not a doc", () => {
        expect(() => render(`{ "adf": { "type": "paragraph" } }`)).toThrow(
            'root node is "paragraph", want doc',
        );
    });
});

describe("MarshallMarkdown golden", () => {
    it("renders root_page_1.v5 to the re-baselined golden", async () => {
        const input = readFileSync(
            `${here}testdata/root_page_1.v5.json`,
            "utf8",
        );
        const md = marshallMarkdownAssets(newADF(input), {});
        await expect(md).toMatchFileSnapshot(
            `${here}testdata/root_page_1.v5.md`,
        );
    });
});
