// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"path/filepath"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_mdFilesUnder(t *testing.T) {
	t.Run("returns markdown files under each root sorted", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "one", "sub")
		oskit.MkdirAll(t, dir, "two")
		oskit.Create(t, "a", dir, "one", "_index.md")
		oskit.Create(t, "b", dir, "one", "sub", "leaf.md")
		oskit.Create(t, "c", dir, "one", "note.txt")
		oskit.Create(t, "d", dir, "two", "page.md")
		roots := []string{filepath.Join(dir, "one"), filepath.Join(dir, "two")}

		// --- When ---
		have := mdFilesUnder(roots)

		// --- Then ---
		want := []string{
			filepath.Join(dir, "one", "_index.md"),
			filepath.Join(dir, "one", "sub", "leaf.md"),
			filepath.Join(dir, "two", "page.md"),
		}
		assert.Equal(t, want, have)
	})

	t.Run("skips the adf cache directory", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, adfCacheDir)
		oskit.Create(t, "a", dir, "page.md")
		oskit.Create(t, "b", dir, adfCacheDir, "page.v1.md")
		roots := []string{dir}

		// --- When ---
		have := mdFilesUnder(roots)

		// --- Then ---
		want := []string{filepath.Join(dir, "page.md")}
		assert.Equal(t, want, have)
	})

	t.Run("skips a root that does not exist", func(t *testing.T) {
		// --- Given ---
		roots := []string{filepath.Join(t.TempDir(), "missing")}

		// --- When ---
		have := mdFilesUnder(roots)

		// --- Then ---
		assert.Nil(t, have)
	})
}

