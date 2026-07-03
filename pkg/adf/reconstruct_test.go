// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_ADF_Put_GetPut_tabular(t *testing.T) {
	// GetPut: pushing the body back unchanged must yield a byte-identical
	// document — no edit means no change.
	tt := []struct {
		testN string
		data  string
	}{
		{
			"paragraphs and a heading",
			`{ "title": "T", "id": "1", "version": 3, "space_id": "9",
			   "adf": { "type": "doc", "content": [
			      { "type": "heading", "attrs": { "level": 2, "localId": "h" },
			        "content": [ { "type": "text", "text": "Head" } ] },
			      { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
			         { "type": "text", "text": "hello " },
			         { "type": "text", "text": "world", "marks": [ { "type": "strong" } ] } ] }
			   ] } }`,
		},
		{
			"a non-breaking-space spacer paragraph survives",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "paragraph", "attrs": { "localId": "p1" },
			     "content": [ { "type": "text", "text": "before" } ] },
			   { "type": "paragraph", "attrs": { "localId": "sp" },
			     "content": [ { "type": "text", "text": "\u00a0" } ] },
			   { "type": "paragraph", "attrs": { "localId": "p2" },
			     "content": [ { "type": "text", "text": "after" } ] } ] } }`,
		},
		{
			"a table is copied verbatim",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "paragraph", "attrs": { "localId": "p" },
			     "content": [ { "type": "text", "text": "intro" } ] },
			   { "type": "table", "attrs": { "localId": "t" }, "content": [
			      { "type": "tableRow", "content": [
			         { "type": "tableCell", "content": [ { "type": "paragraph",
			           "content": [ { "type": "text", "text": "A" } ] } ] },
			         { "type": "tableCell", "content": [ { "type": "paragraph",
			           "content": [ { "type": "text", "text": "B" } ] } ] } ] } ] } ] } }`,
		},
		{
			// A block-level alignment mark is not rendered, so it is invisible in
			// the Markdown; the retentive lens must keep it on the node verbatim.
			"a block alignment mark survives a no-op",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "paragraph", "attrs": { "localId": "p" },
			     "marks": [ { "type": "alignment", "attrs": { "align": "center" } } ],
			     "content": [ { "type": "text", "text": "centered" } ] } ] } }`,
		},
		{
			// A breakout mark on a panel is likewise node-level and unrendered.
			"a panel breakout mark survives a no-op",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
			     "marks": [ { "type": "breakout", "attrs": { "mode": "wide" } } ],
			     "content": [ { "type": "paragraph",
			       "content": [ { "type": "text", "text": "wide note" } ] } ] } ] } }`,
		},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			base := must.Value(NewADF([]byte(tc.data)))
			body := renderBody(t, base, nil)

			// --- When ---
			out, err := base.Put(body, nil, nil, nil)

			// --- Then --- the rebuilt document marshals identically to the base.
			assert.NoError(t, err)
			assert.Equal(t,
				string(must.Value(json.Marshal(base))),
				string(must.Value(json.Marshal(out))))
		})
	}
}

