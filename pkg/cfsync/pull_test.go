// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ctx42/goldkit/pkg/goldkit"
	"github.com/ctx42/ring/pkg/ring/ringtest"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/httpkit"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_pull(t *testing.T) {
	t.Run("error - configuration cannot be loaded", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		path := "does-not-exist.yaml"

		// --- When ---
		have, err := pull(ctx, rng, path, "")

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "reading config", err)
	})
}

func Test_pullConfig(t *testing.T) {
	t.Run("keeps the prior links index on partial folder discovery",
		func(t *testing.T) {
			// --- Given --- a prior complete links index on disk that lists a
			// folder page, a config whose one folder fails discovery (404), and
			// one configured page that pulls fine.
			ctx := t.Context()
			client := http.DefaultClient
			dir := t.TempDir()
			page := goldkit.Create(t, pageTpl, pageData{
				ID: "1", Title: "A", SpaceID: "9", Version: 2,
				ADF: `{"type":"doc"}`,
			}).Body()
			srv := httpkit.NewServer(t).
				Rsp(http.StatusNotFound, nil). // folder direct-children
				Rsp(http.StatusOK, page)       // configured page

			prior := "" +
				`[{"id":"1","dest":"a.md","url":"/wiki/spaces/T/pages/1/A",` +
				`"title":""},` +
				`{"id":"9","dest":"docs/child.md",` +
				`"url":"/wiki/spaces/D/pages/9/C","title":"Child"}]` + "\n"
			oskit.MkdirAll(t, dir, adfCacheDir)
			oskit.Create(t, prior, dir, adfCacheDir, linksFile)

			cfg := &config{
				Host:    srv.URL(),
				Account: "a@ex.com",
				Token:   "secret",
				WorkDir: dir,
				Pages: map[string]string{
					filepath.Join(dir, "a.md"): "/wiki/spaces/T/pages/1/A",
				},
				Folders: map[string]string{
					filepath.Join(dir, "docs"): "/wiki/spaces/D/folder/100",
				},
			}

			// --- When ---
			_, err := pullConfig(ctx, client, cfg)

			// --- Then --- discovery failed, and the prior index is untouched,
			// so the folder page it listed survives for a later push.
			assert.ErrorContain(t, "folders failed", err)

			have := oskit.ReadFileStr(t, filepath.Join(dir, adfCacheDir, linksFile))
			assert.Contain(t, "docs/child.md", have)
		})

	t.Run("pulls a whole space", func(t *testing.T) {
		// --- Given --- a spaces-only config whose space has a homepage and one
		// child page.
		ctx := t.Context()
		client := http.DefaultClient
		dir := t.TempDir()
		homeChildren := []byte(`{
		   "results": [{"id": "P1", "type": "page", "title": "Alpha"}],
		   "_links": {}
		}`)
		homePage := goldkit.Create(t, pageTpl, pageData{
			ID: "H", Title: "Home", SpaceID: "9", Version: 1,
			ADF: `{"type":"doc"}`,
		}).Body()
		alphaPage := goldkit.Create(t, pageTpl, pageData{
			ID: "P1", Title: "Alpha", SpaceID: "9", Version: 1,
			ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, spaceOK).      // resolve space key
			Rsp(http.StatusOK, homeChildren). // homepage children
			Rsp(http.StatusOK, noChildren).   // P1 children
			Rsp(http.StatusOK, homePage).     // fetch homepage
			Rsp(http.StatusOK, alphaPage)     // fetch P1
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Spaces:  map[string]string{dir: "/wiki/spaces/TEST"},
		}

		// --- When ---
		have, err := pullConfig(ctx, client, cfg)

		// --- Then --- the homepage lands at _index.md and the child alongside.
		assert.NoError(t, err)
		assert.Contain(t, "_index.md ... ok (v1)", have)
		assert.Contain(t, "alpha.md ... ok (v1)", have)
		assert.Contain(t,
			"cfsync: 2 pages — 2 pulled (new version), "+
				"0 re-rendered, 0 unchanged", have)

		assert.FileExist(t, filepath.Join(dir, "_index.md"))
		assert.FileExist(t, filepath.Join(dir, "alpha.md"))

		// The homepage has no parent and omits parent_id; the child page
		// carries the homepage id as its parent_id, from the walk.
		home := oskit.ReadFileStr(t, filepath.Join(dir, "_index.md"))
		assert.NotContain(t, "parent_id", home)
		alpha := oskit.ReadFileStr(t, filepath.Join(dir, "alpha.md"))
		assert.Contain(t, "parent_id: \"H\"", alpha)

		links := oskit.ReadFileStr(t, filepath.Join(dir, adfCacheDir, linksFile))
		assert.Contain(t, "_index.md", links)
		assert.Contain(t, "alpha.md", links)
	})

	t.Run("combines the summary across pages and folders", func(t *testing.T) {
		// --- Given --- one configured page and one folder holding one page.
		ctx := t.Context()
		client := http.DefaultClient
		dir := t.TempDir()
		children := []byte(`{
		   "results": [{"id": "2", "type": "page", "title": "Child"}],
		   "_links": {}
		}`)
		page1 := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "A", SpaceID: "9", Version: 1, ADF: `{"type":"doc"}`,
		}).Body()
		page2 := goldkit.Create(t, pageTpl, pageData{
			ID: "2", Title: "Child", SpaceID: "9", Version: 1, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, children). // folder discovery
			Rsp(http.StatusOK, page1).    // configured page
			Rsp(http.StatusOK, page2)     // folder page
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/T/pages/1/A",
			},
			Folders: map[string]string{
				filepath.Join(dir, "docs"): "/wiki/spaces/D/folder/100",
			},
		}

		// --- When ---
		have, err := pullConfig(ctx, client, cfg)

		// --- Then --- one combined summary, not one per source.
		assert.NoError(t, err)
		assert.Contain(t, "a.md ... ok (v1)", have)
		assert.Contain(t, "docs/child.md ... ok (v1)", have)
		assert.Contain(t,
			"cfsync: 2 pages — 2 pulled (new version), "+
				"0 re-rendered, 0 unchanged", have)
		assert.NotContain(t, "1 pulled (new version)", have)
	})
}

