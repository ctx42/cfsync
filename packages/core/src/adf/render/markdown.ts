// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// ADF → Markdown renderer, ported from `pkg/adf/markdown.go`. This module lands
// incrementally across M2: the inline half (text nodes, marks, the text-run
// merge, and the inline dispatch, M2.1–M2.2) and the block half (headings,
// paragraphs, lists, callouts, media, and the block dispatch, M2.3). Directive
// carriers live in directives.ts, tables in table.ts, escaping in escape.ts.
// Frontmatter and the top-level `MarshallMarkdown` entry arrive in M2.4.

import {
    attrInt,
    attrStr,
    type Mark,
    mediaAssetKey,
    type Node,
} from "../../models/adf.ts";
import { wrapTokens } from "../../textwrap/textwrap.ts";
import { type Links, localLink } from "../links.ts";
import { codeFenceEnd, scanLink } from "../parse/inline.ts";
import {
    allStringAttrs,
    placeholder,
    renderAnchor,
    renderDirective,
    renderExtension,
    renderInlineCard,
    renderMention,
} from "./directives.ts";
import { escapeInline } from "./escape.ts";
import { renderTable } from "./table.ts";

/**
 * blockPrefixWidth is the display width of a block prefix such as `> ` or `- `,
 * subtracted from the wrap margin so prefixed lines still fit.
 */
const blockPrefixWidth = 2;

/**
 * marginOf returns the wrap column for a render context: {@link MdCtx.margin}
 * when set, else 0. A margin of 0 (or any value that leaves no room after a
 * block prefix) disables soft-wrapping, matching Obsidian, which soft-wraps in
 * the editor rather than in the file.
 */
function marginOf(ctx: MdCtx): number {
    return ctx.margin ?? 0;
}

/**
 * MdCtx carries the page-level state threaded through the render so leaf nodes
 * render correctly: the resolved image `assets` (media localId → image path),
 * the set of `ambig`uous mention display names (a name seen with more than one
 * account id, forcing the inline id override), and the `links` resolver that
 * rewrites cross-page links. Its empty value (`{}`) is a valid context, matching
 * the zero value of Go's `mdCtx`.
 */
export interface MdCtx {
    /** Resolved media: node localId → image path, relative to the Markdown file. */
    assets?: Record<string, string>;
    /** Mention display names that are ambiguous on the page. */
    ambig?: Record<string, boolean>;
    /** The cross-page link resolver, or null to leave links untouched. */
    links?: Links | null;
    /**
     * The column at which to soft-wrap block text (the `markdown.margin` config).
     * 0 or unset disables wrapping — the default, since Obsidian soft-wraps in the
     * editor. See {@link marginOf}.
     */
    margin?: number;
}

/**
 * renderText renders a single text node with its marks. Formatting marks nest
 * in canonical order with `strong` innermost; a link mark wraps the result.
 */
export function renderText(nod: Node, ctx: MdCtx): string {
    const href = linkHref(nod);
    let s = escapedText(nod, href !== undefined);
    for (const code of formatMarks(nod).reverse()) {
        s = markOpen(code) + s + markClose(code);
    }
    if (href !== undefined) {
        s = `[${s}](${encodeHref(localLink(ctx.links ?? null, href))})`;
    }
    return s;
}

/**
 * renderInline renders a single inline node to Markdown. A text node carries its
 * marks (see {@link renderText}); a mention, inlineCard, or directive node
 * (status/date/emoji, or any other all-string-attr node) renders through its
 * `adf:` carrier; an inline node that cannot round-trip keeps a read-only
 * placeholder.
 */
export function renderInline(nod: Node, ctx: MdCtx): string {
    switch (nod.type) {
        case "text":
            return renderText(nod, ctx);
        case "inlineCard":
            return renderInlineCard(nod, ctx);
        case "mention":
            return renderMention(nod, ctx);
        case "status":
        case "date":
        case "emoji":
            return renderDirective(nod);
        default:
            if (allStringAttrs(nod)) {
                return renderDirective(nod);
            }
            return placeholder(nod);
    }
}

/**
 * renderTextRun renders consecutive text nodes as one inline string, keeping a
 * formatting mark open across the boundary whenever adjacent nodes share it.
 * Delimiters stay balanced, so a mark that spans nodes never degenerates into an
 * empty run like `~~~~`; splitting a marked span across text nodes is
 * meaningless in ADF, so the merge round-trips.
 */
