// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ctx42/goldkit/pkg/goldkit"
	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/ring/pkg/ring/ringtest"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testkit/pkg/httpkit"
	"github.com/ctx42/testkit/pkg/oskit"
)

// baseDoc is the ADF document used across push tests: one paragraph with a
// localId, so an edit can be verified to preserve it.
const baseDoc = `{"type":"doc","content":[` +
	`{"type":"paragraph","attrs":{"localId":"p"},` +
	`"content":[{"type":"text","text":"hello"}]}]}`

// writeBaseline writes a version-3 cache file for name under dir and the
// rendered Markdown to its destination, returning the destination path and the
// rendered Markdown a user would edit.
func writeBaseline(t *testing.T, dir, name, docJSON string) (string, string) {
	t.Helper()
	p := &page{
		Name: name, ID: "1", Title: "T", Version: 3, SpaceID: "9",
		ADF: json.RawMessage(docJSON),
	}
	cachePath := filepath.Join(dir, adfCacheDir, p.cacheFile())
	must.Nil(p.write(cachePath))

	doc := must.Value(p.doc())
	md := must.Value(doc.MarshallMarkdown(nil))
	dest := filepath.Join(dir, name)
	oskit.MkdirAll(t, filepath.Dir(dest))
	oskit.Create(t, md, dest)
	return dest, string(md)
}

func Test_managedPushDests(t *testing.T) {
	const tracked = "---\ntitle: \"T\"\npage_id: \"1\"\nspace_id: \"9\"\n---\nx\n"

	t.Run("unions pages folders and spaces", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		page := filepath.Join(dir, "solo.md")
		folderRoot := filepath.Join(dir, "docs")
		spaceRoot := filepath.Join(dir, "team")
		oskit.MkdirAll(t, folderRoot)
		oskit.MkdirAll(t, spaceRoot)
		folderPage := oskit.Create(t, tracked, dir, "docs", "a.md")
		spacePage := oskit.Create(t, tracked, dir, "team", "b.md")
		// Stray notes under roots are not push candidates.
		oskit.Create(t, "scratch notes\n", dir, "docs", "notes.md")
		cfg := &config{
			WorkDir: dir,
			Pages:   map[string]string{page: "/wiki/spaces/T/pages/1/P"},
			Folders: map[string]string{folderRoot: "/wiki/spaces/T/folder/2"},
			Spaces:  map[string]string{spaceRoot: "/wiki/spaces/T"},
		}

		// --- When ---
		have := managedPushDests(cfg)

		// --- Then ---
		want := []string{folderPage, page, spacePage}
		sort.Strings(want)
		assert.Equal(t, want, have)
	})

	t.Run("dedupes a page also under a root", func(t *testing.T) {
		// --- Given --- the same path listed under Pages and under a folder.
		dir := t.TempDir()
		root := filepath.Join(dir, "docs")
		oskit.MkdirAll(t, root)
		dest := oskit.Create(t, tracked, dir, "docs", "a.md")
		cfg := &config{
			WorkDir: dir,
			Pages:   map[string]string{dest: "/wiki/spaces/T/pages/1/P"},
			Folders: map[string]string{root: "/wiki/spaces/T/folder/2"},
		}

		// --- When ---
		have := managedPushDests(cfg)

		// --- Then ---
		assert.Equal(t, []string{dest}, have)
	})

	t.Run("drops a cf_local page from Pages", func(t *testing.T) {
		// --- Given --- a Pages-mapped file marked local alongside a normal one.
		dir := t.TempDir()
		local := oskit.Create(t,
			"---\ntitle: \"T\"\npage_id: \"1\"\nspace_id: \"9\"\n"+
				"cf_local: true\n---\nx\n",
			dir, "local.md")
		page := oskit.Create(t, tracked, dir, "solo.md")
		cfg := &config{
			WorkDir: dir,
			Pages: map[string]string{
				local: "/wiki/spaces/T/pages/2/L",
				page:  "/wiki/spaces/T/pages/1/P",
			},
		}

		// --- When ---
		have := managedPushDests(cfg)

		// --- Then ---
		assert.Equal(t, []string{page}, have)
	})
}

