// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/ctx42/ring/pkg/ring"
	"golang.org/x/term"
)

// staleItem is a local path under a folder root that no longer corresponds to
// remote Confluence content: a cfsync-managed Markdown file whose page is gone,
// or a directory left empty once such files are removed.
type staleItem struct {
	// Path is the absolute path of the file or directory.
	Path string

	// IsDir reports whether Path is a directory rather than a Markdown file.
	IsDir bool
}

// clean loads the configuration from the path and removes local files under the
// configured folder and space roots that no longer exist in Confluence. It
// returns the report to print and any error. See [cleanRoots].
func clean(
	ctx context.Context,
	rng *ring.Ring,
	path string,
	yes bool,
) (string, error) {

	cfg, err := loadConfig(rng, path)
	if err != nil {
		return "", err
	}
	return cleanRoots(ctx, rng, http.DefaultClient, cfg, yes)
}

// cleanRoots discovers the current remote content of each configured folder and
// space, finds the cfsync-managed Markdown files under its root that no longer
// exist remotely, and removes them along with any directory they leave empty. A
// root whose discovery fails is skipped with a warning, never cleaned on an
// incomplete picture. When yes is false it prompts for confirmation on a
// terminal, pre-selecting every stale item; with yes, or no stale items, it
// does not prompt. It returns the report to print and any error.
func cleanRoots(
	ctx context.Context,
	rng *ring.Ring,
	client *http.Client,
	cfg *config,
	yes bool,
) (string, error) {

	if len(cfg.Folders) == 0 && len(cfg.Spaces) == 0 {
		return "cfsync: nothing to clean\n", nil
	}

	var out strings.Builder
	items, err := staleInRoots(ctx, client, cfg, &out, cfg.Folders, discoverFolder)
	if err != nil {
		return out.String(), err
	}
	spaceStale, err := staleInRoots(ctx, client, cfg, &out, cfg.Spaces, discoverSpace)
	if err != nil {
		return out.String(), err
	}
	items = append(items, spaceStale...)

	if len(items) == 0 {
		out.WriteString("cfsync: no stale files\n")
		return out.String(), nil
	}

	chosen := items
	if !yes {
		if !onTerminal(rng) {
			return out.String(), errors.New(
				"refusing to prompt without a terminal; re-run with --yes")
		}
		selected, err := promptStale(rng, cfg.WorkDir, items)
		if err != nil {
			return out.String(), err
		}
		chosen = selected
	}

	removeStale(cfg.WorkDir, &out, chosen)
	return out.String(), nil
}

// staleInRoots returns the stale local items under every root in roots, a
// destination-directory to source map, discovering each root's current remote
// content with discover. A root whose discovery fails is skipped with a warning
// written to out, so it is never cleaned on an incomplete picture. Roots are
// visited in a stable order.
func staleInRoots(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	out *strings.Builder,
	roots map[string]string,
	discover func(
		context.Context, *http.Client, *config, string, string,
	) ([]folderPage, error),
) ([]staleItem, error) {

	sorted := make([]string, 0, len(roots))
	for root := range roots {
		sorted = append(sorted, root)
	}
	sort.Strings(sorted)

	var items []staleItem
	for _, root := range sorted {
		found, err := discover(ctx, client, cfg, roots[root], root)
		if err != nil {
			_, _ = fmt.Fprintf(out,
				"warning: skipping %s: %v\n", pageName(cfg.WorkDir, root), err)
			continue
		}
		stale, err := staleUnder(root, found)
		if err != nil {
			return nil, err
		}
		items = append(items, stale...)
	}
	return items, nil
}

// staleUnder returns the stale items under the absolute directory root, given
// the pages found is the folder's current remote content. A Markdown file is
// stale when it is cfsync-managed (carries page_id frontmatter) and its path is
// not among the found pages; a directory is stale when it holds only stale
// files and stale sub-directories.
func staleUnder(root string, found []folderPage) ([]staleItem, error) {
	expected := make(map[string]bool, len(found))
	for _, fol := range found {
		expected[fol.Dest] = true
	}

	var items []staleItem
	if _, err := scanStale(root, expected, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// scanStale walks dir, appending each stale Markdown file and each removable
// sub-directory to items. It returns whether dir itself is removable: it is
// non-empty and holds only stale files and removable sub-directories. An empty
// or non-existent directory is not removable and yields no items, so a
// directory cfsync did not empty is left alone.
func scanStale(
	dir string,
	expected map[string]bool,
	items *[]staleItem,
) (bool, error) {

	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("reading %s: %w", dir, err)
	}
	if len(entries) == 0 {
		return false, nil
	}

	removable := true
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		if e.IsDir() {
			sub, err := scanStale(path, expected, items)
			if err != nil {
				return false, err
			}
			if sub {
				*items = append(*items, staleItem{Path: path, IsDir: true})
			} else {
				removable = false
			}
			continue
		}
		stale, err := staleFile(path, expected)
		if err != nil {
			return false, err
		}
		if stale {
			*items = append(*items, staleItem{Path: path})
		} else {
			removable = false
		}
	}
	return removable, nil
}

