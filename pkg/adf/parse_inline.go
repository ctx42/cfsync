// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"sort"
	"strings"
)

// parseInline is the inverse of the inline render: it turns one logical inline
// run of Markdown (no hard breaks, no soft wrapping) back into ADF inline
// nodes. It handles what the renderer emits — plain text, the formatting marks
// strong (**), em (*), code (`) and strike (~~), links [label](href),
// inlineCard autolinks <url>, and the "[[…]]" directives, sugar and generic
// alike (see [inlineParser.parseDirective]) — and nothing else. An inline node
// the renderer emits in a lossy form (an inlineCard rewritten to a link by the
// links map, an unknown node as a comment) does not round-trip through here;
// the caller must gate on [inlineRoundTrips] so such a block is treated as
// read-only rather than silently rewritten.
//
// pc supplies the display-name→account-id map from the page frontmatter, used
// to resolve a bare @[name] mention back to its id.
func parseInline(s string, pc parseCtx) []Node {
	ipr := &inlineParser{s: s, pc: pc}
	return ipr.parseRun("")
}

// parseCtx carries the page-level state a parse needs: the mentions map read
// from the frontmatter, keyed by display name. Its zero value is a valid empty
// context.
type parseCtx struct {
	mentions map[string]string
	links    Links
}

// inlineParser is a single-pass cursor over an inline Markdown run.
type inlineParser struct {
	s   string
	pos int
	pc  parseCtx
}

// parseRun parses inline nodes until it reaches the delimiter stop (which it
// consumes) or the end of input. stop is "" for the top-level run. It
// recognizes the mark, link and mention openers and treats everything else as
// literal text.
func (ipr *inlineParser) parseRun(stop string) []Node {
	var nodes []Node
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			nodes = append(nodes, Node{Type: "text", Text: buf.String()})
			buf.Reset()
		}
	}

	for ipr.pos < len(ipr.s) {
		rest := ipr.s[ipr.pos:]

		// A closing delimiter ends the run, unless it is really the start of a longer
		// delimiter (a "**" seen while closing an em "*").
		if stop != "" && strings.HasPrefix(rest, stop) &&
			!(stop == "*" && strings.HasPrefix(rest, "**")) {
			ipr.pos += len(stop)
			flush()
			return nodes
		}

		switch {
		case rest[0] == '\\':
			// A backslash escapes the next character when that character is one
			// the renderer escapes; otherwise the backslash is literal text.
			if len(rest) >= 2 && isEscapable(rest[1]) {
				buf.WriteByte(rest[1])
				ipr.pos += 2
			} else {
				buf.WriteByte('\\')
				ipr.pos++
			}

		case strings.HasPrefix(rest, "[["):
			if n, ok := ipr.parseDirective(); ok {
				flush()
				nodes = append(nodes, n)
			} else {
				buf.WriteByte('[')
				ipr.pos++
			}

		case strings.HasPrefix(rest, "<u>"):
			flush()
			ipr.pos += len("<u>")
			nodes = append(nodes, applyMark(ipr.parseRun("</u>"), "underline")...)

		case strings.HasPrefix(rest, `<span style="color:`):
			if ns, ok := ipr.parseColorSpan(); ok {
				flush()
				nodes = append(nodes, ns...)
			} else {
				buf.WriteByte('<')
				ipr.pos++
			}

		case rest[0] == '<':
			if n, ok := ipr.parseAutolink(); ok {
				flush()
				nodes = append(nodes, n)
			} else {
				buf.WriteByte('<')
				ipr.pos++
			}

		case strings.HasPrefix(rest, "**"):
			flush()
			nodes = append(nodes, ipr.parseMark("**", "strong")...)

		case strings.HasPrefix(rest, "~~"):
			flush()
			nodes = append(nodes, ipr.parseMark("~~", "strike")...)

		case rest[0] == '`':
			flush()
			nodes = append(nodes, ipr.parseCode())

		case rest[0] == '*':
			flush()
			nodes = append(nodes, ipr.parseMark("*", "em")...)

		case rest[0] == '[':
			if ns, ok := ipr.parseLink(); ok {
				flush()
				nodes = append(nodes, ns...)
			} else {
				buf.WriteByte('[')
				ipr.pos++
			}

		default:
			buf.WriteByte(ipr.s[ipr.pos])
			ipr.pos++
		}
	}
	flush()
	return nodes
}

