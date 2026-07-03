// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"path/filepath"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_pageURL(t *testing.T) {
	t.Run("builds a space page URL", func(t *testing.T) {
		// --- When ---
		have := pageURL("RZ", "123")

		// --- Then ---
		assert.Equal(t, "/wiki/spaces/RZ/pages/123", have)
	})

	t.Run("falls back to an id-addressable URL without a space", func(t *testing.T) {
		// --- When ---
		have := pageURL("", "123")

		// --- Then ---
		assert.Equal(t, "/wiki/pages/viewpage.action?pageId=123", have)
	})
}

func Test_buildLinkIndex(t *testing.T) {
	t.Run("indexes configured pages and folder pages", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cfg := &config{
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/X/pages/1/A",
			},
		}
		folders := []folderPage{
			{
				Dest:     filepath.Join(dir, "docs/b.md"),
				ID:       "2",
				Title:    "B",
				URL:      "/wiki/spaces/Y/pages/2",
				SpaceKey: "Y",
			},
		}

		// --- When ---
		have := buildLinkIndex(cfg, folders)

		// --- Then ---
		assert.Equal(t, "/wiki/spaces/X/pages/1/A", have.byID["1"].URL)
		assert.Equal(t, "a.md", have.byID["1"].Dest)
		assert.Equal(t, "", have.byID["1"].SpaceKey)

		assert.Equal(t, "B", have.byID["2"].Title)
		assert.Equal(t, "docs/b.md", have.byID["2"].Dest)
		assert.Equal(t, "Y", have.byID["2"].SpaceKey)
	})

	t.Run("skips a configured page whose source is not a page", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cfg := &config{
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/X/folder/9",
			},
		}

		// --- When ---
		have := buildLinkIndex(cfg, nil)

		// --- Then ---
		assert.Equal(t, 0, len(have.byID))
	})
}

func Test_linkIndex_write_load(t *testing.T) {
	t.Run("round-trips through the cache file", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cfg := &config{WorkDir: dir}
		idx := &linkIndex{
			workDir: dir,
			byID:    map[string]linkEntry{},
			byDest:  map[string]linkEntry{},
		}
		idx.add(linkEntry{ID: "1", Dest: "a.md", URL: "/wiki/x/1", Title: "A"})

		// --- When ---
		err := idx.write()

		// --- Then ---
		assert.NoError(t, err)
		have := must.Value(loadLinkIndex(cfg))
		assert.Equal(t, "/wiki/x/1", have.byID["1"].URL)
		abs := filepath.Join(dir, "a.md")
		assert.Equal(t, "A", have.byDest[abs].Title)
	})

	t.Run("returns nil when no file exists", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: t.TempDir()}

		// --- When ---
		have, err := loadLinkIndex(cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Nil(t, have)
	})
}

// linkTestIndex builds a one-entry index for the docLinks tests: page 456 at
// glossary/bar.md under work dir /wd.
func linkTestIndex() *linkIndex {
	idx := &linkIndex{
		workDir: "/wd",
		byID:    map[string]linkEntry{},
		byDest:  map[string]linkEntry{},
	}
	idx.add(linkEntry{
		ID:    "456",
		Dest:  "glossary/bar.md",
		URL:   "/wiki/spaces/X/pages/456",
		Title: "Bar",
	})
	return idx
}