func Test_pushManaged(t *testing.T) {
	const src = "/wiki/spaces/TEST/pages/1/Page"

	t.Run("pushes a folder page when only folders are configured", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		root := filepath.Join(dir, "docs")
		dest, md := writeBaseline(t, dir, "docs/page.md", baseDoc)
		oskit.Create(t, strings.Replace(md, "hello", "hello world", 1), dest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Folders: map[string]string{root: "/wiki/spaces/TEST/folder/9"},
		}

		// --- When ---
		have, err := pushManaged(ctx, rng, http.DefaultClient, cfg, "", false)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "docs/page.md ... ok (v4)", have)
		assert.Contain(t, "cfsync: 1 of 1 pages pushed", have)
	})

	t.Run("pushes pages and space roots together", func(t *testing.T) {
		// --- Given --- an edited Pages entry and an edited space page.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		spaceRoot := filepath.Join(dir, "team")
		pageDest, pageMD := writeBaseline(t, dir, "solo.md", baseDoc)
		oskit.Create(t,
			strings.Replace(pageMD, "hello", "hello page", 1), pageDest)
		spaceDest, spaceMD := writeBaseline(t, dir, "team/_index.md", baseDoc)
		oskit.Create(t,
			strings.Replace(spaceMD, "hello", "hello space", 1), spaceDest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusOK, []byte(`{}`)).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages:  map[string]string{pageDest: src},
			Spaces: map[string]string{spaceRoot: "/wiki/spaces/TEST"},
		}

		// --- When ---
		have, err := pushManaged(ctx, rng, http.DefaultClient, cfg, "", false)

		// --- Then --- both destinations are pushed (not only space roots).
		assert.NoError(t, err)
		assert.Contain(t, "solo.md ... ok (v4)", have)
		assert.Contain(t, "team/_index.md ... ok (v4)", have)
		assert.Contain(t, "cfsync: 2 of 2 pages pushed", have)
		assert.Equal(t, 4, srv.ReqCount())
	})

	t.Run("never prompts for a cf_local candidate", func(t *testing.T) {
		// --- Given --- a titled, id-less file marked local under a space root.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t,
			"---\ntitle: \"Local\"\nspace_id: \"9\"\ncf_local: true\n---\nx\n",
			dir, "team", "local.md")
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: "/wiki/spaces/TEST"},
		}

		// --- When ---
		have, err := pushManaged(ctx, rng, http.DefaultClient, cfg, "", false)

		// --- Then --- the file is neither a create candidate nor an update.
		assert.NoError(t, err)
		assert.Contain(t, "no pages to push", have)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("error - selected file is marked local", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t,
			"---\ntitle: \"Local\"\nspace_id: \"9\"\ncf_local: true\n---\nx\n",
			dir, "team", "local.md")
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: "/wiki/spaces/TEST"},
		}

		// --- When ---
		have, err := pushManaged(
			ctx, rng, http.DefaultClient, cfg, "team/local.md", false)

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "marked local", err)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("never updates a cf_local Pages entry with a page id", func(t *testing.T) {
		// --- Given --- a Pages-mapped, tracked file marked local.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		dest := oskit.Create(t,
			"---\ntitle: \"Local\"\npage_id: \"1\"\nspace_id: \"9\"\n"+
				"cf_local: true\n---\nx\n",
			dir, "local.md")
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		have, err := pushManaged(ctx, rng, http.DefaultClient, cfg, "", false)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "no pages to push", have)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("never prompts for a cf_local Pages entry with no page id", func(t *testing.T) {
		// --- Given --- a Pages-mapped, id-less file marked local.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		dest := oskit.Create(t,
			"---\ntitle: \"Local\"\nspace_id: \"9\"\ncf_local: true\n---\nx\n",
			dir, "local.md")
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		have, err := pushManaged(ctx, rng, http.DefaultClient, cfg, "", false)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "no pages to push", have)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("error - selected Pages entry is marked local", func(t *testing.T) {
		// --- Given --- a Pages-mapped, tracked file marked local, selected by
		// name.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		dest := oskit.Create(t,
			"---\ntitle: \"Local\"\npage_id: \"1\"\nspace_id: \"9\"\n"+
				"cf_local: true\n---\nx\n",
			dir, "local.md")
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		have, err := pushManaged(
			ctx, rng, http.DefaultClient, cfg, "local.md", false)

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "marked local", err)
		assert.Equal(t, 0, srv.ReqCount())
	})
}

