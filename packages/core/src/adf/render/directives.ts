// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Inline directive rendering, ported from the directive half of
// `pkg/adf/markdown.go`. An ADF inline node with no plain-Markdown form renders
// as an `adf:` inline code span so it survives a pull → edit → push round trip.
// Only the OUTER carrier changed from the Go reference: Go's `[[…]]` becomes a
// backtick-delimited `adf:…` span, and the read-only `<!-- adf:… -->`
// placeholder becomes a `%%adf:…%%` comment. The inner grammar — sigil dispatch,
// `|` content/attr split, `;`-joined `key=value` attrs, canonical ordering, and
// quoting — ports verbatim (see escape.ts).

import { attrStr, type Node } from "../../models/adf.ts";
import {
    escapeDirectiveContent,
    escapeLinkLabel,
    quoteDirectiveKey,
    quoteDirectiveValue,
} from "./escape.ts";
import { encodeHref, type MdCtx } from "./markdown.ts";

/** dirAttr is one `key=value` attribute of a rendered inline directive. */
interface DirAttr {
    key: string;
    val: string;
}

/**
 * renderDirective renders an inline node that has no plain-Markdown equivalent
 * as an `adf:` directive span. A sigil'd type renders as sugar — status
 * `` `adf:!content|attrs` ``, date `` `adf:#…` ``, emoji `` `adf::…` `` — and
 * every other type as the generic `` `adf:*type:content|attrs` ``. content is
 * the node's human-readable text, and every round-tripped attribute rides after
 * the `|`, in a per-type canonical order for status/date/emoji, else the
 * remaining string attributes sorted by key.
 */
export function renderDirective(nod: Node): string {
    const [content, attrs] = directiveParts(nod);
    const body = directiveBody(content, attrs);
    switch (nod.type) {
        case "status":
            return `\`adf:!${body}\``;
        case "date":
            return `\`adf:#${body}\``;
        case "emoji":
            return `\`adf::${body}\``;
        default:
            return `\`adf:*${nod.type}:${body}\``;
    }
}

/**
 * directiveBody renders the `content|key=value;key=value` tail shared by every
 * directive form: the escaped content, then, when the node has any attribute, a
 * `|` and the attributes joined by `;`. Each key and value is quoted only when a
 * bare token would not re-parse (see {@link quoteDirectiveKey} and
 * {@link quoteDirectiveValue}); a key carrying a separator such as `=` or `;` is
 * quoted so it round-trips like its value.
 */
function directiveBody(content: string, attrs: DirAttr[]): string {
    let b = escapeDirectiveContent(content);
    if (attrs.length > 0) {
        b += `|${attrs
            .map(
                (a) =>
                    `${quoteDirectiveKey(a.key)}=${quoteDirectiveValue(a.val)}`,
            )
            .join(";")}`;
    }
    return b;
}

/**
 * directiveParts returns the content text and the canonically-ordered
 * attributes of an inline directive node. A status carries its label plus color
 * (defaulting to `neutral`) and a non-default style; a date shows its human day
 * with the authoritative epoch-ms in `ts=`; an emoji shows its shortName
 * (colons stripped) with the id when present. The emoji glyph is not rendered —
 * the shortName is the readable form.
 */
function directiveParts(nod: Node): [string, DirAttr[]] {
    switch (nod.type) {
        case "status": {
            let color = attrStr(nod.attrs, "color");
            if (color === "") {
                color = "neutral";
            }
            const attrs: DirAttr[] = [{ key: "color", val: color }];
            const style = attrStr(nod.attrs, "style");
            if (style !== "" && style !== "default") {
                attrs.push({ key: "style", val: style });
            }
            return [attrStr(nod.attrs, "text"), attrs];
        }
        case "date": {
            const ts = dateTimestamp(nod);
            return [humanDate(ts), [{ key: "ts", val: ts }]];
        }
        case "emoji": {
            const attrs: DirAttr[] = [];
            const id = attrStr(nod.attrs, "id");
            if (id !== "") {
                attrs.push({ key: "id", val: id });
            }
            return [emojiContent(attrStr(nod.attrs, "shortName")), attrs];
        }
        default:
            return [attrStr(nod.attrs, "text"), genericAttrs(nod)];
    }
}

/**
 * emojiContent is the readable content of an emoji directive: the shortName with
 * its surrounding colons stripped, so `:smile:` renders as `smile`. A shortName
 * not wrapped in colons is returned unchanged.
 */