func Test_ADF_Put_nestedBlocks(t *testing.T) {
	t.Run("a code block round-trips and is read-only", func(t *testing.T) {
		// --- Given --- a document with a paragraph and a frozen code block.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" },
		     "content": [ { "type": "text", "text": "intro" } ] },
		   { "type": "codeBlock", "attrs": { "localId": "cb", "language": "go" },
		     "content": [ { "type": "text", "text": "x := 1\ny := 2" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		self := renderBody(t, base, nil)
		assert.Contain(t, "```go\nx := 1\ny := 2\n```", self)

		// --- When --- pushed back unchanged.
		out, err := base.Put(self, nil, nil, nil)

		// --- Then --- GetPut holds byte-for-byte.
		assert.NoError(t, err)
		assert.Equal(t,
			string(must.Value(json.Marshal(base))),
			string(must.Value(json.Marshal(out))))

		// --- And --- editing the code is rejected.
		edited := strings.Replace(self, "x := 1", "x := 9", 1)
		_, err = base.Put(edited, nil, nil, nil)
		assert.ErrorContain(t, "cannot edit codeBlock", err)
	})

	t.Run("nested sub-list read-only, sibling item edits", func(t *testing.T) {
		// --- Given --- a list whose first item holds a nested sub-list and whose
		// second item is a plain paragraph.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
		      { "type": "listItem", "content": [
		         { "type": "paragraph",
		           "content": [ { "type": "text", "text": "top" } ] },
		         { "type": "bulletList", "content": [
		            { "type": "listItem", "content": [ { "type": "paragraph",
		              "content": [ { "type": "text", "text": "sub one" } ] } ] } ] } ] },
		      { "type": "listItem", "content": [ { "type": "paragraph",
		        "content": [ { "type": "text", "text": "plain item" } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		self := renderBody(t, base, nil)
		assert.Contain(t, "  - sub one", self)

		// --- When --- editing only the sibling plain item.
		out, err := base.Put(
			strings.Replace(self, "plain item", "plain edited", 1), nil, nil, nil)

		// --- Then --- the edit lands; the nested item is untouched.
		assert.NoError(t, err)
		list := out.Doc.Content[0]
		assert.Equal(t, "plain edited",
			list.Content[1].Content[0].Content[0].Text)
		assert.Equal(t, "sub one",
			list.Content[0].Content[1].Content[0].Content[0].Content[0].Text)

		// --- And --- editing the nested sub-list text is rejected.
		_, err = base.Put(
			strings.Replace(self, "sub one", "sub X", 1), nil, nil, nil)
		assert.ErrorContain(t, "list item", err)
	})
}

func Test_ADF_Put_mediaGroup(t *testing.T) {
	// A mediaGroup renders as several image lines in one block; the group must
	// stay a single block on the round trip and be read-only.
	data := `{ "adf": { "type": "doc", "content": [
	   { "type": "paragraph", "attrs": { "localId": "p" },
	     "content": [ { "type": "text", "text": "intro" } ] },
	   { "type": "mediaGroup", "attrs": { "localId": "mg" }, "content": [
	      { "type": "media", "attrs": {
	        "type": "file", "id": "F1", "localId": "L1", "alt": "a.png" } },
	      { "type": "media", "attrs": {
	        "type": "file", "id": "F2", "localId": "L2", "alt": "b.png" } } ] } ] } }`
	assets := map[string]string{
		"L1": "../_assets/F1-L1.png", "L2": "../_assets/F2-L2.png"}

	t.Run("an unchanged mediaGroup round-trips (GetPut)", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(data)))
		body := renderBody(t, base, assets)

		// --- When ---
		out, err := base.Put(body, nil, assets, nil)

		// --- Then --- the group survived as one block and the document is intact.
		assert.NoError(t, err)
		assert.Equal(t,
			string(must.Value(json.Marshal(base))),
			string(must.Value(json.Marshal(out))))
	})

	t.Run("editing a mediaGroup image is rejected", func(t *testing.T) {
		// --- Given --- one image's alt text changed.
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, assets), "a.png", "z.png", 1)

		// --- When ---
		_, err := base.Put(body, nil, assets, nil)

		// --- Then --- media is read-only, so the edit is rejected.
		assert.ErrorContain(t, "cannot edit mediaGroup", err)
	})
}

func Test_ADF_Put_modify(t *testing.T) {
	t.Run("edits paragraph text and keeps the localId", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p1" },
		     "content": [ { "type": "text", "text": "hello" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "goodbye"

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		assert.Equal(t, "paragraph", para.Type)
		assert.Equal(t, "p1", para.attrStr("localId"))
		assert.Equal(t, 1, len(para.Content))
		assert.Equal(t, "goodbye", para.Content[0].Text)
	})

	t.Run("edits a paragraph, keeping underline and color", func(t *testing.T) {
		// --- Given --- a paragraph whose text is underlined and colored; the
		// user edits an untouched word elsewhere.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "keep " },
		      { "type": "text", "text": "styled",
		        "marks": [ { "type": "underline" },
		          { "type": "textColor", "attrs": { "color": "#ff0000" } } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		self := renderBody(t, base, nil)
		assert.Contain(t,
			`<span style="color:#ff0000"><u>styled</u></span>`, self)
		body := strings.Replace(self, "keep", "KEEP", 1)

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then --- the edit lands and the styled run keeps both its marks.
		assert.NoError(t, err)
		styled := out.Doc.Content[0].Content[1]
		assert.Equal(t, "styled", styled.Text)
		var hasU, hasC bool
		for _, m := range styled.Marks {
			hasU = hasU || m.Type == "underline"
			if m.Type == "textColor" {
				hasC = m.attrStr("color") == "#ff0000"
			}
		}
		assert.True(t, hasU)
		assert.True(t, hasC)
	})

	t.Run("editing keeps the block alignment mark", func(t *testing.T) {
		// --- Given --- a center-aligned paragraph (a node-level mark the render
		// does not show); the user edits its text.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" },
		     "marks": [ { "type": "alignment", "attrs": { "align": "center" } } ],
		     "content": [ { "type": "text", "text": "before" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))

		// --- When ---
		out, err := base.Put("after", nil, nil, nil)

		// --- Then --- the edit lands and the alignment mark is retained verbatim.
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		assert.Equal(t, "after", para.Content[0].Text)
		assert.Equal(t, 1, len(para.Marks))
		assert.Equal(t, "alignment", para.Marks[0].Type)
		assert.Equal(t, "center", para.Marks[0].attrStr("align"))
	})

	t.Run("editing keeps the panel breakout mark", func(t *testing.T) {
		// --- Given --- a wide (breakout) info panel; the user edits its body.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
		     "marks": [ { "type": "breakout", "attrs": { "mode": "wide" } } ],
		     "content": [ { "type": "paragraph",
		       "content": [ { "type": "text", "text": "note body" } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "note body", "note new", 1)

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then --- the body edit lands and the breakout mark is retained.
		assert.NoError(t, err)
		panel := out.Doc.Content[0]
		assert.Equal(t, 1, len(panel.Marks))
		assert.Equal(t, "breakout", panel.Marks[0].Type)
		assert.Equal(t, "wide", panel.Marks[0].attrStr("mode"))
		assert.Equal(t, "note new", panel.Content[0].Content[0].Text)
	})

	t.Run("adds a strong mark from the edited text", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p1" },
		     "content": [ { "type": "text", "text": "plain here" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "plain **here**"

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		assert.Equal(t, 2, len(para.Content))
		assert.Equal(t, "here", para.Content[1].Text)
		assert.Equal(t, "strong", para.Content[1].Marks[0].Type)
	})

	t.Run("edits a heading keeping its level", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "heading", "attrs": { "level": 3, "localId": "h" },
		     "content": [ { "type": "text", "text": "Old" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "### New Title"

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		h := out.Doc.Content[0]
		assert.Equal(t, "heading", h.Type)
		assert.Equal(t, 3, h.attrInt("level"))
		assert.Equal(t, "New Title", h.Content[0].Text)
	})

	t.Run("changes a heading level from the hashes", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "heading", "attrs": { "level": 2, "localId": "h" },
		     "content": [ { "type": "text", "text": "Title" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "### Title"

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, 3, out.Doc.Content[0].attrInt("level"))
	})

	t.Run("keeps a mention id when editing around it", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "see " },
		      { "type": "mention", "attrs": { "id": "A", "text": "@Ann" } } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		pc := parseCtx{mentions: map[string]string{"Ann": "A"}}
		body := "see [[@Ann]] now"

		// --- When ---
		out, err := base.Put(body, pc.mentions, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		var men Node
		for _, n := range para.Content {
			if n.Type == "mention" {
				men = n
			}
		}
		assert.Equal(t, "A", men.attrStr("id"))
	})

	t.Run("indentation survives a text edit", func(t *testing.T) {
		// --- Given --- a level-1 indented paragraph.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" },
		     "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ],
		     "content": [ { "type": "text", "text": "old text",
		       "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))

		// --- When --- the text is edited but the "1>" marker is kept.
		out, err := base.Put("1> new text", nil, nil, nil)

		// --- Then --- the paragraph keeps its level-1 indentation.
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		assert.Equal(t, 1, para.indentLevel())
		assert.Equal(t, "new text", para.Content[0].Text)
	})

	t.Run("marker change re-indents, removal de-indents", func(t *testing.T) {
		// --- Given --- a level-1 indented paragraph.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" },
		     "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ],
		     "content": [ { "type": "text", "text": "text",
		       "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ] } ] } ] } }`

		// --- When / Then --- bump the marker to level 3.
		up := must.Value(
			must.Value(NewADF([]byte(data))).Put("3> text", nil, nil, nil))
		assert.Equal(t, 3, up.Doc.Content[0].indentLevel())

		// --- When / Then --- drop the marker entirely.
		flat := must.Value(
			must.Value(NewADF([]byte(data))).Put("text", nil, nil, nil))
		assert.Equal(t, 0, flat.Doc.Content[0].indentLevel())
	})

	t.Run("keeps an inlineCard when editing around it", func(t *testing.T) {
		// --- Given --- a paragraph mixing text and an inlineCard.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "ticket " },
		      { "type": "inlineCard", "attrs": {
		        "url": "https://example.com/DOC-42", "localId": "c" } } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "the ticket <https://example.com/DOC-42>"

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then --- the inlineCard survives with its url.
		assert.NoError(t, err)
		var card Node
		for _, n := range out.Doc.Content[0].Content {
			if n.Type == "inlineCard" {
				card = n
			}
		}
		assert.Equal(t, "https://example.com/DOC-42", card.attrStr("url"))
	})

	t.Run("keeps date and emoji when editing around them", func(t *testing.T) {
		// --- Given --- a paragraph mixing text, a date and an emoji.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "due " },
		      { "type": "date", "attrs": { "timestamp": "1720224000000" } },
		      { "type": "text", "text": " " },
		      { "type": "emoji", "attrs": {
		        "shortName": ":smile:", "id": "1f604", "text": "😄" } } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "shipped due [[#2024-07-06|ts=1720224000000]] " +
			"[[:smile|id=1f604]]"

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- both special nodes survive with their key attributes.
		var date, emoji Node
		for _, n := range out.Doc.Content[0].Content {
			switch n.Type {
			case "date":
				date = n
			case "emoji":
				emoji = n
			}
		}
		assert.Equal(t, "1720224000000", date.attrStr("timestamp"))
		assert.Equal(t, ":smile:", emoji.attrStr("shortName"))
	})

	t.Run("keeps a toc macro across a neighbor edit", func(t *testing.T) {
		// --- Given --- a toc extension followed by an editable paragraph.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "extension", "attrs": {
		     "extensionKey": "toc", "localId": "e1" } },
		   { "type": "paragraph", "attrs": { "localId": "p" },
		     "content": [ { "type": "text", "text": "intro" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "[[TOC]]\n\nrewritten intro"

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then --- the extension node survives untouched, the paragraph edits.
		assert.NoError(t, err)
		assert.Equal(t, "extension", out.Doc.Content[0].Type)
		assert.Equal(t, "toc", out.Doc.Content[0].attrStr("extensionKey"))
		assert.Equal(t, "e1", out.Doc.Content[0].attrStr("localId"))
	})

	t.Run("keeps status color and style across an edit", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "state " },
		      { "type": "status", "attrs": {
		        "text": "OK", "color": "green", "style": "bold" } } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "reviewed state [[!OK|color=green;style=bold]]"

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then --- the status survives with its color and style intact.
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		var sta Node
		for _, n := range para.Content {
			if n.Type == "status" {
				sta = n
			}
		}
		assert.Equal(t, "OK", sta.attrStr("text"))
		assert.Equal(t, "green", sta.attrStr("color"))
		assert.Equal(t, "bold", sta.attrStr("style"))
	})
}

func Test_ADF_Put_rejects_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		data    string
		editFn  func(body string) string
		wantErr string
	}{
		{
			"merging the paragraphs of a table cell is rejected",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "table", "attrs": { "localId": "t" }, "content": [
			      { "type": "tableRow", "content": [
			         { "type": "tableCell", "content": [
			           { "type": "paragraph",
			             "content": [ { "type": "text", "text": "A" } ] },
			           { "type": "paragraph",
			             "content": [ { "type": "text", "text": "B" } ] } ] } ] } ] } ] } }`,
			func(b string) string { return strings.Replace(b, "A<br>B", "AB", 1) },
			"cannot add or remove a paragraph in table cell",
		},
		{
			"editing a table cell holding a code block is rejected",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "table", "attrs": { "localId": "t" }, "content": [
			      { "type": "tableRow", "content": [
			         { "type": "tableCell", "content": [
			           { "type": "paragraph",
			             "content": [ { "type": "text", "text": "N" } ] },
			           { "type": "codeBlock",
			             "content": [ { "type": "text", "text": "code" } ] } ] } ] } ] } ] } }`,
			func(b string) string { return strings.Replace(b, "code", "cody", 1) },
			"cannot edit a multi-block table cell",
		},
		{
			"editing a toc macro marker is rejected",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "extension", "attrs": {
			     "extensionKey": "toc", "localId": "e1" } } ] } }`,
			func(b string) string { return strings.Replace(b, "TOC", "toc", 1) },
			"only paragraph and heading text is editable",
		},
		{
			"editing text next to a non-string-attr node is rejected",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
			      { "type": "text", "text": "hi " },
			      { "type": "inlineExtension", "attrs": {
			        "extensionKey": "x",
			        "parameters": { "a": "b" } } } ] } ] } }`,
			func(b string) string { return "changed " + b },
			"cannot express",
		},
		{
			"editing text with an unsupported mark is rejected",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
			      { "type": "text", "text": "hi",
			        "marks": [ { "type": "backgroundColor",
			          "attrs": { "color": "#ff0" } } ] } ] } ] } }`,
			func(b string) string { return "changed " + b },
			"cannot express",
		},
		{
			"inserting a table without a separator row is rejected",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "paragraph", "attrs": { "localId": "p" },
			     "content": [ { "type": "text", "text": "one" } ] } ] } }`,
			func(b string) string { return b + "\n\n| a | b |" },
			"needs a header and a separator row",
		},
		{
			"deleting a read-only block is rejected",
			`{ "adf": { "type": "doc", "content": [
			   { "type": "paragraph", "attrs": { "localId": "p" },
			     "content": [ { "type": "text", "text": "keep" } ] },
			   { "type": "table", "attrs": { "localId": "t" }, "content": [
			      { "type": "tableRow", "content": [
			         { "type": "tableCell", "content": [ { "type": "paragraph",
			           "content": [ { "type": "text", "text": "A" } ] } ] } ] } ] } ] } }`,
			func(b string) string { return "keep" },
			"only paragraph and heading blocks can be deleted",
		},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			base := must.Value(NewADF([]byte(tc.data)))
			body := tc.editFn(renderBody(t, base, nil))

			// --- When ---
			_, err := base.Put(body, nil, nil, nil)

			// --- Then ---
			assert.ErrorContain(t, tc.wantErr, err)
		})
	}
}