func Test_pullSelected(t *testing.T) {
	t.Run("pulls a configured page by path without discovery", func(t *testing.T) {
		// --- Given --- a config with one page and a server that serves only
		// that page, so any folder or space discovery would run out of
		// responses and fail.
		ctx := t.Context()
		client := http.DefaultClient
		dir := t.TempDir()
		page := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "A", SpaceID: "9", ParentID: "77", Version: 3,
			ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, page)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/T/pages/1/A",
			},
		}

		// --- When ---
		have, err := pullSelected(ctx, client, cfg, "a.md")

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "a.md ... ok (v3)", have)
		assert.Contain(t, "cfsync: 1 page pulled (new version)", have)
		assert.FileExist(t, filepath.Join(dir, "a.md"))
		assert.Equal(t, 1, srv.ReqCount()) // Only the page, no discovery.

		// A single-page re-pull has no walk to consult, so its parent_id
		// comes straight from the page GET, same as any pages:-mapped page.
		md := oskit.ReadFileStr(t, filepath.Join(dir, "a.md"))
		assert.Contain(t, "parent_id: \"77\"", md)
	})

	t.Run("a page GET without parentId omits parent_id", func(t *testing.T) {
		// --- Given --- a page response with no parentId field at all, so the
		// decode must leave the parent empty and the frontmatter omit it.
		ctx := t.Context()
		client := http.DefaultClient
		dir := t.TempDir()
		body := `{"id":"1","title":"A","spaceId":"9",` +
			`"version":{"number":3},` +
			`"body":{"atlas_doc_format":{"value":"{\"type\":\"doc\"}"}}}`
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte(body))
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/T/pages/1/A",
			},
		}

		// --- When ---
		_, err := pullSelected(ctx, client, cfg, "a.md")

		// --- Then --- the empty parent is not written to the frontmatter.
		assert.NoError(t, err)
		md := oskit.ReadFileStr(t, filepath.Join(dir, "a.md"))
		assert.NotContain(t, "parent_id", md)
	})

	t.Run("pulls a link-indexed page by path without discovery",
		func(t *testing.T) {
			// --- Given --- a folder-only config, a prior links index that lists
			// the folder page, and a server that serves only that page.
			ctx := t.Context()
			client := http.DefaultClient
			dir := t.TempDir()
			page := goldkit.Create(t, pageTpl, pageData{
				ID: "9", Title: "Child", SpaceID: "9", Version: 1,
				ADF: `{"type":"doc"}`,
			}).Body()
			srv := httpkit.NewServer(t).Rsp(http.StatusOK, page)
			prior := "" +
				`[{"id":"9","dest":"docs/child.md",` +
				`"url":"/wiki/spaces/D/pages/9/C","title":"Child"}]` + "\n"
			oskit.MkdirAll(t, dir, adfCacheDir)
			oskit.Create(t, prior, dir, adfCacheDir, linksFile)
			cfg := &config{
				Host:    srv.URL(),
				Account: "a@ex.com",
				Token:   "secret",
				WorkDir: dir,
				Folders: map[string]string{
					filepath.Join(dir, "docs"): "/wiki/spaces/D/folder/100",
				},
			}

			// --- When ---
			have, err := pullSelected(ctx, client, cfg, "docs/child.md")

			// --- Then ---
			assert.NoError(t, err)
			assert.Contain(t, "docs/child.md ... ok (v1)", have)
			assert.FileExist(t, filepath.Join(dir, "docs", "child.md"))
			assert.Equal(t, 1, srv.ReqCount()) // Only the page, no discovery.
		})

	t.Run("leaves the link index unchanged", func(t *testing.T) {
		// --- Given --- a folder page pulled by path against a prior index.
		ctx := t.Context()
		client := http.DefaultClient
		dir := t.TempDir()
		page := goldkit.Create(t, pageTpl, pageData{
			ID: "9", Title: "Child", SpaceID: "9", Version: 1,
			ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, page)
		prior := "" +
			`[{"id":"9","dest":"docs/child.md",` +
			`"url":"/wiki/spaces/D/pages/9/C","title":"Child"}]` + "\n"
		oskit.MkdirAll(t, dir, adfCacheDir)
		linksPath := oskit.Create(t, prior, dir, adfCacheDir, linksFile)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Folders: map[string]string{
				filepath.Join(dir, "docs"): "/wiki/spaces/D/folder/100",
			},
		}
		before := oskit.ReadFileStr(t, linksPath)

		// --- When ---
		_, err := pullSelected(ctx, client, cfg, "docs/child.md")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, 1, srv.ReqCount()) // Only the page, no discovery.
		have := oskit.ReadFileStr(t, linksPath)
		assert.Equal(t, before, have)
	})

	t.Run("error - path is not a managed page", func(t *testing.T) {
		// --- Given --- an index that does not list the requested path.
		ctx := t.Context()
		dir := t.TempDir()
		prior := "" +
			`[{"id":"9","dest":"docs/child.md",` +
			`"url":"/wiki/spaces/D/pages/9/C","title":"Child"}]` + "\n"
		oskit.MkdirAll(t, dir, adfCacheDir)
		oskit.Create(t, prior, dir, adfCacheDir, linksFile)
		cfg := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}

		// --- When ---
		have, err := pullSelected(ctx, http.DefaultClient, cfg, "nope.md")

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "not a managed page", err)
	})

	t.Run("error - unindexed page suggests pulling the root",
		func(t *testing.T) {
			// --- Given --- no prior links index on disk.
			ctx := t.Context()
			dir := t.TempDir()
			cfg := &config{
				Host:    "https://ex.atlassian.net",
				Account: "a@ex.com",
				Token:   "secret",
				WorkDir: dir,
			}

			// --- When ---
			have, err := pullSelected(
				ctx, http.DefaultClient, cfg, "docs/child.md")

			// --- Then ---
			assert.Equal(t, "", have)
			assert.ErrorContain(t, "pull its folder or space root first", err)
		})
}

