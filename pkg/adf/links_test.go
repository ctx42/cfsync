// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

// fakeLinks maps one Confluence page href to one local Markdown target, and
// back, for the link tests.
type fakeLinks struct{}

const fakeHref = "https://s.atlassian.net/wiki/spaces/X/pages/456/Bar"

func (fakeLinks) ToLocal(href string) (string, string, bool) {
	if href == fakeHref {
		return "../glossary/bar.md", "Bar Page", true
	}
	return "", "", false
}

func (fakeLinks) ToRemote(target string) (string, bool) {
	if target == "../glossary/bar.md" {
		return fakeHref, true
	}
	return "", false
}

// slugDropLinks is a many-to-one Links mirroring the real mapper: ToLocal maps
// any href for page 1 to the same local target regardless of host or slug, so
// ToRemote(ToLocal(href)) reconstructs a normalized URL that differs from the
// original stored href.
type slugDropLinks struct{}

func (slugDropLinks) ToLocal(href string) (string, string, bool) {
	if strings.Contains(href, "/pages/1") {
		return "page.md", "P", true
	}
	return "", "", false
}

func (slugDropLinks) ToRemote(target string) (string, bool) {
	if path, _, _ := strings.Cut(target, "#"); path == "page.md" {
		return "/wiki/spaces/X/pages/1", true // host and slug dropped
	}
	return "", false
}

func Test_ADF_MarshallMarkdownLinks(t *testing.T) {
	t.Run("rewrites a text link and inline card to local", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "content": [
		      { "type": "text", "text": "see " },
		      { "type": "text", "text": "here", "marks": [
		         { "type": "link", "attrs": { "href": "` + fakeHref + `" } } ] } ] },
		   { "type": "paragraph", "content": [
		      { "type": "inlineCard", "attrs": { "url": "` + fakeHref + `" } } ] } ] } }`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdownLinks(nil, fakeLinks{}))

		// --- Then ---
		assert.Contain(t, "[here](../glossary/bar.md)", string(have))
		assert.Contain(t, "[Bar Page](../glossary/bar.md)", string(have))
	})

	t.Run("leaves a link to an unmapped page unchanged", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "content": [
		      { "type": "text", "text": "x", "marks": [
		         { "type": "link", "attrs": { "href": "https://other/p" } } ] } ] } ] } }`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := must.Value(adf.MarshallMarkdownLinks(nil, fakeLinks{}))

		// --- Then ---
		assert.Contain(t, "[x](https://other/p)", string(have))
	})
}

func Test_ADF_PutLinks(t *testing.T) {
	t.Run("unedited rewrite round-trips to the same ADF", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "see " },
		      { "type": "text", "text": "here", "marks": [
		         { "type": "link", "attrs": { "href": "` + fakeHref + `" } } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		md, sm := must.Values(base.marshallMapped(nil, fakeLinks{}))
		body := strings.TrimRight(string(md[sm.BodyStart:]), "\n")

		// --- When ---
		out, err := base.PutLinks(body, nil, nil, nil, fakeLinks{})

		// --- Then ---
		assert.NoError(t, err)
		// The body carries the local link, but the unedited block is kept from
		// the baseline, so the pushed ADF still holds the original Confluence
		// href and equals the input document.
		assert.Contain(t, "here](../glossary/bar.md)", body)

		want := string(must.Value(json.Marshal(base.Doc)))
		have := string(must.Value(json.Marshal(out.Doc)))
		assert.Equal(t, want, have)
	})

	t.Run("an edited link is restored to its Confluence href", func(t *testing.T) {
		// --- Given ---
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "old", "marks": [
		         { "type": "link", "attrs": { "href": "` + fakeHref + `" } } ] } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		body := "[new](../glossary/bar.md)"

		// --- When ---
		out, err := base.PutLinks(body, nil, nil, nil, fakeLinks{})

		// --- Then ---
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		href, ok := para.Content[0].linkHref()
		assert.True(t, ok)
		assert.Equal(t, fakeHref, href)
		assert.Equal(t, "new", para.Content[0].Text)
	})

	t.Run("a full URL link is pushed verbatim", func(t *testing.T) {
		// --- Given --- an external tool authored a link whose target is a
		// full Confluence page URL; the mapper does not map it, so push keeps
		// it as-is rather than treating it as a local path.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
		      { "type": "text", "text": "old" } ] } ] } }`
		base := must.Value(NewADF([]byte(data)))
		want := "https://s.atlassian.net/wiki/spaces/K/pages/999/External"
		body := "[Ext](" + want + ")"

		// --- When ---
		out, err := base.PutLinks(body, nil, nil, nil, fakeLinks{})

		// --- Then ---
		assert.NoError(t, err)
		para := out.Doc.Content[0]
		have, ok := para.Content[0].linkHref()
		assert.True(t, ok)
		assert.Equal(t, want, have)
		assert.Equal(t, "Ext", para.Content[0].Text)
	})
}
