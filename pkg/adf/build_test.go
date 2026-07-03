// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

// emptyDoc is a baseline with no content, the shape a page create starts from.
const emptyDoc = `{ "adf": { "type": "doc", "content": [] } }`

func Test_ADF_Put_insertRoundTrip_tabular(t *testing.T) {
	tt := []struct {
		testN    string
		body     string
		wantType string
	}{
		{
			"toc marker",
			"[[TOC]]",
			"extension",
		},
		{
			"code block with language",
			"```go\nx := 1\n```",
			"codeBlock",
		},
		{
			"code block without language",
			"```\nplain\n```",
			"codeBlock",
		},
		{
			"code block with blank lines and pipes",
			"```plaintext\n| a |\n\n| b |\n```",
			"codeBlock",
		},
		{
			"bullet list",
			"- one\n- two",
			"bulletList",
		},
		{
			"bullet list with inline formatting",
			"- `ID` is a **code**\n- plain",
			"bulletList",
		},
		{
			"ordered list",
			"1. one\n2. two",
			"orderedList",
		},
		{
			"ordered list starting past one",
			"3. three\n4. four",
			"orderedList",
		},
		{
			"blockquote",
			"> hello",
			"blockquote",
		},
		{
			"blockquote with two paragraphs",
			"> alpha\n>\n> beta",
			"blockquote",
		},
		{
			"note panel",
			"> [!NOTE]\n> body",
			"panel",
		},
		{
			"warning panel",
			"> [!WARNING]\n> body",
			"panel",
		},
		{
			"expand with title",
			"> [!EXPAND] More detail\n> body",
			"expand",
		},
		{
			"expand without title",
			"> [!EXPAND]\n> body",
			"expand",
		},
		{
			"table with header row",
			"| a | b |\n|---|---|\n| 1 | 2 |",
			"table",
		},
		{
			"table without header row",
			"|   |   |\n|---|---|\n| k | v |",
			"table",
		},
		{
			"table with escaped pipe",
			"| a \\| b |\n|--------|\n| c      |",
			"table",
		},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			base := must.Value(NewADF([]byte(emptyDoc)))

			// --- When ---
			out := must.Value(base.Put(tc.body, nil, nil, nil))

			// --- Then ---
			assert.Equal(t, tc.body, renderBody(t, out, nil))
			assert.Equal(t, tc.wantType, out.Doc.Content[0].Type)
		})
	}
}

func Test_ADF_Put_insertToc(t *testing.T) {
	// --- Given ---
	base := must.Value(NewADF([]byte(emptyDoc)))

	// --- When ---
	out := must.Value(base.Put("[[TOC]]", nil, nil, nil))

	// --- Then ---
	node := out.Doc.Content[0]
	assert.Equal(t, "extension", node.Type)
	assert.Equal(t, "toc", node.attrStr("extensionKey"))
	want := "com.atlassian.confluence.macro.core"
	assert.Equal(t, want, node.attrStr("extensionType"))
	assert.Equal(t, "default", node.attrStr("layout"))
}

func Test_ADF_Put_insertCodeBlock(t *testing.T) {
	t.Run("language and body", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))

		// --- When ---
		out := must.Value(base.Put("```go\nx := 1\ny := 2\n```", nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, "codeBlock", node.Type)
		assert.Equal(t, "go", node.attrStr("language"))
		assert.Equal(t, "x := 1\ny := 2", node.codeText())
	})

	t.Run("empty body", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))

		// --- When ---
		out := must.Value(base.Put("```\n\n```", nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, "codeBlock", node.Type)
		assert.Equal(t, "", node.codeText())
	})
}

func Test_ADF_Put_insertBulletList(t *testing.T) {
	// --- Given ---
	base := must.Value(NewADF([]byte(emptyDoc)))
	body := "- one\n- two wrapped\n  over lines"

	// --- When ---
	out := must.Value(base.Put(body, nil, nil, nil))

	// --- Then ---
	node := out.Doc.Content[0]
	assert.Equal(t, "bulletList", node.Type)
	assert.Equal(t, 2, len(node.Content))
	assert.Equal(t, "listItem", node.Content[0].Type)
	assert.Equal(t, "one", node.Content[0].Content[0].Content[0].Text)
	assert.Equal(t, "listItem", node.Content[1].Type)
}

func Test_ADF_Put_insertOrderedList(t *testing.T) {
	t.Run("starting at one omits the order attribute", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))

		// --- When ---
		out := must.Value(base.Put("1. one\n2. two", nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, "orderedList", node.Type)
		assert.Equal(t, 2, len(node.Content))
		assert.Nil(t, node.Attrs)
	})

	t.Run("starting past one records the start", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))

		// --- When ---
		out := must.Value(base.Put("3. three\n4. four", nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, "orderedList", node.Type)
		assert.Equal(t, 3, node.attrInt("order"))
	})
}

func Test_ADF_Put_insertPanel(t *testing.T) {
	// --- Given ---
	base := must.Value(NewADF([]byte(emptyDoc)))

	// --- When ---
	out := must.Value(base.Put("> [!SUCCESS]\n> alpha\n>\n> beta", nil, nil, nil))

	// --- Then ---
	node := out.Doc.Content[0]
	assert.Equal(t, "panel", node.Type)
	assert.Equal(t, "success", node.attrStr("panelType"))
	assert.Equal(t, 2, len(node.Content))
	assert.Equal(t, "paragraph", node.Content[0].Type)
	assert.Equal(t, "alpha", node.Content[0].Content[0].Text)
}

