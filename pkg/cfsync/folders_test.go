// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ctx42/goldkit/pkg/goldkit"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/httpkit"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_discoverFolders(t *testing.T) {
	t.Run("recursive discovery, derived destinations", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{
		   "results": [
		      {"id": "1", "type": "page", "title": "Root Page 1"},
		      {"id": "200", "type": "folder", "title": "Sub"}
		   ],
		   "_links": {}
		}`)
		sub := []byte(`{
		   "results": [
		      {"id": "2", "type": "page", "title": "Child Page"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, top).
			Rsp(http.StatusOK, sub)
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
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "docs/root_page_1.md"),
				ID:       "1",
				Title:    "Root Page 1",
				URL:      "/wiki/spaces/DOCS/pages/1",
				ParentID: "100",
			},
			{
				Dest:     filepath.Join(dir, "docs/sub/child_page.md"),
				ID:       "2",
				Title:    "Child Page",
				URL:      "/wiki/spaces/DOCS/pages/2",
				ParentID: "200",
			},
		}
		assert.Equal(t, want, have)

		assert.Equal(t,
			"/wiki/api/v2/folders/100/direct-children", srv.Request(0).URL.Path)
		assert.Equal(t,
			"/wiki/api/v2/folders/200/direct-children", srv.Request(1).URL.Path)
	})

	t.Run("follows pagination to completion", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		page1 := []byte(`{
		   "results": [{"id": "1", "type": "page", "title": "One"}],
		   "_links": {
		      "next": "/wiki/api/v2/folders/100/direct-children?cursor=abc"
		   }
		}`)
		page2 := []byte(`{
		   "results": [{"id": "2", "type": "page", "title": "Two"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, page1).
			Rsp(http.StatusOK, page2)
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
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "docs/one.md"),
				ID:       "1",
				Title:    "One",
				URL:      "/wiki/spaces/DOCS/pages/1",
				ParentID: "100",
			},
			{
				Dest:     filepath.Join(dir, "docs/two.md"),
				ID:       "2",
				Title:    "Two",
				URL:      "/wiki/spaces/DOCS/pages/2",
				ParentID: "100",
			},
		}
		assert.Equal(t, want, have)
		assert.Equal(t, "abc", srv.Request(1).URL.Query().Get("cursor"))
	})

	t.Run("ignores non-page non-folder children", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{
		   "results": [
		      {"id": "1", "type": "page", "title": "Kept"},
		      {"id": "9", "type": "whiteboard", "title": "Board"},
		      {"id": "8", "type": "database", "title": "Data"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, top)
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
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "docs/kept.md"),
				ID:       "1",
				Title:    "Kept",
				URL:      "/wiki/spaces/DOCS/pages/1",
				ParentID: "100",
			},
		}
		assert.Equal(t, want, have)
	})

	t.Run("skips non-current children", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{
		   "results": [
		      {"id": "1", "type": "page", "title": "Kept"},
		      {"id": "9", "type": "page", "title": "", "status": "draft"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, top)
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
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "docs/kept.md"),
				ID:       "1",
				Title:    "Kept",
				URL:      "/wiki/spaces/DOCS/pages/1",
				ParentID: "100",
			},
		}
		assert.Equal(t, want, have)
	})

	t.Run("returns nothing when no folders configured", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		cfg := &config{WorkDir: t.TempDir()}

		// --- When ---
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Nil(t, have)
	})

	t.Run("skips a sibling that collides but keeps the rest", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{
		   "results": [
		      {"id": "1", "type": "page", "title": "Dup"},
		      {"id": "2", "type": "page", "title": "Dup"}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, top)
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
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		// Page 1 is placed; page 2 collides, is recorded, and skipped, and
		// the error names it.
		assert.ErrorContain(t, "name collision", err)
		assert.ErrorContain(t, "1 of 1 folders failed", err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "docs/dup.md"),
				ID:       "1",
				Title:    "Dup",
				URL:      "/wiki/spaces/DOCS/pages/1",
				ParentID: "100",
			},
		}
		assert.Equal(t, want, have)
	})

	t.Run("skips a page with an empty name but keeps the rest", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		// Page 2's title is whitespace only, so it derives to an empty name;
		// it is recorded and skipped while page 1 is still placed.
		top := []byte(`{
		   "results": [
		      {"id": "1", "type": "page", "title": "Good"},
		      {"id": "2", "type": "page", "title": " "}
		   ],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, top)
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
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		assert.ErrorContain(t, "page 2:", err)
		assert.ErrorContain(t, "derives to an empty name", err)
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "docs/good.md"),
				ID:       "1",
				Title:    "Good",
				URL:      "/wiki/spaces/DOCS/pages/1",
				ParentID: "100",
			},
		}
		assert.Equal(t, want, have)
	})

	t.Run("continues and reports when a folder fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		top := []byte(`{
		   "results": [{"id": "1", "type": "page", "title": "Kept"}],
		   "_links": {}
		}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusNotFound, nil).
			Rsp(http.StatusOK, top)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Folders: map[string]string{
				filepath.Join(dir, "a"): "/wiki/spaces/DOCS/folder/100",
				filepath.Join(dir, "b"): "/wiki/spaces/DOCS/folder/200",
			},
		}

		// --- When ---
		have, err := discoverFolders(ctx, client, cfg)

		// --- Then ---
		want := []folderPage{
			{
				Dest:     filepath.Join(dir, "b/kept.md"),
				ID:       "1",
				Title:    "Kept",
				URL:      "/wiki/spaces/DOCS/pages/1",
				ParentID: "200",
			},
		}
		assert.Equal(t, want, have)
		assert.ErrorContain(t, "1 of 2 folders failed", err)
		assert.ErrorContain(t, "a: folder 100 children: HTTP 404", err)
	})
}

