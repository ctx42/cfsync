// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

// These tests hit the live Atlassian Site using the environment loaded by
// liveEnv (see live_test.go). They run only when CFSYNC_TEST_HOST,
// CFSYNC_TEST_ACCOUNT, CFSYNC_TEST_TOKEN and CFSYNC_TEST_SPACE are set (directly
// or via a .env file at the repository root); otherwise they skip.
//
// Run with: go test -tags confluence ./pkg/cfsync/
package cfsync

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_live_push_noop(t *testing.T) {
	// A pull refreshes a page's Markdown to its baseline, so an immediate push
	// must report no changes and send no update — a full-pipeline smoke test
	// (frontmatter parse, cache load, Put, GetPut) that mutates nothing beyond
	// the throwaway page it creates.

	// --- Given ---
	ctx, client, cfg, lp := liveEnv(t)
	spaceID := must.Value(spaceIDByKey(ctx, client, cfg, lp.space))
	id := must.Value(seedPage(ctx, client, cfg, spaceID, lp.folder,
		uniqueTitle("push-noop"),
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"hello from cfsync"}]}]}`))
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, id) })

	dest := filepath.Join(cfg.WorkDir, "page.md")
	cfg.Pages = map[string]string{
		dest: "/wiki/spaces/" + lp.space + "/pages/" + id + "/it",
	}
	_, _, err := pullPages(ctx, client, cfg)
	must.Nil(err)

	// --- When ---
	have, err := pushPages(ctx, client, cfg, "")

	// --- Then ---
	assert.NoError(t, err)
	assert.Contain(t, "no changes", have)
}
