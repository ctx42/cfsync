// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"testing"

	"github.com/ctx42/testing/pkg/assert"
)

func Test_parseInline_tabular(t *testing.T) {
	strong := []Mark{{Type: "strong"}}
	em := []Mark{{Type: "em"}}
	code := []Mark{{Type: "code"}}
	strike := []Mark{{Type: "strike"}}
	link := func(href string) []Mark {
		return []Mark{{Type: "link", Attrs: map[string]any{"href": href}}}
	}

	tt := []struct {
		testN string
		in    string
		pc    parseCtx
		want  []Node
	}{
		{
			"plain text",
			"hello world", parseCtx{},
			[]Node{{Type: "text", Text: "hello world"}},
		},
		{
			"strong",
			"**bold**", parseCtx{},
			[]Node{{Type: "text", Text: "bold", Marks: strong}},
		},
		{
			"em",
			"*it*", parseCtx{},
			[]Node{{Type: "text", Text: "it", Marks: em}},
		},
		{
			"code is literal",
			"`a*b`", parseCtx{},
			[]Node{{Type: "text", Text: "a*b", Marks: code}},
		},
		{
			"strike",
			"~~no~~", parseCtx{},
			[]Node{{Type: "text", Text: "no", Marks: strike}},
		},
		{
			"link",
			"[label](http://x)", parseCtx{},
			[]Node{{Type: "text", Text: "label", Marks: link("http://x")}},
		},
		{
			"text around a mark",
			"a **b** c", parseCtx{},
			[]Node{
				{Type: "text", Text: "a "},
				{Type: "text", Text: "b", Marks: strong},
				{Type: "text", Text: " c"},
			},
		},
		{
			"nested em inside strong",
			"**a *b* c**", parseCtx{},
			[]Node{
				{Type: "text", Text: "a ", Marks: strong},
				{Type: "text", Text: "b", Marks: []Mark{{Type: "em"}, {Type: "strong"}}},
				{Type: "text", Text: " c", Marks: strong},
			},
		},
		{
			"mention resolved from the map",
			"[[@Ann]]", parseCtx{mentions: map[string]string{"Ann": "A"}},
			[]Node{{Type: "mention", Attrs: map[string]any{"id": "A", "text": "@Ann"}}},
		},
		{
			"mention with an inline id",
			"[[@Sam|id=S2]]", parseCtx{},
			[]Node{{Type: "mention", Attrs: map[string]any{"id": "S2", "text": "@Sam"}}},
		},
		{
			"unresolved mention degrades to text",
			"[[@Ghost]]", parseCtx{},
			[]Node{{Type: "text", Text: "@Ghost"}},
		},
		{
			"status directive with color and style",
			"[[!APPROVED|color=green;style=bold]]", parseCtx{},
			[]Node{{Type: "status", Attrs: map[string]any{
				"text": "APPROVED", "color": "green", "style": "bold"}}},
		},
		{
			"status directive defaults a missing color to neutral",
			"[[!TODO]]", parseCtx{},
			[]Node{{Type: "status", Attrs: map[string]any{
				"text": "TODO", "color": "neutral"}}},
		},
		{
			"date directive takes ts as authoritative",
			"[[#2024-07-06|ts=1720224000000]]", parseCtx{},
			[]Node{{Type: "date", Attrs: map[string]any{
				"timestamp": "1720224000000"}}},
		},
		{
			"emoji directive rebuilds shortName and id",
			"[[:smile|id=1f604]]", parseCtx{},
			[]Node{{Type: "emoji", Attrs: map[string]any{
				"shortName": ":smile:", "id": "1f604"}}},
		},
		{
			"a bare colon is literal text",
			"ready at 12:30 sharp", parseCtx{},
			[]Node{{Type: "text", Text: "ready at 12:30 sharp"}},
		},
		{
			"a generic directive builds an unknown node",
			"[[*wibble:x|y=z]]", parseCtx{},
			[]Node{{Type: "wibble", Attrs: map[string]any{
				"text": "x", "y": "z"}}},
		},
		{
			"a sigil-less double bracket stays literal",
			"[[TOC]]", parseCtx{},
			[]Node{{Type: "text", Text: "[[TOC]]"}},
		},
		{
			"an autolink becomes an inlineCard",
			"<https://example.com/x>", parseCtx{},
			[]Node{{Type: "inlineCard",
				Attrs: map[string]any{"url": "https://example.com/x"}}},
		},
		{
			"a non-URL angle span stays literal",
			"a <br> b", parseCtx{},
			[]Node{{Type: "text", Text: "a <br> b"}},
		},
		{
			"an escaped asterisk is literal",
			`2 \* 3`, parseCtx{},
			[]Node{{Type: "text", Text: "2 * 3"}},
		},
		{
			"an escaped bracket defuses a link",
			`\[x](y)`, parseCtx{},
			[]Node{{Type: "text", Text: "[x](y)"}},
		},
		{
			"a doubled backslash is one literal backslash",
			`a \\ b`, parseCtx{},
			[]Node{{Type: "text", Text: `a \ b`}},
		},
		{
			"a backslash before a plain char stays literal",
			`c:\dir`, parseCtx{},
			[]Node{{Type: "text", Text: `c:\dir`}},
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			assert.Equal(t, tc.want, parseInline(tc.in, tc.pc))
		})
	}
}

