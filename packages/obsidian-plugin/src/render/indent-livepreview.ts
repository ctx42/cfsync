// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live Preview rendering of the `N> ` indentation marker. A CM6 view plugin
// hides the marker glyph and pads the line left by level × step, revealing the
// raw marker on the line under the cursor so it stays editable. Byte-preserving:
// decorations never change the document.

import type { Extension } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    type DecorationSet,
    type EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";

import {
    type IndentDecoration,
    parseIndentMarker,
    planIndentDecorations,
} from "./indent.ts";

/** editingLineSet returns the 0-based lines any selection range touches. */
function editingLineSet(view: EditorView): Set<number> {
    const set = new Set<number>();
    for (const range of view.state.selection.ranges) {
        const from = view.state.doc.lineAt(range.from).number - 1;
        const to = view.state.doc.lineAt(range.to).number - 1;
        for (let n = from; n <= to; n++) {
            set.add(n);
        }
    }
    return set;
}

/**
 * blockScanStart returns the 0-based line where the planner must begin so the
 * decorations for a viewport starting at `vpFrom` are correct. The planner
 * attributes a paragraph's level from its `N> ` marker line and walks forward
 * over continuation lines, so if `vpFrom` lands mid-paragraph its marker is
 * above the viewport. This backs up over non-blank, non-marker lines until it
 * reaches the owning marker, a blank boundary, or line 0 — every one of which
 * is a clean block boundary the planner can restart from with identical output.
 * `lineText(n)` reads a line lazily so only the walked-over lines are fetched.
 */
export function blockScanStart(
    lineText: (n: number) => string,
    vpFrom: number,
): number {
    let s = vpFrom;
    while (s > 0) {
        const cur = lineText(s);
        if (cur.trim() === "" || parseIndentMarker(cur) !== null) {
            break;
        }
        s--;
    }
    return s;
}

/**
 * planViewportDecorations scopes {@link planIndentDecorations} to the visible
 * viewport instead of the whole document. It expands the start back to the
 * enclosing marker via {@link blockScanStart} (so a wrapped paragraph is never
 * split and levels are never misattributed), runs the planner only over lines
 * `[start, vpTo]`, and returns decorations with absolute 0-based line indices —
 * identical to a full-document run restricted to the visible lines, but O(view)
 * rather than O(doc). Lines past `vpTo` are off-screen and need no decoration,
 * so truncating there is safe. `editingLines` are absolute doc indices.
 */
export function planViewportDecorations(
    lineText: (n: number) => string,
    vpFrom: number,
    vpTo: number,
    editingLines: ReadonlySet<number>,
): IndentDecoration[] {
    const start = blockScanStart(lineText, vpFrom);
    const lines: string[] = [];
    for (let n = start; n <= vpTo; n++) {
        lines.push(lineText(n));
    }
    const editing = new Set<number>();
    for (const n of editingLines) {
        if (n >= start && n <= vpTo) {
            editing.add(n - start);
        }
    }
    return planIndentDecorations(lines, editing).map((d) => ({
        ...d,
        line: d.line + start,
    }));
}

/** buildDecorations turns the pure plan into a CM6 DecorationSet. */
function buildDecorations(view: EditorView): DecorationSet {
    const { doc } = view.state;
    // Scope planning to the rendered viewport: rebuilding the whole-document
    // line array and re-planning on every cursor move (selectionSet) is O(doc)
    // per update. blockScanStart expands the range back to the enclosing marker
    // so continuation levels stay correct.
    const lastLine = doc.lines - 1;
    const vpFrom = doc.lineAt(view.viewport.from).number - 1;
    const vpTo = Math.min(doc.lineAt(view.viewport.to).number - 1, lastLine);
    // Escaped `\N>` lines get no decoration (parseIndentMarker returns null
    // for them), so they stay literal in Live Preview; Reading view's
    // post-processor strips the backslash instead — an accepted difference.
    const plan = planViewportDecorations(
        (n) => doc.line(n + 1).text,
        vpFrom,
        vpTo,
        editingLineSet(view),
    );
    const builder = new RangeSetBuilder<Decoration>();
    for (const d of plan) {
        const line = doc.line(d.line + 1);
        builder.add(
            line.from,
            line.from,
            Decoration.line({
                attributes: {
                    class: "cfsync-indent",
                    style: `--cfsync-indent-level:${d.level}`,
                },
            }),
        );
        if (d.hideMarker && d.markerTo > d.markerFrom) {
            builder.add(
                line.from + d.markerFrom,
                line.from + d.markerTo,
                Decoration.replace({}),
            );
        }
    }
    return builder.finish();
}

/**
 * safeBuildDecorations wraps buildDecorations so a bug in the planner or the
 * decoration wiring can never throw out of the view plugin (a throw there
 * breaks the whole editor). On failure it logs the error and falls back to no
 * decorations, so the indent feature degrades to plain markers instead of
 * crashing Live Preview — and the failure is still visible in the console.
 */
function safeBuildDecorations(view: EditorView): DecorationSet {
    try {
        return buildDecorations(view);
    } catch (err) {
        console.error("cfsync: indent decoration failed", err);
        return Decoration.none;
    }
}

/**
 * indentViewPlugin decorates `N> ` indentation markers in Live Preview. Register
 * it via `this.registerEditorExtension(indentViewPlugin)`.
 */
export const indentViewPlugin: Extension = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
            this.decorations = safeBuildDecorations(view);
        }
        update(u: ViewUpdate): void {
            if (u.docChanged || u.selectionSet || u.viewportChanged) {
                this.decorations = safeBuildDecorations(u.view);
            }
        }
    },
    { decorations: (v) => v.decorations },
);