func Test_ADF_Put_structural(t *testing.T) {
	// twoPara is a base document with two localId-tagged paragraphs.
	twoPara := `{ "adf": { "type": "doc", "content": [
	   { "type": "paragraph", "attrs": { "localId": "p1" },
	     "content": [ { "type": "text", "text": "alpha" } ] },
	   { "type": "paragraph", "attrs": { "localId": "p2" },
	     "content": [ { "type": "text", "text": "beta" } ] } ] } }`
	texts := func(a *ADF) []string {
		var out []string
		for _, n := range a.Doc.Content {
			out = append(out, n.Content[0].Text)
		}
		return out
	}

	t.Run("inserting a paragraph appends a new node", func(t *testing.T) {
		base := must.Value(NewADF([]byte(twoPara)))
		out := must.Value(base.Put("alpha\n\nbeta\n\ngamma", nil, nil, nil))
		assert.Equal(t, []string{"alpha", "beta", "gamma"}, texts(out))
	})

	t.Run("deleting a paragraph keeps the survivor id", func(t *testing.T) {
		base := must.Value(NewADF([]byte(twoPara)))
		out := must.Value(base.Put("alpha", nil, nil, nil))
		assert.Equal(t, []string{"alpha"}, texts(out))
		assert.Equal(t, "p1", out.Doc.Content[0].attrStr("localId"))
	})

	t.Run("reordering paragraphs swaps them", func(t *testing.T) {
		base := must.Value(NewADF([]byte(twoPara)))
		out := must.Value(base.Put("beta\n\nalpha", nil, nil, nil))
		assert.Equal(t, []string{"beta", "alpha"}, texts(out))
	})

	t.Run("splitting a paragraph yields two", func(t *testing.T) {
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" },
		     "content": [ { "type": "text", "text": "one two" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		out := must.Value(base.Put("one\n\ntwo", nil, nil, nil))
		assert.Equal(t, []string{"one", "two"}, texts(out))
	})

	t.Run("an inserted heading gets its level", func(t *testing.T) {
		base := must.Value(NewADF([]byte(twoPara)))
		out := must.Value(base.Put("## New\n\nalpha\n\nbeta", nil, nil, nil))
		assert.Equal(t, "heading", out.Doc.Content[0].Type)
		assert.Equal(t, 2, out.Doc.Content[0].attrInt("level"))
		assert.Equal(t, "New", out.Doc.Content[0].Content[0].Text)
	})

	t.Run("inserted paragraph carries an indent marker", func(t *testing.T) {
		base := must.Value(NewADF([]byte(twoPara)))
		out := must.Value(base.Put("alpha\n\nbeta\n\n2> deep", nil, nil, nil))
		assert.Equal(t, 2, out.Doc.Content[2].indentLevel())
	})

	// emptyTail is twoPara with a trailing empty paragraph, the invisible node
	// Confluence appends: it renders to nothing, so it carries no baseline block.
	emptyTail := `{ "adf": { "type": "doc", "content": [
	   { "type": "paragraph", "attrs": { "localId": "p1" },
	     "content": [ { "type": "text", "text": "alpha" } ] },
	   { "type": "paragraph", "attrs": { "localId": "p2" },
	     "content": [ { "type": "text", "text": "beta" } ] },
	   { "type": "paragraph", "attrs": { "localId": "tail" } } ] } }`

	t.Run("a trailing non-rendered node survives an insert", func(t *testing.T) {
		base := must.Value(NewADF([]byte(emptyTail)))
		out := must.Value(base.Put("alpha\n\nbeta\n\ngamma", nil, nil, nil))
		// The visible blocks are exactly the user's edit...
		assert.Equal(t, "alpha\n\nbeta\n\ngamma", renderBody(t, out, nil))
		// ...and the empty paragraph is kept, still last, so nothing is lost.
		last := out.Doc.Content[len(out.Doc.Content)-1]
		assert.Equal(t, "paragraph", last.Type)
		assert.Equal(t, "tail", last.attrStr("localId"))
		assert.Equal(t, 0, len(last.Content))
	})

	t.Run("a trailing non-rendered node survives a delete", func(t *testing.T) {
		base := must.Value(NewADF([]byte(emptyTail)))
		out := must.Value(base.Put("alpha", nil, nil, nil))
		assert.Equal(t, "alpha", renderBody(t, out, nil))
		last := out.Doc.Content[len(out.Doc.Content)-1]
		assert.Equal(t, "tail", last.attrStr("localId"))
	})

	t.Run("a non-rendered node between blocks stays anchored", func(t *testing.T) {
		// An empty paragraph sits between alpha and beta; it anchors to beta.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p1" },
		     "content": [ { "type": "text", "text": "alpha" } ] },
		   { "type": "paragraph", "attrs": { "localId": "gap" } },
		   { "type": "paragraph", "attrs": { "localId": "p2" },
		     "content": [ { "type": "text", "text": "beta" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		out := must.Value(base.Put("alpha\n\nbeta\n\ngamma", nil, nil, nil))
		assert.Equal(t, "alpha\n\nbeta\n\ngamma", renderBody(t, out, nil))
		// The empty paragraph is re-emitted just before its anchor, beta.
		assert.Equal(t, "gap", out.Doc.Content[1].attrStr("localId"))
		assert.Equal(t, "beta", out.Doc.Content[2].Content[0].Text)
	})

	t.Run("NR predecessor stays before a cross-kind replace", func(t *testing.T) {
		// Empty paragraph anchors to alpha; user replaces alpha with a heading
		// (different blockKind → insert + leftover delete). The gap must stay
		// before the new heading, not after it.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "gap" } },
		   { "type": "paragraph", "attrs": { "localId": "p1" },
		     "content": [ { "type": "text", "text": "alpha" } ] },
		   { "type": "paragraph", "attrs": { "localId": "p2" },
		     "content": [ { "type": "text", "text": "beta" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		out := must.Value(base.Put("# Head\n\nbeta", nil, nil, nil))

		assert.Equal(t, "# Head\n\nbeta", renderBody(t, out, nil))
		assert.Equal(t, "gap", out.Doc.Content[0].attrStr("localId"))
		assert.Equal(t, "heading", out.Doc.Content[1].Type)
		assert.Equal(t, "Head", out.Doc.Content[1].Content[0].Text)
		assert.Equal(t, "beta", out.Doc.Content[2].Content[0].Text)
	})

	t.Run("insert next to a modified list pairs by kind", func(t *testing.T) {
		// A paragraph precedes a two-item list. The user modifies the paragraph,
		// inserts a new paragraph, and adds a list item. Kind-aware pairing must
		// pair paragraph↔paragraph and list↔list, not mispair list↔paragraph.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" },
		     "content": [ { "type": "text", "text": "intro" } ] },
		   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
		      { "type": "listItem", "content": [ { "type": "paragraph",
		        "content": [ { "type": "text", "text": "one" } ] } ] },
		      { "type": "listItem", "content": [ { "type": "paragraph",
		        "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		out := must.Value(base.Put(
			"intro now\n\nadded para\n\n- one\n- two\n- three", nil, nil, nil))

		assert.Equal(t,
			"intro now\n\nadded para\n\n- one\n- two\n- three",
			renderBody(t, out, nil))
		// The list kept its id (paired as a modify, not dropped and re-inserted).
		list := out.Doc.Content[2]
		assert.Equal(t, "bulletList", list.Type)
		assert.Equal(t, "bl", list.attrStr("localId"))
		assert.Equal(t, 3, len(list.Content))
	})
}

func Test_ADF_Put_nested(t *testing.T) {
	bulletBase := `{ "adf": { "type": "doc", "content": [
	   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
	      { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "one" } ] } ] },
	      { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "two" } ] } ] },
	      { "type": "listItem", "attrs": { "localId": "li3" }, "content": [
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "three" } ] } ] } ] } ] } }`

	t.Run("editing one list item leaves the others intact", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(bulletBase)))
		body := strings.Replace(renderBody(t, base, nil), "two", "TWO now", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- only the middle item changed; ids stay put.
		list := out.Doc.Content[0]
		assert.Equal(t, "one", list.Content[0].Content[0].Content[0].Text)
		assert.Equal(t, "TWO now", list.Content[1].Content[0].Content[0].Text)
		assert.Equal(t, "three", list.Content[2].Content[0].Content[0].Text)
		assert.Equal(t, "li2", list.Content[1].attrStr("localId"))
	})

	// itemTexts returns the plain text of each item's paragraph in the list at
	// the given top-level index.
	itemTexts := func(a *ADF, listIdx int) []string {
		var out []string
		for _, li := range a.Doc.Content[listIdx].Content {
			out = append(out, li.Content[0].Content[0].Text)
		}
		return out
	}

	t.Run("deleting the last list item drops it", func(t *testing.T) {
		base := must.Value(NewADF([]byte(bulletBase)))
		out := must.Value(base.Put("- one\n- two", nil, nil, nil))
		assert.Equal(t, []string{"one", "two"}, itemTexts(out, 0))
	})

	t.Run("deleting a middle item keeps the survivors' ids", func(t *testing.T) {
		base := must.Value(NewADF([]byte(bulletBase)))
		out := must.Value(base.Put("- one\n- three", nil, nil, nil))
		list := out.Doc.Content[0]
		assert.Equal(t, []string{"one", "three"}, itemTexts(out, 0))
		assert.Equal(t, "li1", list.Content[0].attrStr("localId"))
		assert.Equal(t, "li3", list.Content[1].attrStr("localId"))
	})

	t.Run("appending a list item adds a fresh node", func(t *testing.T) {
		base := must.Value(NewADF([]byte(bulletBase)))
		out := must.Value(base.Put("- one\n- two\n- three\n- four", nil, nil, nil))
		list := out.Doc.Content[0]
		assert.Equal(t, []string{"one", "two", "three", "four"}, itemTexts(out, 0))
		// The inserted item carries no localId; Confluence assigns one on save.
		assert.Equal(t, "", list.Content[3].attrStr("localId"))
		assert.Equal(t, "listItem", list.Content[3].Type)
	})

	t.Run("inserting a list item in the middle keeps order", func(t *testing.T) {
		base := must.Value(NewADF([]byte(bulletBase)))
		out := must.Value(
			base.Put("- one\n- two\n- inserted\n- three", nil, nil, nil))
		assert.Equal(t,
			[]string{"one", "two", "inserted", "three"}, itemTexts(out, 0))
		// Survivor ids stay put around the insertion.
		list := out.Doc.Content[0]
		assert.Equal(t, "li3", list.Content[3].attrStr("localId"))
	})

	t.Run("modifying and inserting an item together", func(t *testing.T) {
		base := must.Value(NewADF([]byte(bulletBase)))
		out := must.Value(
			base.Put("- ONE now\n- two\n- added\n- three", nil, nil, nil))
		assert.Equal(t,
			[]string{"ONE now", "two", "added", "three"}, itemTexts(out, 0))
		assert.Equal(t, "li1", out.Doc.Content[0].Content[0].attrStr("localId"))
	})

	t.Run("edits one paragraph of a list item", func(t *testing.T) {
		// --- Given --- a list whose first item has two paragraphs.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
		      { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
		         { "type": "paragraph",
		           "content": [ { "type": "text", "text": "lead para" } ] },
		         { "type": "paragraph",
		           "content": [ { "type": "text", "text": "follow para" } ] } ] },
		      { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
		         { "type": "paragraph",
		           "content": [ { "type": "text", "text": "plain" } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "follow para", "FOLLOW", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- both paragraphs survive in order, only one changed.
		li1 := out.Doc.Content[0].Content[0]
		assert.Equal(t, "li1", li1.attrStr("localId"))
		assert.Equal(t, 2, len(li1.Content))
		assert.Equal(t, "lead para", li1.Content[0].Content[0].Text)
		assert.Equal(t, "FOLLOW", li1.Content[1].Content[0].Text)
		nested := out.Doc.Content[0].Content[1].Content[0].Content[0]
		assert.Equal(t, "plain", nested.Text)
	})

	t.Run("hard break sibling survives when another item is edited", func(t *testing.T) {
		// --- Given --- one item with a hardBreak; edit a different item.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
		      { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
		         { "type": "paragraph", "content": [
		            { "type": "text", "text": "alpha" },
		            { "type": "hardBreak" },
		            { "type": "text", "text": "beta" } ] } ] },
		      { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
		         { "type": "paragraph",
		           "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "two", "TWO", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- hardBreak and both segments of li1 stay put.
		p1 := out.Doc.Content[0].Content[0].Content[0]
		assert.Equal(t, 3, len(p1.Content))
		assert.Equal(t, "alpha", p1.Content[0].Text)
		assert.Equal(t, "hardBreak", p1.Content[1].Type)
		assert.Equal(t, "beta", p1.Content[2].Text)
		assert.Equal(t, "TWO",
			out.Doc.Content[0].Content[1].Content[0].Content[0].Text)
	})

	t.Run("edits list item text while keeping its hard break", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
		      { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
		         { "type": "paragraph", "content": [
		            { "type": "text", "text": "alpha" },
		            { "type": "hardBreak" },
		            { "type": "text", "text": "beta" } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "alpha", "ALPHA", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		p1 := out.Doc.Content[0].Content[0].Content[0]
		assert.Equal(t, 3, len(p1.Content))
		assert.Equal(t, "ALPHA", p1.Content[0].Text)
		assert.Equal(t, "hardBreak", p1.Content[1].Type)
		assert.Equal(t, "beta", p1.Content[2].Text)
	})

	t.Run("editing panel body text keeps its type", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
		     "content": [ { "type": "paragraph",
		       "content": [ { "type": "text", "text": "hello world" } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "hello world", "bye now", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		panel := out.Doc.Content[0]
		assert.Equal(t, "info", panel.attrStr("panelType"))
		assert.Equal(t, "bye now", panel.Content[0].Content[0].Text)
	})

	t.Run("editing one paragraph of a multi-paragraph panel", func(t *testing.T) {
		// --- Given --- a two-paragraph panel; the tag line stays frozen.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "panel", "attrs": { "panelType": "warning", "localId": "pn" },
		     "content": [
		        { "type": "paragraph",
		          "content": [ { "type": "text", "text": "top note" } ] },
		        { "type": "paragraph",
		          "content": [ { "type": "text", "text": "low note" } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "low note", "LOW", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		panel := out.Doc.Content[0]
		assert.Equal(t, "warning", panel.attrStr("panelType"))
		assert.Equal(t, 2, len(panel.Content))
		assert.Equal(t, "top note", panel.Content[0].Content[0].Text)
		assert.Equal(t, "LOW", panel.Content[1].Content[0].Text)
	})
}

func Test_ADF_Put_orderedList(t *testing.T) {
	orderedBase := `{ "adf": { "type": "doc", "content": [
	   { "type": "orderedList",
	     "attrs": { "localId": "ol", "order": 1 }, "content": [
	      { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "one" } ] } ] },
	      { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "two" } ] } ] },
	      { "type": "listItem", "attrs": { "localId": "li3" }, "content": [
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "three" } ] } ] } ] } ] } }`

	// itemTexts returns the plain text of each item's paragraph in the list at
	// the top level.
	itemTexts := func(a *ADF) []string {
		var out []string
		for _, li := range a.Doc.Content[0].Content {
			out = append(out, li.Content[0].Content[0].Text)
		}
		return out
	}

	t.Run("an unedited list renders as a numbered block", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(orderedBase)))

		// --- When ---
		have := renderBody(t, base, nil)

		// --- Then ---
		assert.Equal(t, "1. one\n2. two\n3. three", have)
	})

	t.Run("editing one item leaves the others and ids intact", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(orderedBase)))
		body := strings.Replace(renderBody(t, base, nil), "two", "TWO now", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		assert.Equal(t, []string{"one", "TWO now", "three"}, itemTexts(out))
		assert.Equal(t, "li2", out.Doc.Content[0].Content[1].attrStr("localId"))
	})

	t.Run("deleting an item renumbers the survivors", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(orderedBase)))

		// --- When ---
		out := must.Value(base.Put("1. one\n2. three", nil, nil, nil))

		// --- Then --- the survivors renumber 1, 2 and keep their ids.
		assert.Equal(t, []string{"one", "three"}, itemTexts(out))
		assert.Equal(t, "1. one\n2. three", renderBody(t, out, nil))
		assert.Equal(t, "li3", out.Doc.Content[0].Content[1].attrStr("localId"))
	})

	t.Run("inserting an item adds a fresh idless node", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(orderedBase)))

		// --- When ---
		out := must.Value(
			base.Put("1. one\n2. two\n3. added\n4. three", nil, nil, nil))

		// --- Then --- the inserted item carries no localId (Confluence mints it).
		assert.Equal(t,
			[]string{"one", "two", "added", "three"}, itemTexts(out))
		assert.Equal(t, "", out.Doc.Content[0].Content[2].attrStr("localId"))
	})
}

func Test_ADF_Put_image(t *testing.T) {
	base := `{ "adf": { "type": "doc", "content": [
	   { "type": "paragraph", "attrs": { "localId": "p" },
	     "content": [ { "type": "text", "text": "intro" } ] } ] } }`

	t.Run("inserting an uploaded image adds a media node", func(t *testing.T) {
		// --- Given --- the user added a lone image block after the paragraph.
		adf := must.Value(NewADF([]byte(base)))
		img := NewImage{
			Path: "pics/new.png", Alt: "shot", FileID: "F9",
			LocalID: "abc123def456", Collection: "contentId-42",
		}

		// --- When ---
		out := must.Value(adf.Put(
			"intro\n\n![shot](pics/new.png)", nil, nil, []NewImage{img}))

		// --- Then --- a mediaSingle+media node carries the upload's attributes.
		assert.Equal(t, 2, len(out.Doc.Content))
		media := out.Doc.Content[1]
		assert.Equal(t, "mediaSingle", media.Type)
		assert.Equal(t, 1, len(media.Content))
		file := media.Content[0]
		assert.Equal(t, "media", file.Type)
		assert.Equal(t, "file", file.attrStr("type"))
		assert.Equal(t, "F9", file.attrStr("id"))
		assert.Equal(t, "abc123def456", file.attrStr("localId"))
		assert.Equal(t, "contentId-42", file.attrStr("collection"))
		assert.Equal(t, "shot", file.attrStr("alt"))
	})

	t.Run("inserting an image with no upload is rejected", func(t *testing.T) {
		// --- Given --- no NewImage names the path, so there is no attachment.
		adf := must.Value(NewADF([]byte(base)))

		// --- When ---
		_, err := adf.Put("intro\n\n![x](untracked.png)", nil, nil, nil)

		// --- Then ---
		want := `image "untracked.png" has no uploaded attachment`
		assert.ErrorContain(t, want, err)
	})
}

func Test_ADF_Put_realPageRoundTrips(t *testing.T) {
	// GetPut on real data: pushing the root page's unchanged rendered body back
	// must yield a byte-identical document, exercising its table (with a
	// colspan) and every other node through the lens.
	// --- Given ---
	data := must.Value(os.ReadFile("testdata/root_page_1.v5.json"))
	base := must.Value(NewADF(data))
	body := renderBody(t, base, nil)

	// --- When ---
	out, err := base.Put(body, nil, nil, nil)

	// --- Then ---
	assert.NoError(t, err)
	assert.Equal(t,
		string(must.Value(json.Marshal(base))),
		string(must.Value(json.Marshal(out))))
}

func Test_ADF_Put_blockquote(t *testing.T) {
	single := `{ "adf": { "type": "doc", "content": [
	   { "type": "blockquote", "attrs": { "localId": "bq" }, "content": [
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "hello world" } ] } ] } ] } }`

	t.Run("editing the body keeps the blockquote type and id", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(single)))
		body := strings.Replace(renderBody(t, base, nil), "hello world", "bye now", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		bq := out.Doc.Content[0]
		assert.Equal(t, "blockquote", bq.Type)
		assert.Equal(t, "bq", bq.attrStr("localId"))
		assert.Equal(t, "bye now", bq.Content[0].Content[0].Text)
	})

	t.Run("an unedited blockquote round-trips (GetPut)", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(single)))
		body := renderBody(t, base, nil)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		assert.Equal(t,
			string(must.Value(json.Marshal(base))),
			string(must.Value(json.Marshal(out))))
	})

	multiPara := `{ "adf": { "type": "doc", "content": [
	   { "type": "blockquote", "attrs": { "localId": "bq" }, "content": [
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "first para" } ] },
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "second para" } ] } ] } ] } }`

	t.Run("edits one paragraph of a blockquote", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(multiPara)))
		body := strings.Replace(renderBody(t, base, nil), "first para", "FIRST", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- only the edited paragraph changed; both survive in order.
		bq := out.Doc.Content[0]
		assert.Equal(t, 2, len(bq.Content))
		assert.Equal(t, "FIRST", bq.Content[0].Content[0].Text)
		assert.Equal(t, "second para", bq.Content[1].Content[0].Text)
	})

	t.Run("adding a paragraph to a blockquote is rejected", func(t *testing.T) {
		// --- Given --- a new "> extra" paragraph appended after a ">" separator.
		base := must.Value(NewADF([]byte(multiPara)))
		body := renderBody(t, base, nil) + "\n>\n> extra"

		// --- When ---
		_, err := base.Put(body, nil, nil, nil)

		// --- Then ---
		assert.ErrorContain(t, "add or remove a paragraph", err)
	})
}

