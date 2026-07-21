// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Atlassian Document Format (ADF) model: a Confluence page as pulled and
// cached, plus the helpers that read its nodes. Ported from `pkg/adf/adf.go`.
// Rendering to Markdown ({@link ADF} → frontmatter + body) and the push lens
// arrive in later milestones; this module is only the data model and its
// accessors.

/**
 * Mark is an inline formatting mark applied to a text node, such as `strong`,
 * `em`, or `link`.
 */
export interface Mark {
    /** The mark type. */
    type: string;
    /** Type-specific attributes, such as a link `href`. */
    attrs?: Record<string, unknown>;
}

/**
 * Node is a single node in the ADF document tree. The same shape models block
 * nodes, inline nodes, and text leaves; which fields are populated depends on
 * {@link Node.type}.
 */
export interface Node {
    /** The ADF node type, such as `paragraph`, `text`, or `table`. */
    type: string;
    /** The node's children; absent for leaf nodes. */
    content?: Node[];
    /** The literal text of a `text` node. */
    text?: string;
    /** The inline formatting marks applied to a `text` node. */
    marks?: Mark[];
    /** The node's type-specific attributes. */
    attrs?: Record<string, unknown>;
}

/**
 * ADF is a Confluence page in Atlassian Document Format together with the
 * wrapper metadata needed to render its Markdown frontmatter. It is parsed from
 * the cached wrapper JSON produced by a page pull:
 *
 * ```json
 * {"name":…,"id":…,"title":…,"version":…,"space_id":…,"adf":{ADF doc}}
 * ```
 */
export interface ADF {
    /**
     * The page's destination name, relative to the work directory and ending in
     * `.md` — the `page_path` frontmatter field and the path passed to push.
     */
    name: string;
    /** The numeric Confluence page identifier. */
    id: string;
    /** The page title as stored in Confluence. */
    title: string;
    /** The Confluence page version number. */
    version: number;
    /** The numeric identifier of the space the page belongs to. */
    spaceId: string;
    /**
     * The key of the space the page belongs to. Set only for a page pulled
     * through a configured space; empty (and omitted from frontmatter) for a
     * page pulled through `pages:` or `folders:`.
     */
    spaceKey: string;
    /**
     * The Confluence page id of the parent page, empty for a space homepage.
     * Rendered as `parent_id` (after `space_id`, before `space_key`); omitted
     * when empty.
     */
    parentId: string;
    /**
     * The Confluence Site host the page was pulled from, such as
     * `example.atlassian.net`. Rendered as `cf_domain`; omitted when empty.
     */
    domain: string;
    /** The root of the ADF document tree, a node of type `doc`. */
    doc: Node;
}

/**
 * MediaRef identifies an uploaded-file image referenced by the document: the
 * information a caller needs to fetch it and link the download back to its ADF
 * node.
 */
export interface MediaRef {
    /**
     * The media node's stable per-node anchor — its ADF `localId`, or its
     * `fileId` as a fallback (see {@link mediaAssetKey}). Used as the
     * frontmatter and assets-map key.
     */
    localId: string;
    /** The media node's `attrs.id`, equal to the Confluence attachment fileId. */
    fileId: string;
    /** The media node's `attrs.alt`, the original file name. */
    alt: string;
}

/** Read a string attribute, or `""` when absent or not a string. */
export function attrStr(
    attrs: Record<string, unknown> | undefined,
    key: string,
): string {
    const value = attrs?.[key];
    return typeof value === "string" ? value : "";
}

/**
 * Read an integer attribute, or `0` when absent or not a number. JSON numbers
 * decode as floats, so the value is truncated toward zero, matching Go's
 * `int(float64)`.
 */
export function attrInt(
    attrs: Record<string, unknown> | undefined,
    key: string,
): number {
    const value = attrs?.[key];
    return typeof value === "number" ? Math.trunc(value) : 0;
}

/**
 * mediaAssetKey is the key a file-media node is tracked under in the assets map
 * and the `page_images` frontmatter: its `localId` when it has one, else its
 * `fileId` as a fallback so a node Confluence left without a localId still
 * resolves to a downloaded image. Derived identically on render and on the push
 * baseline, so the two always agree.
 */
export function mediaAssetKey(node: Node): string {
    const localId = attrStr(node.attrs, "localId");
    return localId !== "" ? localId : attrStr(node.attrs, "id");
}

/**
 * collectFileMedia appends every uploaded-file media node at or below `node` to
 * `out`, in document order. Both a block `media` node and an inline
 * `mediaInline` reference count when their `attrs.type` is `file`.
 */
function collectFileMedia(node: Node, out: Node[]): Node[] {
    if (
        (node.type === "media" || node.type === "mediaInline") &&
        attrStr(node.attrs, "type") === "file"
    ) {
        out.push(node);
    }
    for (const child of node.content ?? []) {
        collectFileMedia(child, out);
    }
    return out;
}

/**
 * fileMedia returns a {@link MediaRef} for every uploaded-file media node in the
 * document, in document order, including those inside a `mediaGroup` and inline
 * `mediaInline` file references. External media is omitted (it carries its own
 * URL and is not downloaded). A node with neither a localId nor a fileId cannot
 * be anchored to an asset and is omitted; one lacking only a localId falls back
 * to its fileId as the anchor key.
 */
export function fileMedia(adf: ADF): MediaRef[] {
    const refs: MediaRef[] = [];
    for (const node of collectFileMedia(adf.doc, [])) {
        const key = mediaAssetKey(node);
        if (key === "") {
            continue; // no localId and no fileId: nothing to anchor to
        }
        refs.push({
            localId: key,
            fileId: attrStr(node.attrs, "id"),
            alt: attrStr(node.attrs, "alt"),
        });
    }
    return refs;
}

/** Read a string field, or `""` when absent or not a string. */
function fieldStr(obj: Record<string, unknown>, key: string): string {
    const value = obj[key];
    return typeof value === "string" ? value : "";
}

/** Read a numeric field, or `0` when absent or not a number. */
function fieldInt(obj: Record<string, unknown>, key: string): number {
    const value = obj[key];
    return typeof value === "number" ? Math.trunc(value) : 0;
}

/**
 * newADF parses the cached wrapper JSON into an {@link ADF} value. It throws an
 * `Error` whose message begins `decoding ADF page` when the input is not valid
 * JSON, mirroring the Go `NewADF` error.
 */
export function newADF(data: string): ADF {
    let raw: unknown;
    try {
        raw = JSON.parse(data);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`decoding ADF page: ${reason}`);
    }
    if (typeof raw !== "object" || raw === null) {
        throw new Error("decoding ADF page: not a JSON object");
    }
    const obj = raw as Record<string, unknown>;
    const doc = obj["adf"];
    return {
        name: fieldStr(obj, "name"),
        id: fieldStr(obj, "id"),
        title: fieldStr(obj, "title"),
        version: fieldInt(obj, "version"),
        spaceId: fieldStr(obj, "space_id"),
        spaceKey: fieldStr(obj, "space_key"),
        parentId: fieldStr(obj, "parent_id"),
        domain: fieldStr(obj, "cf_domain"),
        doc: isNode(doc) ? doc : { type: "" },
    };
}

/** Narrow a parsed JSON value to a {@link Node} (has a string `type`). */
function isNode(value: unknown): value is Node {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { type?: unknown }).type === "string"
    );
}
