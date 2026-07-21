// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Confluence REST client, ported from the net layer of `pkg/cfsync`
// (connection/pull/spaces/folders/assets). It talks to a Site only through the
// injected {@link HttpClient} port — never `fetch` or `node:http` — so the CLI
// backs it with `fetch` and the plugin with Obsidian's `requestUrl`. Every call
// is an authenticated GET against the Confluence v2 API; list endpoints follow
// the `_links.next` cursor to completion. Per-request timeout, retry/backoff, and
// bounded concurrency wrap the underlying HttpClient in M9.1; source-string
// parsing (page/folder/space ids) and the discovery walk are M7.

import type { HttpClient, HttpResponse } from "../ports/http.ts";
import { responseText } from "../ports/http.ts";

/** The Confluence current-user endpoint (v1; returns the authenticated account). */
const USER_ENDPOINT = "/wiki/rest/api/user/current";
/** The Confluence v2 page-by-id endpoint prefix. */
export const PAGE_ENDPOINT = "/wiki/api/v2/pages/";
/** The Confluence v2 pages-list endpoint (no trailing id): multi-`id` + cursor. */
const PAGES_LIST_ENDPOINT = "/wiki/api/v2/pages";
/** The max page ids per {@link ConfluenceClient.fetchPageVersions} request. */
const VERSION_BATCH = 250;
/** The Confluence v2 folder-by-id endpoint prefix. */
export const FOLDER_ENDPOINT = "/wiki/api/v2/folders/";
/** The Confluence v2 spaces-by-key list endpoint. */
const SPACES_ENDPOINT = "/wiki/api/v2/spaces";
/** The Confluence v2 page-create endpoint (no trailing id). */
const CREATE_PAGE_ENDPOINT = "/wiki/api/v2/pages";
/** The Confluence v2 folder-create endpoint (no trailing id). */
const CREATE_FOLDER_ENDPOINT = "/wiki/api/v2/folders";
/** The Confluence v1 per-page restriction endpoint prefix and suffix. */
const RESTRICTION_PREFIX = "/wiki/rest/api/content/";
const RESTRICTION_SUFFIX = "/restriction";
/** The direct-children suffix appended to a page or folder path. */
export const CHILDREN_PATH = "/direct-children";

/**
 * FolderTitleTakenError reports that a folder create was rejected because a
 * folder with the same title already exists in the space. Confluence requires
 * folder titles to be unique per space, not merely per parent, so the caller
 * reuses the existing folder when it sits under the intended parent and refuses
 * otherwise. The counterpart of Go's `errFolderTitleTaken` sentinel.
 */
export class FolderTitleTakenError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = "FolderTitleTakenError";
    }
}

/** The Site credentials a {@link ConfluenceClient} authenticates with. */
export interface ConfluenceClientConfig {
    /** The Site base URL, e.g. `https://ex.atlassian.net`. */
    host: string;
    /** The account (email) for Basic auth. */
    account: string;
    /** The API token for Basic auth. */
    token: string;
}

/** PageData is the subset of a Confluence v2 page the sync layer reads. */
export interface PageData {
    id: string;
    title: string;
    version: number;
    spaceId: string;
    parentId: string;
    /** The page body as a raw ADF JSON string (validated as parseable JSON). */
    adf: string;
}

/** SpaceRef identifies a space by its numeric id and homepage id. */
export interface SpaceRef {
    id: string;
    homepageId: string;
}

/** ChildNode is one entry of a direct-children response. */
export interface ChildNode {
    id: string;
    type: string;
    title: string;
    status: string;
}

/** ChildrenPage is one page of a direct-children response with its next cursor. */
export interface ChildrenPage {
    results: ChildNode[];
    /** The resolved absolute URL of the next page, or `""` when there is none. */
    next: string;
}

/** Attachment is the subset of a Confluence v2 attachment the sync layer reads. */
export interface Attachment {
    fileId: string;
    title: string;
    mediaType: string;
    /** Site-relative download path; it lacks the `/wiki` prefix and redirects. */
    downloadLink: string;
}

/**
 * basicAuth builds the HTTP `Authorization` header value for the given
 * credentials — `Basic <base64(account:token)>` — mirroring Go's
 * `Request.SetBasicAuth`. Exported so adapter and client tests can assert it.
 */