func Test_pushPages(t *testing.T) {
	const src = "/wiki/spaces/TEST/pages/1/Page"

	t.Run("pushes an edited page and refreshes the cache", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(t, strings.Replace(md, "hello", "hello world", 1), dest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).    // conflict check GET
			Rsp(http.StatusOK, []byte(`{}`)) // update PUT
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		have, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "page.md ... ok (v4)", have)
		assert.Contain(t, "cfsync: 1 of 1 pages pushed", have)

		put := srv.Request(1)
		assert.Equal(t, http.MethodPut, put.Method)
		assert.Equal(t, "/wiki/api/v2/pages/1", put.URL.Path)
		body := string(must.Value(io.ReadAll(put.Body)))
		assert.Contain(t, `"number":4`, body)
		assert.Contain(t, "hello world", body)
		assert.Contain(t, `\"localId\":\"p\"`, body) // localId preserved

		// The cache and Markdown are refreshed to the new version.
		cached := filepath.Join(dir, adfCacheDir, "test", "page.v4.json")
		assert.Contain(t, "hello world", oskit.ReadFileStr(t, cached))
		assert.Contain(t, "page_version: 4", oskit.ReadFileStr(t, dest))
	})

	t.Run("pushes a title-only frontmatter change", func(t *testing.T) {
		// --- Given --- only the frontmatter title is edited; the body is intact.
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(
			t, strings.Replace(md, `title: "T"`, `title: "Renamed"`, 1), dest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		have, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "page.md ... ok (v4)", have)
		put := string(must.Value(io.ReadAll(srv.Request(1).Body)))
		assert.Contain(t, `"title":"Renamed"`, put)
	})

	t.Run("reports no changes for an unedited page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		dest, _ := writeBaseline(t, dir, "test/page.md", baseDoc)
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		have, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "page.md ... no changes", have)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("refuses a page whose remote version moved", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(t, strings.Replace(md, "hello", "hello world", 1), dest)

		moved := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 7, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, moved)
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		_, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then --- refused before any PUT.
		assert.ErrorContain(t, "conflict: local base v3 but remote is v7", err)
		assert.Equal(t, 1, srv.ReqCount())
	})

	t.Run("pushes only the selected page", func(t *testing.T) {
		// --- Given --- two configured pages, both edited; one is selected.
		ctx := t.Context()
		dir := t.TempDir()
		selDest, selMD := writeBaseline(t, dir, "test/one.md", baseDoc)
		oskit.Create(t, strings.Replace(selMD, "hello", "hello world", 1), selDest)
		otherDest, otherMD := writeBaseline(t, dir, "test/two.md", baseDoc)
		oskit.Create(
			t, strings.Replace(otherMD, "hello", "changed too", 1), otherDest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).    // conflict check GET
			Rsp(http.StatusOK, []byte(`{}`)) // update PUT
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{selDest: src, otherDest: src},
		}

		// --- When --- select by a work-dir-relative path.
		have, err := pushPages(ctx, http.DefaultClient, cfg, "test/one.md")

		// --- Then --- only the selected page is touched.
		assert.NoError(t, err)
		assert.Contain(t, "one.md ... ok (v4)", have)
		assert.NotContain(t, "two.md", have)
		assert.Contain(t, "cfsync: 1 of 1 pages pushed", have)
		assert.Equal(t, 2, srv.ReqCount()) // one GET + one PUT, not four.
	})

	t.Run("selects the page by an absolute path", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(t, strings.Replace(md, "hello", "hello world", 1), dest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When --- dest is already an absolute, cleaned path.
		have, err := pushPages(ctx, http.DefaultClient, cfg, dest)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "page.md ... ok (v4)", have)
	})

	t.Run("refuses a path that is not a configured page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		dest, _ := writeBaseline(t, dir, "test/page.md", baseDoc)
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		_, err := pushPages(ctx, http.DefaultClient, cfg, "test/missing.md")

		// --- Then ---
		assert.ErrorContain(t, "not a configured page: test/missing.md", err)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("surfaces a rejected structural edit", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(t, md+"\n| a | b |\n", dest)

		srv := httpkit.NewServer(t)
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		_, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then --- a malformed table cannot be inserted, so the push is
		// rejected before any request reaches the server.
		assert.ErrorContain(t, "a table needs a header and a separator row", err)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("uploads a user-added image and splices it in", func(t *testing.T) {
		// --- Given --- an image file on disk and a lone image block appended.
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(t, "PNGDATA", dir, "test", "shot.png")
		oskit.Create(t, md+"\n\n![a shot](shot.png)", dest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			// attachment upload POST, then conflict GET, then update PUT
			Rsp(http.StatusOK,
				[]byte(`{"results":[{"extensions":{"fileId":"NEWFILE"}}]}`)).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		have, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "page.md ... ok (v4)", have)

		// The first request is the multipart attachment upload.
		up := srv.Request(0)
		assert.Equal(t, http.MethodPost, up.Method)
		assert.Equal(t,
			"/wiki/rest/api/content/1/child/attachment", up.URL.Path)
		assert.Equal(t, "no-check", up.Header.Get("X-Atlassian-Token"))
		assert.True(t, strings.HasPrefix(
			up.Header.Get("Content-Type"), "multipart/form-data"))

		// The PUT carries a synthesized media node keyed by the returned fileId.
		put := string(must.Value(io.ReadAll(srv.Request(2).Body)))
		assert.Contain(t, "mediaSingle", put)
		assert.Contain(t, `\"id\":\"NEWFILE\"`, put)
		assert.Contain(t, `\"collection\":\"contentId-1\"`, put)

		// The refreshed frontmatter tracks the new image so a re-push is a no-op,
		// and the image was canonicalized into the shared assets directory: the
		// Markdown now references it there and the working-tree copy is gone.
		refreshed := oskit.ReadFileStr(t, dest)
		assert.Contain(t, "page_images:", refreshed)
		assert.Contain(t, "../_assets/NEWFILE-", refreshed)
		assert.NotContain(t, "(shot.png)", refreshed)

		assert.NoFileExist(t, filepath.Join(dir, "test", "shot.png"))
		assets, err := filepath.Glob(filepath.Join(dir, "_assets", "NEWFILE-*.png"))
		assert.NoError(t, err)
		assert.Equal(t, 1, len(assets))
	})

	t.Run("rejects a user-added inline image before any request", func(t *testing.T) {
		// --- Given --- an image file on disk referenced inline in a paragraph
		// (not on its own line), which cannot be uploaded.
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(t, "PNGDATA", dir, "test", "shot.png")
		oskit.Create(
			t, strings.Replace(md, "hello", "hello ![x](shot.png) world", 1), dest)

		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		_, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then --- the push is refused with a clear message, no request sent.
		assert.ErrorContain(t, "inline image", err)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("deletes the orphan attachment on merge conflict", func(t *testing.T) {
		// --- Given --- an uploaded image, plus a local edit to the one paragraph
		// that the remote also changed, so the three-way merge cannot resolve it;
		// the attachment already on the server is then an orphan.
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "test/page.md", baseDoc)
		oskit.Create(t, "PNGDATA", dir, "test", "shot.png")
		edited := strings.Replace(md, "hello", "hello local", 1) +
			"\n\n![a shot](shot.png)"
		oskit.Create(t, edited, dest)

		// The remote (v4) changed the same paragraph differently.
		remoteADF := `{"type":"doc","content":[{"type":"paragraph",` +
			`"attrs":{"localId":"p"},"content":[` +
			`{"type":"text","text":"hello remote"}]}]}`
		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 4, ADF: remoteADF,
		}).Body()
		srv := httpkit.NewServer(t).
			// upload POST (with a content id), conflict GET, cleanup DELETE
			Rsp(http.StatusOK, []byte(
				`{"results":[{"id":"att99","extensions":{"fileId":"NEWFILE"}}]}`)).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusNoContent, nil)
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		_, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then --- the merge conflicts, the push is refused, and the orphan
		// attachment is deleted.
		assert.ErrorContain(t, "conflict", err)
		del := srv.Request(2)
		assert.Equal(t, http.MethodDelete, del.Method)
		assert.Equal(t, "/wiki/rest/api/content/att99", del.URL.Path)
	})

	t.Run("auto-merges a non-conflicting remote change", func(t *testing.T) {
		// --- Given --- a two-paragraph page; locally the first paragraph is
		// edited, while the remote (a newer version) changed only the second.
		ctx := t.Context()
		dir := t.TempDir()
		twoPara := `{"type":"doc","content":[` +
			`{"type":"paragraph","attrs":{"localId":"a"},"content":[` +
			`{"type":"text","text":"alpha"}]},` +
			`{"type":"paragraph","attrs":{"localId":"b"},"content":[` +
			`{"type":"text","text":"beta"}]}]}`
		dest, md := writeBaseline(t, dir, "test/page.md", twoPara)
		oskit.Create(t, strings.Replace(md, "alpha", "alpha local", 1), dest)

		remoteADF := `{"type":"doc","content":[` +
			`{"type":"paragraph","attrs":{"localId":"a"},"content":[` +
			`{"type":"text","text":"alpha"}]},` +
			`{"type":"paragraph","attrs":{"localId":"b"},"content":[` +
			`{"type":"text","text":"beta remote"}]}]}`
		live := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 5, ADF: remoteADF,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, live).        // conflict-check GET (remote at v5)
			Rsp(http.StatusOK, []byte(`{}`)) // update PUT
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Pages: map[string]string{dest: src},
		}

		// --- When ---
		out, err := pushPages(ctx, http.DefaultClient, cfg, "")

		// --- Then --- the push succeeds at the merged version (live 5 + 1).
		assert.NoError(t, err)
		assert.Contain(t, "page.md ... ok (v6)", out)

		// The PUT carries both edits: the local first paragraph and the remote
		// second paragraph.
		put := string(must.Value(io.ReadAll(srv.Request(1).Body)))
		assert.Contain(t, "alpha local", put)
		assert.Contain(t, "beta remote", put)
	})
}

