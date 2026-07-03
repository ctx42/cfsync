// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"fmt"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/httpkit"
	"github.com/ctx42/testkit/pkg/oskit"

	"github.com/ctx42/cfsync/pkg/adf"
)

func Test_downloadImages(t *testing.T) {
	t.Run("downloads matched images and maps them", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
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
			Rsp(http.StatusOK, []byte(atts)).
			Rsp(http.StatusOK, []byte("JPEGDATA"))
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}
		dest := filepath.Join(dir, "test", "root_page_1.md")
		refs := []adf.MediaRef{
			{LocalID: "L1", FileID: "F1", Alt: "pic.jpg"},
			{LocalID: "L2", FileID: "F2", Alt: "gone.jpg"},
		}

		// --- When ---
		have, err := downloadImages(ctx, client, cfg, "1", dest, refs)

		// --- Then ---
		assert.NoError(t, err)
		want := map[string]string{"L1": "../_assets/F1-L1.jpg"}
		assert.Equal(t, want, have)

		asset := filepath.Join(dir, assetsDir, "F1-L1.jpg")
		assert.Equal(t, "JPEGDATA", oskit.ReadFileStr(t, asset))

		req := srv.Request(0)
		assert.Equal(t, "/wiki/api/v2/pages/1/attachments", req.URL.Path)
	})

	t.Run("returns nil without media references", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		cfg := &config{Host: "https://ex.atlassian.net"}
		dest := filepath.Join(t.TempDir(), "a.md")

		// --- When ---
		have, err := downloadImages(ctx, client, cfg, "1", dest, nil)

		// --- Then ---
		assert.NoError(t, err)
		assert.Nil(t, have)
	})

	t.Run("error - listing attachments fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		dest := filepath.Join(t.TempDir(), "a.md")
		refs := []adf.MediaRef{{LocalID: "L1", FileID: "F1", Alt: "pic.jpg"}}

		// --- When ---
		have, err := downloadImages(ctx, client, cfg, "1", dest, refs)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "attachments for 1: HTTP 404", err)
	})

	t.Run("error - downloading an image fails", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		dir := t.TempDir()
		client := http.DefaultClient
		atts := `{
		   "results": [
		      {
		         "fileId": "F1",
		         "title": "pic.jpg",
		         "mediaType": "image/jpeg",
		         "downloadLink": "/att/F1"
		      }
		   ]
		}`
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(atts)).
			Rsp(http.StatusForbidden, nil)
		cfg := &config{
			Host:    srv.URL(),
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: dir,
		}
		dest := filepath.Join(dir, "a.md")
		refs := []adf.MediaRef{{LocalID: "L1", FileID: "F1", Alt: "pic.jpg"}}

		// --- When ---
		have, err := downloadImages(ctx, client, cfg, "1", dest, refs)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "downloading /att/F1: HTTP 403", err)
	})
}

func Test_fetchAttachments(t *testing.T) {
	t.Run("collects attachments across pages", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		next := "/wiki/api/v2/pages/1/attachments?cursor=x"
		page1 := fmt.Sprintf(`{
		   "results": [ { "fileId": "F1", "title": "a.jpg" } ],
		   "_links": { "next": %q }
		}`, next)
		page2 := `{
		   "results": [ { "fileId": "F2", "title": "b.png" } ]
		}`
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(page1)).
			Rsp(http.StatusOK, []byte(page2))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := fetchAttachments(ctx, client, cfg, "1")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "a.jpg", have["F1"].Title)
		assert.Equal(t, "b.png", have["F2"].Title)

		req := srv.Request(0)
		assert.Equal(t, "/wiki/api/v2/pages/1/attachments", req.URL.Path)
		assert.Equal(t, "x", srv.Request(1).URL.Query().Get("cursor"))
	})

	t.Run("error - non-2xx response", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := fetchAttachments(ctx, client, cfg, "1")

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "attachments for 1: HTTP 404", err)
	})

	t.Run("error - response is not valid JSON", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte("not-json"))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := fetchAttachments(ctx, client, cfg, "1")

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "decoding attachments for 1", err)
	})
}

func Test_ensureAsset(t *testing.T) {
	t.Run("downloads the attachment to the path", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte("BYTES"))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		path := filepath.Join(t.TempDir(), "_assets", "F1-L1.jpg")

		// --- When ---
		err := ensureAsset(ctx, client, cfg, "/rest/att/F1/download", path)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "BYTES", oskit.ReadFileStr(t, path))

		req := srv.Request(0)
		assert.Equal(t, "/wiki/rest/att/F1/download", req.URL.Path)
		user, pass, ok := req.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "a@ex.com", user)
		assert.Equal(t, "secret", pass)
	})

	t.Run("leaves an already-downloaded file in place", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		cfg := &config{Host: "https://ex.atlassian.net", Token: "secret"}
		path := oskit.Create(t, "original", t.TempDir(), "F1-L1.jpg")

		// --- When ---
		err := ensureAsset(ctx, client, cfg, "/rest/att/F1/download", path)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "original", oskit.ReadFileStr(t, path))
	})

	t.Run("error - non-2xx response", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).Rsp(http.StatusForbidden, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}
		path := filepath.Join(t.TempDir(), "F1-L1.jpg")

		// --- When ---
		err := ensureAsset(ctx, client, cfg, "/rest/att/F1/download", path)

		// --- Then ---
		assert.ErrorContain(t, "HTTP 403", err)
	})
}

func Test_assetName(t *testing.T) {
	t.Run("joins fileId, localId and media-type extension", func(t *testing.T) {
		// --- Given ---
		ref := adf.MediaRef{LocalID: "L1", FileID: "F1", Alt: "pic.jpg"}
		att := attachment{MediaType: "image/png", Title: "pic.jpg"}

		// --- When ---
		have := assetName(ref, att)

		// --- Then ---
		assert.Equal(t, "F1-L1.png", have)
	})
}

func Test_imageExt_tabular(t *testing.T) {
	tt := []struct {
		testN     string
		mediaType string
		title     string
		want      string
	}{
		{"jpeg", "image/jpeg", "a.jpeg", ".jpg"},
		{"png", "image/png", "a.png", ".png"},
		{"svg", "image/svg+xml", "a.svg", ".svg"},
		{"unknown falls back to title", "application/x", "a.heic", ".heic"},
		{"unknown without title extension", "application/x", "a", ""},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := imageExt(tc.mediaType, tc.title)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_relPath(t *testing.T) {
	t.Run("returns a forward-slash path relative to dest", func(t *testing.T) {
		// --- Given ---
		dest := filepath.Join("/wd", "test", "page.md")
		target := filepath.Join("/wd", "_assets", "F1-L1.jpg")

		// --- When ---
		have, err := relPath(dest, target)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "../_assets/F1-L1.jpg", have)
	})
}

func Test_nextURL_tabular(t *testing.T) {
	tt := []struct {
		testN string
		host  string
		next  string
		want  string
	}{
		{
			"empty next ends pagination",
			"https://ex.net",
			"",
			"",
		},
		{
			"relative next joins host",
			"https://ex.net",
			"/wiki/x?c=1",
			"https://ex.net/wiki/x?c=1",
		},
		{
			"absolute next used as-is",
			"https://ex.net",
			"https://cdn/x",
			"https://cdn/x",
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := nextURL(tc.host, tc.next)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}