export function basicAuth(account: string, token: string): string {
    return `Basic ${base64(`${account}:${token}`)}`;
}

/**
 * ConfluenceClient wraps a Site's v2 REST API over an {@link HttpClient}. It is
 * constructed once per run with the credentials and issues authenticated GETs;
 * it holds no per-request state and never mutates its inputs.
 */
export class ConfluenceClient {
    private readonly auth: string;

    constructor(
        private readonly http: HttpClient,
        private readonly cfg: ConfluenceClientConfig,
    ) {
        this.auth = basicAuth(cfg.account, cfg.token);
    }

    /**
     * currentAccountID returns the account id of the authenticated user, the
     * account a created page is restricted to. It distinguishes a rejected
     * credential (401/403) from other failures.
     */
    async currentAccountID(): Promise<string> {
        const host = this.cfg.host;
        const resp = await this.get(`${host}${USER_ENDPOINT}`);
        if (resp.status === 401 || resp.status === 403) {
            throw new Error(
                `authentication rejected by ${host} (HTTP ${resp.status})`,
            );
        }
        if (!ok(resp.status)) {
            throw new Error(`connecting to ${host}: HTTP ${resp.status}`);
        }
        let user: unknown;
        try {
            user = JSON.parse(responseText(resp));
        } catch (err) {
            throw new Error(
                `connecting to ${host}: invalid response: ${message(err)}`,
            );
        }
        const account = asStr(asObj(user)["accountId"]);
        if (account === "") {
            throw new Error(`connecting to ${host}: response has no accountId`);
        }
        return account;
    }

    /**
     * fetchPage requests the page with the numeric id, asking for its body in
     * Atlassian Document Format, and returns the fields the lens needs. It throws
     * when the ADF body is not parseable JSON.
     */
    async fetchPage(id: string): Promise<PageData> {
        const url =
            `${this.cfg.host}${PAGE_ENDPOINT}${id}` +
            "?body-format=atlas_doc_format";
        const resp = await this.get(url);
        if (!ok(resp.status)) {
            throw new Error(`page ${id}: HTTP ${resp.status}`);
        }
        let pr: unknown;
        try {
            pr = JSON.parse(responseText(resp));
        } catch (err) {
            throw new Error(`decoding page ${id}: ${message(err)}`);
        }
        const o = asObj(pr);
        const adf = asStr(asObj(asObj(o["body"])["atlas_doc_format"])["value"]);
        try {
            JSON.parse(adf);
        } catch {
            throw new Error(`page ${id}: invalid ADF body`);
        }
        return {
            id: asStr(o["id"]),
            title: asStr(o["title"]),
            version: asInt(asObj(o["version"])["number"]),
            spaceId: asStr(o["spaceId"]),
            parentId: asStr(o["parentId"]),
            adf,
        };
    }