func Test_ADF_Put_insertExpand(t *testing.T) {
	t.Run("with title", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))

		// --- When ---
		out := must.Value(base.Put("> [!EXPAND] More\n> body", nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, "expand", node.Type)
		assert.Equal(t, "More", node.attrStr("title"))
	})

	t.Run("without title", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))

		// --- When ---
		out := must.Value(base.Put("> [!EXPAND]\n> body", nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, "expand", node.Type)
		assert.Nil(t, node.Attrs)
	})
}

func Test_ADF_Put_insertTable(t *testing.T) {
	t.Run("header row becomes tableHeader cells", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))
		body := "| a | b |\n|---|---|\n| 1 | 2 |"

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, "table", node.Type)
		assert.Equal(t, 2, len(node.Content))
		assert.Equal(t, "tableHeader", node.Content[0].Content[0].Type)
		assert.Equal(t, "tableHeader", node.Content[0].Content[1].Type)
		assert.Equal(t, "tableCell", node.Content[1].Content[0].Type)
		cell := node.Content[1].Content[0]
		assert.Equal(t, "1", cell.Content[0].Content[0].Text)
	})

	t.Run("blank header row yields no header cells", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))
		body := "|   |   |\n|---|---|\n| k | v |"

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		node := out.Doc.Content[0]
		assert.Equal(t, 1, len(node.Content))
		assert.Equal(t, "tableCell", node.Content[0].Content[0].Type)
	})

	t.Run("br splits a cell into paragraphs", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))
		body := "| h      |\n|--------|\n| a<br>b |"

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		cell := out.Doc.Content[0].Content[1].Content[0]
		assert.Equal(t, 2, len(cell.Content))
		assert.Equal(t, "a", cell.Content[0].Content[0].Text)
		assert.Equal(t, "b", cell.Content[1].Content[0].Text)
	})

	t.Run("escaped pipe stays inside its cell", func(t *testing.T) {
		// --- Given ---
		base := must.Value(NewADF([]byte(emptyDoc)))
		body := "| a \\| b |\n|--------|\n| c      |"

		// --- When ---
		out := must.Value(base.Put(body, nil, nil, nil))

		// --- Then ---
		cell := out.Doc.Content[0].Content[0].Content[0]
		assert.Equal(t, "a | b", cell.Content[0].Content[0].Text)
	})
}

func Test_ADF_Put_insertIntoExisting(t *testing.T) {
	// --- Given ---
	data := `{ "adf": { "type": "doc", "content": [
	   { "type": "paragraph", "attrs": { "localId": "p1" },
	     "content": [ { "type": "text", "text": "alpha" } ] } ] } }`
	base := must.Value(NewADF([]byte(data)))
	body := "alpha\n\n- one\n- two"

	// --- When ---
	out := must.Value(base.Put(body, nil, nil, nil))

	// --- Then ---
	assert.Equal(t, body, renderBody(t, out, nil))
	assert.Equal(t, "p1", out.Doc.Content[0].attrStr("localId"))
	assert.Equal(t, "bulletList", out.Doc.Content[1].Type)
}

func Test_ADF_Put_insertRejects_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		body    string
		wantErr string
	}{
		{
			"star bullet marker",
			"* one\n* two",
			"write bullet items with a \"- \" marker",
		},
		{
			"plus bullet marker",
			"+ one",
			"write bullet items with a \"- \" marker",
		},
		{
			"nested list in a bullet list",
			"- one\n  - nested",
			"a nested block cannot be inserted",
		},
		{
			"nested list in an ordered list",
			"1. one\n   - nested",
			"a nested block cannot be inserted",
		},
		{
			"multi-paragraph list item",
			"- one\n\n  two",
			"only single-paragraph",
		},
		{
			"non-sequential ordered list",
			"1. one\n3. three",
			"items must be numbered sequentially",
		},
		{
			"table without separator row",
			"| a | b |",
			"needs a header and a separator row",
		},
		{
			"table with a malformed separator row",
			"| a | b |\n| x | y |\n| 1 | 2 |",
			"missing its '---' separator row",
		},
		{
			"table with ragged rows",
			"| a | b |\n|---|---|\n| 1 |",
			"every table row needs 2 cells",
		},
		{
			"table with a span marker",
			"| a | b |\n|---|---|\n| « | 2 |",
			"cell spans cannot be inserted",
		},
		{
			"unknown panel tag",
			"> [!BOGUS]\n> body",
			"unknown panel type",
		},
		{
			"custom panel tag",
			"> [!CUSTOM]\n> body",
			"unknown panel type",
		},
		{
			"panel without a body",
			"> [!NOTE]",
			"needs a body",
		},
		{
			"nested block in a blockquote",
			"> - item",
			"a nested block cannot be inserted",
		},
		{
			"toc marker with trailing text",
			"[[TOC]] extra",
			"cannot insert block",
		},
		{
			"anchor comment",
			"<!-- adf:unsupported -->",
			"cannot insert block",
		},
		{
			"image with no uploaded attachment",
			"![alt](missing.png)",
			"no uploaded attachment",
		},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			base := must.Value(NewADF([]byte(emptyDoc)))

			// --- When ---
			_, err := base.Put(tc.body, nil, nil, nil)

			// --- Then ---
			assert.ErrorContain(t, tc.wantErr, err)
		})
	}
}
