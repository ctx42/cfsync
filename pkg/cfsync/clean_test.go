// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ctx42/ring/pkg/ring/ringtest"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/httpkit"
	"github.com/ctx42/testkit/pkg/oskit"
)

// managedMD is the minimal frontmatter that marks a Markdown file as one cfsync
// wrote, so [staleFile] treats it as a deletion candidate.
const managedMD = "---\npage_id: \"1\"\npage_version: 1\n---\nbody\n"

func Test_cleanRoots(t *testing.T) {
	t.Run("removes stale managed files", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{
		   "results": [{"id": "1", "type": "page", "title": "Keep"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, top)
		oskit.MkdirAll(t, dir, "docs")
		oskit.Create(t, managedMD, dir, "docs", "keep.md")
		gone := oskit.Create(t, managedMD, dir, "docs", "gone.md")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Folders: map[string]string{
				filepath.Join(dir, "docs"): "/wiki/spaces/DOCS/folder/100",
			},
		}

		// --- When ---
		have, err := cleanRoots(ctx, rng, client, cfg, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "removed docs/gone.md", have)
		assert.Contain(t, "removed 1 file(s) and 0 director(y/ies)", have)

		assert.NoFileExist(t, gone)
		assert.FileExist(t, filepath.Join(dir, "docs", "keep.md"))
	})

	t.Run("error - refuses to prompt without a terminal", func(t *testing.T) {
		// --- Given --- a stale file but no --yes and an injected, non-terminal
		// input, so the confirm prompt cannot run.
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{"results": [], "_links": {}}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, top)
		oskit.MkdirAll(t, dir, "docs")
		gone := oskit.Create(t, managedMD, dir, "docs", "gone.md")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Folders: map[string]string{
				filepath.Join(dir, "docs"): "/wiki/spaces/DOCS/folder/100",
			},
		}

		// --- When ---
		_, err := cleanRoots(ctx, rng, client, cfg, false)

		// --- Then --- it refuses and leaves the stale file in place.
		assert.ErrorContain(t, "refusing to prompt without a terminal", err)

		assert.FileExist(t, gone)
	})

	t.Run("nothing configured", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		client := http.DefaultClient
		cfg := &config{WorkDir: t.TempDir()}

		// --- When ---
		have, err := cleanRoots(ctx, rng, client, cfg, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "nothing to clean", have)
	})

	t.Run("removes stale managed files under a space root", func(t *testing.T) {
		// --- Given --- a pulled space whose homepage now has only "Keep"; the
		// locally-present gone.md is stale.
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		dir := t.TempDir()
		client := http.DefaultClient
		home := []byte(`{
		   "results": [{"id": "1", "type": "page", "title": "Keep"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).   // resolve space key
			Rsp(http.StatusOK, home).      // homepage children
			Rsp(http.StatusOK, noChildren) // Keep children
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t, managedMD, dir, "team", "keep.md")
		gone := oskit.Create(t, managedMD, dir, "team", "gone.md")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Spaces: map[string]string{
				filepath.Join(dir, "team"): "/wiki/spaces/TEST",
			},
		}

		// --- When ---
		have, err := cleanRoots(ctx, rng, client, cfg, true)

		// --- Then --- only the stale file is removed.
		assert.NoError(t, err)
		assert.Contain(t, "removed team/gone.md", have)
		assert.NoFileExist(t, gone)
		keep := filepath.Join(dir, "team", "keep.md")
		assert.FileExist(t, keep)
	})

	t.Run("reports no stale files when the tree matches", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{
		   "results": [{"id": "1", "type": "page", "title": "Keep"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, top)
		oskit.MkdirAll(t, dir, "docs")
		oskit.Create(t, managedMD, dir, "docs", "keep.md")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Folders: map[string]string{
				filepath.Join(dir, "docs"): "/wiki/spaces/DOCS/folder/100",
			},
		}

		// --- When ---
		have, err := cleanRoots(ctx, rng, client, cfg, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "no stale files", have)
	})

	t.Run("skips a folder whose discovery fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		dir := t.TempDir()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		oskit.MkdirAll(t, dir, "docs")
		gone := oskit.Create(t, managedMD, dir, "docs", "gone.md")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Folders: map[string]string{
				filepath.Join(dir, "docs"): "/wiki/spaces/DOCS/folder/100",
			},
		}

		// --- When ---
		have, err := cleanRoots(ctx, rng, client, cfg, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "warning: skipping docs", have)

		// The unread folder is never cleaned, so its files stay.
		assert.FileExist(t, gone)
	})
}

func Test_staleUnder(t *testing.T) {
	t.Run("finds stale files and removable directories", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		root := filepath.Join(dir, "docs")
		oskit.MkdirAll(t, root, "sub")
		oskit.MkdirAll(t, root, "empty")
		oskit.Create(t, managedMD, root, "keep.md")
		oskit.Create(t, managedMD, root, "gone.md")
		oskit.Create(t, "plain text", root, "notes.txt")
		oskit.Create(t, "no frontmatter", root, "hand.md")
		oskit.Create(t, managedMD, root, "sub", "old.md")
		found := []folderPage{
			{Dest: filepath.Join(root, "keep.md"), ID: "1"},
		}

		// --- When ---
		have, err := staleUnder(root, found)

		// --- Then ---
		assert.NoError(t, err)
		// "empty/" pre-exists empty (cfsync did not empty it), so it is not
		// offered; "sub/" is offered because its only file is stale.
		want := []staleItem{
			{Path: filepath.Join(root, "gone.md")},
			{Path: filepath.Join(root, "sub", "old.md")},
			{Path: filepath.Join(root, "sub"), IsDir: true},
		}
		assert.Equal(t, want, have)
	})

	t.Run("returns nothing when the root is absent", func(t *testing.T) {
		// --- Given ---
		root := filepath.Join(t.TempDir(), "missing")

		// --- When ---
		have, err := staleUnder(root, nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Nil(t, have)
	})
}

func Test_staleFile(t *testing.T) {
	dir := t.TempDir()
	expected := map[string]bool{filepath.Join(dir, "keep.md"): true}

	t.Run("managed page not in the remote set is stale", func(t *testing.T) {
		// --- Given ---
		path := oskit.Create(t, managedMD, dir, "gone.md")

		// --- When ---
		have, err := staleFile(path, expected)

		// --- Then ---
		assert.NoError(t, err)
		assert.True(t, have)
	})

	t.Run("managed page in the remote set is kept", func(t *testing.T) {
		// --- Given ---
		path := oskit.Create(t, managedMD, dir, "keep.md")

		// --- When ---
		have, err := staleFile(path, expected)

		// --- Then ---
		assert.NoError(t, err)
		assert.False(t, have)
	})

	t.Run("non-markdown file is kept", func(t *testing.T) {
		// --- Given ---
		path := oskit.Create(t, "plain", dir, "notes.txt")

		// --- When ---
		have, err := staleFile(path, expected)

		// --- Then ---
		assert.NoError(t, err)
		assert.False(t, have)
	})

	t.Run("markdown without page_id frontmatter is kept", func(t *testing.T) {
		// --- Given ---
		path := oskit.Create(t, "no frontmatter here", dir, "hand.md")

		// --- When ---
		have, err := staleFile(path, expected)

		// --- Then ---
		assert.NoError(t, err)
		assert.False(t, have)
	})
}

func Test_removeStale(t *testing.T) {
	t.Run("removes files and empty directories, skips kept", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "empty")
		oskit.MkdirAll(t, dir, "full")
		file := oskit.Create(t, managedMD, dir, "gone.md")
		kept := oskit.Create(t, managedMD, dir, "full", "keep.md")
		items := []staleItem{
			{Path: file},
			{Path: filepath.Join(dir, "empty"), IsDir: true},
			{Path: filepath.Join(dir, "full"), IsDir: true},
		}
		var out strings.Builder

		// --- When ---
		removeStale(dir, &out, items)

		// --- Then ---
		have := out.String()
		assert.Contain(t, "removed gone.md", have)
		assert.Contain(t, "removed empty/", have)
		assert.Contain(t, "removed 1 file(s) and 1 director(y/ies)", have)

		assert.NoFileExist(t, file)

		// The non-empty directory and its kept file survive.
		assert.FileExist(t, kept)
	})
}

func Test_dirEmpty(t *testing.T) {
	t.Run("true for an empty directory", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()

		// --- When ---
		have, err := dirEmpty(dir)

		// --- Then ---
		assert.NoError(t, err)
		assert.True(t, have)
	})

	t.Run("false for a non-empty directory", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		oskit.Create(t, "x", dir, "f.txt")

		// --- When ---
		have, err := dirEmpty(dir)

		// --- Then ---
		assert.NoError(t, err)
		assert.False(t, have)
	})
}