func Test_config_collides(t *testing.T) {
	t.Run("no collision", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "/wd",
			Pages:   map[string]string{"/wd/page.md": "src"},
		}
		folders := []folderPage{
			{Dest: "/wd/docs/a.md", ID: "1"},
			{Dest: "/wd/docs/b.md", ID: "2"},
		}

		// --- When ---
		err := cfg.collides(folders)

		// --- Then ---
		assert.NoError(t, err)
	})

	t.Run("error - folder page collides with a configured page", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "/wd",
			Pages:   map[string]string{"/wd/docs/a.md": "src"},
		}
		folders := []folderPage{{Dest: "/wd/docs/a.md", ID: "1"}}

		// --- When ---
		err := cfg.collides(folders)

		// --- Then ---
		assert.ErrorContain(t, `"docs/a.md" is claimed by more than one`, err)
	})

	t.Run("error - two folder pages collide", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "/wd"}
		folders := []folderPage{
			{Dest: "/wd/docs/a.md", ID: "1"},
			{Dest: "/wd/docs/a.md", ID: "2"},
		}

		// --- When ---
		err := cfg.collides(folders)

		// --- Then ---
		assert.ErrorContain(t, `"docs/a.md" is claimed by more than one`, err)
	})

	t.Run("error - a page id is claimed by a page and a folder page", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "/wd",
			Pages:   map[string]string{"/wd/intro.md": "/wiki/spaces/T/pages/1/P"},
		}
		folders := []folderPage{{Dest: "/wd/team/intro.md", ID: "1"}}

		// --- When ---
		err := cfg.collides(folders)

		// --- Then ---
		assert.ErrorContain(t, "page 1 is claimed by more than one entry", err)
		assert.ErrorContain(t, `"intro.md"`, err)
		assert.ErrorContain(t, `"team/intro.md"`, err)
	})

	t.Run("error - two folder pages share a page id", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "/wd"}
		folders := []folderPage{
			{Dest: "/wd/a/x.md", ID: "7"},
			{Dest: "/wd/b/y.md", ID: "7"},
		}

		// --- When ---
		err := cfg.collides(folders)

		// --- Then ---
		assert.ErrorContain(t, "page 7 is claimed by more than one entry", err)
	})

	t.Run("error - two configured pages share a page id", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "/wd",
			Pages: map[string]string{
				"/wd/a.md": "/wiki/spaces/T/pages/9/P",
				"/wd/b.md": "/wiki/spaces/T/pages/9/P",
			},
		}

		// --- When ---
		err := cfg.collides(nil)

		// --- Then ---
		assert.ErrorContain(t, "page 9 is claimed by more than one entry", err)
	})

	t.Run("a non-page source contributes no id", func(t *testing.T) {
		// --- Given --- a folder source cannot be parsed to a page id, so it
		// takes part only in the destination check, not the id check.
		cfg := &config{
			WorkDir: "/wd",
			Pages:   map[string]string{"/wd/a.md": "/wiki/spaces/T/folder/1"},
		}
		folders := []folderPage{{Dest: "/wd/docs/b.md", ID: "1"}}

		// --- When ---
		err := cfg.collides(folders)

		// --- Then ---
		assert.NoError(t, err)
	})
}