    /**
     * fetchPageVersions returns the current version number of each given page id,
     * keyed by id. It is the bulk counterpart of {@link fetchPage}: it queries the
     * pages-list endpoint with a batch of `id` filters (no body) so one request
     * carries up to {@link VERSION_BATCH} ids, following the `_links.next` cursor
     * to completion, and issues one such request per batch. An id that is absent
     * from the responses — deleted, or not visible to the account — is simply
     * omitted from the map, so the caller distinguishes it by lookup. It throws
     * only on a transport or decode failure, never for a merely missing page.
     */
    async fetchPageVersions(ids: string[]): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        for (let i = 0; i < ids.length; i += VERSION_BATCH) {
            const batch = ids.slice(i, i + VERSION_BATCH);
            const query = batch
                .map((id) => `id=${encodeURIComponent(id)}`)
                .join("&");
            let addr =
                `${this.cfg.host}${PAGES_LIST_ENDPOINT}` +
                `?${query}&limit=${VERSION_BATCH}`;
            while (addr !== "") {
                const resp = await this.get(addr);
                if (!ok(resp.status)) {
                    throw new Error(`page versions: HTTP ${resp.status}`);
                }
                let pr: unknown;
                try {
                    pr = JSON.parse(responseText(resp));
                } catch (err) {
                    throw new Error(`decoding page versions: ${message(err)}`);
                }
                const o = asObj(pr);
                for (const r of asArr(o["results"])) {
                    const p = asObj(r);
                    const id = asStr(p["id"]);
                    if (id !== "") {
                        out.set(id, asInt(asObj(p["version"])["number"]));
                    }
                }
                addr = nextURL(
                    this.cfg.host,
                    asStr(asObj(o["_links"])["next"]),
                );
            }
        }
        return out;
    }

    /**
     * resolveSpace looks up the numeric space id and homepage id for a space key
     * via the spaces-by-key endpoint. It throws when no space matches the key.
     */
    async resolveSpace(key: string): Promise<SpaceRef> {
        const url =
            `${this.cfg.host}${SPACES_ENDPOINT}` +
            `?keys=${encodeURIComponent(key)}`;
        const resp = await this.get(url);
        if (!ok(resp.status)) {
            throw new Error(`space "${key}": HTTP ${resp.status}`);
        }
        let sr: unknown;
        try {
            sr = JSON.parse(responseText(resp));
        } catch (err) {
            throw new Error(`decoding space "${key}": ${message(err)}`);
        }
        const results = asArr(asObj(sr)["results"]);
        const first = results[0];
        if (first === undefined) {
            throw new Error(`space "${key}" not found`);
        }
        const r = asObj(first);
        return { id: asStr(r["id"]), homepageId: asStr(r["homepageId"]) };
    }

    /**
     * fetchChildren requests one page of a node's direct children from a
     * host-relative path or an absolute next-cursor URL, returning the child
     * nodes and the resolved URL of the next page. Compose the path from
     * {@link PAGE_ENDPOINT}/{@link FOLDER_ENDPOINT} + id + {@link CHILDREN_PATH};
     * the walk (M7) chooses folder-vs-page and paginates.
     */
    async fetchChildren(pathOrUrl: string): Promise<ChildrenPage> {
        const url = isAbsUrl(pathOrUrl)
            ? pathOrUrl
            : `${this.cfg.host}${pathOrUrl}`;
        const resp = await this.get(url);
        if (!ok(resp.status)) {
            throw new Error(`children: HTTP ${resp.status}`);
        }
        let cr: unknown;
        try {
            cr = JSON.parse(responseText(resp));
        } catch (err) {
            throw new Error(`decoding children: ${message(err)}`);
        }
        const o = asObj(cr);
        const results = asArr(o["results"]).map((n) => {
            const c = asObj(n);
            return {
                id: asStr(c["id"]),
                type: asStr(c["type"]),
                title: asStr(c["title"]),
                status: asStr(c["status"]),
            };
        });
        const next = nextURL(this.cfg.host, asStr(asObj(o["_links"])["next"]));
        return { results, next };
    }

    /**
     * fetchAttachments lists every attachment of a page, following the pagination
     * cursor to completion, and returns them keyed by their `fileId` (equal to a
     * media node's `attrs.id`).
     */
    async fetchAttachments(pageId: string): Promise<Map<string, Attachment>> {
        const out = new Map<string, Attachment>();
        let addr = `${this.cfg.host}${PAGE_ENDPOINT}${pageId}/attachments`;
        while (addr !== "") {
            const resp = await this.get(addr);
            if (!ok(resp.status)) {
                throw new Error(
                    `attachments for ${pageId}: HTTP ${resp.status}`,
                );
            }
            let apg: unknown;
            try {
                apg = JSON.parse(responseText(resp));
            } catch (err) {
                throw new Error(
                    `decoding attachments for ${pageId}: ${message(err)}`,
                );
            }
            const o = asObj(apg);
            for (const r of asArr(o["results"])) {
                const a = asObj(r);
                const att: Attachment = {
                    fileId: asStr(a["fileId"]),
                    title: asStr(a["title"]),
                    mediaType: asStr(a["mediaType"]),
                    downloadLink: asStr(a["downloadLink"]),
                };
                out.set(att.fileId, att);
            }
            addr = nextURL(this.cfg.host, asStr(asObj(o["_links"])["next"]));
        }
        return out;
    }

    /**
     * updatePage sends the authenticated v2 update for a page: its new title,
     * version number, and ADF body (as a raw JSON string). It throws on a non-2xx
     * status.
     */
    async updatePage(
        pageId: string,
        title: string,
        version: number,
        docJSON: string,
    ): Promise<void> {
        const payload = {
            id: pageId,
            status: "current",
            title,
            version: { number: version, message: "Updated by cfsync" },
            body: { representation: "atlas_doc_format", value: docJSON },
        };
        const resp = await this.http.do({
            method: "PUT",
            url: `${this.cfg.host}${PAGE_ENDPOINT}${pageId}`,
            headers: {
                Authorization: this.auth,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        if (!ok(resp.status)) {
            throw new Error(`push page ${pageId}: HTTP ${resp.status}`);
        }
    }

    /**
     * uploadAttachment uploads `bytes` as a new attachment named `filename` on the
     * page and returns its `fileId` (the value a media node carries as `attrs.id`)
     * and its content id (the v1 handle used to delete it if the push later
     * fails). It POSTs the multipart form the v1 API expects, with the
     * CSRF-exempting header. It throws on a non-2xx status or a response with no
     * fileId.
     */
    async uploadAttachment(
        pageId: string,
        filename: string,
        bytes: Uint8Array,
    ): Promise<{ fileId: string; contentId: string }> {
        const boundary = "----cfsyncFormBoundary7MA4YWxkTrZu0gW";
        const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
        const head = enc(
            `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="${escapeFormFilename(filename)}"\r\n` +
                "Content-Type: application/octet-stream\r\n\r\n",
        );
        const body = concatBytes(head, bytes, enc(`\r\n--${boundary}--\r\n`));
        const resp = await this.http.do({
            method: "POST",
            url: `${this.cfg.host}/wiki/rest/api/content/${pageId}/child/attachment`,
            headers: {
                Authorization: this.auth,
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "X-Atlassian-Token": "no-check",
            },
            body,
        });
        if (!ok(resp.status)) {
            throw new Error(`upload ${filename}: HTTP ${resp.status}`);
        }
        let ur: unknown;
        try {
            ur = JSON.parse(responseText(resp));
        } catch (err) {
            throw new Error(`decoding upload response: ${message(err)}`);
        }
        const first = asObj(asArr(asObj(ur)["results"])[0]);
        const fileId = asStr(asObj(first["extensions"])["fileId"]);
        if (fileId === "") {
            throw new Error(`upload ${filename}: response carried no fileId`);
        }
        return { fileId, contentId: asStr(first["id"]) };
    }

    /**
     * deleteAttachment removes the attachment with the given v1 content id, the
     * counterpart of {@link uploadAttachment}'s create. It throws on a non-2xx
     * status.
     */
    async deleteAttachment(contentId: string): Promise<void> {
        const resp = await this.http.do({
            method: "DELETE",
            url: `${this.cfg.host}/wiki/rest/api/content/${contentId}`,
            headers: {
                Authorization: this.auth,
                "X-Atlassian-Token": "no-check",
            },
        });
        if (!ok(resp.status)) {
            throw new Error(
                `delete attachment ${contentId}: HTTP ${resp.status}`,
            );
        }
    }

    /**
     * createPage POSTs a new page from its space, title, parent, and rendered ADF
     * body (a raw JSON string), and returns the new numeric id and version. A
     * response without an id is an error, as the page cannot then be restricted or
     * tracked. `parentId` is omitted from the payload when empty (a space root).
     */
    async createPage(input: {
        spaceId: string;
        title: string;
        parentId: string;
        docJSON: string;
    }): Promise<{ id: string; version: number }> {
        const payload: Record<string, unknown> = {
            spaceId: input.spaceId,
            status: "current",
            title: input.title,
            body: { representation: "atlas_doc_format", value: input.docJSON },
        };
        if (input.parentId !== "") {
            payload["parentId"] = input.parentId;
        }
        const resp = await this.http.do({
            method: "POST",
            url: `${this.cfg.host}${CREATE_PAGE_ENDPOINT}`,
            headers: {
                Authorization: this.auth,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        if (!ok(resp.status)) {
            throw new Error(
                `create page "${input.title}": HTTP ${resp.status}`,
            );
        }
        let cr: unknown;
        try {
            cr = JSON.parse(responseText(resp));
        } catch (err) {
            throw new Error(`decoding create response: ${message(err)}`);
        }
        const res = asObj(cr);
        const id = asStr(res["id"]);
        if (id === "") {
            throw new Error(`create page "${input.title}": response has no id`);
        }
        const ver = asInt(asObj(res["version"])["number"]);
        return { id, version: ver === 0 ? 1 : ver };
    }

    /**
     * restrictToAuthor replaces the page's content restrictions so only
     * `accountId` may read or update it, via the v1 restriction endpoint. Space and
     * site admins retain access regardless, so the page is visible to the author
     * plus those admins, never to nobody else. It throws on a non-2xx status.
     */
    async restrictToAuthor(pageId: string, accountId: string): Promise<void> {
        const user = [{ type: "known", accountId }];
        const payload = {
            results: [
                { operation: "read", restrictions: { user } },
                { operation: "update", restrictions: { user } },
            ],
        };
        const resp = await this.http.do({
            method: "PUT",
            url: `${this.cfg.host}${RESTRICTION_PREFIX}${pageId}${RESTRICTION_SUFFIX}`,
            headers: {
                Authorization: this.auth,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        if (!ok(resp.status)) {
            throw new Error(`restrict page ${pageId}: HTTP ${resp.status}`);
        }
    }

    /**
     * deletePage deletes the page with the numeric id from the Site, used to roll
     * back a page created but not restricted. It throws on a non-2xx status.
     */
    async deletePage(pageId: string): Promise<void> {
        const resp = await this.http.do({
            method: "DELETE",
            url: `${this.cfg.host}${PAGE_ENDPOINT}${pageId}`,
            headers: { Authorization: this.auth },
        });
        if (!ok(resp.status)) {
            throw new Error(`delete page ${pageId}: HTTP ${resp.status}`);
        }
    }

    /**
     * createFolder POSTs a new folder titled `title` in `spaceId` under
     * `parentId` and returns its numeric id, parenting new local sub-directories
     * so a page created inside one has a real parent. `parentId` is omitted when
     * empty. A rejection for a duplicate title throws {@link FolderTitleTakenError}
     * so the caller can reuse or refuse; a response without an id is an error.
     */
    async createFolder(
        spaceId: string,
        parentId: string,
        title: string,
    ): Promise<string> {
        const payload: Record<string, unknown> = { spaceId, title };
        if (parentId !== "") {
            payload["parentId"] = parentId;
        }
        const resp = await this.http.do({
            method: "POST",
            url: `${this.cfg.host}${CREATE_FOLDER_ENDPOINT}`,
            headers: {
                Authorization: this.auth,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        if (!ok(resp.status)) {
            const body = responseText(resp);
            if (
                resp.status === 400 &&
                body.toLowerCase().includes("same title")
            ) {
                throw new FolderTitleTakenError(
                    `create folder "${title}": a folder with this title ` +
                        `already exists in the space`,
                );
            }
            throw new Error(`create folder "${title}": HTTP ${resp.status}`);
        }
        let fr: unknown;
        try {
            fr = JSON.parse(responseText(resp));
        } catch (err) {
            throw new Error(`decoding folder response: ${message(err)}`);
        }
        const id = asStr(asObj(fr)["id"]);
        if (id === "") {
            throw new Error(`create folder "${title}": response has no id`);
        }
        return id;
    }

    /**
     * deleteFolder deletes the folder with the numeric id from the Site, used to
     * roll back folders created for a page whose own create then failed. An
     * already-absent folder (404) is not an error.
     */
    async deleteFolder(folderId: string): Promise<void> {
        const resp = await this.http.do({
            method: "DELETE",
            url: `${this.cfg.host}${FOLDER_ENDPOINT}${folderId}`,
            headers: { Authorization: this.auth },
        });
        if (resp.status >= 300 && resp.status !== 404) {
            throw new Error(`delete folder ${folderId}: HTTP ${resp.status}`);
        }
    }

    /**
     * childFolderTitled returns the id of the direct child folder of `parentId`
     * titled `title`, or `""` when no such folder exists. `parentId` may be a page
     * or a folder, so the folder direct-children endpoint is tried first and the
     * page endpoint second; a 404 from one means `parentId` is the other kind.
     */
    async childFolderTitled(parentId: string, title: string): Promise<string> {
        for (const base of [FOLDER_ENDPOINT, PAGE_ENDPOINT]) {
            const { id, matched } = await this.scanChildFolders(
                `${this.cfg.host}${base}${parentId}${CHILDREN_PATH}`,
                title,
            );
            if (matched) {
                return id;
            }
        }
        return "";
    }

    /**
     * scanChildFolders pages through the direct-children listing at `url` and
     * returns the id of the first current folder titled `title`. `matched` reports
     * whether the endpoint fit the node kind: a 404 yields `false` so the caller
     * can try the other endpoint, while a 2xx yields `true` even when no folder
     * matches (id `""`). A non-404 error status or a decode failure throws.
     */
    private async scanChildFolders(
        url: string,
        title: string,
    ): Promise<{ id: string; matched: boolean }> {
        let addr = url;
        while (addr !== "") {
            const resp = await this.get(addr);
            if (resp.status === 404) {
                return { id: "", matched: false };
            }
            if (!ok(resp.status)) {
                throw new Error(`listing children: HTTP ${resp.status}`);
            }
            let cr: unknown;
            try {
                cr = JSON.parse(responseText(resp));
            } catch (err) {
                throw new Error(`listing children: ${message(err)}`);
            }
            const o = asObj(cr);
            for (const r of asArr(o["results"])) {
                const c = asObj(r);
                if (
                    asStr(c["type"]) === "folder" &&
                    asStr(c["status"]) === "current" &&
                    asStr(c["title"]) === title
                ) {
                    return { id: asStr(c["id"]), matched: true };
                }
            }
            addr = nextURL(this.cfg.host, asStr(asObj(o["_links"])["next"]));
        }
        return { id: "", matched: true };
    }

    /**
     * download fetches the raw bytes at a site-relative attachment download link.
     * The link lacks the `/wiki` prefix and redirects to the media store, so the
     * prefix is restored when absent, mirroring Go's `ensureAsset`.
     */
    async download(downloadLink: string): Promise<Uint8Array> {
        const suffix = downloadLink.startsWith("/wiki")
            ? downloadLink
            : `/wiki${downloadLink}`;
        const resp = await this.get(`${this.cfg.host}${suffix}`);
        if (!ok(resp.status)) {
            throw new Error(`downloading ${downloadLink}: HTTP ${resp.status}`);
        }
        return resp.body;
    }

    /** get sends an authenticated GET to url and resolves with its response. */
    private get(url: string): Promise<HttpResponse> {
        return this.http.do({
            method: "GET",
            url,
            headers: { Authorization: this.auth },
        });
    }
}

/** ok reports whether status is a 2xx success code. */
function ok(status: number): boolean {
    return status >= 200 && status < 300;
}

/** isAbsUrl reports whether u is an absolute http(s) URL. */
function isAbsUrl(u: string): boolean {
    return u.startsWith("http://") || u.startsWith("https://");
}

/**
 * nextURL resolves a v2 pagination `next` link against host, returning `""` when
 * there is no next page and the link unchanged when it is already absolute.
 */
function nextURL(host: string, next: string): string {
    if (next === "") {
        return "";
    }
    return isAbsUrl(next) ? next : `${host}${next}`;
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * escapeFormFilename escapes a filename for a multipart Content-Disposition
 * header, mirroring Go's `mime/multipart` writer: a backslash becomes `\\` and a
 * double-quote becomes `\"`, so a quote in the name cannot close the field early.
 * CR and LF are dropped first, as either would break the header/boundary framing.
 */
function escapeFormFilename(name: string): string {
    return name
        .replace(/[\r\n]/g, "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
}

/** concatBytes joins byte arrays into one, for building a multipart body. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** asObj narrows a parsed JSON value to a record, or `{}`. */
function asObj(v: unknown): Record<string, unknown> {
    return typeof v === "object" && v !== null
        ? (v as Record<string, unknown>)
        : {};
}

/** asStr reads a JSON string, or `""`. */
function asStr(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** asInt reads a JSON number truncated toward zero, or `0`. */
function asInt(v: unknown): number {
    return typeof v === "number" ? Math.trunc(v) : 0;
}

/** asArr narrows a parsed JSON value to an array, or `[]`. */
function asArr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/** base64 encodes a UTF-8 string as standard (padded) Base64, no `node:`/`btoa`. */
function base64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    const alpha =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i] ?? 0;
        const b1 = bytes[i + 1] ?? 0;
        const b2 = bytes[i + 2] ?? 0;
        out += alpha.charAt(b0 >> 2);
        out += alpha.charAt(((b0 & 0b11) << 4) | (b1 >> 4));
        out +=
            i + 1 < bytes.length
                ? alpha.charAt(((b1 & 0b1111) << 2) | (b2 >> 6))
                : "=";
        out += i + 2 < bytes.length ? alpha.charAt(b2 & 0b111111) : "=";
    }
    return out;
}
