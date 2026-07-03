// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"strings"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_ADF_Merge3(t *testing.T) {
	// doc builds a two-paragraph document with stable localIds; the paragraph
	// texts are supplied so a test can stand in for a baseline or a remote.
	doc := func(a, b string) *ADF {
		j := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p1" },
		     "content": [ { "type": "text", "text": "` + a + `" } ] },
		   { "type": "paragraph", "attrs": { "localId": "p2" },
		     "content": [ { "type": "text", "text": "` + b + `" } ] } ] } }`
		return must.Value(NewADF([]byte(j)))
	}

	t.Run("disjoint edits merge onto the remote", func(t *testing.T) {
		// --- Given --- base [a,b]; remote edited the 2nd block; local the 1st.
		base := doc("alpha", "beta")
		remote := doc("alpha", "beta remote")
		local := strings.Replace(renderBody(t, base, nil), "alpha", "alpha local", 1)

		// --- When ---
		merged, err := base.Merge3(remote, local, nil)

		// --- Then --- both edits survive; Put against remote rebuilds cleanly.
		assert.NoError(t, err)
		assert.Equal(t, "alpha local\n\nbeta remote", merged)
		out := must.Value(remote.Put(merged, nil, nil, nil))
		assert.Equal(t, "alpha local", out.Doc.Content[0].Content[0].Text)
		assert.Equal(t, "beta remote", out.Doc.Content[1].Content[0].Text)
		assert.Equal(t, "p1", out.Doc.Content[0].attrStr("localId"))
	})

	t.Run("the same edit on both sides is concordant", func(t *testing.T) {
		// --- Given --- both sides made the identical change to block 1.
		base := doc("alpha", "beta")
		remote := doc("alpha edited", "beta")
		local := strings.Replace(renderBody(t, base, nil), "alpha", "alpha edited", 1)

		// --- When ---
		merged, err := base.Merge3(remote, local, nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "alpha edited\n\nbeta", merged)
	})

	t.Run("incompatible edits to one block conflict", func(t *testing.T) {
		// --- Given --- both sides changed block 1, differently.
		base := doc("alpha", "beta")
		remote := doc("alpha remote", "beta")
		local := strings.Replace(renderBody(t, base, nil), "alpha", "alpha local", 1)

		// --- When ---
		_, err := base.Merge3(remote, local, nil)

		// --- Then ---
		assert.ErrorIs(t, ErrMergeConflict, err)
		assert.ErrorContain(t, "merge conflict at block 0", err)
	})

	t.Run("a local insert lands alongside a remote edit", func(t *testing.T) {
		// --- Given --- remote edited block 2; local appended a new paragraph.
		base := doc("alpha", "beta")
		remote := doc("alpha", "beta remote")
		local := renderBody(t, base, nil) + "\n\ngamma added"

		// --- When ---
		merged, err := base.Merge3(remote, local, nil)

		// --- Then --- the insert and the remote edit both appear.
		assert.NoError(t, err)
		assert.Equal(t, "alpha\n\nbeta remote\n\ngamma added", merged)
	})

	t.Run("a local delete drops the block on the merged side", func(t *testing.T) {
		// --- Given --- local deleted block 1; remote edited block 2.
		base := doc("alpha", "beta")
		remote := doc("alpha", "beta remote")
		local := "beta" // only the 2nd paragraph remains

		// --- When ---
		merged, err := base.Merge3(remote, local, nil)

		// --- Then --- block 1 is gone; the remote edit to block 2 survives.
		assert.NoError(t, err)
		assert.Equal(t, "beta remote", merged)
	})

	t.Run("both sides inserting at the same place conflict", func(t *testing.T) {
		// --- Given --- both appended a new final block.
		base := doc("alpha", "beta")
		remote := doc("alpha", "beta")
		remote.Doc.Content = append(remote.Doc.Content, Node{Type: "paragraph",
			Attrs:   map[string]any{"localId": "pr"},
			Content: []Node{{Type: "text", Text: "remote tail"}}})
		local := renderBody(t, base, nil) + "\n\nlocal tail"

		// --- When ---
		_, err := base.Merge3(remote, local, nil)

		// --- Then ---
		assert.ErrorIs(t, ErrMergeConflict, err)
		assert.ErrorContain(t, "both sides inserted", err)
	})
}

func FuzzMerge3(f *testing.F) {
	// A fixed baseline and a remote that diverged from it; the fuzzer supplies
	// the local body. Merge3 must never panic and, when it succeeds, its merged
	// body must Put against remote without panicking.
	base := must.Value(NewADF([]byte(`{ "adf": { "type": "doc", "content": [
	   { "type": "heading", "attrs": { "level": 2, "localId": "h" },
	     "content": [ { "type": "text", "text": "Title" } ] },
	   { "type": "paragraph", "attrs": { "localId": "p1" },
	     "content": [ { "type": "text", "text": "alpha" } ] },
	   { "type": "paragraph", "attrs": { "localId": "p2" },
	     "content": [ { "type": "text", "text": "beta" } ] } ] } }`)))
	remote := must.Value(NewADF([]byte(`{ "adf": { "type": "doc", "content": [
	   { "type": "heading", "attrs": { "level": 2, "localId": "h" },
	     "content": [ { "type": "text", "text": "Title" } ] },
	   { "type": "paragraph", "attrs": { "localId": "p1" },
	     "content": [ { "type": "text", "text": "alpha" } ] },
	   { "type": "paragraph", "attrs": { "localId": "p2" },
	     "content": [ { "type": "text", "text": "beta remote" } ] } ] } }`)))

	self := renderBody(&testing.T{}, base, nil)
	f.Add(self)
	f.Add(strings.Replace(self, "alpha", "alpha local", 1))
	f.Add(strings.Replace(self, "beta", "beta local", 1))
	f.Add(self + "\n\ninserted")
	f.Add("")
	f.Fuzz(func(t *testing.T, body string) {
		merged, err := base.Merge3(remote, body, nil)
		if err != nil {
			return // a conflict is a valid, safe outcome
		}
		// A successful merge must reconstruct against remote without panicking.
		_, _ = remote.Put(merged, nil, nil, nil)
	})
}
