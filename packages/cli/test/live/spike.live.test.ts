// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from spike_live_test.go. Answers two questions against the live Site:
// does a v2 page create accept a folder id as parentId (and report parentType
// "folder"), and does the v1 restriction PUT accept a folder id? Both findings
// are logged; a rejection of the restriction PUT is a valid finding.

import { describe, expect, it, onTestFinished } from "vitest";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import {
    deleteFolderRestriction,
    firstSpace,
    probeGet,
    putFolderRestriction,
    uniqueTitle,
} from "./support/probe.ts";

describe.skipIf(!liveConfigured())("live folder-parent spike", () => {
    const env = requireEnv();
    const client = seedClient(env);

    it("probes folder-as-parent and folder restriction", async () => {
        const space = await probeGet(
            env,
            `/wiki/api/v2/spaces?keys=${env.space}`,
        );
        const { id: spaceId, homepageId } = firstSpace(space.body);
        expect(spaceId).not.toBe("");

        // A folder to parent the spike page under: a shared one if configured,
        // else a scratch folder created and deleted for the run.
        let folderId = env.folder;
        if (folderId === "") {
            folderId = await client.createFolder(
                spaceId,
                homepageId,
                uniqueTitle("folder-parent"),
            );
            onTestFinished(async () => {
                await client.deleteFolder(folderId).catch(() => {});
            });
        }

        // Finding 1: does a v2 page create accept a folder as parentId?
        const { id } = await client.createPage({
            spaceId,
            title: uniqueTitle("folder-parent"),
            parentId: folderId,
            docJSON:
                '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"folder-parent spike"}]}]}',
        });
        onTestFinished(async () => {
            await client.deletePage(id).catch(() => {});
        });

        const page = await probeGet(env, `/wiki/api/v2/pages/${id}`);
        expect(page.status).toBe(200);
        const node = JSON.parse(page.body) as {
            parentId: string;
            parentType: string;
        };
        console.log(
            `finding 1 - folder as parentId: requested ${folderId}; created ` +
                `page ${id} reports parentId=${node.parentId} parentType=${node.parentType}`,
        );
        expect(node.parentId).toBe(folderId);
        expect(node.parentType).toBe("folder");

        // Finding 2: does the v1 restriction PUT accept a folder id?
        const accountId = await client.currentAccountID();
        const res = await putFolderRestriction(env, folderId, accountId);
        console.log(`finding 2 - folder restriction PUT: HTTP ${res.status}`);
        if (res.status >= 200 && res.status < 300) {
            onTestFinished(async () => {
                const undo = await deleteFolderRestriction(env, folderId);
                console.log(`reverted folder restriction: HTTP ${undo.status}`);
            });
        }
    });
});
