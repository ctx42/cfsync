// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// YAML frontmatter and the top-level Markdown assembly, ported from the
// frontmatter half of `pkg/adf/markdown.go` and the `marshallMapped` assembly in
// `pkg/adf/sourcemap.go`. The frontmatter fields are dialect-stable and port
// 1:1; the source map itself arrives in M5.2, so this assembles the body without
// one. `goQuote` reproduces Go's `%q` string quoting used for the quoted fields.

import { type ADF, attrStr, fileMedia, type Node } from "../../models/adf.ts";
import { mentionName } from "./directives.ts";

/**
 * frontmatter renders the YAML frontmatter block from the wrapper metadata and
 * the resolved assets, without a trailing newline (it ends at the closing
 * `---`). The block always leads with `cfsync-plugin: pull`, the marker identifying a cfsync-managed note.
 */
export function frontmatter(adf: ADF, assets: Record<string, string>): string {
    let b = "---\n";
    b += "cfsync-plugin: pull\n";
    b += `title: ${goQuote(adf.title)}\n`;
    b += `page_path: ${goQuote(adf.name)}\n`;
    b += `page_id: ${goQuote(adf.id)}\n`;
    b += `page_version: ${adf.version}\n`;
    b += `space_id: ${goQuote(adf.spaceId)}\n`;
    if (adf.parentId !== "") {
        b += `parent_id: ${goQuote(adf.parentId)}\n`;
    }
    if (adf.spaceKey !== "") {
        b += `space_key: ${goQuote(adf.spaceKey)}\n`;
    }
    if (adf.domain !== "") {
        b += `cf_domain: ${goQuote(adf.domain)}\n`;
    }
    b += pageImages(adf, assets);
    b += mentionList(adf);
    b += "---";
    return b;
}

/**
 * pageImages renders the `page_images` frontmatter block: one entry per resolved
 * media node, in document order, each recording its localId, image path and alt
 * text. Returns `""` when no media node resolves to an asset.
 */
function pageImages(adf: ADF, assets: Record<string, string>): string {
    let b = "";
    for (const ref of fileMedia(adf)) {
        const file = assets[ref.localId];
        if (file === undefined) {
            continue;
        }
        if (b === "") {
            b = "page_images:\n";
        }
        b += `  - local_id: ${goQuote(ref.localId)}\n`;
        b += `    file: ${goQuote(file)}\n`;
        b += `    alt: ${goQuote(ref.alt)}\n`;
    }
    return b;
}

/**
 * mentionList renders the `mentions` frontmatter block: one `name: account-id`
 * entry per distinct unambiguous mention display name, in first-occurrence
 * order. A name seen with more than one account id is ambiguous and omitted (it
 * round-trips through the inline id override instead). Returns `""` for a
 * mention-free page.
 */
function mentionList(adf: ADF): string {
    const { order, ids } = mentionIndex(adf);
    let b = "";
    for (const name of order) {
        const list = ids.get(name) ?? [];
        if (list.length !== 1) {
            continue; // ambiguous: carried inline as `adf:@name|id=…`
        }
        if (b === "") {
            b = "mentions:\n";
        }
        b += `  ${goQuote(name)}: ${goQuote(list[0] ?? "")}\n`;
    }
    return b;
}

/**
 * ambiguousMentions returns the set of mention display names that appear on the
 * page with more than one account id, which must render with the inline id
 * override rather than a bare mention span.
 */
export function ambiguousMentions(adf: ADF): Record<string, boolean> {
    const { ids } = mentionIndex(adf);
    const amb: Record<string, boolean> = {};
    for (const [name, list] of ids) {
        if (list.length > 1) {
            amb[name] = true;
        }
    }
    return amb;
}

/**
 * mentionIndex walks the document once and returns the distinct mention display
 * names in first-occurrence order together with, per name, the distinct account
 * ids seen for it (also in first-occurrence order).
 */
function mentionIndex(adf: ADF): {
    order: string[];
    ids: Map<string, string[]>;
} {
    const order: string[] = [];
    const ids = new Map<string, string[]>();
    for (const nod of collectMentions(adf.doc, [])) {
        const name = mentionName(nod);
        const id = attrStr(nod.attrs, "id");
        let seen = ids.get(name);
        if (seen === undefined) {
            order.push(name);
            seen = [];
            ids.set(name, seen);
        }
        if (!seen.includes(id)) {
            seen.push(id);
        }
    }
    return { order, ids };
}

/** collectMentions appends every mention node at or below `node` to `out`. */
function collectMentions(node: Node, out: Node[]): Node[] {
    if (node.type === "mention") {
        out.push(node);
    }
    for (const child of node.content ?? []) {
        collectMentions(child, out);
    }
    return out;
}

/**
 * goQuote reproduces Go's `strconv.Quote` (the `%q` verb for strings): wrap in
 * double quotes, backslash-escape `"` and `\`, use the short escapes for the
 * usual control characters, `\xHH` for the remaining C0/DEL bytes, and keep
 * printable runes — including printable non-ASCII such as `é` — literal, with
 * `\uHHHH`/`\UHHHHHHHH` for the non-printable rest.
 */
export function goQuote(value: string): string {
    let out = '"';
    for (const ch of value) {
        const cp = ch.codePointAt(0) ?? 0;
        if (ch === '"' || ch === "\\") {
            out += `\\${ch}`;
        } else if (SHORT_ESCAPES.has(cp)) {
            out += SHORT_ESCAPES.get(cp) as string;
        } else if (cp < 0x20 || cp === 0x7f) {
            out += `\\x${hex(cp, 2)}`;
        } else if (isPrint(cp)) {
            out += ch;
        } else if (cp < 0x10000) {
            out += `\\u${hex(cp, 4)}`;
        } else {
            out += `\\U${hex(cp, 8)}`;
        }
    }
    return `${out}"`;
}

/** Go's short control-character escapes. */
const SHORT_ESCAPES = new Map<number, string>([
    [0x07, "\\a"],
    [0x08, "\\b"],
    [0x09, "\\t"],
    [0x0a, "\\n"],
    [0x0b, "\\v"],
    [0x0c, "\\f"],
    [0x0d, "\\r"],
]);

/** Lowercase, zero-padded hex, matching Go's `%02x`/`%04x`/`%08x`. */
function hex(cp: number, width: number): string {
    return cp.toString(16).padStart(width, "0");
}

/**
 * isPrint approximates Go's `strconv.IsPrint` for code points at or above the
 * ASCII range. ASCII printables are `0x20`–`0x7e`; above `0x7f`, everything is
 * treated as printable except the C1 controls and the common zero-width /
 * format / noncharacter code points.
 */
function isPrint(cp: number): boolean {
    if (cp <= 0x7e) {
        return cp >= 0x20;
    }
    if (cp <= 0x9f) {
        return false; // C1 controls
    }
    if (
        (cp >= 0x2028 && cp <= 0x2029) || // line/paragraph separators
        (cp >= 0x200b && cp <= 0x200f) || // zero-width, direction marks
        (cp >= 0x202a && cp <= 0x202e) || // bidi embedding
        (cp >= 0x2060 && cp <= 0x2064) || // invisible operators
        (cp >= 0xfdd0 && cp <= 0xfdef) || // noncharacters
        cp === 0xfeff || // BOM
        (cp & 0xfffe) === 0xfffe // U+..FFFE / U+..FFFF noncharacters
    ) {
        return false;
    }
    return true;
}
