// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"strings"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_normalizeBlock_tabular(t *testing.T) {
	tt := []struct {
		testN string
		in    string
		want  string
	}{
		{"collapses soft wrap", "one two\nthree four", "one two three four"},
		{"trims and collapses runs", "  a   b\t c \n", "a b c"},
		{"keeps a hard break marker", "a\\\nb", "a\\ b"},
		{
			"canonicalizes a table, dropping padding and separator width",
			"| a | b |\n|-----|-----|\n| c | d |",
			"|a|b| |-| |c|d|",
		},
		{
			"a table with differing widths normalizes the same",
			"| a  | b |\n|---|---|\n| cc | d |",
			"|a|b| |-| |cc|d|",
		},
		{"empty stays empty", "   \n  ", ""},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			assert.Equal(t, tc.want, normalizeBlock(tc.in))
		})
	}
}

func Test_segmentBody(t *testing.T) {
	t.Run("splits on blank lines and trims", func(t *testing.T) {
		// --- Given ---
		body := "# Title\n\nfirst para\nwrapped\n\n\nsecond para\n"

		// --- When ---
		have := segmentBody(body)

		// --- Then ---
		assert.Equal(t, 3, len(have))
		assert.Equal(t, "# Title", have[0].Text)
		assert.Equal(t, "first para\nwrapped", have[1].Text)
		assert.Equal(t, "second para", have[2].Text)
	})

	t.Run("keeps a fenced code block whole", func(t *testing.T) {
		// --- Given ---
		body := "intro\n\n```go\nx := 1\n\ny := 2\n```\n\ntail"

		// --- When ---
		have := segmentBody(body)

		// --- Then --- the blank line inside the fence does not split it.
		assert.Equal(t, 3, len(have))
		assert.Equal(t, "intro", have[0].Text)
		assert.Equal(t, "```go\nx := 1\n\ny := 2\n```", have[1].Text)
		assert.Equal(t, "tail", have[2].Text)
	})

	t.Run("keeps a multi-paragraph list whole", func(t *testing.T) {
		// --- Given --- a list whose first item has two paragraphs.
		body := "intro\n\n- one lead\n\n  one follow\n- two\n\ntail"

		// --- When ---
		have := segmentBody(body)

		// --- Then --- the blank line inside the item does not split the list.
		assert.Equal(t, 3, len(have))
		assert.Equal(t, "intro", have[0].Text)
		assert.Equal(t, "- one lead\n\n  one follow\n- two", have[1].Text)
		assert.Equal(t, "tail", have[2].Text)
	})

	t.Run("a blank line after a list ends it", func(t *testing.T) {
		// --- Given --- a blank line followed by a non-indented paragraph.
		body := "- a\n- b\n\nafter"

		// --- When ---
		have := segmentBody(body)

		// --- Then ---
		assert.Equal(t, 2, len(have))
		assert.Equal(t, "- a\n- b", have[0].Text)
		assert.Equal(t, "after", have[1].Text)
	})

	t.Run("an empty body yields no blocks", func(t *testing.T) {
		assert.Equal(t, 0, len(segmentBody("")))
		assert.Equal(t, 0, len(segmentBody("\n\n  \n")))
	})
}

func Test_segmentBody_matches_render(t *testing.T) {
	// segmentBody must recover exactly the blocks the renderer emitted, so a
	// round-tripped body diffs cleanly against the baseline. Compare its output
	// against the source-map spans for the same render.

	// --- Given ---
	data := `{
	   "adf": { "type": "doc", "content": [
	      { "type": "heading", "attrs": { "level": 1, "localId": "h" },
	        "content": [ { "type": "text", "text": "Heading" } ] },
	      { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
	         { "type": "text", "text": "` + strings.Repeat("word ", 30) + `" } ] },
	      { "type": "bulletList", "content": [
	         { "type": "listItem", "content": [ { "type": "paragraph", "content": [
	            { "type": "text", "text": "item one" } ] } ] },
	         { "type": "listItem", "content": [ { "type": "paragraph", "content": [
	            { "type": "text", "text": "item two" } ] } ] } ] }
	   ] }
	}`
	adf := must.Value(NewADF([]byte(data)))
	md, sm, err := adf.MarshallMarkdownMapped(nil)
	must.Nil(err)

	// Body is everything after the frontmatter blank line, minus the final "\n".
	body := strings.TrimSuffix(string(md[sm.BodyStart:]), "\n")

	// --- When ---
	have := segmentBody(body)

	// --- Then ---
	assert.Equal(t, len(sm.Origins), len(have))
	for i, o := range sm.Origins {
		assert.Equal(t, string(md[o.Span.Start:o.Span.End]), have[i].Text)
	}
}

func Test_ADF_baselineBlocks(t *testing.T) {
	// --- Given ---
	data := `{
	   "adf": { "type": "doc", "content": [
	      { "type": "paragraph", "attrs": { "localId": "p1" },
	        "content": [ { "type": "text", "text": "alpha" } ] },
	      { "type": "paragraph", "attrs": { "localId": "p2" },
	        "content": [ { "type": "text", "text": "beta" } ] }
	   ] }
	}`
	adf := must.Value(NewADF([]byte(data)))

	// --- When ---
	blocks, origins, err := adf.baselineBlocks(nil, nil)

	// --- Then ---
	assert.NoError(t, err)
	assert.Equal(t, 2, len(blocks))
	assert.Equal(t, "alpha", blocks[0].Text)
	assert.Equal(t, "beta", blocks[1].Text)
	assert.Equal(t, "p1", origins[0].LocalID)
	assert.Equal(t, "p2", origins[1].LocalID)
}
