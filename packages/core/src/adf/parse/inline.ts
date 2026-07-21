// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Inline parser, ported from `pkg/adf/parse_inline.go`. It is the inverse of the
// inline render: it turns one logical inline run of Markdown (no hard breaks, no
// soft wrapping) back into ADF inline nodes. It handles what the renderer emits
// — plain text, the marks strong/em/code/strike/underline/textColor, links,
// inlineCard autolinks, and the `adf:` directive spans (sugar and generic).
//
// Only the directive carrier differs from the reference: a directive is an
// `adf:` inline code span (backtick-terminated) rather than `[[…]]`, so a bare
// `[[wiki link]]` or `[[TOC]]` is inert text here. The escaping is unchanged; a
// literal backtick is always escaped in text, which keeps prose from forming an
// `adf:` span by accident.

import type { Mark, Node } from "../../models/adf.ts";
import { type Links, remoteLink } from "../links.ts";

/**
 * ParseCtx carries the page-level state a parse needs: the mentions map read
 * from the frontmatter (keyed by display name) and the link resolver. Its empty
 * value (`{}`) is a valid context.
 */
export interface ParseCtx {
    mentions?: Record<string, string>;
    links?: Links | null;
}

/** The `adf:` directive-span opener: an inline code span whose body starts `adf:`. */
const DIRECTIVE_OPEN = "`adf:";

/**
 * parseInline turns one logical inline run of Markdown back into ADF inline
 * nodes. `pc` supplies the display-name→account-id map used to resolve a bare
 * `@name` mention back to its id.
 */
export function parseInline(s: string, pc: ParseCtx): Node[] {
    return new InlineParser(s, pc).parseRun("");
}

/** InlineParser is a single-pass cursor over an inline Markdown run. */
class InlineParser {
    private pos = 0;

    constructor(
        private readonly s: string,
        private readonly pc: ParseCtx,
    ) {}

    /**
     * parseRun parses inline nodes until it reaches the delimiter `stop` (which
     * it consumes) or the end of input. `stop` is `""` for the top-level run.
     */
    parseRun(stop: string): Node[] {
        const nodes: Node[] = [];
        let buf = "";
        const flush = (): void => {
            if (buf.length > 0) {
                nodes.push({ type: "text", text: buf });
                buf = "";
            }
        };

        while (this.pos < this.s.length) {
            const rest = this.s.slice(this.pos);

            // A closing delimiter ends the run, unless it is really the start of
            // a longer delimiter (a `**` seen while closing an em `*`).
            if (
                stop !== "" &&
                rest.startsWith(stop) &&
                !(stop === "*" && rest.startsWith("**"))
            ) {
                this.pos += stop.length;
                flush();
                return nodes;
            }

            const c = rest.charAt(0);
            if (c === "\\") {
                // A backslash escapes the next character when the renderer would
                // escape it; otherwise the backslash is literal text.
                if (rest.length >= 2 && isEscapable(rest.charAt(1))) {
                    buf += rest.charAt(1);
                    this.pos += 2;
                } else {
                    buf += "\\";
                    this.pos++;
                }
            } else if (rest.startsWith("<u>")) {
                flush();
                this.pos += "<u>".length;
                nodes.push(...applyMark(this.parseRun("</u>"), "underline"));
            } else if (rest.startsWith('<span style="color:')) {
                const ns = this.parseColorSpan();
                if (ns !== null) {
                    flush();
                    nodes.push(...ns);
                } else {
                    buf += "<";
                    this.pos++;
                }
            } else if (c === "<") {
                const n = this.parseAutolink();
                if (n !== null) {
                    flush();
                    nodes.push(n);
                } else {
                    buf += "<";
                    this.pos++;
                }
            } else if (rest.startsWith("**")) {
                flush();
                nodes.push(...this.parseMark("**", "strong"));
            } else if (rest.startsWith("~~")) {
                flush();
                nodes.push(...this.parseMark("~~", "strike"));
            } else if (c === "`") {
                flush();
                const n = rest.startsWith(DIRECTIVE_OPEN)
                    ? this.parseDirective()
                    : null;
                nodes.push(n ?? this.parseCode());
            } else if (c === "*") {
                flush();
                nodes.push(...this.parseMark("*", "em"));
            } else if (c === "[") {
                const ns = this.parseLink();
                if (ns !== null) {
                    flush();
                    nodes.push(...ns);
                } else {
                    buf += "[";
                    this.pos++;
                }
            } else {
                buf += c;
                this.pos++;
            }
        }
        flush();
        return nodes;
    }