export function renderTextRun(run: Node[]): string {
    let b = "";
    let open: string[] = [];
    for (const nod of run) {
        const want = formatMarks(nod);
        const keep = commonPrefix(open, want);
        for (const code of open.slice(keep).reverse()) {
            b += markClose(code);
        }
        open = open.slice(0, keep);
        for (const kind of want.slice(keep)) {
            b += markOpen(kind);
            open.push(kind);
        }
        b += escapedText(nod);
    }
    for (const code of [...open].reverse()) {
        b += markClose(code);
    }
    return b;
}

/** commonPrefix returns the length of the longest shared prefix of a and b. */
function commonPrefix(a: string[], b: string[]): number {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) {
        i++;
    }
    return i;
}

/**
 * formatMarks returns the node's formatting marks as delimiter codes in
 * canonical nesting order, outermost first, ignoring links and the layout-only
 * marks (`indentation`, node-level `alignment`/`breakout`) that have no inline
 * delimiter. A code is normally the mark type; a textColor carries its color so
 * two differently-colored spans neither merge nor round-trip as equal (see
 * {@link markCode}). The fixed order makes the render deterministic, so an
 * unedited node re-renders byte-identically after a parse.
 */
function formatMarks(nod: Node): string[] {
    // Canonical nesting order, outermost first. The code mark is absent on
    // purpose: a code span is rendered as its own backtick fence by
    // escapedText (variable length, so its content may contain backticks), not
    // as a symmetric delimiter here — and it is always innermost. Strong would
    // nest inside code, but ADF never applies both to one text node (code marks
    // exclude other inline marks), so the code+strong combination is
    // unreachable and needs no ordering.
    const order = ["strike", "textColor", "underline", "em", "strong"];
    const out: string[] = [];
    for (const kind of order) {
        for (const mrk of nod.marks ?? []) {
            if (mrk.type === kind) {
                out.push(markCode(mrk));
                break;
            }
        }
    }
    return out;
}

/**
 * markCode is the delimiter code a mark renders under: its type, except a
 * textColor, which appends its color as `textColor=<color>` so the color rides
 * through the render/parse round trip and distinguishes two spans of different
 * colors. {@link markOpen} and {@link markClose} map a code back to its opening
 * and closing delimiters.
 */
export function markCode(mrk: Mark): string {
    if (mrk.type === "textColor") {
        return `textColor=${attrStr(mrk.attrs, "color")}`;
    }
    return mrk.type;
}

/** linkHref returns the href of the node's link mark, or undefined when it has none. */
export function linkHref(nod: Node): string | undefined {
    for (const mrk of nod.marks ?? []) {
        if (mrk.type === "link") {
            return attrStr(mrk.attrs, "href");
        }
    }
    return undefined;
}

/**
 * markOpen returns the opening delimiter for a formatting-mark code (see
 * {@link markCode}). The inline marks strong, em, strike and code use a
 * symmetric Markdown delimiter; underline and textColor, which Markdown cannot
 * express, use an HTML tag (`<u>`, `<span style="color:…">`). A code with no
 * delimiter renders as `""`.
 */
function markOpen(code: string): string {
    if (code.startsWith("textColor=")) {
        return `<span style="color:${code.slice("textColor=".length)}">`;
    }
    switch (code) {
        case "strong":
            return "**";
        case "em":
            return "*";
        case "strike":
            return "~~";
        case "underline":
            return "<u>";
        default:
            return "";
    }
}

/**
 * markClose returns the closing delimiter for a formatting-mark code, the
 * counterpart of {@link markOpen}. The symmetric Markdown marks close with the
 * same delimiter they open with; the HTML marks close with their end tag.
 */
function markClose(code: string): string {
    if (code.startsWith("textColor=")) {
        return "</span>";
    }
    switch (code) {
        case "underline":
            return "</u>";
        default:
            return markOpen(code);
    }
}

/**
 * escapedText returns a text node's content ready to emit inline: backslash-
 * escaped so it re-parses literally (see {@link escapeInline}), except inside a
 * code span, whose content is literal and is wrapped in a backtick fence by
 * {@link codeSpan}. `inLink` escapes brackets so link-label text round-trips.
 */
function escapedText(nod: Node, inLink = false): string {
    if (hasCodeMark(nod)) {
        return codeSpan(nod.text ?? "");
    }
    return escapeInline(nod.text ?? "", inLink);
}