func Test_pushSpaces(t *testing.T) {
	const link = "/wiki/spaces/TEST"

	t.Run("pushes edited pages under the space root", func(t *testing.T) {
		// --- Given --- a pulled space with the homepage edited and a leaf left
		// untouched.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		idx, md := writeBaseline(t, dir, "team/_index.md", baseDoc)
		oskit.Create(t, strings.Replace(md, "hello", "hello world", 1), idx)
		writeBaseline(t, dir, "team/nested/leaf.md", baseDoc)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).    // live fetch for _index.md
			Rsp(http.StatusOK, []byte(`{}`)) // update PUT
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When ---
		have, err := pushSpaces(ctx, rng, http.DefaultClient, cfg, "", false)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "team/_index.md ... ok (v4)", have)
		assert.Contain(t, "team/nested/leaf.md ... no changes", have)
		assert.Contain(t, "cfsync: 1 of 2 pages pushed", have)
	})

	t.Run("pushes only the selected file", func(t *testing.T) {
		// --- Given --- two edited pages; only the leaf is selected.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		idx, idxMD := writeBaseline(t, dir, "team/_index.md", baseDoc)
		oskit.Create(t, strings.Replace(idxMD, "hello", "hello world", 1), idx)
		leaf, leafMD := writeBaseline(t, dir, "team/leaf.md", baseDoc)
		oskit.Create(t, strings.Replace(leafMD, "hello", "hello there", 1), leaf)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When ---
		have, err := pushSpaces(
			ctx, rng, http.DefaultClient, cfg, "team/leaf.md", false)

		// --- Then --- only the leaf is fetched and pushed (GET + PUT).
		assert.NoError(t, err)
		assert.Contain(t, "team/leaf.md ... ok (v4)", have)
		assert.Contain(t, "cfsync: 1 of 1 pages pushed", have)
		assert.Equal(t, 2, srv.ReqCount())
	})

	t.Run("error - selected file is not a managed page", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		writeBaseline(t, dir, "team/_index.md", baseDoc)
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When ---
		have, err := pushSpaces(
			ctx, rng, http.DefaultClient, cfg, "elsewhere.md", false)

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "not a managed page: elsewhere.md", err)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("reports no pages when nothing is pulled", func(t *testing.T) {
		// --- Given --- a configured space whose root has not been pulled yet.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		cfg := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
			Spaces:  map[string]string{filepath.Join(dir, "team"): link},
		}

		// --- When ---
		have, err := pushSpaces(ctx, rng, http.DefaultClient, cfg, "", false)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "no pages to push", have)
	})

	t.Run("creates a new page under the space root with --yes", func(t *testing.T) {
		// --- Given --- a new-page file (no page id) beside an edited page.
		ctx := t.Context()
		tst := ringtest.New(t)
		tst.WetStderr()
		rng := tst.Ring()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t, newPageMD, dir, "team", "new.md")

		srv := httpkit.NewServer(t).
			// author lookup, create POST, restriction PUT
			Rsp(http.StatusOK, []byte(`{"accountId":"acc-1"}`)).
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When --- --yes skips the per-page prompt.
		have, err := pushSpaces(ctx, rng, http.DefaultClient, cfg, "", true)

		// --- Then --- the page is created, restricted, and reported.
		assert.NoError(t, err)
		assert.Contain(t, "creating team/new.md ... ok (v1)", have)

		assert.Equal(t, "/wiki/api/v2/pages", srv.Request(1).URL.Path)
		assert.Equal(t,
			"/wiki/rest/api/content/555/restriction", srv.Request(2).URL.Path)
		assert.Contain(t, "1 new page(s) to create", tst.Stderr())
	})

	t.Run("creates a title-only page under its derived parent", func(t *testing.T) {
		// --- Given --- a title-only page beside a parent _index.md under a
		// space root; its space and parent come from disk, not frontmatter.
		ctx := t.Context()
		tst := ringtest.New(t)
		tst.WetStderr()
		rng := tst.Ring()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t,
			"---\ntitle: \"Home\"\npage_id: \"100\"\nspace_id: \"9\"\n"+
				"page_version: 1\n---\n\nhome\n", dir, "team", "_index.md")
		create := oskit.Create(t,
			"---\ntitle: \"New\"\n---\n\nbody\n", dir, "team", "new.md")

		srv := httpkit.NewServer(t).
			// author lookup, create POST, restriction PUT
			Rsp(http.StatusOK, []byte(`{"accountId":"acc-1"}`)).
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When --- only the new page is pushed; its parent comes from the
		// sibling _index.md, which is left untouched.
		have, err := pushSpaces(ctx, rng, http.DefaultClient, cfg, create, true)

		// --- Then --- the create POST carries the derived space and parent.
		assert.NoError(t, err)
		assert.Contain(t, "creating team/new.md ... ok (v1)", have)

		post := srv.Request(1)
		assert.Equal(t, "/wiki/api/v2/pages", post.URL.Path)
		body := string(must.Value(io.ReadAll(post.Body)))
		assert.Contain(t, `"spaceId":"9"`, body)
		assert.Contain(t, `"parentId":"100"`, body)
		assert.Contain(t, "1 new page(s) to create", tst.Stderr())
	})

	t.Run("refuses a title-only page it cannot place", func(t *testing.T) {
		// --- Given --- a title-only page alone under a space root, with no
		// _index.md and no siblings to derive from.
		ctx := t.Context()
		rng := ringtest.New(t).Ring()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t,
			"---\ntitle: \"New\"\n---\n\nbody\n", dir, "team", "new.md")

		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When ---
		_, err := pushSpaces(ctx, rng, http.DefaultClient, cfg, "", true)

		// --- Then --- refused before any request, naming the file and fixes.
		assert.ErrorRegexp(t, "team/new.md: cannot derive parent_id", err)
		assert.Equal(t, 0, srv.ReqCount())
	})

	t.Run("creates ancestor folders and the page on a single yes", func(t *testing.T) {
		// --- Given --- a title-only page two new directories deep under an
		// anchored space root.
		ctx := t.Context()
		tst := ringtest.New(t)
		tst.WetStderr()
		rng := tst.Ring()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha", "beta")
		oskit.Create(t,
			"---\ntitle: \"Home\"\npage_id: \"100\"\nspace_id: \"9\"\n"+
				"page_version: 1\n---\n\nhome\n", dir, "team", "_index.md")
		oskit.Create(t,
			"---\ntitle: \"Page\"\n---\n\nbody\n",
			dir, "team", "alpha", "beta", "page.md")

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"accountId":"acc-1"}`)).               // author
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`)).                         // Alpha
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F1 restrict
			Rsp(http.StatusOK, []byte(`{"id":"F2"}`)).                         // Beta
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F2 restrict
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)). // page
			Rsp(http.StatusOK, []byte(`{}`))                                   // page restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When --- push only the new page so the untouched _index is left be.
		have, err := pushSpaces(
			ctx, rng, http.DefaultClient, cfg, "team/alpha/beta/page.md", true)

		// --- Then --- both folders then the page are created, and the summary
		// listed the folders under the page.
		assert.NoError(t, err)
		assert.Contain(t, "creating team/alpha/beta/page.md ... ok (v1)", have)
		assert.Equal(t, "/wiki/api/v2/folders", srv.Request(1).URL.Path)
		assert.Equal(t, "/wiki/api/v2/folders", srv.Request(3).URL.Path)
		assert.Equal(t, "/wiki/api/v2/pages", srv.Request(5).URL.Path)
		assert.Contain(t, `+ new folder "Alpha"`, tst.Stderr())
	})

	t.Run("reports a folder reused on a title collision", func(t *testing.T) {
		// --- Given --- a title-only page one new directory deep whose folder
		// already exists in the space under the anchored root.
		ctx := t.Context()
		rng := ring.New()
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha")
		oskit.Create(t,
			"---\ntitle: \"Home\"\npage_id: \"100\"\nspace_id: \"9\"\n"+
				"page_version: 1\n---\n\nhome\n", dir, "team", "_index.md")
		oskit.Create(t,
			"---\ntitle: \"Page\"\n---\n\nbody\n", dir, "team", "alpha", "page.md")

		taken := []byte(
			`{"errors":[{"title":"A folder exists with the same title in this space"}]}`)
		found := []byte(
			`{"results":[{"id":"FX","type":"folder","title":"Alpha","status":"current"}]}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"accountId":"acc-1"}`)).               // author
			Rsp(http.StatusBadRequest, taken).                                 // Alpha collides
			Rsp(http.StatusNotFound, nil).                                     // folder lookup miss
			Rsp(http.StatusOK, found).                                         // page lookup hit
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)). // page
			Rsp(http.StatusOK, []byte(`{}`))                                   // page restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
			Spaces: map[string]string{root: link},
		}

		// --- When ---
		have, err := pushSpaces(
			ctx, rng, http.DefaultClient, cfg, "team/alpha/page.md", true)

		// --- Then --- the output reports the reuse instead of a new folder.
		assert.NoError(t, err)
		assert.Contain(t, "creating team/alpha/page.md ... ok (v1)", have)
		assert.Contain(t, `reused existing folder "Alpha"`, have)
	})
}