    /**
     * parseMark consumes an opening delimiter, parses the run up to the matching
     * closing delimiter, and applies the mark to every text node produced.
     */
    private parseMark(delim: string, mark: string): Node[] {
        this.pos += delim.length;
        return applyMark(this.parseRun(delim), mark);
    }

    /**
     * parseCode consumes a backtick code span with a variable-length fence and
     * returns a single text node with the code mark. Its content is literal (no
     * inner delimiter is interpreted): the span closes at the next backtick run
     * whose length equals the opening fence, so a code span may itself contain
     * shorter backtick runs. A single leading and trailing space is stripped when
     * the content both begins and ends with one and is not all spaces, the
     * inverse of the render's fence padding (CommonMark code-span normalization).
     */
    private parseCode(): Node {
        let n = 0;
        while (
            this.pos + n < this.s.length &&
            this.s.charAt(this.pos + n) === "`"
        ) {
            n++;
        }
        const end = codeFenceEnd(this.s, this.pos);
        if (end === null) {
            // Unterminated fence: the backticks open a span running to the end of
            // input, matching the render's always-closed span on a reparse.
            const text = this.s.slice(this.pos + n);
            this.pos = this.s.length;
            return { type: "text", text, marks: [{ type: "code" }] };
        }
        let text = this.s.slice(this.pos + n, end - n);
        if (
            text.length >= 2 &&
            text.startsWith(" ") &&
            text.endsWith(" ") &&
            text.trim() !== ""
        ) {
            text = text.slice(1, -1);
        }
        this.pos = end;
        return { type: "text", text, marks: [{ type: "code" }] };
    }

    /**
     * parseLink parses a `[label](href)` link, returning the label's nodes with
     * a link mark applied, or null (cursor untouched) when the cursor is not at a
     * well-formed link. The label close and the destination are found by
     * {@link scanLink}, so a label carrying `](` or a `]` inside a code span does
     * not mis-split it, and a destination in either the bare or `<…>` form is
     * accepted.
     */
    private parseLink(): Node[] | null {
        const parts = scanLink(this.s, this.pos);
        if (parts === null) {
            return null;
        }
        const href = remoteLink(this.pc.links ?? null, parts.href);
        const nodes = applyLink(parseInline(parts.label, this.pc), href);
        this.pos = parts.end;
        return nodes;
    }

    /**
     * parseDirective parses an `adf:` directive span and rebuilds the ADF node,
     * or returns null (cursor untouched) when the span is not a well-formed
     * directive, so the caller can treat the backtick as a plain code span. The
     * character after `adf:` dispatches the kind: a sigil `@`/`!`/`#`/`:` or the
     * generic `*type:`.
     */
    private parseDirective(): Node | null {
        let i = this.pos + DIRECTIVE_OPEN.length; // past "`adf:"
        if (i >= this.s.length) {
            return null;
        }
        let typ: string;
        switch (this.s.charAt(i)) {
            case "@":
                typ = "mention";
                i++;
                break;
            case "!":
                typ = "status";
                i++;
                break;
            case "#":
                typ = "date";
                i++;
                break;
            case ":":
                typ = "emoji";
                i++;
                break;
            case "*": {
                i++;
                const j = i;
                while (i < this.s.length && isAlnum(this.s.charAt(i))) {
                    i++;
                }
                if (
                    j === i ||
                    i >= this.s.length ||
                    this.s.charAt(i) !== ":" ||
                    !isLetter(this.s.charAt(j))
                ) {
                    return null;
                }
                typ = this.s.slice(j, i);
                i++;
                break;
            }
            default:
                return null;
        }

        const tail = scanDirectiveTail(this.s, i);
        if (tail === null) {
            return null;
        }
        this.pos = tail.end;
        return buildDirective(typ, tail.content, tail.attrs, this.pc);
    }