func Test_config_pageSource(t *testing.T) {
	t.Run("resolves a configured page from the config", func(t *testing.T) {
		// --- Given ---
		dir := "/wd"
		dest := filepath.Join(dir, "a.md")
		cfg := &config{
			WorkDir: dir,
			Pages:   map[string]string{dest: "/wiki/spaces/T/pages/1/A"},
		}

		// --- When ---
		hSrc, hKey, err := cfg.pageSource(dest)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "/wiki/spaces/T/pages/1/A", hSrc)
		assert.Equal(t, "", hKey)
	})

	t.Run("resolves a folder or space page from the link index",
		func(t *testing.T) {
			// --- Given ---
			dir := "/wd"
			dest := filepath.Join(dir, "docs", "child.md")
			idx := &linkIndex{
				workDir: dir,
				byID:    map[string]linkEntry{},
				byDest:  map[string]linkEntry{},
			}
			idx.add(linkEntry{
				ID:       "9",
				Dest:     "docs/child.md",
				URL:      "/wiki/spaces/D/pages/9/C",
				Title:    "Child",
				SpaceKey: "D",
			})
			cfg := &config{WorkDir: dir, links: idx}

			// --- When ---
			hSrc, hKey, err := cfg.pageSource(dest)

			// --- Then ---
			assert.NoError(t, err)
			assert.Equal(t, "/wiki/spaces/D/pages/9/C", hSrc)
			assert.Equal(t, "D", hKey)
		})

	t.Run("error - not a managed page when the index lacks it",
		func(t *testing.T) {
			// --- Given ---
			dir := "/wd"
			idx := &linkIndex{
				workDir: dir,
				byID:    map[string]linkEntry{},
				byDest:  map[string]linkEntry{},
			}
			cfg := &config{WorkDir: dir, links: idx}

			// --- When ---
			hSrc, hKey, err := cfg.pageSource(filepath.Join(dir, "nope.md"))

			// --- Then ---
			assert.Equal(t, "", hSrc)
			assert.Equal(t, "", hKey)
			assert.ErrorContain(t, "not a managed page", err)
		})

	t.Run("error - no index suggests pulling the root", func(t *testing.T) {
		// --- Given ---
		dir := "/wd"
		cfg := &config{WorkDir: dir}

		// --- When ---
		hSrc, hKey, err := cfg.pageSource(filepath.Join(dir, "docs", "child.md"))

		// --- Then ---
		assert.Equal(t, "", hSrc)
		assert.Equal(t, "", hKey)
		assert.ErrorContain(t, "pull its folder or space root first", err)
	})
}