func Test_inlineRoundTrips(t *testing.T) {
	pc := parseCtx{mentions: map[string]string{"Ann": "A"}}
	ctx := mdCtx{}

	t.Run("supported runs round-trip", func(t *testing.T) {
		corpus := [][]Node{
			{{Type: "text", Text: "just words"}},
			{{Type: "text", Text: "bold", Marks: []Mark{{Type: "strong"}}}},
			{
				{Type: "text", Text: "a "},
				{Type: "text", Text: "b", Marks: []Mark{{Type: "em"}}},
			},
			{{Type: "text", Text: "link",
				Marks: []Mark{{Type: "link", Attrs: map[string]any{"href": "http://x"}}}}},
			{{Type: "mention", Attrs: map[string]any{"id": "A", "text": "@Ann"}}},
			{
				{Type: "text", Text: "see "},
				{Type: "mention", Attrs: map[string]any{"id": "A", "text": "@Ann"}},
				{Type: "text", Text: " now"},
			},
			{
				{Type: "text", Text: "state: "},
				{Type: "status", Attrs: map[string]any{
					"text": "APPROVED", "color": "green", "style": "bold"}},
			},
			{
				{Type: "text", Text: "see "},
				{Type: "inlineCard",
					Attrs: map[string]any{"url": "https://example.com/x"}},
			},
			{
				{Type: "text", Text: "due "},
				{Type: "date", Attrs: map[string]any{"timestamp": "1720224000000"}},
			},
			{
				{Type: "emoji", Attrs: map[string]any{
					"shortName": ":smile:", "id": "1f604", "text": "😄"}},
			},
		}
		for _, nodes := range corpus {
			assert.True(t, inlineRoundTrips(nodes, ctx, pc))
		}
	})

	t.Run("a link href with balanced parens round-trips", func(t *testing.T) {
		// --- Given --- a link whose destination carries balanced parentheses,
		// as a Confluence anchor like "#Channel-(Data-Channel)-(CH)" does; the
		// parser must close the link at the ")" that balances the opening "(",
		// not the first ")" inside the destination.
		nodes := []Node{{Type: "text", Text: "channel", Marks: []Mark{{
			Type:  "link",
			Attrs: map[string]any{"href": "g.md#Channel-(Data-Channel)-(CH)"}}}}}

		// --- Then ---
		assert.True(t, inlineRoundTrips(nodes, ctx, pc))
	})

	t.Run("a link with a normalized remote form round-trips", func(t *testing.T) {
		// --- Given --- a Links whose ToLocal drops the host and title slug (as
		// the real mapper does), so ToRemote(ToLocal(href)) != href. A link whose
		// stored URL and reconstructed URL denote the same page must still count
		// as round-tripping, else editing the block would be frozen.
		lc := mdCtx{links: slugDropLinks{}}
		lp := parseCtx{links: slugDropLinks{}}
		nodes := []Node{{Type: "text", Text: "see", Marks: []Mark{{Type: "link",
			Attrs: map[string]any{
				"href": "https://s/wiki/spaces/X/pages/1/Slug"}}}}}

		// --- Then ---
		assert.True(t, inlineRoundTrips(nodes, lc, lp))
	})

	t.Run("a status keeping its color is not flattened", func(t *testing.T) {
		// --- Given --- a status now round-trips as a directive, but the
		// self-check must still reject a would-be reparse that drops its color:
		// the signature carries the rendered directive, so a color change shows.
		green := []Node{{Type: "status", Attrs: map[string]any{
			"text": "OK", "color": "green"}}}
		red := []Node{{Type: "status", Attrs: map[string]any{
			"text": "OK", "color": "red"}}}

		// --- Then --- each round-trips to itself, and the two differ, so a
		// color swap could never pass unnoticed.
		assert.True(t, inlineRoundTrips(green, ctx, pc))
		assert.False(t, sigEqual(inlineSig(green, nil), inlineSig(red, nil)))
	})

	t.Run("underline and textColor round-trip", func(t *testing.T) {
		// --- Given --- text carrying an underline or a colored span, alone and
		// combined with other marks, all now render+parse losslessly.
		corpus := [][]Node{
			{{Type: "text", Text: "u", Marks: []Mark{{Type: "underline"}}}},
			{{Type: "text", Text: "c", Marks: []Mark{
				{Type: "textColor", Attrs: map[string]any{"color": "#ff0000"}}}}},
			{{Type: "text", Text: "both", Marks: []Mark{
				{Type: "underline"},
				{Type: "strong"},
				{Type: "textColor", Attrs: map[string]any{"color": "#0a0"}}}}},
		}
		for _, nodes := range corpus {
			assert.True(t, inlineRoundTrips(nodes, ctx, pc))
		}
	})

	t.Run("a textColor recolor is not silently flattened", func(t *testing.T) {
		// --- Given --- two spans differing only by color must have different
		// signatures, so an edit that changes the color can never pass unnoticed.
		red := []Node{{Type: "text", Text: "x", Marks: []Mark{
			{Type: "textColor", Attrs: map[string]any{"color": "#f00"}}}}}
		blue := []Node{{Type: "text", Text: "x", Marks: []Mark{
			{Type: "textColor", Attrs: map[string]any{"color": "#00f"}}}}}

		// --- Then ---
		assert.False(t, sigEqual(inlineSig(red, nil), inlineSig(blue, nil)))
	})

	t.Run("a node-level layout mark stays read-only", func(t *testing.T) {
		// --- Given --- alignment and breakout have no inline delimiter, so a run
		// carrying one cannot round-trip and stays read-only.
		corpus := [][]Node{
			{{Type: "text", Text: "x", Marks: []Mark{{Type: "alignment",
				Attrs: map[string]any{"align": "center"}}}}},
			{{Type: "text", Text: "x", Marks: []Mark{{Type: "backgroundColor",
				Attrs: map[string]any{"color": "#ff0"}}}}},
		}
		for _, nodes := range corpus {
			assert.False(t, inlineRoundTrips(nodes, ctx, pc))
		}
	})

	t.Run("literal underline and color markup round-trips", func(t *testing.T) {
		// --- Given --- prose containing a literal "<u>" or color span opener
		// must be escaped so it stays text rather than opening a mark.
		corpus := [][]Node{
			{{Type: "text", Text: "write <u>tags</u> literally"}},
			{{Type: "text", Text: `a <span style="color:red">literal</span> tag`}},
		}
		for _, nodes := range corpus {
			assert.True(t, inlineRoundTrips(nodes, ctx, pc))
		}
	})

	t.Run("a node with a non-string attr stays read-only", func(t *testing.T) {
		// --- Given --- an inlineExtension whose parameters attr is an object
		// cannot be expressed by the key=value grammar, so it keeps the
		// placeholder and stays read-only rather than losing the object.
		nodes := []Node{
			{Type: "inlineExtension", Attrs: map[string]any{
				"extensionKey": "x",
				"parameters":   map[string]any{"a": "b"},
			}},
		}

		// --- Then ---
		assert.False(t, inlineRoundTrips(nodes, ctx, pc))
	})

	t.Run("unknown inline node round-trips as a directive", func(t *testing.T) {
		// --- Given --- an unknown inline node whose attrs are all strings now
		// renders as a generic directive and reparses to the same node.
		nodes := []Node{
			{Type: "mediaInline", Attrs: map[string]any{
				"id": "m1", "collection": "c"}},
		}

		// --- Then ---
		assert.True(t, inlineRoundTrips(nodes, ctx, pc))
	})

	t.Run("literal markup characters round-trip via escaping", func(t *testing.T) {
		// --- Given --- prose whose literal *, `, ~~, [ ](, [[ directive and
		// <url> would misparse without escaping. Reversible escaping keeps it
		// editable.
		corpus := [][]Node{
			{{Type: "text", Text: "2 * 3 = 6"}},
			{{Type: "text", Text: "use `code` sparingly"}},
			{{Type: "text", Text: "a ~~ b"}},
			{{Type: "text", Text: "see [note](x) here"}},
			{{Type: "text", Text: "write a [[!status]] tag literally"}},
			{{Type: "text", Text: "and a [[@name]] mention verbatim"}},
			{{Type: "text", Text: "quote <https://x/y> verbatim"}},
			{{Type: "text", Text: `a backslash \ here`}},
		}
		for _, nodes := range corpus {
			assert.True(t, inlineRoundTrips(nodes, ctx, pc))
		}
	})

	t.Run("a clock colon and email at-sign are left clean", func(t *testing.T) {
		// --- Given --- punctuation that is not a construct trigger must not be
		// escaped, yet must still round-trip.
		corpus := [][]Node{
			{{Type: "text", Text: "meet at 12:30 today"}},
			{{Type: "text", Text: "mail me at a@example.com"}},
			{{Type: "text", Text: "a < b and c > d"}},
			{{Type: "text", Text: "list item [1] not a link"}},
		}
		for _, nodes := range corpus {
			assert.True(t, inlineRoundTrips(nodes, ctx, pc))
		}
	})
}