func Test_docLinks_ToLocal(t *testing.T) {
	dnk := &docLinks{idx: linkTestIndex(), dir: "/wd/docs",
		host: "s.atlassian.net", site: "https://s.atlassian.net"}

	t.Run("maps a same-site page href to a relative path", func(t *testing.T) {
		// --- When ---
		target, label, ok := dnk.ToLocal(
			"https://s.atlassian.net/wiki/spaces/X/pages/456/Bar")

		// --- Then ---
		assert.True(t, ok)
		assert.Equal(t, "../glossary/bar.md", target)
		assert.Equal(t, "Bar", label)
	})

	t.Run("preserves a fragment", func(t *testing.T) {
		// --- When ---
		target, _, ok := dnk.ToLocal("/wiki/spaces/X/pages/456/Bar#intro")

		// --- Then ---
		assert.True(t, ok)
		assert.Equal(t, "../glossary/bar.md#intro", target)
	})

	t.Run("maps a viewpage pageId query href", func(t *testing.T) {
		// --- When ---
		target, label, ok := dnk.ToLocal(
			"/wiki/pages/viewpage.action?pageId=456")

		// --- Then ---
		assert.True(t, ok)
		assert.Equal(t, "../glossary/bar.md", target)
		assert.Equal(t, "Bar", label)
	})

	t.Run("maps a pageId query with a fragment", func(t *testing.T) {
		// --- When ---
		target, _, ok := dnk.ToLocal(
			"https://s.atlassian.net/wiki/pages/viewpage.action?pageId=456#top")

		// --- Then ---
		assert.True(t, ok)
		assert.Equal(t, "../glossary/bar.md#top", target)
	})

	t.Run("ignores a link to another site", func(t *testing.T) {
		// --- When ---
		_, _, ok := dnk.ToLocal("https://other.example/wiki/pages/456")

		// --- Then ---
		assert.False(t, ok)
	})

	t.Run("ignores a page not in the index", func(t *testing.T) {
		// --- When ---
		_, _, ok := dnk.ToLocal("/wiki/spaces/X/pages/999/Nope")

		// --- Then ---
		assert.False(t, ok)
	})

	t.Run("ignores a non-page href", func(t *testing.T) {
		// --- When ---
		_, _, ok := dnk.ToLocal("https://s.atlassian.net/wiki/spaces/X")

		// --- Then ---
		assert.False(t, ok)
	})
}

func Test_docLinks_ToRemote(t *testing.T) {
	dnk := &docLinks{idx: linkTestIndex(), dir: "/wd/docs",
		host: "s.atlassian.net", site: "https://s.atlassian.net"}

	t.Run("maps a local path back to the absolute page URL with slug", func(t *testing.T) {
		// --- When ---
		href, ok := dnk.ToRemote("../glossary/bar.md")

		// --- Then --- the host and the title slug, both dropped on ToLocal, are
		// restored so the pushed href matches the form Confluence stores.
		assert.True(t, ok)
		assert.Equal(t, "https://s.atlassian.net/wiki/spaces/X/pages/456/Bar", href)
	})

	t.Run("preserves a fragment", func(t *testing.T) {
		// --- When ---
		href, ok := dnk.ToRemote("../glossary/bar.md#intro")

		// --- Then ---
		assert.True(t, ok)
		want := "https://s.atlassian.net/wiki/spaces/X/pages/456/Bar#intro"
		assert.Equal(t, want, href)
	})

	t.Run("ignores a path not in the index", func(t *testing.T) {
		// --- When ---
		_, ok := dnk.ToRemote("../glossary/other.md")

		// --- Then ---
		assert.False(t, ok)
	})

	t.Run("ignores an absolute URL", func(t *testing.T) {
		// --- When ---
		_, ok := dnk.ToRemote("https://s.atlassian.net/wiki/spaces/X/pages/456")

		// --- Then ---
		assert.False(t, ok)
	})

	t.Run("uses a configured page URL verbatim then absolutizes", func(t *testing.T) {
		// --- Given --- a configured page has no title, so its indexed URL
		// (slug and all, from config) is used as-is, only made absolute.
		idx := &linkIndex{workDir: "/wd",
			byID: map[string]linkEntry{}, byDest: map[string]linkEntry{}}
		idx.add(linkEntry{
			ID: "7", Dest: "cfg.md", URL: "/wiki/spaces/Y/pages/7/Configured"})
		cnk := &docLinks{idx: idx, dir: "/wd",
			host: "s.atlassian.net", site: "https://s.atlassian.net"}

		// --- When ---
		href, ok := cnk.ToRemote("cfg.md")

		// --- Then ---
		assert.True(t, ok)
		want := "https://s.atlassian.net/wiki/spaces/Y/pages/7/Configured"
		assert.Equal(t, want, href)
	})

	t.Run("leaves the URL relative when the site host is unknown", func(t *testing.T) {
		// --- Given --- no site configured, so the relative URL is the best form.
		cnk := &docLinks{idx: linkTestIndex(), dir: "/wd/docs",
			host: "s.atlassian.net"}

		// --- When ---
		href, ok := cnk.ToRemote("../glossary/bar.md")

		// --- Then ---
		assert.True(t, ok)
		assert.Equal(t, "/wiki/spaces/X/pages/456/Bar", href)
	})
}
