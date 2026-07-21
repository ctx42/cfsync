// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Verifies the goldkit template shim renders the Confluence page fixture
// byte-identically to Go's text/template + strconv.Quote. The expected strings
// were captured from the Go tool and are written with String.raw so their
// backslash escapes stay literal — independent of goQuote, which is under test.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGolden, goQuote, renderGoTemplate } from "../support/goldkit.ts";

const PAGE_TPL = fileURLToPath(
    new URL("./testdata/page.tpl.yml", import.meta.url),
);

// A JSON string with an embedded quote, backslash, newline, tab, and printable
// non-ASCII rune — the same value the Go capture used.
const ADF = '{"k":"v\n\té\\x"}';

describe("goQuote", () => {
    it("matches Go strconv.Quote for a stress string", () => {
        expect(goQuote(ADF)).toBe(String.raw`"{\"k\":\"v\n\té\\x\"}"`);
    });

    it("uses short escapes and \\xHH for control bytes", () => {
        // "a" NUL "b" BEL "c": NUL has no short escape (\x00); BEL does (\a).
        const input = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`;
        expect(goQuote(input)).toBe(String.raw`"a\x00b\ac"`);
    });
});

describe("renderGoTemplate", () => {
    it("renders a numeric field the way Go prints it", () => {
        expect(renderGoTemplate("v={{.Version}}", { Version: 3 })).toBe("v=3");
    });

    it("throws on an unknown field", () => {
        expect(() => renderGoTemplate("{{.Nope}}", {})).toThrow(
            "unknown field .Nope",
        );
    });

    it("throws on an unsupported action", () => {
        expect(() => renderGoTemplate("{{range .X}}", { X: 1 })).toThrow(
            "unsupported template action",
        );
    });
});

describe("createGolden with page.tpl.yml", () => {
    it("renders the page fixture byte-identically to Go", () => {
        const golden = createGolden(PAGE_TPL, {
            ID: "7",
            Title: "T",
            SpaceID: "9",
            Version: 3,
            ADF,
        });

        expect(golden.bodyType).toBe("json");
        expect(golden.body).toBe(
            String.raw`{
  "id": "7",
  "title": "T",
  "spaceId": "9",
  "version": {"number": 3},
  "body": {"atlas_doc_format": {"value": "{\"k\":\"v\n\té\\x\"}"}}
}`,
        );
    });
});
