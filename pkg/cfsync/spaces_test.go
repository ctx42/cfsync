// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/httpkit"
)

func Test_spaceLinkKey(t *testing.T) {
	t.Run("bare space link", func(t *testing.T) {
		// --- When ---
		have, err := spaceLinkKey("/wiki/spaces/TEST")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "TEST", have)
	})

	t.Run("overview suffix", func(t *testing.T) {
		// --- When ---
		have, err := spaceLinkKey("/wiki/spaces/TEST/overview")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "TEST", have)
	})

	t.Run("full url", func(t *testing.T) {
		// --- When ---
		have, err := spaceLinkKey("https://ex.atlassian.net/wiki/spaces/TEST")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "TEST", have)
	})

	t.Run("trailing slash", func(t *testing.T) {
		// --- When ---
		have, err := spaceLinkKey("/wiki/spaces/TEST/")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "TEST", have)
	})

	t.Run("personal space key", func(t *testing.T) {
		// --- When ---
		have, err := spaceLinkKey("/wiki/spaces/~712020/overview")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "~712020", have)
	})
}

func Test_spaceLinkKey_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		link    string
		wantErr string
	}{
		{"page link", "/wiki/spaces/TEST/pages/1/Page", "is not a space root"},
		{"folder link", "/wiki/spaces/TEST/folder/100", "is not a space root"},
		{"empty key", "/wiki/spaces/", "is not a space root"},
		{"no spaces segment", "/wiki/pages/1/Page", "is not a space root"},
		{"empty link", "", "is not a space root"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have, err := spaceLinkKey(tc.link)

			// --- Then ---
			assert.ErrorContain(t, tc.wantErr, err)
			assert.Equal(t, "", have)
		})
	}
}

// spaceOK is the spaces-by-key response body naming homepage id "H".
var spaceOK = []byte(`{"results": [{"id": "S1", "homepageId": "H"}]}`)

// noChildren is a direct-children response body with no children.
var noChildren = []byte(`{"results": [], "_links": {}}`)