/**
 * codeSpan wraps literal text in a Markdown code span, choosing a backtick fence
 * one longer than the longest backtick run in the content so an embedded
 * backtick never closes the span early. A single space is padded on each side
 * when the content edges are backticks (so the fence stays distinct) or when the
 * content both begins and ends with a space (so CommonMark's code-span
 * normalization does not strip a significant one); {@link InlineParser.parseCode}
 * reverses the padding.
 */
export function codeSpan(text: string): string {
    const fence = "`".repeat(longestBacktickRun(text) + 1);
    const allSpace = text.length > 0 && text.trim() === "";
    const pad =
        text !== "" &&
        (text.startsWith("`") ||
            text.endsWith("`") ||
            (text.startsWith(" ") && text.endsWith(" ") && !allSpace));
    const inner = pad ? ` ${text} ` : text;
    return `${fence}${inner}${fence}`;
}

/** longestBacktickRun returns the length of the longest run of backticks in s. */
function longestBacktickRun(s: string): number {
    let max = 0;
    let cur = 0;
    for (const ch of s) {
        if (ch === "`") {
            cur++;
            if (cur > max) {
                max = cur;
            }
        } else {
            cur = 0;
        }
    }
    return max;
}

/**
 * encodeHref renders a link destination so it survives inside `(…)`. A
 * destination free of whitespace, angle brackets and backslashes and with
 * balanced parentheses is emitted bare, matching {@link scanLink}'s bare form.
 * Anything else uses the CommonMark angle form `<…>`, backslash-escaping the `<`,
 * `>` and `\` that are not allowed literally there; a space or an unbalanced
 * parenthesis then rides through safely.
 */
export function encodeHref(href: string): string {
    if (!/[\s<>\\]/.test(href) && parensBalanced(href)) {
        return href;
    }
    const inner = href.replace(/[\\<>]/g, (c) => `\\${c}`);
    return `<${inner}>`;
}

/** parensBalanced reports whether s has balanced, never-underflowing parentheses. */
function parensBalanced(s: string): boolean {
    let depth = 0;
    for (const ch of s) {
        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;
            if (depth < 0) {
                return false;
            }
        }
    }
    return depth === 0;
}

/**
 * hasCodeMark reports whether the node carries a code mark, which renders it as
 * a backtick code span.
 */
function hasCodeMark(nod: Node): boolean {
    for (const mrk of nod.marks ?? []) {
        if (mrk.type === "code") {
            return true;
        }
    }
    return false;
}

/** hasLink reports whether the node carries a link mark. */
function hasLink(nod: Node): boolean {
    return linkHref(nod) !== undefined;
}

/**
 * RenderedBlock is one rendered top-level block together with the index, in the
 * parent's content slice, of the ADF node that produced it. Blocks that render
 * to nothing are omitted, so `nodeIndex` maps a rendered block back to its
 * source node despite the gaps.
 */
export interface RenderedBlock {
    /** The position of the source node in the parent content slice. */
    nodeIndex: number;
    /** The block's rendered Markdown, without a trailing newline. */
    text: string;
}

/**
 * renderBlockList renders each block node and returns the non-empty results
 * paired with their source-node index. It is the shared core of
 * {@link renderBlocks} and the source-mapped render, so both segment blocks
 * identically.
 */
export function renderBlockList(nodes: Node[], ctx: MdCtx): RenderedBlock[] {
    const out: RenderedBlock[] = [];
    for (const [i, nod] of nodes.entries()) {
        const s = renderBlock(nod, ctx);
        if (s !== "") {
            out.push({ nodeIndex: i, text: s });
        }
    }
    return out;
}

/**
 * renderBlocks renders a sequence of block nodes and joins them with a blank
 * line, dropping any block that renders to nothing. The render context is
 * threaded through so leaf nodes render correctly.
 */
export function renderBlocks(nodes: Node[], ctx: MdCtx): string {
    return renderBlockList(nodes, ctx)
        .map((b) => b.text)
        .join("\n\n");
}

/**
 * renderBlock renders a single block node to Markdown without a trailing
 * newline. An unsupported block type renders as a read-only anchor (see
 * {@link renderAnchor}).
 */