    /**
     * parseAutolink parses a CommonMark autolink `<url>` into an inlineCard node,
     * or null (cursor untouched) when the contents do not look like an absolute
     * URL, so an HTML `<br>` or a stray `<` stays literal text.
     */
    private parseAutolink(): Node | null {
        const rest = this.s.slice(this.pos);
        const end = rest.indexOf(">");
        if (end < 0) {
            return null;
        }
        const url = rest.slice(1, end);
        if (url === "" || /[ \t]/.test(url) || !url.includes("://")) {
            return null;
        }
        this.pos += end + 1;
        return { type: "inlineCard", attrs: { url } };
    }

    /**
     * parseColorSpan parses a textColor span `<span style="color:COLOR">…</span>`
     * into its content with a textColor mark, or null (cursor untouched) when the
     * opener is malformed, so a stray `<span` stays literal text.
     */
    private parseColorSpan(): Node[] | null {
        const open = '<span style="color:';
        const after = this.s.slice(this.pos + open.length);
        const end = after.indexOf('">');
        if (end <= 0 || /["<>]/.test(after.slice(0, end))) {
            return null;
        }
        const color = after.slice(0, end);
        this.pos += open.length + end + '">'.length;
        return applyColorMark(this.parseRun("</span>"), color);
    }
}

/** The parsed tail of a directive: its content, optional attributes, and end index. */
interface DirectiveTail {
    content: string;
    attrs: Record<string, string> | undefined;
    end: number;
}

/**
 * scanDirectiveTail reads a directive's content and optional `|attrs` tail
 * starting at index i, up to the closing backtick. It unescapes `\\`, `` \` ``
 * and `\|` in the content. Returns null when the tail is not well-formed.
 */
function scanDirectiveTail(s: string, start: number): DirectiveTail | null {
    let i = start;
    let b = "";
    while (i < s.length) {
        const c = s.charAt(i);
        if (c === "\\" && i + 1 < s.length) {
            b += s.charAt(i + 1);
            i += 2;
        } else if (c === "`") {
            return { content: b, attrs: undefined, end: i + 1 };
        } else if (c === "|") {
            const a = scanDirectiveAttrs(s, i + 1);
            if (a === null) {
                return null;
            }
            return { content: b, attrs: a.attrs, end: a.end };
        } else {
            b += c;
            i++;
        }
    }
    return null; // no closing backtick
}

/**
 * scanDirectiveAttrs reads a directive's attribute list starting at index i: a
 * `;`-separated run of key=value pairs terminated by the closing backtick.
 */
function scanDirectiveAttrs(
    s: string,
    start: number,
): { attrs: Record<string, string>; end: number } | null {
    let i = start;
    const attrs: Record<string, string> = {};
    while (i < s.length) {
        if (s.charAt(i) === "`") {
            return { attrs, end: i + 1 };
        }
        let key: string;
        if (s.charAt(i) === '"') {
            // A quoted key (it held a separator the render had to quote); the
            // quoted-string scan is shared with the value grammar.
            const k = scanDirectiveValue(s, i);
            if (k === null) {
                return null;
            }
            key = k.val;
            i = k.end;
        } else {
            const ks = i;
            while (i < s.length && isAttrKeyChar(s.charAt(i))) {
                i++;
            }
            if (i === ks) {
                return null;
            }
            key = s.slice(ks, i);
        }
        if (i >= s.length || s.charAt(i) !== "=") {
            return null;
        }
        const v = scanDirectiveValue(s, i + 1);
        if (v === null) {
            return null;
        }
        attrs[key] = v.val;
        i = v.end;
        if (s.charAt(i) === "`") {
            return { attrs, end: i + 1 };
        }
        if (s.charAt(i) === ";") {
            i++;
        } else {
            return null;
        }
    }
    return null; // no closing backtick
}

/**
 * scanDirectiveValue reads one attribute value at index i: a double-quoted
 * string (unescaping `\"` and `\\`) or a bare run up to the next `;` or the
 * closing backtick.
 */
function scanDirectiveValue(
    s: string,
    start: number,
): { val: string; end: number } | null {
    let i = start;
    if (i < s.length && s.charAt(i) === '"') {
        let b = "";
        i++;
        while (i < s.length) {
            const c = s.charAt(i);
            if (c === "\\" && i + 1 < s.length) {
                b += s.charAt(i + 1);
                i += 2;
            } else if (c === '"') {
                return { val: b, end: i + 1 };
            } else {
                b += c;
                i++;
            }
        }
        return null; // unterminated quote
    }
    const vs = i;
    while (i < s.length && s.charAt(i) !== ";" && s.charAt(i) !== "`") {
        i++;
    }
    if (i === vs) {
        return null; // empty bare value
    }
    return { val: s.slice(vs, i), end: i };
}

/**
 * buildDirective reconstructs an inline ADF node from a parsed directive. Each
 * case mirrors the render (`directiveParts` / `renderMention`) so the
 * render→parse round trip is exact. localId is not synthesized: inline leaves
 * are not round-trip anchors. `pc` resolves a bare mention name to its id.
 */
function buildDirective(
    typ: string,
    content: string,
    attrs: Record<string, string> | undefined,
    pc: ParseCtx,
): Node {
    const at = attrs ?? {};
    switch (typ) {
        case "mention": {
            // An id carried inline wins; otherwise resolve through the map. An
            // unresolved name degrades to plain text, which will not round-trip
            // and so leaves the block read-only rather than linking the wrong
            // account.
            let id = at["id"] ?? "";
            if (id === "") {
                id = pc.mentions?.[content] ?? "";
            }
            if (id === "") {
                return { type: "text", text: `@${content}` };
            }
            return { type: "mention", attrs: { id, text: `@${content}` } };
        }
        case "status": {
            let color = at["color"] ?? "";
            if (color === "") {
                color = "neutral";
            }
            const a: Record<string, unknown> = { text: content, color };
            const style = at["style"] ?? "";
            if (style !== "" && style !== "default") {
                a["style"] = style;
            }
            return { type: "status", attrs: a };
        }
        case "date":
            // The ts attribute is authoritative; the content day is cosmetic.
            return { type: "date", attrs: { timestamp: at["ts"] ?? "" } };
        case "emoji": {
            // The content is the shortName body; rewrap it in colons. The id
            // rides along when present. The glyph is not carried.
            const a: Record<string, unknown> = {};
            if (content !== "") {
                a["shortName"] = `:${content}:`;
            }
            const id = at["id"] ?? "";
            if (id !== "") {
                a["id"] = id;
            }
            return emojiNode(a);
        }
        default: {
            // Any other inline node: content is the text attr, the rest ride as
            // string attrs. localId is not synthesized (inline leaves are not
            // anchors); it round-trips only when the render carried it.
            const a: Record<string, unknown> = {};
            if (content !== "") {
                a["text"] = content;
            }
            for (const [k, v] of Object.entries(at)) {
                a[k] = v;
            }
            return Object.keys(a).length > 0
                ? { type: typ, attrs: a }
                : { type: typ };
        }
    }
}

/** emojiNode builds an emoji node, omitting the attrs object when it is empty. */
function emojiNode(a: Record<string, unknown>): Node {
    return Object.keys(a).length > 0
        ? { type: "emoji", attrs: a }
        : { type: "emoji" };
}

/**
 * codeFenceEnd, given that s[start] opens a backtick code span, returns the
 * index just past the span's closing fence, or null when the opening backticks
 * have no matching close (they are then literal text). The fence length is the
 * run of backticks at start, and the span closes at the next backtick run of
 * exactly that length; a shorter or longer run is content. Backslashes are not
 * special inside a code span, so none is skipped. Shared with the render (kept
 * whole across a soft-wrap) and the block normalizer (internal whitespace kept
 * significant).
 */
export function codeFenceEnd(s: string, start: number): number | null {
    let n = 0;
    while (start + n < s.length && s.charAt(start + n) === "`") {
        n++;
    }
    if (n === 0) {
        return null;
    }
    let i = start + n;
    while (i < s.length) {
        if (s.charAt(i) === "`") {
            let k = i;
            while (k < s.length && s.charAt(k) === "`") {
                k++;
            }
            if (k - i === n) {
                return k;
            }
            i = k;
        } else {
            i++;
        }
    }
    return null;
}

/**
 * LinkParts is a parsed `[label](href)` link: the raw label substring (still
 * escaped, for the caller to parse as its own inline run), the decoded
 * destination, and the index just past the closing `)`.
 */
export interface LinkParts {
    label: string;
    href: string;
    end: number;
}

/**
 * scanLink, given that s[start] is `[`, returns the link's parts when a
 * well-formed `[label](dest)` begins there, else null (the `[` is then literal
 * text). The label close is the first unescaped `]` that is not inside a code
 * span, so neither a `]` in an escaped bracket nor one inside an inline code
 * span ends the label early — the fix for a label carrying `](`. The
 * destination is read in the bare balanced-parenthesis form or the `<…>` angle
 * form, matching {@link encodeHref}: the angle form unescapes `\<`, `\>` and
 * `\\`, so a destination with a space or an unbalanced paren round-trips. Shared
 * with the render and the block normalizer so all three agree on a link's extent.
 */
export function scanLink(s: string, start: number): LinkParts | null {
    let i = start + 1;
    while (i < s.length) {
        const c = s.charAt(i);
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === "`") {
            const ce = codeFenceEnd(s, i);
            if (ce !== null) {
                i = ce;
                continue;
            }
            i++;
            continue;
        }
        if (c === "]") {
            break;
        }
        i++;
    }
    if (i >= s.length || s.charAt(i) !== "]" || s.charAt(i + 1) !== "(") {
        return null;
    }
    const label = s.slice(start + 1, i);
    let j = i + 2;
    if (s.charAt(j) === "<") {
        j++;
        let href = "";
        while (j < s.length) {
            const c = s.charAt(j);
            if (c === "\\" && j + 1 < s.length) {
                href += s.charAt(j + 1);
                j += 2;
                continue;
            }
            if (c === ">") {
                break;
            }
            if (c === "\n") {
                return null;
            }
            href += c;
            j++;
        }
        if (s.charAt(j) !== ">" || s.charAt(j + 1) !== ")") {
            return null;
        }
        return { label, href, end: j + 2 };
    }
    // Bare form: a balanced-parenthesis destination. The render only chooses this
    // form for a destination free of whitespace, angle brackets and backslashes,
    // so no unescaping is needed here.
    let depth = 1;
    let href = "";
    while (j < s.length) {
        const c = s.charAt(j);
        if (c === "(") {
            depth++;
        } else if (c === ")") {
            depth--;
            if (depth === 0) {
                return { label, href, end: j + 1 };
            }
        }
        href += c;
        j++;
    }
    return null;
}