func Test_pushDests(t *testing.T) {
	t.Run("skips an unconfirmed create without any request", func(t *testing.T) {
		// --- Given --- a create candidate the plan marks as skipped.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team")
		dest := oskit.Create(t, newPageMD, dir, "team", "new.md")
		srv := httpkit.NewServer(t) // no request expected
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}
		plan := &createPlan{decided: map[string]bool{dest: false}}
		cacheDir := filepath.Join(dir, adfCacheDir)

		// --- When ---
		have, err := pushDests(
			ctx, http.DefaultClient, cfg, cacheDir, []string{dest}, plan)

		// --- Then --- nothing is created and the skip is reported.
		assert.NoError(t, err)
		assert.Contain(t, "creating team/new.md ... skipped", have)
		assert.Equal(t, 0, srv.ReqCount())
	})
}

func Test_pushDests_interactiveCreate(t *testing.T) {
	t.Run("a single y creates the folder chain and the page", func(t *testing.T) {
		// --- Given --- a title-only page two new directories deep and a
		// scripted "y". The prompt (not --yes) confirms the page, which one
		// answer settles, and its two ancestor folders are its dependencies.
		ctx := t.Context()
		tst := ringtest.New(t)
		tst.WetStderr()
		tst.SetStdin(bytes.NewBufferString("y\n"))
		rng := tst.Ring()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha", "beta")
		dest := oskit.Create(t,
			"---\ntitle: \"Page\"\n---\n\n# H\n\nbody\n",
			dir, "team", "alpha", "beta", "page.md")
		cand := createInput{
			Dest: dest, Title: "Page", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{
				{Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha"},
				{Dir: filepath.Join(dir, "team", "alpha", "beta"), Title: "Beta"},
			},
		}
		cands := []createInput{cand}

		// The up-front summary lists both folders under the page.
		summary := createSummary(dir, cands)
		assert.Contain(t, `+ new folder "Alpha"`, summary)
		assert.Contain(t, `+ new folder "Beta"`, summary)

		// --- When --- one prompt decides the page, then it is created.
		decided, err := promptCreates(rng, dir, cands, map[string]bool{})
		assert.NoError(t, err)
		assert.True(t, decided[dest])
		assert.Equal(t, 1, strings.Count(tst.Stderr(), "Create "))

		plan := &createPlan{
			decided:   decided,
			inputs:    map[string]createInput{dest: cand},
			accountID: "acc-1",
		}
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`)).                         // Alpha
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F1 restrict
			Rsp(http.StatusOK, []byte(`{"id":"F2"}`)).                         // Beta
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F2 restrict
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)). // page
			Rsp(http.StatusOK, []byte(`{}`))                                   // page restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		have, err := pushDests(
			ctx, http.DefaultClient, cfg, cacheDir, []string{dest}, plan)

		// --- Then --- two folder POSTs then the page POST reach the server.
		assert.NoError(t, err)
		assert.Contain(t, "creating team/alpha/beta/page.md ... ok (v1)", have)
		assert.Equal(t, "/wiki/api/v2/folders", srv.Request(0).URL.Path)
		assert.Equal(t, "/wiki/api/v2/folders", srv.Request(2).URL.Path)
		assert.Equal(t, "/wiki/api/v2/pages", srv.Request(4).URL.Path)
	})
}

func Test_pushOne(t *testing.T) {
	t.Run("fetches the live page by frontmatter id", func(t *testing.T) {
		// --- Given --- an edited page with no matching Pages entry, as a space
		// page has: its identity comes from the frontmatter, not the config.
		ctx := t.Context()
		dir := t.TempDir()
		dest, md := writeBaseline(t, dir, "team/_index.md", baseDoc)
		oskit.Create(t, strings.Replace(md, "hello", "hello world", 1), dest)

		conflict := goldkit.Create(t, pageTpl, pageData{
			ID: "1", Title: "T", SpaceID: "9", Version: 3, ADF: `{"type":"doc"}`,
		}).Body()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, conflict).    // live fetch GET
			Rsp(http.StatusOK, []byte(`{}`)) // update PUT
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}
		cacheDir := filepath.Join(dir, adfCacheDir)

		// --- When ---
		changed, ver, err := pushOne(ctx, http.DefaultClient, cfg, cacheDir, dest)

		// --- Then --- the live page is fetched by the frontmatter id and pushed.
		assert.NoError(t, err)
		assert.True(t, changed)
		assert.Equal(t, 4, ver)

		get := srv.Request(0)
		assert.Equal(t, http.MethodGet, get.Method)
		assert.Equal(t, "/wiki/api/v2/pages/1", get.URL.Path)
	})
}

func Test_loadPushInput(t *testing.T) {
	t.Run("error - frontmatter lacks the page id", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		content := "---\npage_version: 3\n---\nbody\n"
		dest := oskit.Create(t, content, dir, "p.md")
		cfg := &config{WorkDir: dir}

		// --- When ---
		_, _, _, err := loadPushInput(cfg, filepath.Join(dir, adfCacheDir), dest)

		// --- Then ---
		assert.ErrorContain(t, "frontmatter lacks page_id or page_version", err)
	})

	t.Run("error - missing file", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cfg := &config{WorkDir: dir}
		dest := filepath.Join(dir, "nope.md")

		// --- When ---
		_, _, _, err := loadPushInput(cfg, dir, dest)

		// --- Then ---
		assert.ErrorContain(t, "reading", err)
	})
}

func Test_refreshAfterPush(t *testing.T) {
	t.Run("preserves the space key in the rewritten file", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cacheDir := filepath.Join(dir, adfCacheDir)
		dest := filepath.Join(dir, "team", "_index.md")
		meta := &mdMeta{
			Title:    "T",
			PageID:   "1",
			SpaceID:  "9",
			SpaceKey: "RZTST",
		}
		docJSON := []byte(`{"type":"doc","content":[]}`)

		// --- When ---
		err := refreshAfterPush(
			cacheDir, dest, "team/_index.md", meta, docJSON, 4, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		have := oskit.ReadFileStr(t, dest)
		assert.Contain(t, "space_key: \"RZTST\"", have)
	})

	t.Run("stamps the parent id when the meta sets it", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cacheDir := filepath.Join(dir, adfCacheDir)
		dest := filepath.Join(dir, "team", "page.md")
		meta := &mdMeta{
			Title:    "T",
			PageID:   "1",
			SpaceID:  "9",
			ParentID: "77",
		}
		docJSON := []byte(`{"type":"doc","content":[]}`)

		// --- When ---
		err := refreshAfterPush(
			cacheDir, dest, "team/page.md", meta, docJSON, 4, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		have := oskit.ReadFileStr(t, dest)
		assert.Contain(t, "parent_id: \"77\"", have)
	})

	t.Run("omits the parent id when the meta has none", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cacheDir := filepath.Join(dir, adfCacheDir)
		dest := filepath.Join(dir, "team", "page.md")
		meta := &mdMeta{Title: "T", PageID: "1", SpaceID: "9"}
		docJSON := []byte(`{"type":"doc","content":[]}`)

		// --- When ---
		err := refreshAfterPush(
			cacheDir, dest, "team/page.md", meta, docJSON, 4, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		have := oskit.ReadFileStr(t, dest)
		assert.NotContain(t, "parent_id", have)
	})

	t.Run("preserves the cf_domain when the meta sets it", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cacheDir := filepath.Join(dir, adfCacheDir)
		dest := filepath.Join(dir, "team", "page.md")
		meta := &mdMeta{
			Title:   "T",
			PageID:  "1",
			SpaceID: "9",
			Domain:  "example.atlassian.net",
		}
		docJSON := []byte(`{"type":"doc","content":[]}`)

		// --- When ---
		err := refreshAfterPush(
			cacheDir, dest, "team/page.md", meta, docJSON, 4, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		have := oskit.ReadFileStr(t, dest)
		assert.Contain(t, "cf_domain: \"example.atlassian.net\"", have)
	})

	t.Run("omits the cf_domain when the meta has none", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		cacheDir := filepath.Join(dir, adfCacheDir)
		dest := filepath.Join(dir, "team", "page.md")
		meta := &mdMeta{Title: "T", PageID: "1", SpaceID: "9"}
		docJSON := []byte(`{"type":"doc","content":[]}`)

		// --- When ---
		err := refreshAfterPush(
			cacheDir, dest, "team/page.md", meta, docJSON, 4, nil, nil)

		// --- Then ---
		assert.NoError(t, err)
		have := oskit.ReadFileStr(t, dest)
		assert.NotContain(t, "cf_domain", have)
	})
}

func Test_mdMeta_writableAssets(t *testing.T) {
	t.Run("a page with no images yields a writable empty map", func(t *testing.T) {
		// --- Given ---
		meta := &mdMeta{}

		// --- When ---
		have := meta.writableAssets()

		// --- Then --- non-nil, so a later upload can still be recorded.
		assert.NotNil(t, have)
		assert.Len(t, 0, have)
	})
}

func Test_splitFrontmatter(t *testing.T) {
	t.Run("splits metadata from body", func(t *testing.T) {
		// --- Given ---
		md := "---\n" +
			"title: \"T\"\n" +
			"page_id: \"1\"\n" +
			"page_version: 3\n" +
			"space_id: \"9\"\n" +
			"space_key: \"RZTST\"\n" +
			"mentions:\n  \"Ann\": \"A\"\n" +
			"---\n\nhello world\n"

		// --- When ---
		meta, body, err := splitFrontmatter([]byte(md))

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "1", meta.PageID)
		assert.Equal(t, 3, meta.PageVersion)
		assert.Equal(t, "9", meta.SpaceID)
		assert.Equal(t, "RZTST", meta.SpaceKey)
		assert.Equal(t, "A", meta.Mentions["Ann"])
		assert.Equal(t, "hello world", body)
	})

	t.Run("parses the cf_local marker", func(t *testing.T) {
		// --- Given ---
		md := "---\ntitle: \"T\"\ncf_local: true\n---\nx\n"

		// --- When ---
		meta, _, err := splitFrontmatter([]byte(md))

		// --- Then ---
		assert.NoError(t, err)
		assert.True(t, meta.Local)
	})

	t.Run("errors without frontmatter", func(t *testing.T) {
		_, _, err := splitFrontmatter([]byte("no frontmatter here"))
		assert.ErrorContain(t, "no frontmatter", err)
	})

	t.Run("errors on unterminated frontmatter", func(t *testing.T) {
		_, _, err := splitFrontmatter([]byte("---\ntitle: x\nbody"))
		assert.ErrorContain(t, "unterminated", err)
	})
}

func Test_spaceKey(t *testing.T) {
	assert.Equal(t, "TEST", spaceKey("/wiki/spaces/TEST/pages/1/Page"))
	assert.Equal(t, "WIKI",
		spaceKey("https://x/wiki/spaces/WIKI/pages/2/P"))
	assert.Equal(t, "", spaceKey("/wiki/pages/1"))
}