export function renderBlock(nod: Node, ctx: MdCtx): string {
    switch (nod.type) {
        case "heading": {
            const level = Math.min(Math.max(attrInt(nod.attrs, "level"), 1), 6);
            return `${"#".repeat(level)} ${inlineString(nod, ctx)}`;
        }
        case "paragraph":
            return renderParagraph(nod, ctx);
        case "panel":
            return renderPanel(nod, ctx);
        case "blockquote":
            return renderBlockquote(nod, ctx);
        case "expand":
            return renderExpand(nod, ctx);
        case "table":
            return renderTable(nod, ctx);
        case "bulletList":
            return renderBulletList(nod, ctx);
        case "orderedList":
            return renderOrderedList(nod, ctx);
        case "codeBlock":
            return renderCodeBlock(nod);
        case "mediaSingle":
            return renderBlocks(nod.content ?? [], ctx);
        case "mediaGroup":
            return renderMediaGroup(nod, ctx);
        case "media":
            return renderMedia(nod, ctx.assets ?? {});
        case "extension":
            return renderExtension(nod);
        default:
            return renderAnchor(nod);
    }
}

/**
 * renderMedia renders a media node. An external node renders as `![alt](url)`;
 * an uploaded file resolves through the assets map to an Obsidian embed
 * `![[file]]`; a file with no downloaded asset falls back to a read-only anchor.
 */
export function renderMedia(nod: Node, assets: Record<string, string>): string {
    if (attrStr(nod.attrs, "type") === "external") {
        const url = attrStr(nod.attrs, "url");
        if (url !== "") {
            return `![${attrStr(nod.attrs, "alt")}](${url})`;
        }
        return renderAnchor(nod);
    }
    const file = assets[mediaAssetKey(nod)];
    if (file === undefined) {
        return renderAnchor(nod);
    }
    return `![[${basename(file)}]]`;
}