// staleFile reports whether the file at path is a stale cfsync-managed Markdown
// file: it ends in ".md", carries page_id frontmatter, and its path is not in
// expected. A file cfsync did not write (wrong extension, no frontmatter, or no
// page_id) is never stale, so it is left untouched.
func staleFile(path string, expected map[string]bool) (bool, error) {
	if !strings.HasSuffix(path, ".md") {
		return false, nil
	}
	data, err := os.ReadFile(path) //nolint:gosec // path is under work_dir.
	if err != nil {
		return false, fmt.Errorf("reading %s: %w", path, err)
	}
	meta, _, err := splitFrontmatter(data)
	if err != nil || meta.PageID == "" {
		return false, nil
	}
	return !expected[path], nil
}

// removeStale deletes the chosen items, files first and then directories
// deepest-first, and writes a line per removal and a summary into out. A
// directory that is not empty at removal time — because a file inside it was
// kept — is skipped. The work directory anchors the names shown.
func removeStale(workDir string, out *strings.Builder, items []staleItem) {
	dirs := make([]staleItem, 0, len(items))
	var files int
	for _, it := range items {
		if it.IsDir {
			dirs = append(dirs, it)
			continue
		}
		if err := os.Remove(it.Path); err != nil {
			_, _ = fmt.Fprintf(out, "warning: %v\n", err)
			continue
		}
		files++
		_, _ = fmt.Fprintf(out, "removed %s\n", pageName(workDir, it.Path))
	}

	sort.Slice(dirs, func(i, j int) bool {
		return len(dirs[i].Path) > len(dirs[j].Path)
	})
	var removed int
	for _, it := range dirs {
		empty, err := dirEmpty(it.Path)
		if err != nil {
			_, _ = fmt.Fprintf(out, "warning: %v\n", err)
			continue
		}
		if !empty {
			continue
		}
		if err = os.Remove(it.Path); err != nil {
			_, _ = fmt.Fprintf(out, "warning: %v\n", err)
			continue
		}
		removed++
		_, _ = fmt.Fprintf(out, "removed %s/\n", pageName(workDir, it.Path))
	}

	format := "cfsync: removed %d file(s) and %d director(y/ies)\n"
	_, _ = fmt.Fprintf(out, format, files, removed)
}

// dirEmpty reports whether the directory at path contains no entries.
func dirEmpty(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, fmt.Errorf("reading %s: %w", path, err)
	}
	return len(entries) == 0, nil
}

// promptStale shows an interactive multi-select of the stale items, every item
// pre-selected, and returns the items the user left selected for deletion. The
// work directory anchors the labels shown.
func promptStale(
	rng *ring.Ring,
	workDir string,
	items []staleItem,
) ([]staleItem, error) {

	opts := make([]huh.Option[int], len(items))
	for i, it := range items {
		label := pageName(workDir, it.Path)
		if it.IsDir {
			label += "/"
		}
		opts[i] = huh.NewOption(label, i).Selected(true)
	}

	var chosen []int
	form := huh.NewForm(huh.NewGroup(
		huh.NewMultiSelect[int]().
			Title("Delete stale files (space toggles, enter confirms):").
			Options(opts...).
			Value(&chosen),
	)).WithInput(rng.Stdin()).WithOutput(rng.Stderr())
	if err := form.Run(); err != nil {
		return nil, fmt.Errorf("clean prompt: %w", err)
	}

	selected := make([]staleItem, 0, len(chosen))
	for _, i := range chosen {
		selected = append(selected, items[i])
	}
	return selected, nil
}

// onTerminal reports whether the ring's standard input is an interactive
// terminal. A non-file input (a test buffer, a pipe) is never a terminal.
func onTerminal(rng *ring.Ring) bool {
	file, ok := rng.Stdin().(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}