func Test_discoverSpaces(t *testing.T) {
	t.Run("walks each configured space", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		home := []byte(`{
		   "results": [{"id": "P1", "type": "page", "title": "Alpha"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).
			Rsp(http.StatusOK, home).
			Rsp(http.StatusOK, noChildren)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Spaces:  map[string]string{dir: "/wiki/spaces/TEST"},
		}

		// --- When ---
		have, err := discoverSpaces(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "_index.md"),
				ID:       "H",
				URL:      "/wiki/spaces/TEST/pages/H",
				SpaceKey: "TEST",
			},
			{
				Dest:     filepath.Join(dir, "alpha.md"),
				ID:       "P1",
				Title:    "Alpha",
				URL:      "/wiki/spaces/TEST/pages/P1",
				ParentID: "H",
				SpaceKey: "TEST",
			},
		}
		assert.Equal(t, want, have)
	})

	t.Run("error - a space fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"results": []}`))
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Spaces:  map[string]string{dir: "/wiki/spaces/TEST"},
		}

		// --- When ---
		have, err := discoverSpaces(ctx, client, cfg)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "1 of 1 spaces failed", err)
		assert.ErrorContain(t, `space "TEST" not found`, err)
	})

	t.Run("a partially failed space still contributes its pages", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		// P1 is placed; P2 collides with it and is skipped. The space
		// reports the collision yet still contributes P1 and the homepage.
		home := []byte(`{
		   "results": [
		      {"id": "P1", "type": "page", "title": "Same"},
		      {"id": "P2", "type": "page", "title": "Same"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).
			Rsp(http.StatusOK, home).
			Rsp(http.StatusOK, noChildren). // P1
			Rsp(http.StatusOK, noChildren)  // P2, colliding
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Spaces:  map[string]string{dir: "/wiki/spaces/TEST"},
		}

		// --- When ---
		have, err := discoverSpaces(ctx, client, cfg)

		// --- Then ---
		assert.ErrorContain(t, "1 of 1 spaces failed", err)
		assert.ErrorContain(t, "name collision: same.md", err)
		assert.Len(t, 2, have)
	})

	t.Run("no spaces returns nothing", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		cfg := &config{WorkDir: t.TempDir()}

		// --- When ---
		have, err := discoverSpaces(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Nil(t, have)
	})
}

func Test_discoverSpace(t *testing.T) {
	t.Run("derives destinations across the tree", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		home := []byte(`{
		   "results": [
		      {"id": "P1", "type": "page", "title": "Alpha"},
		      {"id": "F1", "type": "folder", "title": "Docs"},
		      {"id": "P2", "type": "page", "title": "Beta"}
		   ],
		   "_links": {}
		}`)
		docs := []byte(`{
		   "results": [{"id": "P3", "type": "page", "title": "Gamma"}],
		   "_links": {}
		}`)
		beta := []byte(`{
		   "results": [{"id": "P4", "type": "page", "title": "Delta"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).
			Rsp(http.StatusOK, home).
			Rsp(http.StatusOK, noChildren). // P1
			Rsp(http.StatusOK, docs).       // F1
			Rsp(http.StatusOK, noChildren). // P3
			Rsp(http.StatusOK, beta).       // P2
			Rsp(http.StatusOK, noChildren)  // P4
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}

		// --- When ---
		have, err := discoverSpace(ctx, client, cfg, "/wiki/spaces/TEST", dir)

		// --- Then ---
		assert.NoError(t, err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "_index.md"),
				ID:       "H",
				URL:      "/wiki/spaces/TEST/pages/H",
				SpaceKey: "TEST",
			},
			{
				Dest:     filepath.Join(dir, "alpha.md"),
				ID:       "P1",
				Title:    "Alpha",
				URL:      "/wiki/spaces/TEST/pages/P1",
				ParentID: "H",
				SpaceKey: "TEST",
			},
			{
				Dest:     filepath.Join(dir, "docs/gamma.md"),
				ID:       "P3",
				Title:    "Gamma",
				URL:      "/wiki/spaces/TEST/pages/P3",
				ParentID: "F1",
				SpaceKey: "TEST",
			},
			{
				Dest:     filepath.Join(dir, "beta/_index.md"),
				ID:       "P2",
				Title:    "Beta",
				URL:      "/wiki/spaces/TEST/pages/P2",
				ParentID: "H",
				SpaceKey: "TEST",
			},
			{
				Dest:     filepath.Join(dir, "beta/delta.md"),
				ID:       "P4",
				Title:    "Delta",
				URL:      "/wiki/spaces/TEST/pages/P4",
				ParentID: "P2",
				SpaceKey: "TEST",
			},
		}
		assert.Equal(t, want, have)
	})

	t.Run("skips non-current children", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		// P9 is archived; P8 is an untitled draft, whose empty title would
		// otherwise abort the walk when it fails to derive a name.
		home := []byte(`{
		   "results": [
		      {"id": "P1", "type": "page", "title": "Alpha"},
		      {"id": "P9", "type": "page", "title": "Old", "status": "archived"},
		      {"id": "P8", "type": "page", "title": "", "status": "draft"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).
			Rsp(http.StatusOK, home).
			Rsp(http.StatusOK, noChildren) // P1 only; P9 and P8 are skipped
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}

		// --- When ---
		have, err := discoverSpace(ctx, client, cfg, "/wiki/spaces/TEST", dir)

		// --- Then ---
		assert.NoError(t, err)
		assert.Len(t, 2, have)
		assert.Equal(t, "P1", have[1].ID)
	})

	t.Run("disambiguates a page named like the index", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		home := []byte(`{
		   "results": [{"id": "P1", "type": "page", "title": "_index"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).
			Rsp(http.StatusOK, home).
			Rsp(http.StatusOK, noChildren)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}

		// --- When ---
		have, err := discoverSpace(ctx, client, cfg, "/wiki/spaces/TEST", dir)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, filepath.Join(dir, "_index.md"), have[0].Dest)
		assert.Equal(t, filepath.Join(dir, "_index-P1.md"), have[1].Dest)
	})

	t.Run("skips a sibling that collides but keeps the rest", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		home := []byte(`{
		   "results": [
		      {"id": "P1", "type": "page", "title": "Same"},
		      {"id": "P2", "type": "page", "title": "Same"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).
			Rsp(http.StatusOK, home).
			Rsp(http.StatusOK, noChildren). // P1
			Rsp(http.StatusOK, noChildren)  // P2, colliding
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}

		// --- When ---
		have, err := discoverSpace(ctx, client, cfg, "/wiki/spaces/TEST", dir)

		// --- Then ---
		// P1 and the homepage index are placed; P2 collides, is recorded,
		// and skipped, and the error names it.
		assert.ErrorContain(t, "name collision: same.md", err)
		assert.Len(t, 2, have)
		assert.Equal(t, filepath.Join(dir, indexFile), have[0].Dest)
		assert.Equal(t, filepath.Join(dir, "same.md"), have[1].Dest)
	})

	t.Run("keeps pages after a page whose children fail", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		// P1 is a container page whose children fetch fails; P2 is a healthy
		// sibling that must still be discovered.
		home := []byte(`{
		   "results": [
		      {"id": "P1", "type": "page", "title": "Broken"},
		      {"id": "P2", "type": "page", "title": "Good"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).
			Rsp(http.StatusOK, home).
			Rsp(http.StatusInternalServerError, nil). // P1 children fail
			Rsp(http.StatusOK, noChildren)            // P2
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}

		// --- When ---
		have, err := discoverSpace(ctx, client, cfg, "/wiki/spaces/TEST", dir)

		// --- Then ---
		assert.ErrorContain(t, "page P1 children: HTTP 500", err)
		assert.Len(t, 2, have)
		assert.Equal(t, filepath.Join(dir, indexFile), have[0].Dest)
		assert.Equal(t, filepath.Join(dir, "good.md"), have[1].Dest)
	})
}