func Test_ADF_Put_expand(t *testing.T) {
	single := `{ "adf": { "type": "doc", "content": [
	   { "type": "expand", "attrs": { "localId": "x1", "title": "Details" },
	     "content": [
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "hello world" } ] } ] } ] } }`

	t.Run("editing the body keeps the type, id and title", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(single)))
		body := strings.Replace(renderBody(t, base, nil), "hello world", "bye now", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		exp := out.Doc.Content[0]
		assert.Equal(t, "expand", exp.Type)
		assert.Equal(t, "x1", exp.attrStr("localId"))
		assert.Equal(t, "Details", exp.attrStr("title"))
		assert.Equal(t, "bye now", exp.Content[0].Content[0].Text)
	})

	t.Run("editing the title on the tag line pushes it", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(single)))
		body := strings.Replace(renderBody(t, base, nil), "Details", "More", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- only the title changed; body and id survive.
		exp := out.Doc.Content[0]
		assert.Equal(t, "More", exp.attrStr("title"))
		assert.Equal(t, "hello world", exp.Content[0].Content[0].Text)
	})

	t.Run("an unedited expand round-trips (GetPut)", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(single)))
		body := renderBody(t, base, nil)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		assert.Equal(t,
			string(must.Value(json.Marshal(base))),
			string(must.Value(json.Marshal(out))))
	})

	empty := `{ "adf": { "type": "doc", "content": [
	   { "type": "expand", "attrs": { "localId": "x1" }, "content": [
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "body" } ] } ] } ] } }`

	t.Run("an untitled expand round-trips through a bare tag", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(empty)))
		body := renderBody(t, base, nil)

		// --- Then --- the tag is bare, and the body-only edit adds no title.
		assert.Equal(t, "> [!EXPAND]\n> body", body)
		out := must.Value(base.Put(body, nil, nil, nil))
		assert.Equal(t, "", out.Doc.Content[0].attrStr("title"))
	})

	multiBlock := `{ "adf": { "type": "doc", "content": [
	   { "type": "expand", "attrs": { "localId": "x1", "title": "T" },
	     "content": [
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "para one" } ] },
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "para two" } ] } ] } ] } }`

	t.Run("adding a paragraph to an expand is rejected", func(t *testing.T) {
		// --- Given --- a new paragraph appended after a ">" separator.
		base := must.Value(NewADF([]byte(multiBlock)))
		body := renderBody(t, base, nil) + "\n>\n> extra"

		// --- When ---
		_, err := base.Put(body, nil, nil, nil)

		// --- Then ---
		assert.ErrorContain(t, "add or remove a paragraph", err)
	})
}

