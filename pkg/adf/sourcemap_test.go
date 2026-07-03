// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_ADF_MarshallMarkdownMapped(t *testing.T) {
	t.Run("output is byte-identical to MarshallMarkdown", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "adf": { "type": "doc", "content": [
		      { "type": "heading", "attrs": { "level": 2, "localId": "h1" },
		        "content": [ { "type": "text", "text": "Title" } ] },
		      { "type": "paragraph", "attrs": { "localId": "p1" },
		        "content": [ { "type": "text", "text": "Hello world" } ] }
		   ] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		plain := must.Value(adf.MarshallMarkdown(nil))
		mapped, _, err := adf.MarshallMarkdownMapped(nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, string(plain), string(mapped))
	})

	t.Run("each top-level block maps to its source node", func(t *testing.T) {
		// --- Given --- an empty paragraph between blocks renders to nothing, so
		// it must be skipped and leave a gap in the node indices.
		data := `{
		   "adf": { "type": "doc", "content": [
		      { "type": "heading", "attrs": { "level": 2, "localId": "h1" },
		        "content": [ { "type": "text", "text": "Title" } ] },
		      { "type": "paragraph", "attrs": { "localId": "p1" },
		        "content": [ { "type": "text", "text": "Hello world" } ] },
		      { "type": "paragraph", "attrs": { "localId": "pEmpty" } },
		      { "type": "paragraph", "attrs": { "localId": "p2" },
		        "content": [ { "type": "text", "text": "Second" } ] }
		   ] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		md, sm, err := adf.MarshallMarkdownMapped(nil)

		// --- Then ---
		assert.NoError(t, err)
		want := []Origin{
			{NodeIndex: 0, Type: "heading", LocalID: "h1"},
			{NodeIndex: 1, Type: "paragraph", LocalID: "p1"},
			{NodeIndex: 3, Type: "paragraph", LocalID: "p2"},
		}
		assert.Equal(t, len(want), len(sm.Origins))
		for i, w := range want {
			have := sm.Origins[i]
			assert.Equal(t, w.NodeIndex, have.NodeIndex)
			assert.Equal(t, w.Type, have.Type)
			assert.Equal(t, w.LocalID, have.LocalID)
		}

		// The span of every origin slices out exactly that block's Markdown.
		span := func(i int) string {
			return string(md[sm.Origins[i].Span.Start:sm.Origins[i].Span.End])
		}
		assert.Equal(t, "## Title", span(0))
		assert.Equal(t, "Hello world", span(1))
		assert.Equal(t, "Second", span(2))
	})

	t.Run("spans are ordered and in bounds", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "adf": { "type": "doc", "content": [
		      { "type": "paragraph", "content": [ { "type": "text", "text": "one" } ] },
		      { "type": "paragraph", "content": [ { "type": "text", "text": "two" } ] },
		      { "type": "paragraph", "content": [ { "type": "text", "text": "three" } ] }
		   ] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		md, sm, err := adf.MarshallMarkdownMapped(nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, sm.BodyStart, sm.Origins[0].Span.Start)
		prevEnd := sm.BodyStart
		for i, o := range sm.Origins {
			assert.True(t, o.Span.Start >= prevEnd)
			assert.True(t, o.Span.End <= len(md))
			assert.True(t, o.Span.End > o.Span.Start)
			if i > 0 {
				// Consecutive blocks are separated by exactly one blank line.
				gap := string(md[sm.Origins[i-1].Span.End:o.Span.Start])
				assert.Equal(t, "\n\n", gap)
			}
			prevEnd = o.Span.End
		}
		// The body begins right after the frontmatter and its blank line.
		assert.Equal(t, "\n\n", string(md[sm.BodyStart-2:sm.BodyStart]))
	})

	t.Run("bodyless doc reports body start at end", func(t *testing.T) {
		// --- Given --- a doc whose only block renders to nothing.
		data := `{
		   "adf": { "type": "doc", "content": [
		      { "type": "paragraph" }
		   ] }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		md, sm, err := adf.MarshallMarkdownMapped(nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, 0, len(sm.Origins))
		// Only the trailing newline follows the frontmatter.
		assert.Equal(t, len(md)-1, sm.BodyStart)
	})

	t.Run("a non-doc root errors", func(t *testing.T) {
		// --- Given ---
		adf := &ADF{Doc: Node{Type: "paragraph"}}

		// --- When ---
		_, _, err := adf.MarshallMarkdownMapped(nil)

		// --- Then ---
		assert.ErrorContain(t, `root node is "paragraph", want doc`, err)
	})
}
