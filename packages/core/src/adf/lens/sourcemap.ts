// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The source map, ported from `pkg/adf/sourcemap.go`, plus the top-level render
// assembly it shares with `MarshallMarkdown`. A render pairs each non-empty
// top-level block with the ADF node that produced it, recording the block's byte
// range in the output — the invisible anchor push uses to back-port edits
// without writing any marker into the Markdown. Offsets are string indices
// (UTF-16 code units), used consistently for both the recorded spans and the
// slices that read them back, so the map stays self-consistent.
//
// Landed ahead of its plan slot (M5.2) because the Put lens (M4) needs
// `baselineBlocks`, which the source map produces.

import { type ADF, attrStr } from "../../models/adf.ts";
import type { Links } from "../links.ts";
import { type MdBlock, newBlock } from "../parse/blocks.ts";
import {
    ambiguousMentions,
    frontmatter,
    goQuote,
} from "../render/frontmatter.ts";
import { type MdCtx, renderBlockList } from "../render/markdown.ts";

/**
 * Span is the half-open range `[start, end)` a rendered block occupies in the
 * Markdown produced by {@link marshallMapped}. The offsets index the returned
 * string, frontmatter included.
 */
export interface Span {
    start: number;
    end: number;
}

/**
 * Origin links one rendered top-level block back to the ADF node that produced
 * it. On push, the cached ADF is re-rendered, the user's edited blocks are
 * aligned against these origins by normalized content, and the ADF is rebuilt
 * from the cached tree plus the expressed edits using {@link Origin.nodeIndex}.
 */
export interface Origin {
    /**
     * The position, in the document's top-level content slice, of the source
     * node. Blocks that render to nothing have no origin, so indices are not
     * necessarily contiguous.
     */
    nodeIndex: number;
    /** The source node's ADF type, such as `paragraph` or `table`. */
    type: string;
    /** The source node's `localId`, or `""` when it has none. */
    localId: string;
    /** The block's range in the rendered Markdown. */
    span: Span;
}

/**
 * SourceMap is the ordered origin table for one render: the offset where the
 * body begins and, per non-empty top-level block, the {@link Origin} linking it
 * to its source node.
 */
export interface SourceMap {
    /**
     * The offset at which the rendered body begins, just after the frontmatter
     * and its separating blank line. When the document has no rendered body it
     * points just past the frontmatter's closing `---`, one byte short of the
     * output length — the render still appends a single trailing newline after it.
     */
    bodyStart: number;
    /** One entry per non-empty top-level block, in document order. */
    origins: Origin[];
}

/**
 * marshallMapped renders the document as {@link marshallMarkdownAssets} does and
 * additionally returns a {@link SourceMap} describing where each top-level block
 * landed and which ADF node produced it. It throws when the root is not a `doc`.
 * `margin` sets the soft-wrap column (0, the default, disables wrapping); it only
 * affects text written to a note, never the reflow-agnostic block diff.
 */
export function marshallMapped(
    adf: ADF,
    assets: Record<string, string>,
    links: Links | null,
    margin = 0,
): [string, SourceMap] {
    if (adf.doc.type !== "doc") {
        throw new Error(`root node is ${goQuote(adf.doc.type)}, want doc`);
    }
    const ctx: MdCtx = { assets, ambig: ambiguousMentions(adf), links, margin };
    const blocks = renderBlockList(adf.doc.content ?? [], ctx);

    let b = frontmatter(adf, assets);
    const sm: SourceMap = { bodyStart: 0, origins: [] };
    const content = adf.doc.content ?? [];
    if (blocks.length > 0) {
        b += "\n\n";
        sm.bodyStart = b.length;
        for (const [i, blk] of blocks.entries()) {
            if (i > 0) {
                b += "\n\n";
            }
            const start = b.length;
            b += blk.text;
            const node = content[blk.nodeIndex] ?? { type: "" };
            sm.origins.push({
                nodeIndex: blk.nodeIndex,
                type: node.type,
                localId: attrStr(node.attrs, "localId"),
                span: { start, end: b.length },
            });
        }
    } else {
        sm.bodyStart = b.length;
    }
    b += "\n";
    return [b, sm];
}

/**
 * marshallMarkdownMapped renders the document and returns it with its
 * {@link SourceMap}, mirroring Go's `ADF.MarshallMarkdownMapped`. The string is
 * identical to what {@link marshallMarkdownAssets} returns for the same input.
 */
export function marshallMarkdownMapped(
    adf: ADF,
    assets: Record<string, string>,
): [string, SourceMap] {
    return marshallMapped(adf, assets, null);
}

/**
 * marshallMarkdownAssets renders the document with resolved image assets and no
 * link rewriting, mirroring Go's `ADF.MarshallMarkdown`.
 */
export function marshallMarkdownAssets(
    adf: ADF,
    assets: Record<string, string>,
): string {
    return marshallMapped(adf, assets, null)[0];
}

/**
 * marshallMarkdownLinks renders as {@link marshallMarkdownAssets} does, also
 * rewriting each link to a pulled Confluence page into its local Markdown link
 * via `links`. Mirrors Go's `ADF.MarshallMarkdownLinks`. `margin` sets the
 * soft-wrap column (0, the default, disables wrapping).
 */
export function marshallMarkdownLinks(
    adf: ADF,
    assets: Record<string, string>,
    links: Links | null,
    margin = 0,
): string {
    return marshallMapped(adf, assets, links, margin)[0];
}

/**
 * baselineBlocks renders the document and returns its top-level blocks, each
 * paired with the {@link Origin} linking it to the ADF node that produced it. It
 * is the authoritative baseline for a push diff: the block text comes straight
 * from the render and every block carries its source node index and localId.
 */
export function baselineBlocks(
    adf: ADF,
    assets: Record<string, string>,
    links: Links | null,
): [MdBlock[], Origin[]] {
    const [md, sm] = marshallMapped(adf, assets, links);
    const blocks = sm.origins.map((o) =>
        newBlock(md.slice(o.span.start, o.span.end)),
    );
    return [blocks, sm.origins];
}