func Test_ADF_Put_table(t *testing.T) {
	// headerRow is a table whose first row is all headers, so it renders as a
	// GFM header row over two data rows.
	headerRow := `{ "adf": { "type": "doc", "content": [
	   { "type": "table", "attrs": { "localId": "t" }, "content": [
	      { "type": "tableRow", "content": [
	         { "type": "tableHeader", "content": [ { "type": "paragraph",
	           "content": [ { "type": "text", "text": "Key" } ] } ] },
	         { "type": "tableHeader", "content": [ { "type": "paragraph",
	           "content": [ { "type": "text", "text": "Val" } ] } ] } ] },
	      { "type": "tableRow", "content": [
	         { "type": "tableCell", "attrs": { "localId": "c1" },
	           "content": [ { "type": "paragraph",
	             "content": [ { "type": "text", "text": "one" } ] } ] },
	         { "type": "tableCell", "content": [ { "type": "paragraph",
	           "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } ] } }`

	cell := func(a *ADF, row, col int) Node {
		return a.Doc.Content[0].Content[row].Content[col]
	}

	t.Run("editing a data cell keeps structure and localId", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(headerRow)))
		body := strings.Replace(renderBody(t, base, nil), "one", "ONE", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- only the edited cell changed; type and id are intact.
		c1 := cell(out, 1, 0)
		assert.Equal(t, "tableCell", c1.Type)
		assert.Equal(t, "c1", c1.attrStr("localId"))
		assert.Equal(t, "ONE", c1.Content[0].Content[0].Text)
		assert.Equal(t, "two", cell(out, 1, 1).Content[0].Content[0].Text)
		assert.Equal(t, "Key", cell(out, 0, 0).Content[0].Content[0].Text)
	})

	t.Run("editing one paragraph of a multi-paragraph cell", func(t *testing.T) {
		// --- Given --- a cell holding two paragraphs, rendered "one<br>two".
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "table", "attrs": { "localId": "t" }, "content": [
		      { "type": "tableRow", "content": [
		         { "type": "tableCell", "attrs": { "localId": "c" }, "content": [
		           { "type": "paragraph",
		             "content": [ { "type": "text", "text": "one" } ] },
		           { "type": "paragraph",
		             "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		self := renderBody(t, base, nil)
		assert.Contain(t, "one<br>two", self)
		body := strings.Replace(self, "one<br>two", "ONE<br>two", 1)

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then --- only the first paragraph changed; the cell, its localId and
		// its second paragraph are intact.
		assert.NoError(t, err)
		c := cell(out, 0, 0)
		assert.Equal(t, "c", c.attrStr("localId"))
		assert.Equal(t, 2, len(c.Content))
		assert.Equal(t, "ONE", c.Content[0].Content[0].Text)
		assert.Equal(t, "two", c.Content[1].Content[0].Text)
	})

	t.Run("editing a header cell adds a strong mark inline", func(t *testing.T) {
		// --- Given --- the header cell text itself is edited (still a header).
		base := must.Value(NewADF([]byte(headerRow)))
		body := strings.Replace(renderBody(t, base, nil), "Key", "Name", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		h := cell(out, 0, 0)
		assert.Equal(t, "tableHeader", h.Type)
		assert.Equal(t, "Name", h.Content[0].Content[0].Text)
	})

	t.Run("editing a bold header cell strips the bold", func(t *testing.T) {
		// --- Given --- a table with no all-header first row: its header cell is
		// rendered bolded as data under a blank synthetic header.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "table", "attrs": { "localId": "t" }, "content": [
		      { "type": "tableRow", "content": [
		         { "type": "tableHeader", "content": [ { "type": "paragraph",
		           "content": [ { "type": "text", "text": "RowH" } ] } ] },
		         { "type": "tableCell", "content": [ { "type": "paragraph",
		           "content": [ { "type": "text", "text": "v1" } ] } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "**RowH**", "**NewH**", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then --- the header keeps its type and holds the un-bolded text.
		h := cell(out, 0, 0)
		assert.Equal(t, "tableHeader", h.Type)
		assert.Equal(t, 1, len(h.Content[0].Content))
		assert.Equal(t, "NewH", h.Content[0].Content[0].Text)
	})

	t.Run("editing a spanning cell keeps its colspan", func(t *testing.T) {
		// --- Given --- an origin cell that spans two columns.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "table", "attrs": { "localId": "t" }, "content": [
		      { "type": "tableRow", "content": [
		         { "type": "tableCell", "attrs": { "colspan": 2 },
		           "content": [ { "type": "paragraph",
		             "content": [ { "type": "text", "text": "wide" } ] } ] } ] },
		      { "type": "tableRow", "content": [
		         { "type": "tableCell", "content": [ { "type": "paragraph",
		           "content": [ { "type": "text", "text": "l" } ] } ] },
		         { "type": "tableCell", "content": [ { "type": "paragraph",
		           "content": [ { "type": "text", "text": "r" } ] } ] } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil), "wide", "WIDE", 1)

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		wide := cell(out, 0, 0)
		assert.Equal(t, 2, wide.attrInt("colspan"))
		assert.Equal(t, "WIDE", wide.Content[0].Content[0].Text)
	})

	t.Run("editing one cell of the real page table", func(t *testing.T) {
		// --- Given --- the root page's table has a link, a mention and a
		// colspan in neighboring cells, all of which must survive the edit.
		data := must.Value(os.ReadFile("testdata/root_page_1.v5.json"))
		base := must.Value(NewADF([]byte(data)))
		body := strings.Replace(renderBody(t, base, nil),
			"Access window", "Access period", 1)

		// --- When ---
		out, err := base.Put(body, nil, nil, nil)

		// --- Then --- the edit lands and the rest of the document is intact.
		assert.NoError(t, err)
		md := string(must.Value(out.MarshallMarkdown(nil)))
		assert.Contain(t, "Access period", md)
		assert.Contain(t, "[the spec](https://example.com/spec)", md)
		assert.Contain(t, "[[@Jane Doe]]", md)
	})

	t.Run("changing the column count is rejected", func(t *testing.T) {
		// --- Given --- a third column appended to the data row.
		base := must.Value(NewADF([]byte(headerRow)))
		body := strings.Replace(renderBody(t, base, nil),
			"| one ", "| one | x ", 1)

		// --- When ---
		_, err := base.Put(body, nil, nil, nil)

		// --- Then ---
		assert.ErrorContain(t, "number of table columns", err)
	})
}

func FuzzMerge(f *testing.F) {
	// A fixed base with a heading, a marked paragraph, a bullet list and a
	// panel, so the fuzzer exercises structural and nested-container edits too.
	data := `{ "adf": { "type": "doc", "content": [
	   { "type": "heading", "attrs": { "level": 2, "localId": "h" },
	     "content": [ { "type": "text", "text": "Title" } ] },
	   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
	      { "type": "text", "text": "hello " },
	      { "type": "text", "text": "world", "marks": [ { "type": "strong" } ] },
	      { "type": "text", "text": " and ",
	        "marks": [ { "type": "underline" } ] },
	      { "type": "text", "text": "hue", "marks": [
	        { "type": "textColor", "attrs": { "color": "#ff0000" } } ] } ] },
	   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
	      { "type": "listItem", "content": [
	         { "type": "paragraph",
	           "content": [ { "type": "text", "text": "alpha" } ] },
	         { "type": "paragraph",
	           "content": [ { "type": "text", "text": "alpha two" } ] } ] },
	      { "type": "listItem", "content": [
	         { "type": "paragraph",
	           "content": [ { "type": "text", "text": "beta" } ] },
	         { "type": "bulletList", "content": [
	            { "type": "listItem", "content": [ { "type": "paragraph",
	              "content": [ { "type": "text", "text": "beta sub" } ] } ] } ] } ] } ] },
	   { "type": "codeBlock", "attrs": { "localId": "cb", "language": "go" },
	     "content": [ { "type": "text", "text": "n := 1\nm := 2" } ] },
	   { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
	     "content": [
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "note here" } ] },
	        { "type": "paragraph",
	          "content": [ { "type": "text", "text": "note two" } ] } ] },
	   { "type": "blockquote", "attrs": { "localId": "bq" }, "content": [
	      { "type": "paragraph",
	        "content": [ { "type": "text", "text": "quoted line" } ] } ] },
	   { "type": "table", "attrs": { "localId": "tb" }, "content": [
	      { "type": "tableRow", "content": [
	         { "type": "tableHeader", "content": [ { "type": "paragraph",
	           "content": [ { "type": "text", "text": "Key" } ] } ] },
	         { "type": "tableHeader", "content": [ { "type": "paragraph",
	           "content": [ { "type": "text", "text": "Val" } ] } ] } ] },
	      { "type": "tableRow", "content": [
	         { "type": "tableCell", "content": [
	           { "type": "paragraph",
	             "content": [ { "type": "text", "text": "one" } ] },
	           { "type": "paragraph",
	             "content": [ { "type": "text", "text": "cell two" } ] } ] },
	         { "type": "tableCell", "content": [ { "type": "paragraph",
	           "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } ] } }`
	base := must.Value(NewADF([]byte(data)))
	pc := parseCtx{mentions: map[string]string{"Ann": "A"}}

	self := renderBody(&testing.T{}, base, nil)
	f.Add(self)
	f.Add("## Title\n\nhello **world**")
	f.Add("## Changed\n\nhello **world**")
	f.Add("## Title\n\nhello **world** and more")
	f.Add(strings.Replace(self, "hue", "COLOR", 1))
	f.Add(strings.Replace(self, "<u> and </u>", " plain ", 1))
	f.Add("## Title\n\n1> hello **world**")
	f.Add("## Title\n\nhello [[!OK|color=green]] world")
	f.Add("## Title\n\nsee <https://example.com/x> now")
	f.Add(strings.Replace(self, "alpha", "ALPHA edited", 1))
	f.Add(strings.Replace(self, "note here", "note edited", 1))
	f.Add(strings.Replace(self, "one", "ONE cell", 1))
	f.Add(strings.Replace(self, "quoted line", "QUOTED", 1))
	f.Add(strings.Replace(self, "alpha two", "ALPHA TWO edited", 1))
	f.Add(strings.Replace(self, "note two", "note two edited", 1))
	f.Add(strings.Replace(self, "one<br>cell two", "ONE<br>cell two", 1))
	f.Add(strings.Replace(self, "one<br>cell two", "merged", 1))
	f.Add(strings.Replace(self, "beta sub", "beta SUB edited", 1))
	f.Add(strings.Replace(self, "n := 1", "n := 9", 1))
	f.Add("")
	f.Fuzz(func(t *testing.T, body string) {
		// Put must never panic on arbitrary edited bodies. It may reject.
		out, err := base.Put(body, pc.mentions, nil, nil)
		if err == nil && out == nil {
			t.Fatal("nil document with nil error")
		}
	})

	// GetPut: the unchanged body always rebuilds identically.
	out, err := base.Put(self, pc.mentions, nil, nil)
	if err != nil {
		f.Fatalf("GetPut round-trip errored: %v", err)
	}
	if string(must.Value(json.Marshal(base))) !=
		string(must.Value(json.Marshal(out))) {
		f.Fatal("GetPut: unchanged body did not rebuild identically")
	}
}

func Test_orderedMarkerWidth_tabular(t *testing.T) {
	tests := []struct {
		name string
		line string
		want int
	}{
		{"single digit marker", "1. item", 3},
		{"multi digit marker", "10. item", 4},
		{"leading zeros count", "007. item", 5},
		{"no marker", "- item", 0},
		{"digits without dot", "12 item", 0},
		{"dot without trailing space", "1.item", 0},
		{"digits then dot at end", "1.", 0},
		{"empty line", "", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			have := orderedMarkerWidth(tc.line)
			assert.Equal(t, tc.want, have)
		})
	}
}
