// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Test-only helpers for the live integration suites: raw-fetch probes against
// the Confluence REST API (independent of the ConfluenceClient under test) and
// walkers over a parsed atlas_doc_format document. Ported from the raw helpers
// in all_live_test.go, spaceroot_live_test.go, spike_live_test.go, and the ADF
// inspectors in roundtrip_live_test.go / explore_live_test.go.

import { basicAuth, type Node } from "@cfsync/core";

/** LiveCreds is the Site + auth subset the raw probes need. */
export interface LiveCreds {
    host: string;
    account: string;
    token: string;
}

/** uniqueTitle builds a collision-free page/folder title for a test run. */
export function uniqueTitle(name: string): string {
    const tag = `${Date.now().toString(36)}${Math.floor(
        Math.random() * 1e6,
    ).toString(36)}`;
    return `cfsync-it ${name} ${tag}`;
}

/** parseDoc parses an atlas_doc_format value string into its root doc node. */
export function parseDoc(adfJSON: string): Node {
    return JSON.parse(adfJSON) as Node;
}

/** docText concatenates every text node in document order, newline-separated. */
export function docText(root: Node): string {
    const parts: string[] = [];
    const walk = (n: Node): void => {
        if (n.type === "text" && n.text !== undefined) {
            parts.push(n.text);
        }
        for (const c of n.content ?? []) {
            walk(c);
        }
    };
    walk(root);
    return parts.join("\n");
}

/** firstNode returns the first node of the given type in document order. */
export function firstNode(root: Node, type: string): Node | undefined {
    if (root.type === type) {
        return root;
    }
    for (const c of root.content ?? []) {
        const found = firstNode(c, type);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}

/** textNodeWith returns the first text node whose text contains `sub`. */
export function textNodeWith(root: Node, sub: string): Node | undefined {
    if (root.type === "text" && (root.text ?? "").includes(sub)) {
        return root;
    }
    for (const c of root.content ?? []) {
        const found = textNodeWith(c, sub);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}

/** probeGet performs an authenticated GET for a host-relative path. */
export async function probeGet(
    creds: LiveCreds,
    path: string,
): Promise<{ status: number; body: string }> {
    const resp = await fetch(`${creds.host}${path}`, {
        method: "GET",
        headers: {
            Authorization: basicAuth(creds.account, creds.token),
            Accept: "application/json",
        },
    });
    return { status: resp.status, body: await resp.text() };
}

/**
 * waitForPageVersion polls fetchPage until the page reports at least `version`,
 * so a server-side update is visible on the read path before a test reads it.
 * Confluence Cloud's content GET can lag a PUT under sustained load, so an
 * immediate read may still return the prior version and body; this waits on the
 * actual condition instead of assuming read-after-write consistency. It polls
 * every 300ms (each check is a network GET), tolerating transient fetch errors
 * — the same load that lags the write can blip a read — and throws only if the
 * version is not reached within `timeoutMs`, surfacing the last seen state.
 */
export async function waitForPageVersion(
    client: { fetchPage(id: string): Promise<{ version: number }> },
    id: string,
    version: number,
    timeoutMs = 15_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let detail = "no response yet";
    for (;;) {
        try {
            const { version: seen } = await client.fetchPage(id);
            if (seen >= version) {
                return;
            }
            detail = `last saw version ${seen}`;
        } catch (err) {
            detail = err instanceof Error ? err.message : String(err);
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `page ${id} did not reach version ${version} ` +
                    `within ${timeoutMs}ms (${detail})`,
            );
        }
        await new Promise((r) => setTimeout(r, 300));
    }
}

/** firstSpace extracts the id and homepageId of the first space in a body. */
export function firstSpace(body: string): { id: string; homepageId: string } {
    const results = (JSON.parse(body) as { results?: unknown[] }).results ?? [];
    const first = (results[0] ?? {}) as {
        id?: string;
        homepageId?: string;
    };
    return { id: first.id ?? "", homepageId: first.homepageId ?? "" };
}

/** RESTRICTION_ENDPOINT is the v1 content-restriction path for an id. */
const restrictionPath = (id: string): string =>
    `/wiki/rest/api/content/${id}/restriction`;

/** putFolderRestriction restricts read+update on a folder to `accountId`. */
export async function putFolderRestriction(
    creds: LiveCreds,
    folderId: string,
    accountId: string,
): Promise<{ status: number; body: string }> {
    const user = [{ type: "known", accountId }];
    const payload = {
        results: [
            { operation: "read", restrictions: { user } },
            { operation: "update", restrictions: { user } },
        ],
    };
    const resp = await fetch(`${creds.host}${restrictionPath(folderId)}`, {
        method: "PUT",
        headers: {
            Authorization: basicAuth(creds.account, creds.token),
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
    return { status: resp.status, body: await resp.text() };
}

/** deleteFolderRestriction clears every content restriction on the folder. */
export async function deleteFolderRestriction(
    creds: LiveCreds,
    folderId: string,
): Promise<{ status: number; body: string }> {
    const resp = await fetch(`${creds.host}${restrictionPath(folderId)}`, {
        method: "DELETE",
        headers: { Authorization: basicAuth(creds.account, creds.token) },
    });
    return { status: resp.status, body: await resp.text() };
}

/** restrictionRead reads the read-operation restriction of a content id. */
export async function restrictionRead(
    creds: LiveCreds,
    id: string,
): Promise<{ status: number; body: string }> {
    return probeGet(creds, `${restrictionPath(id)}/byOperation/read`);
}

/** collectTypes tallies every node type and mark type at or below `node`. */
export function collectTypes(
    node: Node,
    types: Record<string, number>,
    marks: Record<string, number>,
): void {
    types[node.type] = (types[node.type] ?? 0) + 1;
    for (const m of node.marks ?? []) {
        marks[m.type] = (marks[m.type] ?? 0) + 1;
    }
    for (const c of node.content ?? []) {
        collectTypes(c, types, marks);
    }
}

/** histogram renders a count map as "key=count", sorted by descending count. */
export function histogram(m: Record<string, number>): string {
    return Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
}
