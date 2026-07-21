// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { putLinks } from "../../src/adf/lens/reconstruct.ts";
import { marshallMapped } from "../../src/adf/lens/sourcemap.ts";
import {
    DEFAULT_FLAVOR,
    flavorIds,
    obsidianFlavor,
    register,
    resolveFlavor,
} from "../../src/flavor/flavor.ts";
import type { ADF } from "../../src/models/adf.ts";

const doc: ADF = {
    name: "",
    id: "",
    title: "",
    version: 0,
    spaceId: "",
    spaceKey: "",
    parentId: "",
    domain: "",
    doc: {
        type: "doc",
        content: [
            { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
    },
};

describe("resolveFlavor", () => {
    it("defaults to the obsidian flavor", () => {
        expect(resolveFlavor().id).toBe("obsidian");
        expect(resolveFlavor(DEFAULT_FLAVOR)).toBe(obsidianFlavor);
    });

    it("throws a naming error on an unknown id", () => {
        expect(() => resolveFlavor("markdown-xyz")).toThrow(/markdown-xyz/);
    });
});

describe("register", () => {
    it("throws a naming error on a duplicate id", () => {
        expect(() => register(obsidianFlavor)).toThrow(/obsidian/);
    });
});

describe("obsidianFlavor", () => {
    it("render matches marshallMapped", () => {
        const opts = { assets: {}, links: null, margin: 0 };
        expect(obsidianFlavor.render(doc, opts)).toEqual(
            marshallMapped(doc, opts.assets, opts.links, opts.margin),
        );
    });

    it("render defaults margin to 0 when omitted", () => {
        const opts = { assets: {}, links: null };
        expect(obsidianFlavor.render(doc, opts)).toEqual(
            marshallMapped(doc, {}, null, 0),
        );
    });

    it("reconstruct matches putLinks", () => {
        const [body] = marshallMapped(doc, {}, null, 0);
        const opts = {
            mentions: null,
            assets: null,
            images: null,
            links: null,
        };
        expect(obsidianFlavor.reconstruct(doc, body, opts)).toEqual(
            putLinks(doc, body, null, null, null, null),
        );
    });
});

describe("flavorIds", () => {
    it("lists the registered flavor ids, sorted", () => {
        const ids = flavorIds();
        expect(ids).toContain("obsidian");
        expect([...ids]).toEqual([...ids].sort());
    });
});
