// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { Node } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import {
    docText,
    firstNode,
    histogram,
    parseDoc,
    textNodeWith,
    uniqueTitle,
} from "./probe.ts";

const doc: Node = {
    type: "doc",
    content: [
        { type: "paragraph", content: [{ type: "text", text: "hello world" }] },
        {
            type: "table",
            content: [
                {
                    type: "text",
                    text: "styled bit",
                    marks: [{ type: "underline" }],
                },
            ],
        },
    ],
};

describe("probe ADF walkers", () => {
    it("docText concatenates every text node", () => {
        expect(docText(doc)).toContain("hello world");
        expect(docText(doc)).toContain("styled bit");
    });

    it("firstNode finds a node by type", () => {
        expect(firstNode(doc, "table")?.type).toBe("table");
        expect(firstNode(doc, "panel")).toBeUndefined();
    });

    it("textNodeWith finds a text node by substring", () => {
        expect(textNodeWith(doc, "styled")?.marks?.[0]?.type).toBe("underline");
    });

    it("parseDoc parses an atlas_doc_format value string", () => {
        expect(parseDoc('{"type":"doc","content":[]}').type).toBe("doc");
    });

    it("uniqueTitle is prefixed and varies", () => {
        expect(uniqueTitle("smoke")).toContain("cfsync-it smoke ");
        expect(uniqueTitle("x")).not.toBe(uniqueTitle("x"));
    });

    it("histogram sorts by descending count", () => {
        expect(histogram({ a: 1, b: 3 })).toBe("b=3 a=1");
    });
});
