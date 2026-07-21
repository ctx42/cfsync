// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from spaceroot_live_test.go. The contract test for the spaces traversal
// model: the homepage-rooted direct-children walk must reach exactly the pages
// the flat spaces/{id}/pages listing reports. Read-only.

import { describe, expect, it } from "vitest";
import { liveConfigured, requireEnv } from "./support/live-env.ts";
import { firstSpace, probeGet } from "./support/probe.ts";

interface ProbeNode {
    id: string;
    type: string;
    title: string;
}

interface ProbeResp {
    results: ProbeNode[];
    _links?: { next?: string };
}

describe.skipIf(!liveConfigured())("live space walk", () => {
    const env = requireEnv();

    it("the homepage walk reaches every flat-listed page", async () => {
        const creds = env;
        const space = await probeGet(
            creds,
            `/wiki/api/v2/spaces?keys=${env.space}`,
        );
        const { id: spaceId, homepageId } = firstSpace(space.body);
        expect(spaceId).not.toBe("");
        expect(homepageId).not.toBe("");

        // Flat truth set: every page id the space lists, following pagination.
        const flat = new Set<string>();
        let path = `/wiki/api/v2/spaces/${spaceId}/pages?limit=250`;
        while (path !== "") {
            const { status, body } = await probeGet(creds, path);
            expect(status).toBe(200);
            const resp = JSON.parse(body) as ProbeResp;
            for (const n of resp.results) {
                flat.add(n.id);
            }
            path = resp._links?.next ?? "";
        }

        // Walked set: pages reached from the homepage via direct children.
        const walked = new Set<string>();
        const walkNode = async (kind: string, id: string): Promise<void> => {
            const base =
                kind === "folder"
                    ? "/wiki/api/v2/folders/"
                    : "/wiki/api/v2/pages/";
            const kids: ProbeNode[] = [];
            let p = `${base}${id}/direct-children?limit=250`;
            while (p !== "") {
                const { status, body } = await probeGet(creds, p);
                expect(status, `${kind} ${id} children`).toBe(200);
                const resp = JSON.parse(body) as ProbeResp;
                kids.push(...resp.results);
                p = resp._links?.next ?? "";
            }
            if (kind === "page") {
                walked.add(id);
            }
            for (const k of kids) {
                if (k.type === "page" || k.type === "folder") {
                    await walkNode(k.type, k.id);
                }
            }
        };
        await walkNode("page", homepageId);

        for (const id of flat) {
            expect(walked.has(id), `flat page ${id} missed by walk`).toBe(true);
        }
        for (const id of walked) {
            expect(flat.has(id), `walked page ${id} absent from flat`).toBe(
                true,
            );
        }
    });
});