function emojiContent(short: string): string {
    if (short.length >= 2 && short.startsWith(":") && short.endsWith(":")) {
        return short.slice(1, -1);
    }
    return short;
}

/**
 * genericAttrs returns a node's attributes as directive attributes in a
 * deterministic order: every attribute except the text content and the dropped
 * localId, keyed lexically. It is the fallback for a node type without a
 * canonical attr order.
 */
function genericAttrs(nod: Node): DirAttr[] {
    const keys = Object.keys(nod.attrs ?? {})
        .filter((k) => k !== "text" && k !== "localId")
        .sort();
    return keys.map((k) => ({ key: k, val: attrStr(nod.attrs, k) }));
}

/**
 * dateTimestamp returns the node's timestamp attribute as a string, whether it
 * decoded as a string or a JSON number.
 */
function dateTimestamp(nod: Node): string {
    const s = attrStr(nod.attrs, "timestamp");
    if (s !== "") {
        return s;
    }
    const v = nod.attrs?.["timestamp"];
    if (typeof v === "number") {
        return String(Math.trunc(v));
    }
    return "";
}

/**
 * humanDate renders epoch-millisecond ts as a UTC `YYYY-MM-DD` day, the cosmetic
 * content of a date directive. An unparseable ts is returned verbatim, so the
 * render stays deterministic and the ts attribute stays authoritative.
 */
function humanDate(ts: string): string {
    if (!/^[+-]?\d+$/.test(ts)) {
        return ts;
    }
    const ms = Number(ts);
    if (!Number.isFinite(ms)) {
        return ts;
    }
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
        return ts; // ms out of Date's range (Go's ParseInt overflows here)
    }
    return d.toISOString().slice(0, 10);
}

/**
 * renderMention renders a mention as `` `adf:@name` ``, the account id being
 * recovered from the mentions frontmatter map on the way back. When the display
 * name is ambiguous on the page (it appears with more than one account id, so
 * the frontmatter map cannot key it), the id is carried inline as
 * `` `adf:@name|id=…` `` instead.
 */
export function renderMention(nod: Node, ctx: MdCtx): string {
    const name = mentionName(nod);
    const body = escapeDirectiveContent(name);
    if (ctx.ambig?.[name]) {
        return `\`adf:@${body}|id=${quoteDirectiveValue(attrStr(nod.attrs, "id"))}\``;
    }
    return `\`adf:@${body}\``;
}

/**
 * mentionName is the display name of a mention: its text attribute without the
 * leading `@`, which is the body `@name` label and the mentions-map key.
 */
export function mentionName(nod: Node): string {
    const text = attrStr(nod.attrs, "text");
    return text.startsWith("@") ? text.slice(1) : text;
}

/**
 * renderInlineCard renders an inlineCard (a Confluence smart link) as a
 * CommonMark autolink `<url>`. That is distinct from a plain link `[label](href)`
 * so it re-parses back to an inlineCard rather than collapsing into a link. A
 * card that targets a pulled page becomes a normal `[title](path)` link, the
 * resolver supplying the label and {@link encodeHref} the destination. A url
 * that cannot sit inside an autolink (empty, or containing whitespace, `<`, `>`
 * or a carriage return) falls back to the read-only placeholder.
 */
export function renderInlineCard(nod: Node, ctx: MdCtx): string {
    const url = attrStr(nod.attrs, "url");
    if (ctx.links != null) {
        const local = ctx.links.toLocal(url);
        if (local !== undefined) {
            return `[${escapeLinkLabel(local.label)}](${encodeHref(local.target)})`;
        }
    }
    if (url === "" || /[ \t\r\n<>]/.test(url)) {
        return placeholder(nod);
    }
    return `<${url}>`;
}

/**
 * rendersAsDirective reports whether an inline node renders as a directive
 * rather than as literal text or a read-only placeholder. It mirrors
 * {@link renderInline}: text, mentions and inlineCards have their own encodings;
 * status, date and emoji are always directives; any other node is a directive
 * only when its attributes are all strings. It is how the self-check keys a
 * directive token.
 */
export function rendersAsDirective(nod: Node): boolean {
    switch (nod.type) {
        case "text":
        case "mention":
        case "inlineCard":
        case "hardBreak":
            return false;
        case "status":
        case "date":
        case "emoji":
            return true;
        default:
            return allStringAttrs(nod);
    }
}

/**
 * allStringAttrs reports whether every attribute of the node is a string, so the
 * node can be rendered as a directive without losing a non-string value.
 */
