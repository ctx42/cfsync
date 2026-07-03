// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// mdFilesUnder returns the Markdown files under each root, walking each root's
// subtree but skipping the [adfCacheDir] cache directory, whose Markdown files
// are baseline mirrors rather than managed pages. A root that does not exist or
// cannot be read contributes nothing. The result is sorted for a stable order.
func mdFilesUnder(roots []string) []string {
	var files []string
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // skip an unreadable subtree; an absent root yields none
			}
			if d.IsDir() && d.Name() == adfCacheDir {
				return filepath.SkipDir
			}
			if !d.IsDir() && strings.HasSuffix(p, ".md") {
				files = append(files, p)
			}
			return nil
		})
	}
	sort.Strings(files)
	return files
}

// plural returns one when n is 1, otherwise many, for count messages that read
// grammatically at any count.
func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// isDigits reports whether s is non-empty and contains only ASCII digits.
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// pushableFiles keeps only dests that push can act on: a file with page_id
// (update) or a titled create candidate (a title, no page id). A create
// candidate needs only a title, as its space and parent are derived from disk
// (see [classifyCreates]). Stray notes without a title are dropped so they do
// not fail a run. A file whose frontmatter sets cf_local is dropped regardless
// of its other fields, so it is never a create candidate and never attempted
// as an update. Unreadable files are kept so the push path can report the read
// error.
func pushableFiles(dests []string) []string {
	out := make([]string, 0, len(dests))
	for _, dest := range dests {
		data, err := os.ReadFile(dest) //nolint:gosec // dest is config-derived.
		if err != nil {
			out = append(out, dest)
			continue
		}
		meta, _, err := splitFrontmatter(data)
		if err != nil {
			continue
		}
		switch {
		case meta.Local:
			continue
		case meta.PageID != "":
			out = append(out, dest)
		case meta.Title != "":
			out = append(out, dest)
		}
	}
	return out
}

// underAnyRoot reports whether dest lies within any of the roots, a root
// itself included. It compares cleaned paths, so a root's sibling directory
// sharing its name prefix does not count as under it.
func underAnyRoot(dest string, roots []string) bool {
	for _, root := range roots {
		rel, err := filepath.Rel(root, dest)
		if err == nil && rel != ".." &&
			!strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// rootOf returns the managed root in roots that contains dest — the longest
// one when several nest — or "" when none does. It pairs with [underAnyRoot] to
// bound a walk up dest's directories at the root.
func rootOf(dest string, roots []string) string {
	best := ""
	for _, root := range roots {
		rel, err := filepath.Rel(root, dest)
		if err != nil || rel == ".." ||
			strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if len(root) > len(best) {
			best = root
		}
	}
	return best
}

// destIsLocal reports whether the Markdown file at dest carries cf_local:
// true in its frontmatter. It lets an explicit push-by-name refuse with a
// reason specific to that marker rather than the generic "not a managed
// page" error. A missing file or one whose frontmatter does not parse
// reports false, leaving the caller's existing checks to report the error.
func destIsLocal(dest string) bool {
	data, err := os.ReadFile(dest) //nolint:gosec // dest is config-derived.
	if err != nil {
		return false
	}
	meta, _, err := splitFrontmatter(data)
	if err != nil {
		return false
	}
	return meta.Local
}

// fileExists reports whether a regular file exists at path.
func fileExists(path string) (bool, error) {
	switch _, err := os.Stat(path); {
	case err == nil:
		return true, nil
	case errors.Is(err, os.ErrNotExist):
		return false, nil
	default:
		return false, fmt.Errorf("checking file: %w", err)
	}
}

// moveFile moves src to dst, creating dst's parent directories. It first tries
// an atomic rename and, when that fails because the two paths are on different
// file systems, falls back to a copy followed by removing src. dst is
// overwritten if it already exists.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return fmt.Errorf("creating dir: %w", err)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	data, err := os.ReadFile(src) //nolint:gosec // src is body-derived, local.
	if err != nil {
		return fmt.Errorf("reading %s: %w", src, err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil { //nolint:gosec // asset.
		return fmt.Errorf("writing %s: %w", dst, err)
	}
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("removing %s: %w", src, err)
	}
	return nil
}

// writeFileIfChanged writes data to path only when its current content differs,
// creating the file (and parents) when absent. It reports whether it wrote, so
// a pull that renders identical Markdown leaves the file — and the working
// tree — untouched.
func writeFileIfChanged(
	path string,
	data []byte,
	mode os.FileMode,
) (bool, error) {

	cur, err := os.ReadFile(path) //nolint:gosec // path is config-derived.
	if err == nil && bytes.Equal(cur, data) {
		return false, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, fmt.Errorf("reading %s: %w", path, err)
	}
	if err = writeFile(path, data, mode); err != nil {
		return false, err
	}
	return true, nil
}

// writeFile writes data to the path with the given mode, creating missing
// parent directories. The caller chooses mode: cache files use 0o600,
// user-facing Markdown uses 0o644.
func writeFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("creating dir: %w", err)
	}
	//nolint:gosec // Mode is caller-chosen; user-facing Markdown is 0o644.
	if err := os.WriteFile(path, data, mode); err != nil {
		return fmt.Errorf("writing file: %w", err)
	}
	return nil
}
