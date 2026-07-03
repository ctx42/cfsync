// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ctx42/ring/pkg/ring"
)

// gc loads the configuration and reports orphaned files in the shared assets
// directory: files under _assets/ that no managed page's page_images
// frontmatter references, whether that page is configured or discovered under a
// folder or space root. When prune is true it also deletes them. It returns the
// report to print and any error.
func gc(
	ctx context.Context,
	rng *ring.Ring,
	path string,
	prune bool,
) (string, error) {

	cfg, err := loadConfig(rng, path)
	if err != nil {
		return "", err
	}
	return collectGarbage(ctx, cfg, prune)
}

// collectGarbage finds orphaned assets under cfg and, when prune is set,
// deletes them. Because _assets/ is shared across all pages, a file is orphaned
// only when no page references it; collectGarbage therefore reads every managed
// page, configured or under a folder or space root. It refuses to prune when
// any such page's Markdown cannot be read, since that page's references are then
// unknown and a still-used image could be deleted by mistake.
func collectGarbage(
	ctx context.Context,
	cfg *config,
	prune bool,
) (string, error) {

	orphans, unreadable, err := orphanedAssets(cfg)
	if err != nil {
		return "", err
	}

	var out strings.Builder
	for _, name := range unreadable {
		_, _ = fmt.Fprintf(&out,
			"warning: cannot read %s; its images are unknown\n", name)
	}

	if len(orphans) == 0 {
		out.WriteString("cfsync: no orphaned assets\n")
		return out.String(), nil
	}

	if !prune {
		_, _ = fmt.Fprintf(&out,
			"%d orphaned asset(s) in %s:\n", len(orphans), assetsDir)
		for _, o := range orphans {
			_, _ = fmt.Fprintf(&out, "  %s\n", filepath.Base(o))
		}
		out.WriteString(`cfsync: run "cfsync gc --prune" to delete them` + "\n")
		return out.String(), nil
	}

	if len(unreadable) > 0 {
		return out.String(), fmt.Errorf("refusing to prune: %d managed "+
			"page(s) could not be read", len(unreadable))
	}

	for _, o := range orphans {
		if err := ctx.Err(); err != nil {
			return out.String(), err
		}
		if err := os.Remove(o); err != nil {
			return out.String(), fmt.Errorf("removing %s: %w", o, err)
		}
		_, _ = fmt.Fprintf(&out, "pruned %s\n", filepath.Base(o))
	}
	_, _ = fmt.Fprintf(&out,
		"cfsync: pruned %d orphaned asset(s)\n", len(orphans))
	return out.String(), nil
}

// orphanedAssets lists the files in the shared assets directory that no
// configured page references, together with the names of pages whose Markdown
// could not be read (so their references are unknown). It reports no orphans
// when the assets directory does not exist.
func orphanedAssets(cfg *config) ([]string, []string, error) {
	dir := filepath.Join(cfg.WorkDir, assetsDir)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("reading %s: %w", dir, err)
	}

	referenced, unreadable := referencedAssets(cfg)

	var orphans []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		abs := filepath.Join(dir, e.Name())
		if !referenced[abs] {
			orphans = append(orphans, abs)
		}
	}
	sort.Strings(orphans)
	sort.Strings(unreadable)
	return orphans, unreadable, nil
}

// referencedAssets reads the page_images frontmatter of every managed Markdown
// file — each configured page and every page under a configured folder or space
// root — and returns the set of absolute asset paths they reference, plus the
// names of files whose Markdown could not be read or parsed. Because discovered
// pages share the same _assets directory as configured pages, both must be
// scanned or a still-used discovered-page image would look orphaned. Each
// page_images file path is resolved relative to its own Markdown file, mirroring
// how it was written.
func referencedAssets(cfg *config) (map[string]bool, []string) {
	referenced := make(map[string]bool)
	var unreadable []string
	seen := make(map[string]bool)

	add := func(dest string) {
		if seen[dest] {
			return
		}
		seen[dest] = true
		data, err := os.ReadFile(dest) //nolint:gosec // dest is managed by cfg.
		if err != nil {
			unreadable = append(unreadable, pageName(cfg.WorkDir, dest))
			return
		}
		meta, _, err := splitFrontmatter(data)
		if err != nil {
			unreadable = append(unreadable, pageName(cfg.WorkDir, dest))
			return
		}
		base := filepath.Dir(dest)
		for _, img := range meta.PageImages {
			abs := filepath.Join(base, filepath.FromSlash(img.File))
			referenced[abs] = true
		}
	}

	for dest := range cfg.Pages {
		add(dest)
	}
	for _, dest := range managedPageFiles(cfg) {
		add(dest)
	}
	return referenced, unreadable
}

// managedPageFiles returns the Markdown files under every configured folder and
// space root, so a discovered page's referenced assets are counted the same as
// a configured page's. These pages are discovered over the network on pull, so
// garbage collection — which runs offline — walks the on-disk roots instead. A
// root not yet pulled (an absent directory) contributes nothing.
func managedPageFiles(cfg *config) []string {
	roots := make([]string, 0, len(cfg.Folders)+len(cfg.Spaces))
	for root := range cfg.Folders {
		roots = append(roots, root)
	}
	for root := range cfg.Spaces {
		roots = append(roots, root)
	}
	return mdFilesUnder(roots)
}