export function allStringAttrs(nod: Node): boolean {
    for (const v of Object.values(nod.attrs ?? {})) {
        if (typeof v !== "string") {
            return false;
        }
    }
    return true;
}

/**
 * placeholder renders an unsupported node as a `%%adf:…%%` comment carrying its
 * type and a few identifying attributes, so nothing is dropped silently. It is
 * the invisible, frozen counterpart to an editable directive span (Go emitted an
 * HTML `<!-- adf:… -->` comment here).
 */
export function placeholder(nod: Node): string {
    let attrs: string[];
    switch (nod.type) {
        case "extension":
            attrs = placeholderAttrs(nod, ["extensionKey", "localId"]);
            break;
        case "media":
            attrs = placeholderAttrs(nod, ["alt", "id"]);
            break;
        default:
            attrs = placeholderAttrs(nod, ["localId"]);
    }
    let head = `%%adf:${nod.type}`;
    if (attrs.length > 0) {
        head += ` ${attrs.join(" ")}`;
    }
    return `${head}%%`;
}

/**
 * placeholderAttrs formats the named string attributes as `key="value"` pairs,
 * skipping any that are absent.
 */
function placeholderAttrs(nod: Node, keys: string[]): string[] {
    const out: string[] = [];
    for (const k of keys) {
        const v = attrStr(nod.attrs, k);
        if (v !== "") {
            out.push(`${k}=${JSON.stringify(v)}`);
        }
    }
    return out;
}

/**
 * renderExtension renders a block-level Confluence macro as a frozen
 * {@link adfBlock}. The Table of Contents macro (extensionKey `toc`), present on
 * nearly every page, is recognized and carried under the synthetic `type: toc`;
 * every other macro renders as a generic anchor until specifically supported.
 */
export function renderExtension(nod: Node): string {
    if (attrStr(nod.attrs, "extensionKey") === "toc") {
        const entries: Array<[string, string]> = [];
        const localId = attrStr(nod.attrs, "localId");
        if (localId !== "") {
            entries.push(["localId", localId]);
        }
        return adfBlock("toc", entries);
    }
    return renderAnchor(nod);
}

/**
 * renderAnchor renders a read-only block node as a frozen `adf` fenced block
 * carrying its node type and string attributes (including the `localId` the
 * merge matches to copy the cached node back verbatim). It is the block-level
 * counterpart to {@link renderDirective}: the reference tool emitted a
 * `[[*type:…]]` directive here, which becomes a YAML-bodied ```` ```adf ````
 * block in the Obsidian dialect.
 */
export function renderAnchor(nod: Node): string {
    return adfBlock(nod.type, anchoredAttrs(nod));
}

/**
 * anchoredAttrs returns a node's string attributes as `key`/`value` pairs in
 * lexical order, dropping any non-string value and the `type` key — the node
 * type already owns the block's `type:` line, so a node with its own `type`
 * attribute (a media node's `file`/`external`) does not collide. The dropped
 * value is restored from the cached ADF on push, keyed by localId.
 */
function anchoredAttrs(nod: Node): Array<[string, string]> {
    const attrs = nod.attrs ?? {};
    return Object.keys(attrs)
        .filter((k) => k !== "type" && typeof attrs[k] === "string")
        .sort()
        .map((k): [string, string] => [k, attrStr(attrs, k)]);
}

/**
 * adfBlock builds a frozen ```` ```adf ```` fenced block: a YAML body with the
 * node `type` first, then one `key: value` line per entry. Values are emitted as
 * bare YAML scalars, double-quoted only when a bare scalar would be ambiguous.
 */
function adfBlock(type: string, entries: Array<[string, string]>): string {
    const lines = [`type: ${yamlValue(type)}`];
    for (const [k, v] of entries) {
        lines.push(`${k}: ${yamlValue(v)}`);
    }
    return `\`\`\`adf\n${lines.join("\n")}\n\`\`\``;
}

/**
 * yamlValue emits a string as a YAML scalar: bare when it is a plain token,
 * double-quoted (JSON string form, valid YAML) when empty, whitespace-padded, or
 * carrying a character that would misparse as YAML structure.
 */
function yamlValue(s: string): string {
    const unsafe =
        s === "" ||
        /^\s|\s$/.test(s) ||
        /[\n\t]/.test(s) ||
        /: |#/.test(s) ||
        /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
        s.includes('"') ||
        s.includes("\\");
    return unsafe ? JSON.stringify(s) : s;
}
