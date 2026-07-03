// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"strings"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_ADF_frontmatter_pagePath(t *testing.T) {
	t.Run("renders the page path from the name", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		want := "" +
			"---\n" +
			"title: \"My Page\"\n" +
			"page_path: \"docs/my-page.md\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"\"\n" +
			"---\n"
		assert.Equal(t, want, string(have))
	})
}

func Test_ADF_frontmatter_spaceKey(t *testing.T) {
	t.Run("renders the space key after the space id when set", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "space_id": "42",
		   "space_key": "RZTST",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		want := "" +
			"---\n" +
			"title: \"My Page\"\n" +
			"page_path: \"docs/my-page.md\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"42\"\n" +
			"space_key: \"RZTST\"\n" +
			"---\n"
		assert.Equal(t, want, string(have))
	})

	t.Run("omits the space key when unset", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		want := "" +
			"---\n" +
			"title: \"My Page\"\n" +
			"page_path: \"docs/my-page.md\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"\"\n" +
			"---\n"
		assert.Equal(t, want, string(have))
	})
}

func Test_ADF_frontmatter_parentID(t *testing.T) {
	t.Run("renders parent_id after space_id when set", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "space_id": "42",
		   "parent_id": "77",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		want := "" +
			"---\n" +
			"title: \"My Page\"\n" +
			"page_path: \"docs/my-page.md\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"42\"\n" +
			"parent_id: \"77\"\n" +
			"---\n"
		assert.Equal(t, want, string(have))
	})

	t.Run("renders parent_id before space_key when both are set", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "space_id": "42",
		   "parent_id": "77",
		   "space_key": "RZTST",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		want := "" +
			"---\n" +
			"title: \"My Page\"\n" +
			"page_path: \"docs/my-page.md\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"42\"\n" +
			"parent_id: \"77\"\n" +
			"space_key: \"RZTST\"\n" +
			"---\n"
		assert.Equal(t, want, string(have))
	})

	t.Run("omits parent_id when unset, such as a space homepage", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		assert.NotContain(t, "parent_id", string(have))
	})
}

func Test_ADF_frontmatter_domain(t *testing.T) {
	t.Run("renders the domain when set", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "cf_domain": "ex.atlassian.net",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		want := "" +
			"---\n" +
			"title: \"My Page\"\n" +
			"page_path: \"docs/my-page.md\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"\"\n" +
			"cf_domain: \"ex.atlassian.net\"\n" +
			"---\n"
		assert.Equal(t, want, string(have))
	})

	t.Run("omits the domain when unset", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "name": "docs/my-page.md",
		   "title": "My Page",
		   "adf": { "type": "doc", "content": [] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		assert.NotContain(t, "cf_domain", string(have))
	})
}