func Test_plural_tabular(t *testing.T) {
	tt := []struct {
		testN string
		n     int
		want  string
	}{
		{"zero is plural", 0, "pages"},
		{"one is singular", 1, "page"},
		{"many is plural", 2, "pages"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := plural(tc.n, "page", "pages")

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_pushableFiles(t *testing.T) {
	t.Run("keeps updates and create candidates only", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		update := oskit.Create(t,
			"---\ntitle: \"T\"\npage_id: \"1\"\nspace_id: \"9\"\n---\nx\n",
			dir, "old.md")
		create := oskit.Create(t, newPageMD, dir, "new.md")
		oskit.Create(t, "no frontmatter\n", dir, "notes.md")
		titled := oskit.Create(t, "---\ntitle: \"T\"\n---\nx\n", dir, "titled.md")
		dests := []string{
			update,
			create,
			filepath.Join(dir, "notes.md"),
			titled,
		}

		// --- When ---
		have := pushableFiles(dests)

		// --- Then --- a title-only file is a create candidate whose space is
		// derived later; only the frontmatter-less note is dropped.
		assert.Equal(t, []string{update, create, titled}, have)
	})

	t.Run("drops a cf_local file with a page id", func(t *testing.T) {
		// --- Given --- a tracked page marked local alongside a normal update.
		dir := t.TempDir()
		update := oskit.Create(t,
			"---\ntitle: \"T\"\npage_id: \"1\"\nspace_id: \"9\"\n---\nx\n",
			dir, "old.md")
		local := oskit.Create(t,
			"---\ntitle: \"T\"\npage_id: \"2\"\nspace_id: \"9\"\n"+
				"cf_local: true\n---\nx\n",
			dir, "local.md")
		dests := []string{update, local}

		// --- When ---
		have := pushableFiles(dests)

		// --- Then ---
		assert.Equal(t, []string{update}, have)
	})

	t.Run("drops a cf_local create candidate", func(t *testing.T) {
		// --- Given --- an id-less, titled file marked local.
		dir := t.TempDir()
		local := oskit.Create(t,
			"---\ntitle: \"T\"\nspace_id: \"9\"\ncf_local: true\n---\nx\n",
			dir, "local.md")

		// --- When ---
		have := pushableFiles([]string{local})

		// --- Then ---
		assert.Len(t, 0, have)
	})
}

func Test_underAnyRoot_tabular(t *testing.T) {
	tt := []struct {
		testN string
		dest  string
		roots []string
		want  bool
	}{
		{"under a root", "/wd/team/new.md", []string{"/wd/team"}, true},
		{"the root file itself", "/wd/team/a.md", []string{"/wd/team"}, true},
		{"nested under a root", "/wd/team/sub/a.md", []string{"/wd/team"}, true},
		{"outside every root", "/wd/other/a.md", []string{"/wd/team"}, false},
		{"a sibling prefix is not under", "/wd/teamx/a.md", []string{"/wd/team"}, false},
		{"no roots", "/wd/team/a.md", nil, false},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := underAnyRoot(tc.dest, tc.roots)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_destIsLocal(t *testing.T) {
	t.Run("true for a file marked cf_local", func(t *testing.T) {
		// --- Given ---
		dest := oskit.Create(t,
			"---\ntitle: \"T\"\ncf_local: true\n---\nx\n",
			t.TempDir(), "local.md")

		// --- When ---
		have := destIsLocal(dest)

		// --- Then ---
		assert.True(t, have)
	})

	t.Run("false for a file without the marker", func(t *testing.T) {
		// --- Given ---
		dest := oskit.Create(t,
			"---\ntitle: \"T\"\npage_id: \"1\"\n---\nx\n",
			t.TempDir(), "page.md")

		// --- When ---
		have := destIsLocal(dest)

		// --- Then ---
		assert.False(t, have)
	})

	t.Run("false for a missing file", func(t *testing.T) {
		// --- Given ---
		dest := filepath.Join(t.TempDir(), "missing.md")

		// --- When ---
		have := destIsLocal(dest)

		// --- Then ---
		assert.False(t, have)
	})
}

func Test_fileExists(t *testing.T) {
	t.Run("true when the file exists", func(t *testing.T) {
		// --- Given ---
		path := oskit.Create(t, "x", t.TempDir(), "a.v3.json")

		// --- When ---
		have, err := fileExists(path)

		// --- Then ---
		assert.NoError(t, err)
		assert.True(t, have)
	})

	t.Run("false when the file does not exist", func(t *testing.T) {
		// --- Given ---
		path := filepath.Join(t.TempDir(), "missing.json")

		// --- When ---
		have, err := fileExists(path)

		// --- Then ---
		assert.NoError(t, err)
		assert.False(t, have)
	})
}

func Test_moveFile(t *testing.T) {
	t.Run("moves a file and creates parent dirs", func(t *testing.T) {
		// --- Given --- a source file and a destination in a not-yet-existing dir.
		dir := t.TempDir()
		src := oskit.Create(t, "PNG", dir, "shot.png")
		dst := filepath.Join(dir, "_assets", "F1-L1.png")

		// --- When ---
		err := moveFile(src, dst)

		// --- Then --- the destination holds the content and the source is gone.
		assert.NoError(t, err)
		assert.Equal(t, "PNG", oskit.ReadFileStr(t, dst))
		have, err := fileExists(src)
		assert.NoError(t, err)
		assert.False(t, have)
	})

	t.Run("overwrites an existing destination", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		src := oskit.Create(t, "new", dir, "src.txt")
		dst := oskit.Create(t, "old", dir, "dst.txt")

		// --- When ---
		err := moveFile(src, dst)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "new", oskit.ReadFileStr(t, dst))
	})

	t.Run("error - source missing", func(t *testing.T) {
		// --- Given --- a missing source, so the rename fails and the copy
		// fallback cannot read it.
		dir := t.TempDir()
		src := filepath.Join(dir, "missing.png")
		dst := filepath.Join(dir, "out.png")

		// --- When ---
		err := moveFile(src, dst)

		// --- Then ---
		assert.ErrorContain(t, "reading", err)
	})

	t.Run("error - destination is a directory", func(t *testing.T) {
		// --- Given --- a destination that is an existing directory, so the
		// rename fails and the fallback copy cannot write it.
		dir := t.TempDir()
		src := oskit.Create(t, "data", dir, "src.png")
		dst := filepath.Join(dir, "sub")
		oskit.MkdirAll(t, dst)

		// --- When ---
		err := moveFile(src, dst)

		// --- Then ---
		assert.ErrorContain(t, "writing", err)
	})
}

func Test_writeFileIfChanged(t *testing.T) {
	t.Run("writes when the file is absent", func(t *testing.T) {
		// --- Given ---
		path := filepath.Join(t.TempDir(), "sub", "a.md")

		// --- When ---
		have, err := writeFileIfChanged(path, []byte("new"), 0o644)

		// --- Then ---
		assert.NoError(t, err)
		assert.True(t, have)
		assert.Equal(t, "new", oskit.ReadFileStr(t, path))
	})

	t.Run("skips when the content is identical", func(t *testing.T) {
		// --- Given ---
		path := oskit.Create(t, "same", t.TempDir(), "a.md")

		// --- When ---
		have, err := writeFileIfChanged(path, []byte("same"), 0o644)

		// --- Then ---
		assert.NoError(t, err)
		assert.False(t, have)
	})

	t.Run("writes when the content differs", func(t *testing.T) {
		// --- Given ---
		path := oskit.Create(t, "old", t.TempDir(), "a.md")

		// --- When ---
		have, err := writeFileIfChanged(path, []byte("new"), 0o644)

		// --- Then ---
		assert.NoError(t, err)
		assert.True(t, have)
		assert.Equal(t, "new", oskit.ReadFileStr(t, path))
	})

	t.Run("error - path is a directory", func(t *testing.T) {
		// --- Given --- a path that is an existing directory, so the read fails
		// with something other than not-exist.
		path := t.TempDir()

		// --- When ---
		have, err := writeFileIfChanged(path, []byte("x"), 0o644)

		// --- Then ---
		assert.False(t, have)
		assert.ErrorContain(t, "reading", err)
	})
}