func Test_resolveSpaceID(t *testing.T) {
	t.Run("returns the id and homepage id", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, spaceOK)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		id, home, err := resolveSpaceID(ctx, client, cfg, "TEST")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "S1", id)
		assert.Equal(t, "H", home)
		assert.Equal(t,
			"/wiki/api/v2/spaces", srv.Request(0).URL.Path)
		assert.Equal(t, "keys=TEST", srv.Request(0).URL.RawQuery)
	})

	t.Run("error - space not found", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte(`{"results": []}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		id, home, err := resolveSpaceID(ctx, client, cfg, "TEST")

		// --- Then ---
		assert.ErrorContain(t, `space "TEST" not found`, err)
		assert.Equal(t, "", id)
		assert.Equal(t, "", home)
	})

	t.Run("error - space has no homepage", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		body := []byte(`{"results": [{"id": "S1"}]}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, _, err := resolveSpaceID(ctx, client, cfg, "TEST")

		// --- Then ---
		assert.ErrorContain(t, `space "TEST" has no homepage`, err)
	})

	t.Run("error - non-2xx response", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, _, err := resolveSpaceID(ctx, client, cfg, "TEST")

		// --- Then ---
		assert.ErrorContain(t, `space "TEST": HTTP 404`, err)
	})

	t.Run("error - invalid response body", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte("not-json"))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, _, err := resolveSpaceID(ctx, client, cfg, "TEST")

		// --- Then ---
		assert.ErrorContain(t, `decoding space "TEST"`, err)
	})
}

func Test_spaceWalk_claim(t *testing.T) {
	t.Run("claims a free name", func(t *testing.T) {
		// --- Given ---
		wlk := &spaceWalk{cfg: &config{WorkDir: t.TempDir()}}
		dest := filepath.Join(wlk.cfg.WorkDir, "intro.md")
		seen := map[string]bool{}

		// --- When ---
		have := wlk.claim("intro", dest, "", seen)

		// --- Then ---
		assert.True(t, have)
		assert.Nil(t, wlk.errs)
	})

	t.Run("rejects a duplicate page name", func(t *testing.T) {
		// --- Given ---
		wlk := &spaceWalk{cfg: &config{WorkDir: t.TempDir()}}
		dest := filepath.Join(wlk.cfg.WorkDir, "dup.md")
		seen := map[string]bool{}
		wlk.claim("dup", dest, "", seen)

		// --- When ---
		have := wlk.claim("dup", dest, "", seen)

		// --- Then ---
		assert.False(t, have)
		assert.Len(t, 1, wlk.errs)
		assert.ErrorContain(t, "name collision: dup.md", wlk.errs[0])
	})

	t.Run("a page and a directory of one name do not collide", func(t *testing.T) {
		// --- Given ---
		wlk := &spaceWalk{cfg: &config{WorkDir: t.TempDir()}}
		pageDest := filepath.Join(wlk.cfg.WorkDir, "docs.md")
		dirDest := filepath.Join(wlk.cfg.WorkDir, "docs")
		seen := map[string]bool{}
		wlk.claim("docs", pageDest, "", seen)

		// --- When --- the directory slot is distinct from the page slot.
		have := wlk.claim("docs", "", dirDest, seen)

		// --- Then ---
		assert.True(t, have)
		assert.Nil(t, wlk.errs)
	})
}

func Test_childrenLink_tabular(t *testing.T) {
	tt := []struct {
		testN string
		kind  string
		id    string
		want  string
	}{
		{"page", "page", "1", "/wiki/api/v2/pages/1/direct-children"},
		{"folder", "folder", "2", "/wiki/api/v2/folders/2/direct-children"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := childrenLink(tc.kind, tc.id)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}
