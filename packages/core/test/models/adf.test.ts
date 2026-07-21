// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported 1:1 from pkg/adf/adf_test.go (Test_NewADF, Test_ADF_FileMedia). The
// MarshallMarkdown scenarios in that file belong to the renderer and are ported
// in M2.4.

import { describe, expect, it } from "vitest";
import { fileMedia, type MediaRef, newADF } from "../../src/models/adf.ts";

describe("newADF", () => {
    it("parses wrapper metadata and doc", () => {
        const data = `{
           "id": "7",
           "title": "T",
           "version": 3,
           "space_id": "9",
           "adf":{
              "type": "doc",
              "content": []
           }
        }`;

        const have = newADF(data);

        expect(have.id).toBe("7");
        expect(have.title).toBe("T");
        expect(have.version).toBe(3);
        expect(have.spaceId).toBe("9");
        expect(have.doc.type).toBe("doc");
    });

    it("error - invalid JSON", () => {
        expect(() => newADF("not-json")).toThrow("decoding ADF page");
    });
});

describe("fileMedia", () => {
    it("returns file-media refs in document order", () => {
        const data = `{
           "adf": {
              "type": "doc",
              "content": [
                 {
                    "type": "mediaSingle",
                    "content": [
                       {
                          "type": "media",
                          "attrs": {
                             "type": "file",
                             "id": "F1",
                             "localId": "L1",
                             "alt": "a.jpg"
                          }
                       }
                    ]
                 },
                 {
                    "type": "mediaSingle",
                    "content": [
                       {
                          "type": "media",
                          "attrs": {
                             "type": "file",
                             "id": "F2",
                             "localId": "L2",
                             "alt": "b.png"
                          }
                       }
                    ]
                 }
              ]
           }
        }`;
        const adf = newADF(data);

        const have = fileMedia(adf);

        const want: MediaRef[] = [
            { localId: "L1", fileId: "F1", alt: "a.jpg" },
            { localId: "L2", fileId: "F2", alt: "b.png" },
        ];
        expect(have).toEqual(want);
    });

    it("anchors a localId-less file by fileId", () => {
        // An external node (never downloaded) and a file node with no localId
        // (anchored by its fileId as a fallback).
        const data = `{
           "adf": {
              "type": "doc",
              "content": [
                 {
                    "type": "media",
                    "attrs": { "type": "external", "id": "F1", "localId": "L1" }
                 },
                 {
                    "type": "media",
                    "attrs": { "type": "file", "id": "F2" }
                 }
              ]
           }
        }`;
        const adf = newADF(data);

        const have = fileMedia(adf);

        expect(have).toEqual([{ localId: "F2", fileId: "F2", alt: "" }]);
    });

    it("collects an inline mediaInline file reference", () => {
        const data = `{
           "adf": {
              "type": "doc",
              "content": [
                 {
                    "type": "paragraph",
                    "content": [
                       { "type": "text", "text": "see " },
                       {
                          "type": "mediaInline",
                          "attrs": {
                             "type": "file",
                             "id": "F7",
                             "localId": "L7",
                             "alt": "inline.png"
                          }
                       }
                    ]
                 }
              ]
           }
        }`;
        const adf = newADF(data);

        const have = fileMedia(adf);

        expect(have).toEqual([
            { localId: "L7", fileId: "F7", alt: "inline.png" },
        ]);
    });

    it("omits a file node with neither localId nor fileId", () => {
        const data = `{ "adf": { "type": "doc", "content": [
           { "type": "media", "attrs": { "type": "file" } } ] } }`;
        const adf = newADF(data);

        const have = fileMedia(adf);

        expect(have).toEqual([]);
    });
});
