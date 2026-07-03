// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/oskit"
)

// writePage writes a page Markdown file under dir/name whose page_images
// frontmatter references each given asset file name (as "../_assets/<file>",
// the form the renderer emits for a page in a subdirectory). It returns the
// absolute destination path.
func writePage(t *testing.T, dir, name string, files ...string) string {
	t.Helper()
	var b strings.Builder
	b.WriteString("---\ntitle: \"T\"\npage_id: \"1\"\n" +
		"page_version: 1\nspace_id: \"9\"\n")
	if len(files) > 0 {
		b.WriteString("page_images:\n")
		for i, f := range files {
			_, _ = fmt.Fprintf(&b, "  - local_id: L%d\n    file: %q\n"+
				"    alt: \"a\"\n", i, "../"+assetsDir+"/"+f)
		}
	}
	b.WriteString("---\n\nbody\n")
	dest := filepath.Join(dir, name)
	oskit.MkdirAll(t, filepath.Dir(dest))
	oskit.Write(t, b.String(), dest)
	return dest
}

// writeAsset writes a dummy asset file into the shared assets directory under
// dir and returns its absolute path.
func writeAsset(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, assetsDir, name)
	oskit.MkdirAll(t, filepath.Dir(p))
	oskit.Write(t, "img", p)
	return p
}

func Test_collectGarbage(t *testing.T) {
	t.Run("no assets directory reports nothing", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		cfg := &config{WorkDir: dir, Pages: map[string]string{
			writePage(t, dir, "test/page.md"): "src"}}

		// --- When ---
		out, err := collectGarbage(ctx, cfg, false)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "cfsync: no orphaned assets\n", out)
	})

	t.Run("an unreferenced file is reported, not deleted", func(t *testing.T) {
		// --- Given --- one page references keep.jpg; orphan.jpg is unreferenced.
		ctx := t.Context()
		dir := t.TempDir()
		dest := writePage(t, dir, "test/page.md", "keep.jpg")
		writeAsset(t, dir, "keep.jpg")
		orphan := writeAsset(t, dir, "orphan.jpg")
		cfg := &config{WorkDir: dir, Pages: map[string]string{dest: "src"}}

		// --- When ---
		out, err := collectGarbage(ctx, cfg, false)

		// --- Then --- orphan is listed but still on disk.
		assert.NoError(t, err)
		assert.Contain(t, "orphan.jpg", out)
		assert.NotContain(t, "keep.jpg", out)
		assert.Contain(t, `run "cfsync gc --prune"`, out)
		assert.FileExist(t, orphan)
	})

	t.Run("prune deletes orphans and keeps referenced files", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		dest := writePage(t, dir, "test/page.md", "keep.jpg")
		keep := writeAsset(t, dir, "keep.jpg")
		orphan := writeAsset(t, dir, "orphan.jpg")
		cfg := &config{WorkDir: dir, Pages: map[string]string{dest: "src"}}

		// --- When ---
		out, err := collectGarbage(ctx, cfg, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "pruned orphan.jpg", out)
		assert.NoFileExist(t, orphan)
		assert.FileExist(t, keep)
	})

	t.Run("a cancelled context aborts prune before deleting", func(t *testing.T) {
		// --- Given --- an orphan to prune and an already-cancelled context.
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		dir := t.TempDir()
		dest := writePage(t, dir, "test/page.md")
		orphan := writeAsset(t, dir, "orphan.jpg")
		cfg := &config{WorkDir: dir, Pages: map[string]string{dest: "src"}}

		// --- When ---
		_, err := collectGarbage(ctx, cfg, true)

		// --- Then --- the run stops at the cancellation; the file survives.
		assert.ErrorIs(t, context.Canceled, err)
		assert.FileExist(t, orphan)
	})

	t.Run("a file any page references is never orphaned", func(t *testing.T) {
		// --- Given --- two pages sharing _assets; only page two uses shared.jpg.
		ctx := t.Context()
		dir := t.TempDir()
		one := writePage(t, dir, "test/one.md")
		two := writePage(t, dir, "test/two.md", "shared.jpg")
		shared := writeAsset(t, dir, "shared.jpg")
		cfg := &config{WorkDir: dir, Pages: map[string]string{
			one: "s1", two: "s2"}}

		// --- When ---
		out, err := collectGarbage(ctx, cfg, true)

		// --- Then --- shared.jpg survives even though page one omits it.
		assert.NoError(t, err)
		assert.Equal(t, "cfsync: no orphaned assets\n", out)
		assert.FileExist(t, shared)
	})

	t.Run("a file a folder page references is never orphaned", func(t *testing.T) {
		// --- Given --- a folder page under a folder root references folder.jpg,
		// which lives in the shared _assets dir like any configured page's image.
		ctx := t.Context()
		dir := t.TempDir()
		writePage(t, dir, "notes/page.md", "folder.jpg")
		folder := writeAsset(t, dir, "folder.jpg")
		cfg := &config{WorkDir: dir, Folders: map[string]string{
			filepath.Join(dir, "notes"): "src"}}

		// --- When ---
		out, err := collectGarbage(ctx, cfg, true)

		// --- Then --- the folder page's image is not pruned.
		assert.NoError(t, err)
		assert.Equal(t, "cfsync: no orphaned assets\n", out)
		assert.FileExist(t, folder)
	})

	t.Run("a file a space page references is never orphaned", func(t *testing.T) {
		// --- Given --- a space page under a space root references space.jpg,
		// which lives in the shared _assets dir like any configured page's image.
		ctx := t.Context()
		dir := t.TempDir()
		writePage(t, dir, "team/_index.md", "space.jpg")
		space := writeAsset(t, dir, "space.jpg")
		cfg := &config{WorkDir: dir, Spaces: map[string]string{
			filepath.Join(dir, "team"): "/wiki/spaces/TEST"}}

		// --- When ---
		out, err := collectGarbage(ctx, cfg, true)

		// --- Then --- the space page's image is not pruned.
		assert.NoError(t, err)
		assert.Equal(t, "cfsync: no orphaned assets\n", out)
		assert.FileExist(t, space)
	})

	t.Run("prune is refused for an unparsable folder page", func(t *testing.T) {
		// --- Given --- a folder page whose Markdown has no frontmatter, so its
		// references are unknown.
		ctx := t.Context()
		dir := t.TempDir()
		bad := filepath.Join(dir, "notes", "bad.md")
		oskit.MkdirAll(t, dir, "notes")
		oskit.Write(t, "no frontmatter here\n", bad)
		orphan := writeAsset(t, dir, "orphan.jpg")
		cfg := &config{WorkDir: dir, Folders: map[string]string{
			filepath.Join(dir, "notes"): "src"}}

		// --- When ---
		_, err := collectGarbage(ctx, cfg, true)

		// --- Then --- prune refuses and the file is left in place.
		assert.ErrorContain(t, "refusing to prune", err)
		assert.FileExist(t, orphan)
	})

	t.Run("prune is refused when a page cannot be read", func(t *testing.T) {
		// --- Given --- a configured page whose .md was never written.
		ctx := t.Context()
		dir := t.TempDir()
		missing := filepath.Join(dir, "test", "missing.md")
		orphan := writeAsset(t, dir, "orphan.jpg")
		cfg := &config{WorkDir: dir, Pages: map[string]string{missing: "src"}}

		// --- When ---
		out, err := collectGarbage(ctx, cfg, true)

		// --- Then --- prune refuses and the file is left in place.
		assert.ErrorContain(t, "refusing to prune", err)
		assert.Contain(t, "cannot read", out)
		assert.FileExist(t, orphan)
	})
}
