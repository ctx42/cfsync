// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Reading-view rendering of the `N> ` indentation marker. For each rendered
// paragraph whose text starts with a marker, strip the marker glyph from the
// first text node and pad the block left by level. Inline formatting is already
// rendered by Obsidian, so it survives untouched. The escaped `\N>` form renders
// as a flush-left literal `N>` (only the backslash is removed).

import type { MarkdownPostProcessor } from "obsidian";

import { isEscapedMarker, parseIndentMarker } from "./indent.ts";

/**
 * stripLeadingText removes the first `n` characters of the element's rendered
 * text, walking across leading text nodes until `n` is consumed. Normal Markdown
 * keeps the whole `N> ` marker in one text node, but walking is defensive against
 * a leading empty node or a marker prefix split across nodes.
 */
function stripLeadingText(el: HTMLElement, n: number): void {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = n;
    for (
        let node = walker.nextNode();
        node !== null && remaining > 0;
        node = walker.nextNode()
    ) {
        const text = node.textContent ?? "";
        if (text.length <= remaining) {
            remaining -= text.length;
            node.textContent = "";
        } else {
            node.textContent = text.slice(remaining);
            remaining = 0;
        }
    }
}

/**
 * decorateParagraph applies the indent marker's effect to one rendered `<p>`:
 * strips the escape backslash for `\N>` literals, or strips the marker glyph
 * and adds the indent class/level for a real `N> ` marker. No-op otherwise.
 */
function decorateParagraph(para: HTMLElement): void {
    const text = para.textContent ?? "";
    if (isEscapedMarker(text)) {
        stripLeadingText(para, 1); // drop the backslash, keep `N>` literal
        return;
    }
    const marker = parseIndentMarker(text);
    if (marker === null) {
        return;
    }
    stripLeadingText(para, marker.markerLen);
    para.classList.add("cfsync-indent");
    para.style.setProperty("--cfsync-indent-level", String(marker.level));
}

/**
 * indentPostProcessor decorates `N> ` markers in Reading view. Register it via
 * `this.registerMarkdownPostProcessor(indentPostProcessor)`. Each paragraph is
 * decorated defensively: a bug triggered by one malformed paragraph is logged
 * and skipped rather than thrown, so it can't break the rest of the render.
 */
export const indentPostProcessor: MarkdownPostProcessor = (el) => {
    for (const p of Array.from(el.querySelectorAll("p"))) {
        try {
            decorateParagraph(p as HTMLElement);
        } catch (err) {
            console.error("cfsync: indent post-processing failed", err);
        }
    }
};