// parseMark consumes an opening delimiter, parses the run up to the matching
// closing delimiter, and applies the mark to every text node produced.
func (ipr *inlineParser) parseMark(delim, mark string) []Node {
	ipr.pos += len(delim)
	children := ipr.parseRun(delim)
	return applyMark(children, mark)
}

// parseCode consumes a backtick code span and returns a single text node with
// the code mark. Its content is literal: no inner delimiter is interpreted.
func (ipr *inlineParser) parseCode() Node {
	ipr.pos++ // opening backtick
	end := strings.IndexByte(ipr.s[ipr.pos:], '`')
	if end < 0 {
		end = len(ipr.s) - ipr.pos
	}
	text := ipr.s[ipr.pos : ipr.pos+end]
	ipr.pos += end
	if ipr.pos < len(ipr.s) {
		ipr.pos++ // closing backtick
	}
	return Node{Type: "text", Text: text, Marks: []Mark{{Type: "code"}}}
}

// parseLink parses a "[label](href)" link, returning the label's nodes with a
// link mark applied. It reports false when the cursor is not at a well-formed
// link, leaving the cursor untouched so the caller can treat "[" as literal.
func (ipr *inlineParser) parseLink() ([]Node, bool) {
	rest := ipr.s[ipr.pos:]
	mid := strings.Index(rest, "](")
	if mid < 0 {
		return nil, false
	}
	label := rest[1:mid]
	after := rest[mid+2:]
	end := linkHrefEnd(after)
	if end < 0 {
		return nil, false
	}
	href := remoteLink(ipr.pc.links, after[:end])
	nodes := parseInline(label, ipr.pc)
	nodes = applyLink(nodes, href)
	ipr.pos += mid + 2 + end + 1
	return nodes, true
}