func FuzzInline(f *testing.F) {
	seeds := []string{
		"", "plain", "**b**", "*i*", "`c`", "~~s~~", "[l](u)", "[[@Ann]]",
		"[[@Sam|id=S2]]", "**a *b* c**", "unbalanced **", "[bad", "`open",
		"a*b*c", "***", "[[@]]", `[[@a\|b|id=c]]`, "[a](b)(c)",
		"[[!OK|color=green]]", "[[!a]]", "[[!|color=x;style=y]]",
		"[[*wibble:x|y=z]]", "12:30", `[[!a\]b|color=grey]]`,
		`[[!x|k="a b"]]`, "[[!", "[[", "[[!x|bad",
		"<https://example.com/x>", "<br>", "<not a url>", "<unterminated",
		`\*`, `\\`, `\`, `2 \* 3`, `\[x](y)`, `c:\dir`, `a \~~ b`, `\[[@x]]`,
		"[[#2024-07-06|ts=1720224000000]]", "[[#|ts=]]", "[[#x]]",
		"[[:smile|id=1f604]]", "[[:x]]", "[[:]]",
		"[[*mediaInline:|collection=c;id=m1]]", "[[*foo:bar|a=b;c=d]]", "[[*x:y]]",
		"[[*3d:x]]", "[[TOC]]", "[[*Foo:X]]", "[[*foo:]]",
		"<u>x</u>", "<u>a **b** c</u>", "<u>open", "<u></u>", `\<u>x</u>`,
		`<span style="color:#ff0000">red</span>`, `<span style="color:">e</span>`,
		`<span style="color:a"b">bad</span>`, `<span style="color:red">no close`,
		`<span style="color:#0a0">a</span> and <span style="color:#00f">b</span>`,
	}
	for _, s := range seeds {
		f.Add(s)
	}
	pc := parseCtx{mentions: map[string]string{"Ann": "A"}}
	ctx := mdCtx{}
	f.Fuzz(func(t *testing.T, s string) {
		// Must never panic on arbitrary input.
		nodes := parseInline(s, pc)
		// A run that reports round-trippable must actually re-render to a run
		// with the same signature — the invariant push relies on.
		if inlineRoundTrips(nodes, ctx, pc) {
			rendered := Node{Type: "paragraph", Content: nodes}.inlineString(ctx)
			if !sigEqual(
				inlineSig(nodes, ctx.links),
				inlineSig(parseInline(rendered, pc), ctx.links)) {
				t.Fatalf("round-trip claimed but signatures differ for %q", s)
			}
		}
	})
}