/** basename returns the final path segment of a `/`-separated path. */
export function basename(p: string): string {
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * renderMediaGroup renders a mediaGroup — a run of attached files — as one image
 * per child on its own line, joined by single newlines so the whole group stays
 * a single top-level block.
 */
function renderMediaGroup(nod: Node, ctx: MdCtx): string {
    const lines: string[] = [];
    for (const child of nod.content ?? []) {
        const s = renderBlock(child, ctx);
        if (s !== "") {
            lines.push(s);
        }
    }
    return lines.join("\n");
}

/**
 * renderParagraph renders a paragraph, encoding its indentation level as an
 * `N> ` marker on the first line with continuation lines aligned under the text.
 * A non-indented paragraph whose own text would begin with such a marker is
 * escaped with a leading backslash so it never re-parses as indented.
 */
function renderParagraph(nod: Node, ctx: MdCtx): string {
    const segs = inlineSegments(nod, ctx);
    const level = indentLevel(nod);
    if (level === 0) {
        return escapeIndentMarker(wrapSegments(segs, marginOf(ctx)));
    }
    const marker = `${level}> `;
    const pad = " ".repeat(marker.length);
    const lines = wrapSegments(segs, marginOf(ctx) - marker.length).split("\n");
    return lines
        .map((ln, i) => (i === 0 ? marker + ln : ln !== "" ? pad + ln : ln))
        .join("\n");
}

/**
 * indentLevel returns the level of the node's indentation mark, or 0 when it
 * carries none. This reads the node-level mark, which the `N>` marker encodes.
 */
export function indentLevel(nod: Node): number {
    for (const mrk of nod.marks ?? []) {
        if (mrk.type === "indentation") {
            return attrInt(mrk.attrs, "level");
        }
    }
    return 0;
}

/**
 * escapeIndentMarker prefixes a backslash to flush-left text that would itself
 * begin with an `N>` indentation marker, so it is never mistaken for one on the
 * way back.
 */
function escapeIndentMarker(text: string): string {
    return indentMarkerLen(text) > 0 ? `\\${text}` : text;
}

/**
 * indentMarkerLen returns the length of a leading `N>` indentation marker at the
 * start of s — one or more digits followed by `>` — or 0 when s does not begin
 * with one.
 */
export function indentMarkerLen(s: string): number {
    let i = 0;
    while (i < s.length) {
        const ch = s.charCodeAt(i);
        if (ch < 48 || ch > 57) {
            break;
        }
        i++;
    }
    if (i > 0 && i < s.length && s[i] === ">") {
        return i + 1;
    }
    return 0;
}

/**
 * renderPanel renders a panel as a GitHub-style alert blockquote, mapping the
 * panelType to an uppercased `[!TYPE]` tag. A panel whose type is `EXPAND` would
 * collide with an expand's tag, so it falls back to a read-only anchor.
 */
function renderPanel(nod: Node, ctx: MdCtx): string {
    let label = attrStr(nod.attrs, "panelType").toUpperCase();
    if (label === "") {
        label = "NOTE";
    }
    if (label === "EXPAND") {
        return renderAnchor(nod);
    }
    const lines = [
        `[!${label}]`,
        ...quotedContentLines(nod.content ?? [], ctx),
    ];
    return quotePrefix(lines).join("\n");
}

/**
 * renderBlockquote renders a blockquote as a plain GitHub-style quote: every
 * content line carries a `> ` marker, with no `[!TYPE]` tag line — that tag is
 * the one thing distinguishing a panel from a bare blockquote.
 */
function renderBlockquote(nod: Node, ctx: MdCtx): string {
    return quotePrefix(quotedContentLines(nod.content ?? [], ctx)).join("\n");
}

/**
 * renderExpand renders an expand as a GitHub-style alert blockquote tagged
 * `[!EXPAND]`, with its title as the rest of the tag line. An empty or missing
 * title leaves a bare `[!EXPAND]` tag.
 */
function renderExpand(nod: Node, ctx: MdCtx): string {
    let tag = "[!EXPAND]";
    const title = attrStr(nod.attrs, "title");
    if (title !== "") {
        tag += ` ${title}`;
    }
    const lines = [tag, ...quotedContentLines(nod.content ?? [], ctx)];
    return quotePrefix(lines).join("\n");
}

/**
 * quotedContentLines renders a node's block children to soft-wrapped lines,
 * narrowed by the `> ` marker width, ready for {@link quotePrefix}. Consecutive
 * paragraphs are separated by a blank line (which quotePrefix turns into a bare
 * `>` line) so a multi-paragraph container keeps its boundaries across the round
 * trip.
 */
function quotedContentLines(content: Node[], ctx: MdCtx): string[] {
    const lines: string[] = [];
    for (const [i, child] of content.entries()) {
        if (i > 0) {
            lines.push("");
        }
        if (child.type === "paragraph") {
            const wrapped = wrapSegments(
                inlineSegments(child, ctx),
                marginOf(ctx) - blockPrefixWidth,
            );
            lines.push(...wrapped.split("\n"));
            continue;
        }
        // Nested lists, code blocks, tables, and the like keep their block shape.
        const body = renderBlock(child, ctx).replace(/\n+$/, "");
        if (body !== "") {
            lines.push(...body.split("\n"));
        }
    }
    return lines;
}

/**
 * quotePrefix prefixes each line with the blockquote `> ` marker, using a bare
 * `>` for an empty line.
 */
function quotePrefix(lines: string[]): string[] {
    return lines.map((ln) => (ln === "" ? ">" : `> ${ln}`));
}

/** renderBulletList renders a bullet list, one item per line, each with a `- ` marker. */
function renderBulletList(nod: Node, ctx: MdCtx): string {
    return renderList(nod.content ?? [], () => "- ", ctx);
}

/**
 * renderOrderedList renders a numbered list. Items are numbered sequentially
 * from the list's `order` attribute (the start number, default 1).
 */
function renderOrderedList(nod: Node, ctx: MdCtx): string {
    const start = Math.max(attrInt(nod.attrs, "order"), 1);
    return renderList(nod.content ?? [], (i) => `${start + i}. `, ctx);
}

/** renderList renders a list's items, one per line, prefixing item i with marker(i). */
function renderList(
    items: Node[],
    marker: (i: number) => string,
    ctx: MdCtx,
): string {
    return items.map((li, i) => renderListItem(li, marker(i), ctx)).join("\n");
}

/**
 * renderListItem renders one list item: its first line prefixed with the given
 * marker, its continuation lines indented to align under the text. A
 * paragraph-separating blank line stays bare.
 */
function renderListItem(li: Node, marker: string, ctx: MdCtx): string {
    const pad = " ".repeat(marker.length);
    const lines = listItemBody(li, ctx).split("\n");
    return lines
        .map((ln, i) => (i === 0 ? marker + ln : ln === "" ? ln : pad + ln))
        .join("\n");
}

/**
 * listItemBody renders a list item's children as its un-prefixed body: a
 * paragraph as wrapped inline text, a nested block as its own block render,
 * joined by a blank line.
 */
export function listItemBody(li: Node, ctx: MdCtx): string {
    const blocks: string[] = [];
    for (const child of li.content ?? []) {
        if (child.type === "paragraph") {
            blocks.push(
                wrapSegments(
                    inlineSegments(child, ctx),
                    marginOf(ctx) - blockPrefixWidth,
                ),
            );
            continue;
        }
        blocks.push(renderBlock(child, ctx));
    }
    return blocks.join("\n\n");
}

/**
 * renderCodeBlock renders a codeBlock as a fenced code block, the language (if
 * any) on the opening fence. The body is the node's literal text.
 */
function renderCodeBlock(nod: Node): string {
    return `\`\`\`${attrStr(nod.attrs, "language")}\n${codeText(nod)}\n\`\`\``;
}

/**
 * codeText concatenates the literal text of a code block's children, preserving
 * the embedded newlines that separate its lines.
 */
function codeText(nod: Node): string {
    let b = "";
    for (const child of nod.content ?? []) {
        if (child.type === "text") {
            b += child.text ?? "";
        }
    }
    return b;
}

/**
 * cellText renders a table cell's children as one inline string, joined by a
 * `<br>`. A non-paragraph child is rendered as its block form with newlines
 * flattened to `<br>`.
 */
export function cellText(nod: Node, ctx: MdCtx): string {
    const parts: string[] = [];
    for (const child of nod.content ?? []) {
        if (child.type === "paragraph") {
            parts.push(inlineString(child, ctx));
            continue;
        }
        parts.push(renderBlock(child, ctx).replaceAll("\n", "<br>"));
    }
    return parts.join("<br>").trim();
}

/**
 * inlineString renders the node's inline children to a single string, with no
 * wrapping and no line breaks; a hardBreak renders as an HTML `<br>`.
 */
export function inlineString(nod: Node, ctx: MdCtx): string {
    return inlineSegments(nod, ctx).join("<br>");
}

/**
 * inlineSegments renders the node's inline children to one string per
 * hardBreak-delimited segment, with no wrapping; a node with no hardBreak yields
 * a single segment. Consecutive plain text nodes render as one run so a
 * formatting mark shared across the boundary is emitted once.
 */
export function inlineSegments(nod: Node, ctx: MdCtx): string[] {
    const segments: string[] = [];
    let b = "";
    let run: Node[] = [];
    const flush = (): void => {
        if (run.length > 0) {
            b += renderTextRun(run);
            run = [];
        }
    };
    const cut = (): void => {
        flush();
        segments.push(b);
        b = "";
    };
    for (const child of nod.content ?? []) {
        if (child.type === "hardBreak") {
            cut();
        } else if (child.type === "text" && !hasLink(child)) {
            run.push(child);
        } else {
            flush();
            b += renderInline(child, ctx);
        }
    }
    cut();
    return segments;
}

/**
 * wrap soft-wraps s at width columns, keeping each Markdown link whole even when
 * its label contains spaces. A width of 0 or less disables wrapping and returns s
 * unchanged, which is how a zero (or unset) {@link MdCtx.margin} suppresses reflow.
 */
function wrap(s: string, width: number): string {
    if (width <= 0) {
        return s;
    }
    return wrapTokens(splitTokens(s), width);
}

/**
 * wrapSegments soft-wraps each hardBreak-delimited segment to width columns and
 * joins them with a Markdown hard line break: a trailing backslash then a
 * newline.
 */
function wrapSegments(segments: string[], width: number): string {
    return segments.map((seg) => wrap(seg, width)).join("\\\n");
}

/**
 * splitTokens splits s into space-separated tokens, keeping whole the spans a
 * space inside must not break at: a Markdown link `[label](url)` (found by
 * {@link scanLink}, so its label or destination may hold spaces), an inline code
 * span or `adf:` directive (found by {@link codeFenceEnd}), and a literal `{…}`
 * group. A `[` that does not open a link is an ordinary character, so an
 * unbalanced bracket no longer wedges the splitter and disables every later wrap
 * point.
 */
function splitTokens(s: string): string[] {
    const tokens: string[] = [];
    let cur = "";
    let brace = 0; // depth inside a literal {…} group; a space splits only at 0
    let i = 0;
    const flush = (): void => {
        if (cur.length > 0) {
            tokens.push(cur);
            cur = "";
        }
    };
    while (i < s.length) {
        const c = s.charAt(i);
        if (brace === 0 && c === " ") {
            flush();
            i++;
            continue;
        }
        if (brace === 0 && c === "`") {
            const end = codeFenceEnd(s, i);
            if (end !== null) {
                cur += s.slice(i, end);
                i = end;
                continue;
            }
        }
        if (brace === 0 && c === "[") {
            const lk = scanLink(s, i);
            if (lk !== null) {
                cur += s.slice(i, lk.end);
                i = lk.end;
                continue;
            }
        }
        if (c === "{") {
            brace++;
        } else if (c === "}" && brace > 0) {
            brace--;
        }
        cur += c;
        i++;
    }
    flush();
    return tokens;
}