/** isAlnum reports whether c is a single ASCII letter or digit. */
function isAlnum(c: string): boolean {
    return isLetter(c) || (c >= "0" && c <= "9" && c.length === 1);
}

/** isLetter reports whether c is a single ASCII letter. */
function isLetter(c: string): boolean {
    return c.length === 1 && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
}

/** isAttrKeyChar reports whether c may appear in a directive attribute key. */
function isAttrKeyChar(c: string): boolean {
    return isAlnum(c) || c === "-" || c === "_";
}

/**
 * isEscapable reports whether c is a character the renderer backslash-escapes
 * (see escapeInline), and which a leading backslash therefore restores to
 * literal text on parse.
 */
function isEscapable(c: string): boolean {
    return (
        c === "\\" ||
        c === "`" ||
        c === "*" ||
        c === "~" ||
        c === "[" ||
        c === "]" ||
        c === "<"
    );
}

/** addMark appends a mark to a text node, creating its marks array if needed. */
function addMark(n: Node, mark: Mark): void {
    if (n.marks === undefined) {
        n.marks = [];
    }
    n.marks.push(mark);
}

/**
 * applyMark adds the mark to every text node in nodes, in place. Marks apply to
 * text leaves only; a mention or other atom is left untouched.
 */
function applyMark(nodes: Node[], mark: string): Node[] {
    for (const n of nodes) {
        if (n.type === "text") {
            addMark(n, { type: mark });
        }
    }
    return nodes;
}

/** applyLink adds a link mark with the href to every text node in nodes. */
function applyLink(nodes: Node[], href: string): Node[] {
    for (const n of nodes) {
        if (n.type === "text") {
            addMark(n, { type: "link", attrs: { href } });
        }
    }
    return nodes;
}

/** applyColorMark adds a textColor mark with the color to every text node in nodes. */
function applyColorMark(nodes: Node[], color: string): Node[] {
    for (const n of nodes) {
        if (n.type === "text") {
            addMark(n, { type: "textColor", attrs: { color } });
        }
    }
    return nodes;
}
