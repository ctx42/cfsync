// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

// This integration test hits the live Atlassian Site using the environment
// loaded by liveEnv (see live_test.go). It MUTATES: it creates one throwaway
// page in the configured test space, pulls the whole space, edits and pushes
// that page, and verifies the edit on the Site. Only the throwaway page is
// changed — push sends a page only when its Markdown diverges from the cache
// written on pull, so every other page reports no changes. The page is deleted
// on cleanup.
//
// Run with: go test -tags confluence -run Test_live_space ./pkg/cfsync/
package cfsync

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testkit/pkg/oskit"
)

// Test_live_space_roundtrip pulls the whole test space, then edits and pushes a
// throwaway page created for the test, exercising the spaces: pull and push
// wiring end-to-end against the Site.
func Test_live_space_roundtrip(t *testing.T) {
	ctx, client, cfg, lp := liveEnv(t)

	// Create the throwaway page with a known seed paragraph.
	const seed = "space round trip seed"
	initial := `{"type":"doc","content":[{"type":"paragraph","content":[` +
		`{"type":"text","text":"` + seed + `"}]}]}`
	spaceID := must.Value(spaceIDByKey(ctx, client, cfg, lp.space))
	id := must.Value(seedPage(
		ctx, client, cfg, spaceID, lp.folder, uniqueTitle("space-rt"), initial))
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, id) })

	// Pull the whole space into the work dir.
	cfg.Spaces = map[string]string{cfg.WorkDir: "/wiki/spaces/" + lp.space}
	_, err := pullConfig(ctx, client, cfg)
	must.Nil(err)

	// The homepage lands at the space root, and the throwaway page is reachable
	// from the homepage walk, so its Markdown was written.
	assert.FileExist(t, filepath.Join(cfg.WorkDir, indexFile))
	dest := findSpacePage(t, cfg.WorkDir, id)
	assert.NotEqual(t, "", dest)

	// Edit the body and push. Only the edited page is selected, so the live run
	// can touch nothing else in the real space; the whole-space "push only what
	// changed" path is covered hermetically by Test_pushSpaces.
	md := oskit.ReadFileStr(t, dest)
	edited := strings.Replace(md, seed, seed+" EDITED", 1)
	assert.NotEqual(t, md, edited) // the seed was present to edit
	oskit.Create(t, edited, dest)

	out, err := pushSpaces(ctx, ring.New(), client, cfg, dest, false)
	must.Nil(err)
	assert.Contain(t, "ok (v2)", out)
	assert.Contain(t, "1 of 1 pages pushed", out)

	// The edit is live on the Site at the next version.
	src := "/wiki/spaces/" + lp.space + "/pages/" + id + "/it"
	fetched := must.Value(fetchPage(ctx, client, cfg, "page.md", src))
	assert.Equal(t, 2, fetched.Version)
	assert.Contain(t, seed+" EDITED", docText(must.Value(fetched.doc())))
}

// findSpacePage returns the pulled Markdown file under root whose frontmatter
// page_id is id, skipping the ADF cache. It returns "" when none matches.
func findSpacePage(t *testing.T, root, id string) string {
	t.Helper()
	sep := string(os.PathSeparator)
	for _, p := range mdFilesUnder([]string{root}) {
		if strings.Contains(p, sep+adfCacheDir+sep) {
			continue
		}
		meta, _, err := splitFrontmatter([]byte(oskit.ReadFileStr(t, p)))
		if err != nil {
			continue
		}
		if meta.PageID == id {
			return p
		}
	}
	return ""
}