func Test_pullDiscovered(t *testing.T) {
	t.Run("pulls discovered pages into the cache", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		body := goldkit.Create(t, pageTpl, pageData{
			ID:      "1",
			Title:   "T",
			SpaceID: "9",
			Version: 3,
			ADF:     `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}
		folders := []folderPage{
			{Dest: filepath.Join(dir, "docs/a.md"), ID: "1"},
		}

		// --- When ---
		have, sta, err := pullDiscovered(ctx, client, cfg, folders)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "docs/a.md ... ok (v3)", have)
		assert.Equal(t, pullStats{pulled: 1, total: 1}, sta)

		assert.Equal(t, "/wiki/api/v2/pages/1", srv.Request(0).URL.Path)

		md := oskit.ReadFileStr(t, filepath.Join(dir, "docs/a.md"))
		assert.Contain(t, "page_id: \"1\"", md)
		cached := filepath.Join(dir, adfCacheDir, "docs", "a.v3.json")
		assert.Contain(t, `"name": "docs/a.md"`, oskit.ReadFileStr(t, cached))
	})

	t.Run("the page's parent comes from the walk, not the page GET",
		func(t *testing.T) {
			// --- Given --- the page GET response reports no parentId, so a
			// stamped parent_id can only have come from the walk.
			ctx := t.Context()
			dir := t.TempDir()
			client := http.DefaultClient
			body := goldkit.Create(t, pageTpl, pageData{
				ID:      "1",
				Title:   "T",
				SpaceID: "9",
				Version: 3,
				ADF:     `{"type":"doc"}`,
			}).Body()
			srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
			cfg := &config{
				Host:    srv.URL(),
				Account: "a@ex.com",
				Token:   "secret",
				WorkDir: dir,
			}
			folders := []folderPage{
				{
					Dest:     filepath.Join(dir, "docs/a.md"),
					ID:       "1",
					ParentID: "77",
				},
			}

			// --- When ---
			_, _, err := pullDiscovered(ctx, client, cfg, folders)

			// --- Then ---
			assert.NoError(t, err)
			md := oskit.ReadFileStr(t, filepath.Join(dir, "docs/a.md"))
			assert.Contain(t, "parent_id: \"77\"", md)
		})

	t.Run("skips an already-cached version", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		body := goldkit.Create(t, pageTpl, pageData{
			ID:      "1",
			Title:   "T",
			SpaceID: "9",
			Version: 3,
			ADF:     `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		oskit.MkdirAll(t, dir, adfCacheDir, "docs")
		oskit.Create(t, "original", dir, adfCacheDir, "docs", "a.v3.json")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}
		folders := []folderPage{
			{Dest: filepath.Join(dir, "docs/a.md"), ID: "1"},
		}

		// --- When ---
		have, sta, err := pullDiscovered(ctx, client, cfg, folders)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "docs/a.md ... skipped (v3 cached), md written", have)
		assert.Equal(t, pullStats{rendered: 1, total: 1}, sta)
	})

	t.Run("returns nothing when no pages", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		cfg := &config{WorkDir: t.TempDir()}

		// --- When ---
		have, sta, err := pullDiscovered(ctx, client, cfg, nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "", have)
		assert.Equal(t, pullStats{}, sta)
	})

	t.Run("continues and reports when a page fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}
		folders := []folderPage{
			{Dest: filepath.Join(dir, "docs/a.md"), ID: "1"},
		}

		// --- When ---
		_, _, err := pullDiscovered(ctx, client, cfg, folders)

		// --- Then ---
		assert.ErrorContain(t, "1 of 1 pages failed", err)
		assert.ErrorContain(t, "docs/a.md: page 1: HTTP 404", err)
	})
}

func Test_fetchChildren(t *testing.T) {
	t.Run("returns one page of children", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		body := []byte(`{
		   "results": [{"id": "1", "type": "page", "title": "One"}],
		   "_links": {"next": "/next"}
		}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		path := "/wiki/api/v2/folders/100/direct-children"

		// --- When ---
		have, err := fetchChildren(ctx, client, cfg, "folder", "100", path)

		// --- Then ---
		assert.NoError(t, err)
		assert.Len(t, 1, have.Results)
		assert.Equal(t, "One", have.Results[0].Title)
		assert.Equal(t, "/next", have.Links.Next)
	})

	t.Run("error - non-2xx response", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusInternalServerError, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		path := "/wiki/api/v2/folders/100/direct-children"

		// --- When ---
		have, err := fetchChildren(ctx, client, cfg, "folder", "100", path)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "folder 100 children: HTTP 500", err)
	})

	t.Run("error - invalid response body", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte("not-json"))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		path := "/wiki/api/v2/folders/100/direct-children"

		// --- When ---
		have, err := fetchChildren(ctx, client, cfg, "folder", "100", path)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "decoding folder 100 children", err)
	})
}

func Test_childFolderTitled(t *testing.T) {
	found := []byte(
		`{"results":[{"id":"FX","type":"folder","title":"Alpha","status":"current"}]}`)

	t.Run("finds a matching folder under a folder parent", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, found)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := childFolderTitled(ctx, http.DefaultClient, cfg, "100", "Alpha")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "FX", have)
		assert.Equal(t, 1, srv.ReqCount())
		assert.Equal(t,
			"/wiki/api/v2/folders/100/direct-children", srv.Request(0).URL.Path)
	})

	t.Run("falls back to the page endpoint when parent is a page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusNotFound, nil).
			Rsp(http.StatusOK, found)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := childFolderTitled(ctx, http.DefaultClient, cfg, "100", "Alpha")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "FX", have)
		assert.Equal(t, 2, srv.ReqCount())
		assert.Equal(t,
			"/wiki/api/v2/pages/100/direct-children", srv.Request(1).URL.Path)
	})

	t.Run("returns empty when both endpoints report not found", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusNotFound, nil).
			Rsp(http.StatusNotFound, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := childFolderTitled(ctx, http.DefaultClient, cfg, "100", "Alpha")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "", have)
		assert.Equal(t, 2, srv.ReqCount())
	})

	t.Run("follows pagination to a later page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		page1 := []byte(
			`{"results":[{"id":"P1","type":"page","title":"Note"}],` +
				`"_links":{"next":"/next"}}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, page1).
			Rsp(http.StatusOK, found)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := childFolderTitled(ctx, http.DefaultClient, cfg, "100", "Alpha")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "FX", have)
		assert.Equal(t, 2, srv.ReqCount())
	})

	t.Run("error - non-404 error status", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusInternalServerError, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := childFolderTitled(ctx, http.DefaultClient, cfg, "100", "Alpha")

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "listing children: HTTP 500", err)
	})
}

