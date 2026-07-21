// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The inline self-check, ported from `pkg/adf/parse_inline.go`. It confirms an
// inline run survives a render→parse round trip: a run whose signature equals
// the signature of parsing its own render may be safely reparsed on push; one
// for which the check fails holds something the Markdown cannot express
// losslessly and is treated as read-only rather than silently rewritten.

import { attrStr, type Node } from "../../models/adf.ts";
import { type Links, localLink } from "../links.ts";
import { renderDirective, rendersAsDirective } from "../render/directives.ts";
import {
    inlineString,
    linkHref,
    type MdCtx,
    markCode,
} from "../render/markdown.ts";
import { type ParseCtx, parseInline } from "./inline.ts";

/**
 * InlineTok is one element of an inline signature: a canonical,
 * node-splitting-insensitive description of an inline node, used to compare two
 * inline runs for equality without depending on how text is chunked into nodes.
 */
interface InlineTok {
    /** "text", "mention", "card", "directive", or "other". */
    kind: string;
    /** Text content of a text token, or the rendered directive of a directive token. */
    text: string;
    /** Sorted formatting-mark codes, comma-joined, for a text token. */
    marks: string;
    /** Link href (text token, local target) or card url. */
    href: string;
    /** Account id for a mention token. */
    id: string;
    /** Node type for an "other" token. */
    typ: string;
}

/** emptyTok returns a zero-valued token, so only the set fields differ. */
function emptyTok(kind: string): InlineTok {
    return { kind, text: "", marks: "", href: "", id: "", typ: "" };
}

/**
 * inlineSig reduces an inline run to its signature: adjacent text nodes that
 * share the same marks and link are merged, so "ab" and "a"+"b" compare equal. A
 * directive node becomes a token carrying its full rendered directive, so two
 * directives compare equal only when every round-tripped attribute matches. Any
 * node the parser cannot reproduce (a hardBreak, a node with a non-string attr)
 * becomes an "other" token carrying its type, which is how the self-check
 * detects a lossy block.
 *
 * A link href is keyed by its local target (via links), not its raw Confluence
 * URL, because {@link Links.toLocal} is intentionally many-to-one, so
 * toRemote(toLocal(href)) need not equal href. Keying by the local target lets a
 * link whose stored and reconstructed URLs denote the same page round-trip.
 */
export function inlineSig(nodes: Node[], links: Links | null): InlineTok[] {
    const sig: InlineTok[] = [];
    for (const nod of nodes) {
        if (nod.type === "text") {
            const tok = emptyTok("text");
            tok.text = nod.text ?? "";
            tok.marks = markSig(nod);
            tok.href = localLink(links, linkHref(nod) ?? "");
            const last = sig[sig.length - 1];
            if (
                last !== undefined &&
                last.kind === "text" &&
                last.marks === tok.marks &&
                last.href === tok.href
            ) {
                last.text += tok.text;
            } else {
                sig.push(tok);
            }
        } else if (nod.type === "mention") {
            const tok = emptyTok("mention");
            tok.id = attrStr(nod.attrs, "id");
            sig.push(tok);
        } else if (nod.type === "inlineCard") {
            const tok = emptyTok("card");
            tok.href = attrStr(nod.attrs, "url");
            sig.push(tok);
        } else if (rendersAsDirective(nod)) {
            const tok = emptyTok("directive");
            tok.text = renderDirective(nod);
            sig.push(tok);
        } else {
            const tok = emptyTok("other");
            tok.typ = nod.type;
            sig.push(tok);
        }
    }
    return sig;
}

/**
 * markSig returns a node's mark delimiter codes (see {@link markCode}) except
 * link (compared separately via the href) and indentation (expressed by the
 * paragraph's `N>` marker), sorted and comma-joined, so two nodes with the same
 * marks in any order compare equal. A textColor rides with its color, so
 * recoloring is detected. It still includes marks the renderer emits no
 * delimiter for — the node-level layout marks — on purpose: their presence makes
 * the signature differ from a reparse, so a block carrying one is judged not
 * round-trippable and stays read-only rather than silently losing the mark.
 */
export function markSig(nod: Node): string {
    const types: string[] = [];
    for (const m of nod.marks ?? []) {
        if (m.type === "link" || m.type === "indentation") {
            continue;
        }
        types.push(markCode(m));
    }
    types.sort();
    return types.join(",");
}

/** sigEqual reports whether two inline signatures are identical. */
export function sigEqual(a: InlineTok[], b: InlineTok[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((tok, i) => tokEqual(tok, b[i]));
}

/** tokEqual reports whether two tokens are field-for-field identical. */
function tokEqual(a: InlineTok, b: InlineTok | undefined): boolean {
    return (
        b !== undefined &&
        a.kind === b.kind &&
        a.text === b.text &&
        a.marks === b.marks &&
        a.href === b.href &&
        a.id === b.id &&
        a.typ === b.typ
    );
}

/**
 * inlineRoundTrips reports whether an inline run survives a render→parse round
 * trip unchanged: its signature equals the signature of parsing its own render.
 * The run must be a single logical segment (no hardBreak); callers split on hard
 * breaks first.
 */
export function inlineRoundTrips(
    nodes: Node[],
    ctx: MdCtx,
    pc: ParseCtx,
): boolean {
    const rendered = inlineString({ type: "paragraph", content: nodes }, ctx);
    const reparsed = parseInline(rendered, pc);
    return sigEqual(
        inlineSig(nodes, ctx.links ?? null),
        inlineSig(reparsed, ctx.links ?? null),
    );
}
