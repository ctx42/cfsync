// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Inline escaping, ported from the escape helpers of `pkg/adf/markdown.go`.
// Two groups live here: the inline-text escaper (escapeInline / escapeAt and the
// startsX opener probes), which mirrors the inline parser's opener checks so a
// character is escaped precisely when leaving it raw would begin a construct;
// and the directive escapers (escapeDirectiveContent / quoteDirectiveValue /
// escapeLinkLabel) for the `adf:` code-span carrier. The directive escapers
// already target the Obsidian carrier (backtick terminator); escapeInline still
// tracks the Go `[`/`[[` opener set until the inline parser lands in M3.1.

/** containsAny reports whether s contains any of the characters in chars. */
function containsAny(s: string, chars: string): boolean {
    for (const c of chars) {
        if (s.includes(c)) {
            return true;
        }
    }
    return false;
}

/**
 * escapeInline backslash-escapes the characters in a text node's content that
 * the inline parser would otherwise read as markup, so the text re-parses
 * literally. The escaping is contextual and minimal: `*`, a backtick, and a
 * backslash itself are always escaped, while `~`, `[` and `<` are escaped only
 * where they would actually begin a construct — a `~~` run, a `[label](url)`
 * link, a `[[@…]]` directive or a `<url>` autolink. Ordinary punctuation (a
 * lone tilde, a non-link bracket, a stray `<`) is left untouched so the Markdown
 * stays clean.
 *
 * With `inLink` set — the text is a link's label — both `[` and `]` are always
 * escaped, since an unescaped bracket would otherwise close the label or open a
 * nested link; the parser unescapes them when it re-parses the label. This is
 * the correct place to protect a bracket in link text: escaping the raw text
 * node (before any mark delimiters wrap it) leaves the surrounding `**`/`` ` ``
 * markup untouched, whereas escaping the already-wrapped label would corrupt it.
 */
export function escapeInline(s: string, inLink = false): string {
    if (!containsAny(s, inLink ? "\\`*~[]<" : "\\`*~[<")) {
        return s;
    }
    let b = "";
    for (let i = 0; i < s.length; i++) {
        if (escapeAt(s, i, inLink)) {
            b += "\\";
        }
        b += s[i];
    }
    return b;
}

/**
 * escapeAt reports whether the character at index i in s must be backslash-
 * escaped. The multi-character triggers mirror the parser's opener checks
 * exactly, so a character is escaped precisely when leaving it raw would start a
 * construct. In a link label (`inLink`), both brackets are always escaped.
 */
function escapeAt(s: string, i: number, inLink: boolean): boolean {
    switch (s[i]) {
        case "\\":
        case "`":
        case "*":
            return true;
        case "~":
            return i + 1 < s.length && s[i + 1] === "~";
        case "[":
            return (
                inLink || startsLink(s.slice(i)) || startsDirective(s.slice(i))
            );
        case "]":
            return inLink;
        case "<":
            return (
                startsAutolink(s.slice(i)) ||
                startsUnderline(s.slice(i)) ||
                startsColorSpan(s.slice(i))
            );
    }
    return false;
}

/**
 * startsUnderline reports whether s begins the `<u>` underline opener, so a
 * literal `<u>` in prose is escaped and stays text rather than opening an
 * underline span.
 */
function startsUnderline(s: string): boolean {
    return s.startsWith("<u>");
}

/**
 * startsColorSpan reports whether s begins a well-formed textColor opener
 * `<span style="color:COLOR">`, so a literal one in prose is escaped exactly
 * when it would otherwise parse.
 */
function startsColorSpan(s: string): boolean {
    const open = `<span style="color:`;
    if (!s.startsWith(open)) {
        return false;
    }
    const after = s.slice(open.length);
    const end = after.indexOf(`">`);
    return end > 0 && !containsAny(after.slice(0, end), `"<>`);
}

/**
 * startsLink reports whether s begins a `[label](url)` link: a `](` followed by
 * a closing `)`.
 */
function startsLink(s: string): boolean {
    const idx = s.indexOf("](");
    if (idx < 0) {
        return false;
    }
    return s.slice(idx + 2).includes(")");
}

/**
 * startsDirective reports whether s begins an inline directive `[[` followed by
 * a dispatch character (a sigil `@`, `!`, `#`, `:` or the generic `*`) and a
 * closing `]]`, so a literal directive-looking span in prose is escaped exactly
 * when it would otherwise parse.
 */
function startsDirective(s: string): boolean {
    if (!s.startsWith("[[") || s.length < 3) {
        return false;
    }
    switch (s[2]) {
        case "@":
        case "!":
        case "#":
        case ":":
        case "*":
            return s.slice(3).includes("]]");
    }
    return false;
}

/** startsAutolink reports whether s begins a `<url>` autolink. */
function startsAutolink(s: string): boolean {
    const end = s.indexOf(">");
    if (end < 0) {
        return false;
    }
    const url = s.slice(1, end);
    return url !== "" && !containsAny(url, " \t") && url.includes("://");
}

/**
 * escapeDirectiveContent escapes the characters that would otherwise end or
 * misparse an `adf:` directive's content: a backslash, the backtick that closes
 * the code-span carrier, and the `|` that begins the attribute list. Go escaped
 * the `]` that could close a `[[…]]` directive early; the carrier's terminator
 * is now the span's closing backtick, so that is what is escaped instead.
 */
export function escapeDirectiveContent(s: string): string {
    return s
        .replaceAll("\\", "\\\\")
        .replaceAll("`", "\\`")
        .replaceAll("|", "\\|");
}

/**
 * quoteDirectiveValue returns an attribute value unchanged when it is a bare
 * token, or double-quoted with `"` and `\` escaped when it is empty or contains
 * a character that would break the attribute grammar: a space, tab, quote, the
 * `;` pair separator, or the backtick that closes the span (Go guarded a `]`).
 */
export function quoteDirectiveValue(s: string): string {
    if (s === "" || containsAny(s, ' \t";`')) {
        const r = s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        return `"${r}"`;
    }
    return s;
}

/**
 * quoteDirectiveKey returns an attribute key unchanged when it is a bare run of
 * key characters (letters, digits, `-`, `_`), or double-quoted (with `"` and `\`
 * escaped) when it is empty or holds any other character — a separator such as
 * `=`, `;` or `|` that would otherwise break the attribute grammar. The parser
 * reads a quoted key with the same scan it uses for a quoted value.
 */
export function quoteDirectiveKey(s: string): string {
    if (s !== "" && /^[A-Za-z0-9_-]+$/.test(s)) {
        return s;
    }
    const r = s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `"${r}"`;
}

/**
 * escapeLinkLabel backslash-escapes the characters that would break a Markdown
 * link label: `\`, `[` and `]`. It is used for a synthetic label, such as a
 * page title spliced in when an inlineCard is rewritten into a link.
 */
export function escapeLinkLabel(s: string): string {
    return s
        .replaceAll("\\", "\\\\")
        .replaceAll("[", "\\[")
        .replaceAll("]", "\\]");
}