// linkHrefEnd returns the index of the ")" that closes a link destination —
// the one balancing the "(" already consumed after "](" — or -1 when no
// balanced close exists. An inner "(" deepens the nesting and a ")" unwinds it,
// so a destination carrying balanced parentheses (a Confluence anchor such as
// "#Channel-(Data-Channel)-(CH)") is kept whole rather than truncated at its
// first inner ")".
func linkHrefEnd(s string) int {
	depth := 1
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// parseDirective parses a "[[…]]" inline directive (see
// dev/inline-directives.md) and rebuilds the ADF node. It reports false,
// leaving the cursor where it was, when the cursor is not at a well-formed
// directive, so the caller keeps the "[" as literal text. The first character
// after "[[" dispatches the kind: a
// sigil "@" (mention), "!" (status), "#" (date) or ":" (emoji), or the generic
// "*type:" for any other node type. A "[[" not followed by one of these — an
// ordinary "[[wiki link]]" or the "[[TOC]]" marker — is not a directive.
func (ipr *inlineParser) parseDirective() (Node, bool) {
	i := ipr.pos + 2 // past "[["
	if i >= len(ipr.s) {
		return Node{}, false
	}
	var typ string
	switch ipr.s[i] {
	case '@':
		typ, i = "mention", i+1
	case '!':
		typ, i = "status", i+1
	case '#':
		typ, i = "date", i+1
	case ':':
		typ, i = "emoji", i+1
	case '*':
		i++
		j := i
		for j < len(ipr.s) && isAlnum(ipr.s[j]) {
			j++
		}
		if j == i || j >= len(ipr.s) || ipr.s[j] != ':' || !isLetter(ipr.s[i]) {
			return Node{}, false
		}
		typ, i = ipr.s[i:j], j+1
	default:
		return Node{}, false
	}

	content, attrs, end, ok := scanDirectiveTail(ipr.s, i)
	if !ok {
		return Node{}, false
	}
	node, ok := buildDirective(typ, content, attrs, ipr.pc)
	if !ok {
		return Node{}, false
	}
	ipr.pos = end
	return node, true
}

// scanDirectiveTail reads a directive's "content" and optional "|attrs" tail
// starting at index i, up to the closing "]]". It unescapes "\\", "\|" and "\]"
// in the content and returns the content, the parsed attributes (nil when no
// "|" is present), the index just past the "]]", and whether the tail was
// well-formed.
func scanDirectiveTail(s string, i int) (string, map[string]string, int, bool) {
	var b strings.Builder
	for i < len(s) {
		switch c := s[i]; {
		case c == '\\' && i+1 < len(s):
			b.WriteByte(s[i+1])
			i += 2
		case c == ']' && i+1 < len(s) && s[i+1] == ']':
			return b.String(), nil, i + 2, true
		case c == '|':
			attrs, end, ok := scanDirectiveAttrs(s, i+1)
			if !ok {
				return "", nil, 0, false
			}
			return b.String(), attrs, end, true
		default:
			b.WriteByte(c)
			i++
		}
	}
	return "", nil, 0, false // no closing "]]"
}

// scanDirectiveAttrs reads a directive's attribute list starting at index i: a
// ";"-separated run of key=value pairs terminated by "]]". It returns the
// parsed attributes, the index just past the "]]", and whether the list was
// well-formed.
func scanDirectiveAttrs(s string, i int) (map[string]string, int, bool) {
	attrs := map[string]string{}
	for i < len(s) {
		if s[i] == ']' && i+1 < len(s) && s[i+1] == ']' {
			return attrs, i + 2, true
		}
		ks := i
		for i < len(s) && (isAlnum(s[i]) || s[i] == '-' || s[i] == '_') {
			i++
		}
		if i == ks || i >= len(s) || s[i] != '=' {
			return nil, 0, false
		}
		key := s[ks:i]
		val, end, ok := scanDirectiveValue(s, i+1)
		if !ok {
			return nil, 0, false
		}
		attrs[key] = val
		i = end
		switch {
		case i+1 < len(s) && s[i] == ']' && s[i+1] == ']':
			return attrs, i + 2, true
		case i < len(s) && s[i] == ';':
			i++
		default:
			return nil, 0, false
		}
	}
	return nil, 0, false // no closing "]]"
}

// scanDirectiveValue reads one attribute value at index i: a double-quoted
// string (unescaping '\"' and '\\') or a bare run up to the next ";" or the
// closing "]]". It returns the value, the index after it, and whether it was
// well-formed.
func scanDirectiveValue(s string, i int) (string, int, bool) {
	if i < len(s) && s[i] == '"' {
		var b strings.Builder
		for i++; i < len(s); {
			switch c := s[i]; {
			case c == '\\' && i+1 < len(s):
				b.WriteByte(s[i+1])
				i += 2
			case c == '"':
				return b.String(), i + 1, true
			default:
				b.WriteByte(c)
				i++
			}
		}
		return "", 0, false // unterminated quote
	}
	vs := i
	for i < len(s) {
		if s[i] == ';' || (s[i] == ']' && i+1 < len(s) && s[i+1] == ']') {
			break
		}
		i++
	}
	if i == vs {
		return "", 0, false // empty bare value
	}
	return s[vs:i], i, true
}

// buildDirective reconstructs an inline ADF node from a parsed directive. Each
// case mirrors [directiveParts] and [Node.renderMention] so the render→parse
// round trip is exact. localId is intentionally not synthesized: inline leaves
// are not round-trip anchors. pc resolves a bare mention name to its account
// id.
func buildDirective(
	typ, content string,
	attrs map[string]string,
	pc parseCtx,
) (Node, bool) {
	switch typ {
	case "mention":
		// An id carried inline wins; otherwise resolve the name through the
		// frontmatter map. An unresolved name degrades to plain text, which
		// will not round-trip and so leaves the block read-only rather than
		// linking the wrong account.
		id := attrs["id"]
		if id == "" {
			id = pc.mentions[content]
		}
		if id == "" {
			return Node{Type: "text", Text: "@" + content}, true
		}
		return Node{
			Type:  "mention",
			Attrs: map[string]any{"id": id, "text": "@" + content},
		}, true

	case "status":
		color := attrs["color"]
		if color == "" {
			color = "neutral"
		}
		a := map[string]any{"text": content, "color": color}
		if style := attrs["style"]; style != "" && style != "default" {
			a["style"] = style
		}
		return Node{Type: "status", Attrs: a}, true

	case "date":
		// The ts attribute is authoritative; the content day is cosmetic.
		return Node{Type: "date",
			Attrs: map[string]any{"timestamp": attrs["ts"]}}, true

	case "emoji":
		// The content is the shortName body; rewrap it in colons. The id rides
		// along when present. The glyph is not carried (see [directiveParts]).
		a := map[string]any{}
		if content != "" {
			a["shortName"] = ":" + content + ":"
		}
		if id := attrs["id"]; id != "" {
			a["id"] = id
		}
		node := Node{Type: "emoji"}
		if len(a) > 0 {
			node.Attrs = a
		}
		return node, true

	default:
		// Any other inline node: content is the text attr, the rest ride as
		// string attrs. localId is not synthesized (inline leaves are not
		// anchors); it round-trips only when the render carried it, which it
		// does not.
		a := map[string]any{}
		if content != "" {
			a["text"] = content
		}
		for k, v := range attrs {
			a[k] = v
		}
		node := Node{Type: typ}
		if len(a) > 0 {
			node.Attrs = a
		}
		return node, true
	}
}

// isAlnum reports whether b is an ASCII letter or digit.
func isAlnum(b byte) bool {
	return isLetter(b) || b >= '0' && b <= '9'
}

// isLetter reports whether b is an ASCII letter. A directive type name must
// begin with one, which keeps a numeric colon run (a clock "12:30") from being
// read as a directive.
func isLetter(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

// isEscapable reports whether c is a character the renderer backslash-escapes
// (see escapeInline), and which a leading backslash therefore restores to
// literal text on parse.
func isEscapable(c byte) bool {
	switch c {
	case '\\', '`', '*', '~', '[', '<':
		return true
	}
	return false
}

// parseAutolink parses a CommonMark autolink "<url>" into an inlineCard node,
// the inverse of [Node.renderInlineCard]. It reports false, leaving the cursor
// untouched, when the cursor is not at a "<...>" whose contents look like an
// absolute URL, so an HTML "<br>" or a stray "<" stays literal text.
func (ipr *inlineParser) parseAutolink() (Node, bool) {
	rest := ipr.s[ipr.pos:]
	end := strings.IndexByte(rest, '>')
	if end < 0 {
		return Node{}, false
	}
	url := rest[1:end]
	if url == "" || strings.ContainsAny(url, " \t") ||
		!strings.Contains(url, "://") {
		return Node{}, false
	}
	ipr.pos += end + 1
	return Node{Type: "inlineCard", Attrs: map[string]any{"url": url}}, true
}

// parseColorSpan parses a textColor span '<span style="color:COLOR">…</span>'
// into its content with a textColor mark carrying COLOR, the inverse of the
// [markOpen] textColor delimiter. It reports false, leaving the cursor
// untouched, when the opener is not well-formed — no closing '">', or a color
// containing a quote or angle bracket — so a stray "<span" stays literal text.
func (ipr *inlineParser) parseColorSpan() ([]Node, bool) {
	const open = `<span style="color:`
	rest := ipr.s[ipr.pos:]
	after := rest[len(open):]
	end := strings.Index(after, `">`)
	if end <= 0 || strings.ContainsAny(after[:end], `"<>`) {
		return nil, false
	}
	color := after[:end]
	ipr.pos += len(open) + end + len(`">`)
	children := ipr.parseRun("</span>")
	return applyColorMark(children, color), true
}

// applyColorMark adds a textColor mark with the color to every text node in
// nodes, the inline counterpart of [applyMark] for a mark that carries an
// attribute.
func applyColorMark(nodes []Node, color string) []Node {
	for i := range nodes {
		if nodes[i].Type == "text" {
			nodes[i].Marks = append(nodes[i].Marks,
				Mark{Type: "textColor", Attrs: map[string]any{"color": color}})
		}
	}
	return nodes
}

// applyMark adds the mark to every text node in nodes, in place. Marks apply to
// text leaves only; a mention or other atom is left untouched.
func applyMark(nodes []Node, mark string) []Node {
	for i := range nodes {
		if nodes[i].Type == "text" {
			nodes[i].Marks = append(nodes[i].Marks, Mark{Type: mark})
		}
	}
	return nodes
}

// applyLink adds a link mark with the href to every text node in nodes.
func applyLink(nodes []Node, href string) []Node {
	for i := range nodes {
		if nodes[i].Type == "text" {
			nodes[i].Marks = append(nodes[i].Marks,
				Mark{Type: "link", Attrs: map[string]any{"href": href}})
		}
	}
	return nodes
}

// inlineTok is one element of an inline signature: a canonical, node-splitting-
// insensitive description of an inline node, used to compare two inline runs
// for equality without depending on how text happens to be chunked into nodes.
type inlineTok struct {
	kind  string // "text", "mention", or "other"
	text  string
	marks string // sorted formatting-mark types, comma-joined
	href  string // link href for a text token
	id    string // account id for a mention token
	typ   string // node type for an "other" token
}

// inlineSig reduces an inline run to its signature: adjacent text nodes that
// share the same marks and link are merged, so "ab" and "a"+"b" compare equal.
// A directive node (see [rendersAsDirective]) becomes a token carrying its full
// rendered directive, so two directives compare equal only when every
// round-tripped attribute matches — that is how the self-check confirms a
// status keeps its color and style, and an emoji its shortName. Any node the
// parser still cannot reproduce (a hardBreak, a node with a non-string attr)
// becomes an "other" token carrying its type, which is how the self-check
// detects a lossy block.
//
// A link href is keyed by its local target (via links), not its raw Confluence
// URL, because [Links.ToLocal] is intentionally many-to-one — it drops the site
// host and title slug — so ToRemote(ToLocal(href)) need not equal href. Keying
// by the local target lets a link whose stored URL and reconstructed URL denote
// the same page count as round-tripping, rather than freezing every block that
// holds a cross-page link.
func inlineSig(nodes []Node, links Links) []inlineTok {
	var sig []inlineTok
	for _, nod := range nodes {
		switch {
		case nod.Type == "text":
			href, _ := nod.linkHref()
			href = localLink(links, href)
			tok := inlineTok{
				kind:  "text",
				text:  nod.Text,
				marks: markSig(nod),
				href:  href,
			}
			if n := len(sig); n > 0 && sig[n-1].kind == "text" &&
				sig[n-1].marks == tok.marks && sig[n-1].href == tok.href {
				sig[n-1].text += tok.text
			} else {
				sig = append(sig, tok)
			}
		case nod.Type == "mention":
			sig = append(sig, inlineTok{kind: "mention", id: nod.attrStr("id")})
		case nod.Type == "inlineCard":
			sig = append(sig, inlineTok{kind: "card", href: nod.attrStr("url")})
		case rendersAsDirective(nod):
			sig = append(sig,
				inlineTok{kind: "directive", text: nod.renderDirective()})
		default:
			sig = append(sig, inlineTok{kind: "other", typ: nod.Type})
		}
	}
	return sig
}

// markSig returns a node's mark delimiter codes (see [markCode]) except link
// (compared separately via the href) and indentation (expressed by the
// paragraph's "N>" marker, not by the inline text), sorted and comma-joined, so
// two nodes with the same marks in any order compare equal. A textColor rides
// with its color, so recoloring is detected. It still includes marks the
// renderer emits no delimiter for — the node-level layout marks alignment and
// breakout — on purpose: their presence makes the signature differ from a
// reparse (which cannot recover them), so a block carrying one is judged not
// round-trippable and stays read-only rather than silently losing the mark on
// edit.
func markSig(nod Node) string {
	types := make([]string, 0, len(nod.Marks))
	for _, m := range nod.Marks {
		if m.Type == "link" || m.Type == "indentation" {
			continue
		}
		types = append(types, markCode(m))
	}
	sort.Strings(types)
	return strings.Join(types, ",")
}

// sigEqual reports whether two inline signatures are identical.
func sigEqual(a, b []inlineTok) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// inlineRoundTrips reports whether an inline run survives a render→parse round
// trip unchanged: its signature equals the signature of parsing its own render.
// A run for which this holds may be safely reparsed on push; one for which it
// fails contains something the Markdown cannot express losslessly and must be
// treated as read-only. The run must be a single logical segment (no
// hardBreak); callers split on hard breaks first.
func inlineRoundTrips(nodes []Node, ctx mdCtx, pc parseCtx) bool {
	rendered := Node{Type: "paragraph", Content: nodes}.inlineString(ctx)
	reparsed := parseInline(rendered, pc)
	return sigEqual(
		inlineSig(nodes, ctx.links),
		inlineSig(reparsed, ctx.links))
}