func Test_ADF_mentions(t *testing.T) {
	t.Run("distinct names populate the frontmatter map", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "adf": { "type": "doc", "content": [
		      { "type": "paragraph", "content": [
		         { "type": "mention", "attrs": { "id": "A", "text": "@Ann" } },
		         { "type": "text", "text": " " },
		         { "type": "mention", "attrs": { "id": "B", "text": "@Bob" } }
		      ] }
		   ] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then ---
		want := "" +
			"---\n" +
			"title: \"\"\n" +
			"page_path: \"\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"\"\n" +
			"mentions:\n" +
			"  \"Ann\": \"A\"\n" +
			"  \"Bob\": \"B\"\n" +
			"---\n" +
			"\n" +
			"[[@Ann]] [[@Bob]]\n"
		assert.Equal(t, want, string(have))
	})

	t.Run("a colliding name is inline-only, off the map", func(t *testing.T) {
		// --- Given --- two people rendering as "@Sam" plus a distinct "@Ann".
		data := `{
		   "adf": { "type": "doc", "content": [
		      { "type": "paragraph", "content": [
		         { "type": "mention", "attrs": { "id": "S1", "text": "@Sam" } },
		         { "type": "text", "text": " " },
		         { "type": "mention", "attrs": { "id": "S2", "text": "@Sam" } },
		         { "type": "text", "text": " " },
		         { "type": "mention", "attrs": { "id": "A",  "text": "@Ann" } }
		      ] }
		   ] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdown(nil))

		// --- Then --- only the unambiguous "Ann" is in the map; both "Sam"
		// mentions carry their id inline so the collision round-trips.
		want := "" +
			"---\n" +
			"title: \"\"\n" +
			"page_path: \"\"\n" +
			"page_id: \"\"\n" +
			"page_version: 0\n" +
			"space_id: \"\"\n" +
			"mentions:\n" +
			"  \"Ann\": \"A\"\n" +
			"---\n" +
			"\n" +
			"[[@Sam|id=S1]] [[@Sam|id=S2]] [[@Ann]]\n"
		assert.Equal(t, want, string(have))
	})
}

func Test_Node_renderBlock_hardBreak(t *testing.T) {
	t.Run("a paragraph hardBreak becomes a backslash break", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "paragraph", Content: []Node{
			{Type: "text", Text: "alpha beta"},
			{Type: "hardBreak"},
			{Type: "text", Text: "gamma delta"},
		}}

		// --- When ---
		have := nod.renderBlock(mdCtx{})

		// --- Then ---
		assert.Equal(t, "alpha beta\\\ngamma delta", have)
	})

	t.Run("each hardBreak segment soft-wraps on its own", func(t *testing.T) {
		// --- Given ---
		long := strings.Repeat("word ", 20)
		nod := Node{Type: "paragraph", Content: []Node{
			{Type: "text", Text: strings.TrimSpace(long)},
			{Type: "hardBreak"},
			{Type: "text", Text: "tail"},
		}}

		// --- When ---
		have := nod.renderBlock(mdCtx{})

		// --- Then ---
		// The long first segment wraps internally; the hardBreak still ends its
		// last line with a backslash, and the short second segment follows.
		lines := strings.Split(have, "\n")
		assert.True(t, len(lines) > 2)
		assert.True(t, strings.HasSuffix(lines[len(lines)-2], "\\"))
		assert.Equal(t, "tail", lines[len(lines)-1])
	})

	t.Run("a one-line hardBreak renders as an HTML break", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "heading", Attrs: map[string]any{"level": float64(2)},
			Content: []Node{
				{Type: "text", Text: "a"},
				{Type: "hardBreak"},
				{Type: "text", Text: "b"},
			}}

		// --- When ---
		have := nod.renderBlock(mdCtx{})

		// --- Then ---
		assert.Equal(t, "## a<br>b", have)
	})
}

func Test_Node_renderExtension(t *testing.T) {
	t.Run("a toc macro renders as a TOC marker", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "extension", Attrs: map[string]any{
			"extensionKey": "toc", "localId": "e1"}}

		// --- When ---
		have := nod.renderBlock(mdCtx{})

		// --- Then ---
		assert.Equal(t, "[[TOC]]", have)
	})

	t.Run("another macro renders as an anchor directive", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "extension", Attrs: map[string]any{
			"extensionKey": "chart", "localId": "e2"}}

		// --- When ---
		have := nod.renderBlock(mdCtx{})

		// --- Then ---
		assert.Equal(t, "[[*extension:|extensionKey=chart;localId=e2]]", have)
	})
}

func Test_Node_renderMedia(t *testing.T) {
	t.Run("renders an image when the asset resolves", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "media", Attrs: map[string]any{
			"type": "file", "localId": "L1", "alt": "pic.jpg",
		}}
		assets := map[string]string{"L1": "../_assets/F1-L1.jpg"}

		// --- When ---
		have := nod.renderMedia(assets)

		// --- Then ---
		assert.Equal(t, "![pic.jpg](../_assets/F1-L1.jpg)", have)
	})

	t.Run("falls back to an anchor directive without an asset", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "media", Attrs: map[string]any{
			"type": "file", "localId": "L1", "alt": "pic.jpg", "id": "F1",
		}}

		// --- When ---
		have := nod.renderMedia(nil)

		// --- Then ---
		assert.Equal(t, "[[*media:|alt=pic.jpg;id=F1;localId=L1;type=file]]", have)
	})

	t.Run("renders external media as an image from its url", func(t *testing.T) {
		// --- Given --- an external media node needs no downloaded asset.
		nod := Node{Type: "media", Attrs: map[string]any{
			"type": "external", "url": "https://example.com/p.png", "alt": "P",
		}}

		// --- When ---
		have := nod.renderMedia(nil)

		// --- Then ---
		assert.Equal(t, "![P](https://example.com/p.png)", have)
	})

	t.Run("external media without a url renders an anchor", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "media", Attrs: map[string]any{"type": "external"}}

		// --- When ---
		have := nod.renderMedia(nil)

		// --- Then ---
		assert.Equal(t, "[[*media:|type=external]]", have)
	})
}

func Test_Node_renderParagraph_indentation(t *testing.T) {
	indent := func(level int) []Mark {
		return []Mark{{Type: "indentation",
			Attrs: map[string]any{"level": float64(level)}}}
	}

	t.Run("an indented paragraph gets an N> marker", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "paragraph", Marks: indent(1),
			Content: []Node{{Type: "text", Text: "hello world"}}}

		// --- When ---
		have := nod.renderBlock(mdCtx{})

		// --- Then ---
		assert.Equal(t, "1> hello world", have)
	})

	t.Run("continuation lines align under the text", func(t *testing.T) {
		// --- Given ---
		long := strings.TrimSpace(strings.Repeat("word ", 30))
		nod := Node{Type: "paragraph", Marks: indent(2),
			Content: []Node{{Type: "text", Text: long}}}

		// --- When ---
		have := nod.renderBlock(mdCtx{})

		// --- Then --- first line marked, wrapped lines indented by "2> " width.
		lines := strings.Split(have, "\n")
		assert.True(t, len(lines) > 1)
		assert.True(t, strings.HasPrefix(lines[0], "2> word"))
		assert.True(t, strings.HasPrefix(lines[1], "   word"))
	})

	t.Run("a level-zero paragraph is unmarked", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "paragraph",
			Content: []Node{{Type: "text", Text: "plain"}}}

		// --- Then ---
		assert.Equal(t, "plain", nod.renderBlock(mdCtx{}))
	})

	t.Run("literal text that looks like a marker is escaped", func(t *testing.T) {
		// --- Given --- a non-indented paragraph whose text starts with "3>".
		nod := Node{Type: "paragraph",
			Content: []Node{{Type: "text", Text: "3> a reply quote"}}}

		// --- Then ---
		assert.Equal(t, `\3> a reply quote`, nod.renderBlock(mdCtx{}))
	})
}

func Test_Node_renderBlockquote(t *testing.T) {
	quote := func(texts ...string) Node {
		paras := make([]Node, len(texts))
		for i, tx := range texts {
			paras[i] = Node{Type: "paragraph",
				Content: []Node{{Type: "text", Text: tx}}}
		}
		return Node{Type: "blockquote", Content: paras}
	}

	t.Run("a single-paragraph quote gets a > marker", func(t *testing.T) {
		assert.Equal(t, "> to be or not", quote("to be or not").renderBlock(mdCtx{}))
	})

	t.Run("it carries no [!TYPE] tag, unlike a panel", func(t *testing.T) {
		// --- Given --- a panel and a blockquote with the same body.
		panel := Node{Type: "panel", Attrs: map[string]any{"panelType": "info"},
			Content: []Node{{Type: "paragraph",
				Content: []Node{{Type: "text", Text: "note"}}}}}

		// --- Then --- only the panel gets the alert tag line.
		assert.Equal(t, "> note", quote("note").renderBlock(mdCtx{}))
		assert.Equal(t, "> [!INFO]\n> note", panel.renderBlock(mdCtx{}))
	})

	t.Run("two paragraphs are separated by a bare > line", func(t *testing.T) {
		assert.Equal(t, "> one\n>\n> two",
			quote("one", "two").renderBlock(mdCtx{}))
	})
}

func Test_Node_renderExpand(t *testing.T) {
	expand := func(title string, texts ...string) Node {
		paras := make([]Node, len(texts))
		for i, tx := range texts {
			paras[i] = Node{Type: "paragraph",
				Content: []Node{{Type: "text", Text: tx}}}
		}
		return Node{Type: "expand", Attrs: map[string]any{"title": title},
			Content: paras}
	}

	t.Run("the title rides the [!EXPAND] tag line", func(t *testing.T) {
		have := expand("Details", "the body").renderBlock(mdCtx{})
		assert.Equal(t, "> [!EXPAND] Details\n> the body", have)
	})

	t.Run("an empty title leaves a bare tag", func(t *testing.T) {
		have := expand("", "the body").renderBlock(mdCtx{})
		assert.Equal(t, "> [!EXPAND]\n> the body", have)
	})

	t.Run("a missing title attr leaves a bare tag", func(t *testing.T) {
		nod := Node{Type: "expand", Content: []Node{{Type: "paragraph",
			Content: []Node{{Type: "text", Text: "body"}}}}}
		assert.Equal(t, "> [!EXPAND]\n> body", nod.renderBlock(mdCtx{}))
	})

	t.Run("two paragraphs are separated by a bare > line", func(t *testing.T) {
		have := expand("T", "one", "two").renderBlock(mdCtx{})
		assert.Equal(t, "> [!EXPAND] T\n> one\n>\n> two", have)
	})

	t.Run("a panel typed expand falls back to an anchor", func(t *testing.T) {
		// --- Given --- a panel whose type collides with the expand tag.
		nod := Node{Type: "panel",
			Attrs: map[string]any{"panelType": "expand", "localId": "p1"},
			Content: []Node{{Type: "paragraph",
				Content: []Node{{Type: "text", Text: "x"}}}}}

		// --- Then --- it renders as an anchor, not a "> [!EXPAND]" blockquote.
		assert.Equal(t, "[[*panel:|localId=p1;panelType=expand]]",
			nod.renderBlock(mdCtx{}))
	})
}

func Test_Node_renderBulletList(t *testing.T) {
	item := func(texts ...string) Node {
		paras := make([]Node, len(texts))
		for i, tx := range texts {
			paras[i] = Node{Type: "paragraph",
				Content: []Node{{Type: "text", Text: tx}}}
		}
		return Node{Type: "listItem", Content: paras}
	}
	list := func(items ...Node) Node {
		return Node{Type: "bulletList", Content: items}
	}

	t.Run("single-paragraph items render tight", func(t *testing.T) {
		have := list(item("first"), item("second")).renderBlock(mdCtx{})
		assert.Equal(t, "- first\n- second", have)
	})

	t.Run("a multi-paragraph item separates its paragraphs", func(t *testing.T) {
		have := list(item("lead para", "follow para")).renderBlock(mdCtx{})
		assert.Equal(t, "- lead para\n\n  follow para", have)
	})

	t.Run("a nested sub-list renders indented under its item", func(t *testing.T) {
		// --- Given --- a list item holding a paragraph and a nested bullet list.
		nested := list(item("sub one"), item("sub two"))
		outer := Node{Type: "bulletList", Content: []Node{
			{Type: "listItem", Content: []Node{
				{Type: "paragraph", Content: []Node{{Type: "text", Text: "top"}}},
				nested,
			}},
		}}

		// --- When ---
		have := outer.renderBlock(mdCtx{})

		// --- Then --- the sub-list is indented two columns under the item.
		assert.Equal(t, "- top\n\n  - sub one\n  - sub two", have)
	})
}

func Test_Node_renderOrderedList(t *testing.T) {
	item := func(texts ...string) Node {
		paras := make([]Node, len(texts))
		for i, tx := range texts {
			paras[i] = Node{Type: "paragraph",
				Content: []Node{{Type: "text", Text: tx}}}
		}
		return Node{Type: "listItem", Content: paras}
	}
	list := func(attrs map[string]any, items ...Node) Node {
		return Node{Type: "orderedList", Attrs: attrs, Content: items}
	}

	t.Run("items number sequentially from one", func(t *testing.T) {
		have := list(nil, item("first"), item("second")).renderBlock(mdCtx{})
		assert.Equal(t, "1. first\n2. second", have)
	})

	t.Run("numbering starts at the order attribute", func(t *testing.T) {
		attrs := map[string]any{"order": float64(3)}
		have := list(attrs, item("first"), item("second")).renderBlock(mdCtx{})
		assert.Equal(t, "3. first\n4. second", have)
	})

	t.Run("a multi-paragraph item aligns under its marker", func(t *testing.T) {
		have := list(nil, item("lead para", "follow para")).renderBlock(mdCtx{})
		assert.Equal(t, "1. lead para\n\n   follow para", have)
	})
}

func Test_Node_renderTable(t *testing.T) {
	// cell builds a table cell of the given type holding one text paragraph.
	cell := func(kind, text string, attrs map[string]any) Node {
		return Node{Type: kind, Attrs: attrs, Content: []Node{
			{Type: "paragraph", Content: []Node{{Type: "text", Text: text}}}}}
	}
	row := func(cells ...Node) Node {
		return Node{Type: "tableRow", Content: cells}
	}
	th := func(text string, attrs map[string]any) Node {
		return cell("tableHeader", text, attrs)
	}
	td := func(text string, attrs map[string]any) Node {
		return cell("tableCell", text, attrs)
	}

	t.Run("a colspan cell marks the columns it covers", func(t *testing.T) {
		// --- Given --- a header row then a row whose second cell spans two.
		tbl := Node{Type: "table", Content: []Node{
			row(th("A", nil), th("B", nil)),
			row(td("wide", map[string]any{"colspan": float64(2)})),
		}}

		// --- When ---
		have := tbl.renderBlock(mdCtx{})

		// --- Then --- the value stays in the first column, « covers the second.
		want := "" +
			"| A    | B |\n" +
			"|------|---|\n" +
			"| wide | « |"
		assert.Equal(t, want, have)
	})

	t.Run("a rowspan cell marks the rows below it", func(t *testing.T) {
		// --- Given --- a first-column cell spanning two rows.
		tbl := Node{Type: "table", Content: []Node{
			row(th("A", nil), th("B", nil)),
			row(td("tall", map[string]any{"rowspan": float64(2)}), td("x", nil)),
			row(td("y", nil)),
		}}

		// --- When ---
		have := tbl.renderBlock(mdCtx{})

		// --- Then --- the second row's first column shows « under "tall".
		want := "" +
			"| A    | B |\n" +
			"|------|---|\n" +
			"| tall | x |\n" +
			"| «    | y |"
		assert.Equal(t, want, have)
	})

	t.Run("an escaped cell pipe is not a column break", func(t *testing.T) {
		// --- Given --- a data cell holding a status directive, whose "|"
		// separates the label from its attributes.
		status := Node{Type: "status", Attrs: map[string]any{
			"text": "In progress", "color": "blue", "style": "bold"}}
		statusCell := Node{Type: "tableCell", Content: []Node{
			{Type: "paragraph", Content: []Node{status}}}}
		tbl := Node{Type: "table", Content: []Node{
			row(th("State", nil), statusCell),
		}}

		// --- When ---
		have := tbl.renderBlock(mdCtx{})

		// --- Then --- the directive's "|" is escaped so the row keeps two cells,
		// and splitTableRow recovers the whole directive as one cell.
		want := "" +
			"|           |                                         |\n" +
			"|-----------|-----------------------------------------|\n" +
			"| **State** | [[!In progress\\|color=blue;style=bold]] |"
		assert.Equal(t, want, have)

		cells := splitTableRow(
			"| **State** | [[!In progress\\|color=blue;style=bold]] |")
		assert.Equal(t, []string{"**State**",
			"[[!In progress|color=blue;style=bold]]"}, cells)
	})

	t.Run("a backslash and a pipe in a cell round-trip", func(t *testing.T) {
		// --- Given --- cell text with both a backslash and a pipe; the escape
		// must double the backslash so splitTableRow can tell it from a pipe
		// escape.
		text := `a\b|c`

		// --- When --- escape the text for a row, then split it back out.
		escaped := escapeTableCell(text)
		cells := splitTableRow("| " + escaped + " |")

		// --- Then --- the backslash is doubled, the pipe guarded, and the split
		// restores the original exactly.
		assert.Equal(t, `a\\b\|c`, escaped)
		assert.Equal(t, []string{text}, cells)
	})

	t.Run("a key/value table: blank header, bold keys", func(t *testing.T) {
		// --- Given --- a header in the first column of every row, no header row.
		tbl := Node{Type: "table", Content: []Node{
			row(th("Name", nil), td("Widget", nil)),
			row(th("Type", nil), td("Gadget", nil)),
		}}

		// --- When ---
		have := tbl.renderBlock(mdCtx{})

		// --- Then --- a blank GFM header, keys bolded inline.
		want := "" +
			"|          |        |\n" +
			"|----------|--------|\n" +
			"| **Name** | Widget |\n" +
			"| **Type** | Gadget |"
		assert.Equal(t, want, have)
	})
}

func Test_Node_renderCodeBlock(t *testing.T) {
	t.Run("renders a fenced block with its language", func(t *testing.T) {
		nod := Node{Type: "codeBlock", Attrs: map[string]any{"language": "go"},
			Content: []Node{{Type: "text", Text: "a := 1\nb := 2"}}}
		assert.Equal(t, "```go\na := 1\nb := 2\n```", nod.renderBlock(mdCtx{}))
	})

	t.Run("renders a fence with no language when unset", func(t *testing.T) {
		nod := Node{Type: "codeBlock",
			Content: []Node{{Type: "text", Text: "plain"}}}
		assert.Equal(t, "```\nplain\n```", nod.renderBlock(mdCtx{}))
	})
}

func Test_renderTextRun_tabular(t *testing.T) {
	strike := Mark{Type: "strike"}
	strong := Mark{Type: "strong"}

	tt := []struct {
		testN string
		run   []Node
		want  string
	}{
		{
			"shared mark hoisted across the boundary",
			[]Node{
				{Type: "text", Text: "SC-9:", Marks: []Mark{strike, strong}},
				{Type: "text", Text: " Track it.", Marks: []Mark{strike}},
			},
			"~~**SC-9:** Track it.~~",
		},
		{
			"adjacent equal marks merge without an empty run",
			[]Node{
				{Type: "text", Text: "a", Marks: []Mark{strong}},
				{Type: "text", Text: "b", Marks: []Mark{strong}},
			},
			"**ab**",
		},
		{
			"a mark on one node only wraps that node",
			[]Node{
				{Type: "text", Text: "a", Marks: []Mark{strong}},
				{Type: "text", Text: "b"},
			},
			"**a**b",
		},
		{
			"plain nodes concatenate",
			[]Node{
				{Type: "text", Text: "a"},
				{Type: "text", Text: "b"},
			},
			"ab",
		},
		{
			"underline wraps in an HTML tag pair",
			[]Node{{Type: "text", Text: "u", Marks: []Mark{{Type: "underline"}}}},
			"<u>u</u>",
		},
		{
			"textColor carries its color in a span",
			[]Node{{Type: "text", Text: "red", Marks: []Mark{
				{Type: "textColor", Attrs: map[string]any{"color": "#ff0000"}}}}},
			`<span style="color:#ff0000">red</span>`,
		},
		{
			"same-color span merges across the boundary",
			[]Node{
				{Type: "text", Text: "a", Marks: []Mark{
					{Type: "textColor", Attrs: map[string]any{"color": "#0a0"}}}},
				{Type: "text", Text: "b", Marks: []Mark{
					{Type: "textColor", Attrs: map[string]any{"color": "#0a0"}}}},
			},
			`<span style="color:#0a0">ab</span>`,
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := renderTextRun(tc.run)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_Node_renderInline_generic(t *testing.T) {
	t.Run("an unknown all-string node renders as a directive", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "mediaInline", Attrs: map[string]any{
			"id": "m1", "collection": "c", "localId": "drop"}}

		// --- Then --- attrs sorted by key, text content empty, localId dropped.
		assert.Equal(t,
			"[[*mediaInline:|collection=c;id=m1]]", nod.renderInline(mdCtx{}))
	})

	t.Run("a non-string attr keeps the placeholder", func(t *testing.T) {
		// --- Given --- parameters is an object, inexpressible as key=value.
		nod := Node{Type: "inlineExtension", Attrs: map[string]any{
			"extensionKey": "x", "localId": "e1",
			"parameters": map[string]any{"a": "b"}}}

		// --- Then ---
		assert.Equal(t,
			`<!-- adf:inlineExtension localId="e1" -->`, nod.renderInline(mdCtx{}))
	})
}

func Test_Node_renderDirective_tabular(t *testing.T) {
	tt := []struct {
		testN string
		nod   Node
		want  string
	}{
		{
			"status with color and style",
			Node{Type: "status", Attrs: map[string]any{
				"text": "APPROVED", "color": "green", "style": "bold"}},
			"[[!APPROVED|color=green;style=bold]]",
		},
		{
			"status defaults a missing color to neutral",
			Node{Type: "status", Attrs: map[string]any{"text": "TODO"}},
			"[[!TODO|color=neutral]]",
		},
		{
			"a default style is omitted",
			Node{Type: "status", Attrs: map[string]any{
				"text": "OK", "color": "blue", "style": "default"}},
			"[[!OK|color=blue]]",
		},
		{
			"a closing bracket in the label is escaped",
			Node{Type: "status", Attrs: map[string]any{
				"text": "a]b", "color": "grey"}},
			`[[!a\]b|color=grey]]`,
		},
		{
			"date shows the human day with ts authoritative",
			Node{Type: "date", Attrs: map[string]any{
				"timestamp": "1720224000000"}},
			"[[#2024-07-06|ts=1720224000000]]",
		},
		{
			"a numeric timestamp is accepted",
			Node{Type: "date", Attrs: map[string]any{
				"timestamp": float64(1720224000000)}},
			"[[#2024-07-06|ts=1720224000000]]",
		},
		{
			"emoji shows the shortName with id",
			Node{Type: "emoji", Attrs: map[string]any{
				"shortName": ":smile:", "id": "1f604", "text": "😄"}},
			"[[:smile|id=1f604]]",
		},
		{
			"emoji without an id omits it",
			Node{Type: "emoji", Attrs: map[string]any{
				"shortName": ":wave:", "text": "👋"}},
			"[[:wave]]",
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := tc.nod.renderDirective()

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_Node_renderAnchor(t *testing.T) {
	t.Run("a frozen container renders with its localId", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "nestedExpand", Attrs: map[string]any{
			"localId": "x1", "title": "Details"}}

		// --- When ---
		have := nod.renderAnchor()

		// --- Then ---
		assert.Equal(t, "[[*nestedExpand:|localId=x1;title=Details]]", have)
	})

	t.Run("a non-string attr is dropped", func(t *testing.T) {
		// --- Given --- number is inexpressible as key=value; localId survives.
		nod := Node{Type: "nestedExpand", Attrs: map[string]any{
			"localId": "x1", "number": float64(3)}}

		// --- When ---
		have := nod.renderAnchor()

		// --- Then ---
		assert.Equal(t, "[[*nestedExpand:|localId=x1]]", have)
	})
}

func Test_Node_renderInlineCard(t *testing.T) {
	t.Run("renders as an autolink", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "inlineCard", Attrs: map[string]any{
			"url": "https://example.com/x", "localId": "c"}}

		// --- Then ---
		assert.Equal(t, "<https://example.com/x>", nod.renderInline(mdCtx{}))
	})

	t.Run("a url with a space falls back to a placeholder", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "inlineCard", Attrs: map[string]any{
			"url": "https://example.com/a b", "localId": "c"}}

		// --- Then ---
		assert.Equal(t,
			`<!-- adf:inlineCard localId="c" -->`, nod.renderInline(mdCtx{}))
	})
}

func Test_Node_renderMention(t *testing.T) {
	t.Run("an unambiguous mention renders as [[@name]]", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "mention", Attrs: map[string]any{
			"id": "acc-1", "text": "@Rafal",
		}}

		// --- When ---
		have := nod.renderMention(mdCtx{})

		// --- Then ---
		assert.Equal(t, "[[@Rafal]]", have)
	})

	t.Run("an ambiguous name carries the id inline", func(t *testing.T) {
		// --- Given ---
		nod := Node{Type: "mention", Attrs: map[string]any{
			"id": "acc-1", "text": "@Rafal",
		}}
		ctx := mdCtx{ambig: map[string]bool{"Rafal": true}}

		// --- When ---
		have := nod.renderMention(ctx)

		// --- Then ---
		assert.Equal(t, "[[@Rafal|id=acc-1]]", have)
	})
}

func Test_escapeInline(t *testing.T) {
	tt := []struct {
		testN string
		in    string
		want  string
	}{
		{"asterisk is always escaped", "2 * 3", `2 \* 3`},
		{"backtick is always escaped", "a `b` c", "a \\`b\\` c"},
		{"backslash is doubled", `a \ b`, `a \\ b`},
		{"double tilde is escaped once", "x ~~y", `x \~~y`},
		{"a link pattern is defused", "see [a](b)", `see \[a](b)`},
		{"a directive opener is escaped", "[[!x]]", `\[[!x]]`},
		{"an autolink opener is escaped", "<http://x>", `\<http://x>`},
		{"a lone tilde is left clean", "~/path", "~/path"},
		{"a clock colon is left clean", "at 12:30", "at 12:30"},
		{"an email at-sign is left clean", "a@ex.com", "a@ex.com"},
		{"a bare double bracket is left clean", "[[TOC]]", "[[TOC]]"},
		{"a non-link bracket is left clean", "item [1] here", "item [1] here"},
		{"a stray angle is left clean", "a < b > c", "a < b > c"},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			assert.Equal(t, tc.want, escapeInline(tc.in))
		})
	}
}