func Test_pullPages(t *testing.T) {
	t.Run("pulls a page into the cache", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		body := goldkit.Create(t, pageTpl, pageData{
			ID:       "1",
			Title:    "T",
			SpaceID:  "9",
			ParentID: "77",
			Version:  3,
			ADF:      `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "test/root_page_1.md"): "/wiki/spaces/TEST/pages/1/Page",
			},
		}

		// --- When ---
		have, sta, err := pullPages(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "root_page_1.md ... ok (v3)", have)
		assert.Equal(t, pullStats{pulled: 1, total: 1}, sta)

		req := srv.Request(0)
		assert.Equal(t, "/wiki/api/v2/pages/1", req.URL.Path)
		assert.Equal(t, "atlas_doc_format", req.URL.Query().Get("body-format"))

		user, pass, ok := req.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "a@ex.com", user)
		assert.Equal(t, "secret", pass)

		cached := filepath.Join(dir, adfCacheDir, "test", "root_page_1.v3.json")
		content := oskit.ReadFileStr(t, cached)
		assert.Contain(t, `"name": "test/root_page_1.md"`, content)

		// Markdown is written to the work directory at the configured path,
		// stamped with the Site host it was pulled from, and the parent id
		// the page GET reported for this pages:-mapped page.
		md := oskit.ReadFileStr(t, filepath.Join(dir, "test/root_page_1.md"))
		assert.Contain(t, "page_id: \"1\"", md)
		assert.Contain(t, "page_version: 3", md)
		assert.Contain(t, "parent_id: \"77\"", md)
		assert.Contain(t, "cf_domain:", md)

		// The same Markdown is cached next to the ADF file, version-tagged.
		mdCache := filepath.Join(dir, adfCacheDir, "test", "root_page_1.v3.md")
		assert.Equal(t, md, oskit.ReadFileStr(t, mdCache))
	})

	t.Run("downloads and links images in the Markdown", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		doc := `{
		   "type": "doc",
		   "content": [
		      {
		         "type": "mediaSingle",
		         "attrs": { "layout": "center" },
		         "content": [
		            {
		               "type": "media",
		               "attrs": {
		                  "type": "file",
		                  "id": "F1",
		                  "localId": "L1",
		                  "alt": "pic.jpg"
		               }
		            }
		         ]
		      }
		   ]
		}`
		body := goldkit.Create(t, pageTpl, pageData{
			ID:      "1",
			Title:   "T",
			SpaceID: "9",
			Version: 2,
			ADF:     doc,
		}).Body()
		atts := `{
		   "results": [
		      {
		         "fileId": "F1",
		         "title": "pic.jpg",
		         "mediaType": "image/jpeg",
		         "downloadLink": "/rest/att/F1/download"
		      }
		   ]
		}`
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, body).
			Rsp(http.StatusOK, []byte(atts)).
			Rsp(http.StatusOK, []byte("JPEGDATA"))
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "test/root_page_1.md"): "/wiki/spaces/TEST/pages/1/Page",
			},
		}

		// --- When ---
		have, _, err := pullPages(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "root_page_1.md ... ok (v2)", have)

		assert.Equal(t,
			"/wiki/api/v2/pages/1/attachments", srv.Request(1).URL.Path)
		assert.Equal(t,
			"/wiki/rest/att/F1/download", srv.Request(2).URL.Path)

		// The image is downloaded to the shared assets directory.
		asset := filepath.Join(dir, assetsDir, "F1-L1.jpg")
		assert.Equal(t, "JPEGDATA", oskit.ReadFileStr(t, asset))

		// The Markdown links the image and records it in the frontmatter.
		md := oskit.ReadFileStr(t, filepath.Join(dir, "test/root_page_1.md"))
		assert.Contain(t, "![pic.jpg](../_assets/F1-L1.jpg)", md)
		assert.Contain(t, "    file: \"../_assets/F1-L1.jpg\"", md)
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
		oskit.MkdirAll(t, dir, adfCacheDir)
		cached := oskit.Create(t, "original", dir, adfCacheDir, "a.v3.json")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/TEST/pages/1/Page",
			},
		}

		// --- When ---
		have, sta, err := pullPages(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "a.md ... skipped (v3 cached), md written", have)
		assert.Equal(t, pullStats{rendered: 1, total: 1}, sta)

		// The cached ADF is reused, not rewritten.
		content := oskit.ReadFileStr(t, cached)
		assert.Equal(t, "original", content)

		// Markdown is still (re)generated on a cache hit, both files.
		md := oskit.ReadFileStr(t, filepath.Join(dir, "a.md"))
		assert.Contain(t, "page_version: 3", md)
		mdCache := filepath.Join(dir, adfCacheDir, "a.v3.md")
		assert.Equal(t, md, oskit.ReadFileStr(t, mdCache))
	})

	t.Run("rewrites a file already cached without parent_id", func(t *testing.T) {
		// --- Given --- a page pulled before parent_id existed: its ADF is
		// already cached at this version, and its Markdown on disk (both at
		// dest and next to the cache) has no parent_id line.
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		body := goldkit.Create(t, pageTpl, pageData{
			ID:       "1",
			Title:    "T",
			SpaceID:  "9",
			ParentID: "77",
			Version:  3,
			ADF:      `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		stale := "" +
			"---\n" +
			"title: \"T\"\n" +
			"page_path: \"a.md\"\n" +
			"page_id: \"1\"\n" +
			"page_version: 3\n" +
			"space_id: \"9\"\n" +
			"---\n"
		oskit.MkdirAll(t, dir, adfCacheDir)
		oskit.Create(t, "original", dir, adfCacheDir, "a.v3.json")
		oskit.Create(t, stale, dir, adfCacheDir, "a.v3.md")
		oskit.Create(t, stale, dir, "a.md")
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/TEST/pages/1/Page",
			},
		}

		// --- When ---
		have, sta, err := pullPages(ctx, client, cfg)

		// --- Then --- the freshly-fetched parent_id makes the re-render
		// differ from what is on disk, so the stale file is rewritten even
		// though the cached ADF version is unchanged.
		assert.NoError(t, err)
		assert.Contain(t, "a.md ... skipped (v3 cached), md written", have)
		assert.Equal(t, pullStats{rendered: 1, total: 1}, sta)
		md := oskit.ReadFileStr(t, filepath.Join(dir, "a.md"))
		assert.Contain(t, "parent_id: \"77\"", md)
	})

	t.Run("a second pull of a parent_id-stamped file changes nothing",
		func(t *testing.T) {
			// --- Given --- a page already pulled once with its parent_id
			// stamped, and a server that serves the same version again.
			ctx := t.Context()
			dir := t.TempDir()
			client := http.DefaultClient
			body := goldkit.Create(t, pageTpl, pageData{
				ID:       "1",
				Title:    "T",
				SpaceID:  "9",
				ParentID: "77",
				Version:  3,
				ADF:      `{"type":"doc"}`,
			}).Body()
			srv := httpkit.NewServer(t).
				Rsp(http.StatusOK, body).
				Rsp(http.StatusOK, body)
			cfg := &config{
				Host:    srv.URL(),
				Account: "a@ex.com",
				Token:   "secret",
				WorkDir: dir,
				Pages: map[string]string{
					filepath.Join(dir, "a.md"): "/wiki/spaces/TEST/pages/1/Page",
				},
			}
			_, first, err := pullPages(ctx, client, cfg)
			assert.NoError(t, err)
			assert.Equal(t, pullStats{pulled: 1, total: 1}, first)
			md := oskit.ReadFileStr(t, filepath.Join(dir, "a.md"))
			assert.Contain(t, "parent_id: \"77\"", md)

			// --- When --- the same version is pulled again.
			have, sta, err := pullPages(ctx, client, cfg)

			// --- Then --- nothing is written and the page counts as
			// unchanged: an already-correct parent_id causes no churn.
			assert.NoError(t, err)
			assert.Contain(t, "a.md ... skipped (v3 cached), unchanged", have)
			assert.Equal(t, pullStats{unchanged: 1, total: 1}, sta)
		})

	t.Run("leaves unchanged Markdown untouched on re-pull", func(t *testing.T) {
		// --- Given --- a page already pulled once, so its cache and Markdown
		// are on disk, and a server that serves the same version again.
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
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, body).
			Rsp(http.StatusOK, body)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/TEST/pages/1/Page",
			},
		}
		_, first, err := pullPages(ctx, client, cfg)
		assert.NoError(t, err)
		assert.Equal(t, pullStats{pulled: 1, total: 1}, first)

		// --- When --- the same version is pulled again.
		have, sta, err := pullPages(ctx, client, cfg)

		// --- Then --- nothing is written and the page counts as unchanged.
		assert.NoError(t, err)
		assert.Contain(t, "a.md ... skipped (v3 cached), unchanged", have)
		assert.Equal(t, pullStats{unchanged: 1, total: 1}, sta)
	})

	t.Run("fails the page when Markdown rendering fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		body := goldkit.Create(t, pageTpl, pageData{
			ID:      "1",
			Title:   "T",
			SpaceID: "9",
			Version: 4,
			ADF:     `{"type":"paragraph"}`, // root is not "doc"
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/TEST/pages/1/Page",
			},
		}

		// --- When ---
		_, _, err := pullPages(ctx, client, cfg)

		// --- Then ---
		assert.ErrorContain(t, "want doc", err)
		assert.ErrorContain(t, "1 of 1 pages failed", err)

		// The ADF cache is written before rendering, so it is kept.
		cached := filepath.Join(dir, adfCacheDir, "a.v4.json")
		assert.Contain(t, `"id": "1"`, oskit.ReadFileStr(t, cached))

		// No Markdown was written to the work directory.
		assert.NoFileExist(t, filepath.Join(dir, "a.md"))
	})

	t.Run("returns nothing when no pages are configured", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		cfg := &config{WorkDir: t.TempDir()}

		// --- When ---
		have, sta, err := pullPages(ctx, client, cfg)

		// --- Then --- pullConfig, not pullPages, reports an empty pull.
		assert.NoError(t, err)
		assert.Equal(t, "", have)
		assert.Equal(t, pullStats{}, sta)
	})

	t.Run("continues and reports when a page fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		ok := goldkit.Create(t, pageTpl, pageData{
			ID:      "1",
			Title:   "T",
			SpaceID: "9",
			Version: 2,
			ADF:     `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, ok).
			Rsp(http.StatusNotFound, nil)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/TEST/pages/1/A",
				filepath.Join(dir, "b.md"): "/wiki/spaces/TEST/pages/2/B",
			},
		}

		// --- When ---
		have, _, err := pullPages(ctx, client, cfg)

		// --- Then ---
		assert.Contain(t, "a.md ... ok (v2)", have)
		assert.ErrorContain(t, "1 of 2 pages failed", err)
		assert.ErrorContain(t, "b.md: page 2: HTTP 404", err)
	})

	t.Run("error - folder source", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		cfg := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Pages: map[string]string{
				filepath.Join(dir, "a.md"): "/wiki/spaces/TEST/folder/",
			},
		}

		// --- When ---
		have, _, err := pullPages(ctx, client, cfg)

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "not a single page URL", err)
		assert.ErrorContain(t, "1 of 1 pages failed", err)
	})
}

func Test_fetchPage(t *testing.T) {
	t.Run("returns the tagged page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		adf := `{"version":1,"type":"doc"}`
		body := goldkit.Create(t, pageTpl, pageData{
			ID:       "1975222283",
			Title:    "Root",
			SpaceID:  "9",
			ParentID: "77",
			Version:  5,
			ADF:      adf,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		name := "test/root_page_1.md"
		src := "/wiki/spaces/TEST/pages/1975222283/Root"

		// --- When ---
		have, err := fetchPage(ctx, client, cfg, name, src)

		// --- Then ---
		assert.NoError(t, err)
		want := &page{
			Name:     name,
			ID:       "1975222283",
			Title:    "Root",
			Version:  5,
			SpaceID:  "9",
			ParentID: "77",
			ADF:      json.RawMessage(adf),
		}
		assert.Equal(t, want, have)
	})

	t.Run("error - source is not a page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		cfg := &config{Host: "https://ex.atlassian.net", Token: "secret"}
		src := "/wiki/spaces/TEST/folder/"

		// --- When ---
		have, err := fetchPage(ctx, client, cfg, "a.md", src)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "not a single page", err)
	})

	t.Run("error - non-2xx response", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		src := "/wiki/spaces/TEST/pages/1/Root"

		// --- When ---
		have, err := fetchPage(ctx, client, cfg, "a.md", src)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "HTTP 404", err)
	})

	t.Run("error - invalid ADF body", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		body := goldkit.Create(t, pageTpl, pageData{
			ID:      "1",
			Title:   "T",
			SpaceID: "9",
			Version: 1,
			ADF:     "not-json",
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		src := "/wiki/spaces/TEST/pages/1/Root"

		// --- When ---
		have, err := fetchPage(ctx, client, cfg, "a.md", src)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "invalid ADF body", err)
	})
}

func Test_fetchPageByID(t *testing.T) {
	t.Run("returns the tagged page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		adf := `{"version":1,"type":"doc"}`
		body := goldkit.Create(t, pageTpl, pageData{
			ID:       "42",
			Title:    "Root",
			SpaceID:  "9",
			ParentID: "77",
			Version:  5,
			ADF:      adf,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, body)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := fetchPageByID(ctx, client, cfg, "test/root.md", "42")

		// --- Then ---
		assert.NoError(t, err)
		want := &page{
			Name:     "test/root.md",
			ID:       "42",
			Title:    "Root",
			Version:  5,
			SpaceID:  "9",
			ParentID: "77",
			ADF:      json.RawMessage(adf),
		}
		assert.Equal(t, want, have)
		assert.Equal(t, "/wiki/api/v2/pages/42", srv.Request(0).URL.Path)
	})

	t.Run("error - non-2xx response", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := fetchPageByID(ctx, client, cfg, "a.md", "42")

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "page 42: HTTP 404", err)
	})
}

func Test_newPageRequest(t *testing.T) {
	t.Run("builds an authenticated page request", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		cfg := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
		}
		id := "1975222283"

		// --- When ---
		have, err := newPageRequest(ctx, cfg, id)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, http.MethodGet, have.Method)
		want := "https://ex.atlassian.net/wiki/api/v2/pages/1975222283" +
			"?body-format=atlas_doc_format"
		assert.Equal(t, want, have.URL.String())

		user, pass, ok := have.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "a@ex.com", user)
		assert.Equal(t, "secret", pass)
	})

	t.Run("error - host is not a valid URL", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		cfg := &config{Host: "https://ex\x7f.net", Token: "secret"}

		// --- When ---
		have, err := newPageRequest(ctx, cfg, "1")

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "building request", err)
	})
}

func Test_pageID_tabular(t *testing.T) {
	tt := []struct {
		testN string
		src   string
		want  string
	}{
		{"page", "/wiki/spaces/TEST/pages/1975222283/Title", "1975222283"},
		{"page trailing", "/wiki/spaces/TEST/pages/42", "42"},
		{"page with query", "/wiki/spaces/TEST/pages/7/Title?draft=1", "7"},
		{"edit-v2 form", "/wiki/spaces/TEST/pages/edit-v2/1975222283", "1975222283"},
		{"edit-v2 with fragment", "/wiki/spaces/TEST/pages/edit-v2/42#Heading", "42"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have, err := pageID(tc.src)

			// --- Then ---
			assert.NoError(t, err)
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_pageID_error_tabular(t *testing.T) {
	tt := []struct {
		testN string
		src   string
	}{
		{"error - folder source", "/wiki/spaces/TEST/folder/"},
		{"error - no id segment", "/wiki/spaces/TEST/pages/"},
		{"error - non-numeric id", "/wiki/spaces/TEST/pages/abc/Title"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have, err := pageID(tc.src)

			// --- Then ---
			assert.Equal(t, "", have)
			assert.ErrorContain(t, "not a single page", err)
		})
	}
}

func Test_pageName(t *testing.T) {
	t.Run("returns the path relative to work_dir", func(t *testing.T) {
		// --- When ---
		have := pageName("/base/wd", "/base/wd/test/a.md")

		// --- Then ---
		assert.Equal(t, "test/a.md", have)
	})

	t.Run("falls back to dest when Rel fails", func(t *testing.T) {
		// --- When ---
		have := pageName("/base/wd", "relative/a.md")

		// --- Then ---
		assert.Equal(t, "relative/a.md", have)
	})
}