func Test_newChildrenRequest(t *testing.T) {
	t.Run("builds an authenticated children request", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		cfg := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
		}
		path := "/wiki/api/v2/folders/100/direct-children?cursor=abc"

		// --- When ---
		have, err := newChildrenRequest(ctx, cfg, path)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, http.MethodGet, have.Method)
		assert.Equal(t, "abc", have.URL.Query().Get("cursor"))

		user, pass, ok := have.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "a@ex.com", user)
		assert.Equal(t, "secret", pass)
	})

	t.Run("accepts an absolute pagination next URL", func(t *testing.T) {
		// --- Given --- nextURL may hand a fully-qualified next link.
		ctx := t.Context()
		cfg := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
		}
		path := "https://cdn.example/wiki/api/v2/folders/100/direct-children?c=2"

		// --- When ---
		have, err := newChildrenRequest(ctx, cfg, path)

		// --- Then --- host is not prepended again.
		assert.NoError(t, err)
		assert.Equal(t, path, have.URL.String())
	})

	t.Run("error - host is not a valid URL", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		cfg := &config{Host: "https://ex\x7f.net", Token: "secret"}

		// --- When ---
		have, err := newChildrenRequest(ctx, cfg, "/path")

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "building request", err)
	})
}

func Test_folderID_tabular(t *testing.T) {
	tt := []struct {
		testN string
		src   string
		want  string
	}{
		{"folder", "/wiki/spaces/DOCS/folder/1614610446", "1614610446"},
		{"folder with name", "/wiki/spaces/DOCS/folder/100/Glossary", "100"},
		{"folder with query", "/wiki/spaces/DOCS/folder/7?x=1", "7"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have, err := folderID(tc.src)

			// --- Then ---
			assert.NoError(t, err)
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_folderID_error_tabular(t *testing.T) {
	tt := []struct {
		testN string
		src   string
	}{
		{"error - page source", "/wiki/spaces/DOCS/pages/1/Title"},
		{"error - no id segment", "/wiki/spaces/DOCS/folder/"},
		{"error - non-numeric id", "/wiki/spaces/DOCS/folder/abc"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have, err := folderID(tc.src)

			// --- Then ---
			assert.Equal(t, "", have)
			assert.ErrorContain(t, "is not a folder", err)
		})
	}
}

func Test_deriveName_tabular(t *testing.T) {
	tt := []struct {
		testN string
		title string
		want  string
	}{
		{"lowercases and underscores spaces", "Root Page 1", "root_page_1"},
		{"single word", "Glossary", "glossary"},
		{"collapses and trims whitespace", "  spaced   out ", "spaced_out"},
		{"replaces path separator", "a/b", "a_b"},
		{"replaces unsafe chars", `a:b?c*d"e<f>g|h\i`, "a_b_c_d_e_f_g_h_i"},
		{"collapses tab whitespace", "a\tb", "a_b"},
		{"keeps non-ascii verbatim", "Café", "café"},
		{"replaces leading dot", ".hidden", "_hidden"},
		{"replaces trailing dot", "trailing.", "trailing_"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have, err := deriveName(tc.title)

			// --- Then ---
			assert.NoError(t, err)
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_deriveName_error_tabular(t *testing.T) {
	tt := []struct {
		testN string
		title string
	}{
		{"error - empty title", ""},
		{"error - whitespace only", "   "},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have, err := deriveName(tc.title)

			// --- Then ---
			assert.Equal(t, "", have)
			assert.ErrorContain(t, "derives to an empty name", err)
		})
	}
}
