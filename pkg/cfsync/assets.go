// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/ctx42/cfsync/pkg/adf"
)

// Image download parameters.
const (
	// assetsDir is the shared directory, created under the work directory,
	// that downloaded page images are written to.
	assetsDir = "_assets"

	// attachmentsEndpoint is the Confluence v2 path for a page's attachments,
	// formatted with the numeric page id.
	attachmentsEndpoint = "/wiki/api/v2/pages/%s/attachments"
)

// attachment models the fields cfsync reads from a Confluence v2 attachment.
type attachment struct {
	// FileID is the media file identifier, equal to a media node's attrs.id.
	FileID string `json:"fileId"`

	// Title is the attachment file name as stored in Confluence.
	Title string `json:"title"`

	// MediaType is the attachment MIME type, such as "image/jpeg".
	MediaType string `json:"mediaType"`

	// DownloadLink is the site-relative download path; it lacks the "/wiki"
	// prefix and redirects to the media store.
	DownloadLink string `json:"downloadLink"`
}

// attachmentPage models one page of the Confluence v2 attachments response.
type attachmentPage struct {
	Results []attachment `json:"results"`
	Links   struct {
		Next string `json:"next"`
	} `json:"_links"`
}

// downloadImages resolves every file-media reference in refs against the page's
// attachments, downloads each matched image into the shared assets directory
// under the work directory, and returns a map from each media node localId to
// the image path relative to dest. A reference with no matching attachment is
// skipped, so it renders as a placeholder rather than failing the page; an
// image already present on disk is left in place, not re-downloaded.
func downloadImages(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pageID string,
	dest string,
	refs []adf.MediaRef,
) (map[string]string, error) {

	if len(refs) == 0 {
		return nil, nil
	}

	atts, err := fetchAttachments(ctx, client, cfg, pageID)
	if err != nil {
		return nil, err
	}

	dir := filepath.Join(cfg.WorkDir, assetsDir)
	assets := make(map[string]string, len(refs))
	for _, ref := range refs {
		att, ok := atts[ref.FileID]
		if !ok {
			continue
		}
		path := filepath.Join(dir, assetName(ref, att))
		err = ensureAsset(ctx, client, cfg, att.DownloadLink, path)
		if err != nil {
			return nil, err
		}
		rel, err := relPath(dest, path)
		if err != nil {
			return nil, err
		}
		assets[ref.LocalID] = rel
	}
	return assets, nil
}

// fetchAttachments lists every attachment of the page, following the response
// pagination cursor, and returns them keyed by fileId.
func fetchAttachments(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pageID string,
) (map[string]attachment, error) {

	out := make(map[string]attachment)
	addr := cfg.Host + fmt.Sprintf(attachmentsEndpoint, pageID)
	for addr != "" {
		apg, err := fetchAttachmentPage(ctx, client, cfg, pageID, addr)
		if err != nil {
			return nil, err
		}
		for _, att := range apg.Results {
			out[att.FileID] = att
		}
		addr = nextURL(cfg.Host, apg.Links.Next)
	}
	return out, nil
}

// fetchAttachmentPage requests one page of the page's attachments from addr.
// The request is bounded by the configured per-request timeout.
func fetchAttachmentPage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pageID string,
	addr string,
) (*attachmentPage, error) {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("listing attachments for %s: %w", pageID, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		format := "attachments for %s: HTTP %d"
		return nil, fmt.Errorf(format, pageID, resp.StatusCode)
	}

	var apg attachmentPage
	if err = json.NewDecoder(resp.Body).Decode(&apg); err != nil {
		return nil, fmt.Errorf("decoding attachments for %s: %w", pageID, err)
	}
	return &apg, nil
}

// ensureAsset downloads the attachment at downloadLink to path, unless a file
// is already present there. The download link is site-relative and lacks the
// "/wiki" prefix; the request follows the redirect to the media store.
func ensureAsset(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	downloadLink string,
	path string,
) error {

	exists, err := fileExists(path)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + downloadLink
	if !strings.HasPrefix(downloadLink, "/wiki") {
		addr = cfg.Host + "/wiki" + downloadLink
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, http.NoBody)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", downloadLink, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		format := "downloading %s: HTTP %d"
		return fmt.Errorf(format, downloadLink, resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading %s: %w", downloadLink, err)
	}
	return writeFile(path, data, 0o644)
}

// assetName builds the on-disk file name for a media reference,
// "{fileId}-{localId}{ext}", with the extension taken from the attachment's
// media type. The localId makes the name unique per media node, so the image
// path maps back to exactly one node.
func assetName(ref adf.MediaRef, att attachment) string {
	return ref.FileID + "-" + ref.LocalID + imageExt(att.MediaType, att.Title)
}

// imageExt returns the file extension for an image, preferring a known mapping
// from its media type and falling back to the title's extension.
func imageExt(mediaType, title string) string {
	switch mediaType {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "image/bmp":
		return ".bmp"
	case "image/tiff":
		return ".tiff"
	default:
		return filepath.Ext(title)
	}
}

// canonicalAssetName builds the on-disk asset file name a push must give an
// uploaded image so it matches the name a later pull assigns from the server's
// attachment metadata (see [assetName]). The media type is inferred from the
// local file's own extension and the title from its base name, so an extension
// the server normalizes (".jpeg" to ".jpg") canonicalizes the same on both
// paths and the next pull finds the file already on disk.
func canonicalAssetName(fileID, localID, src string) string {
	mediaType, _, _ := mime.ParseMediaType(mime.TypeByExtension(filepath.Ext(src)))
	return fileID + "-" + localID + imageExt(mediaType, filepath.Base(src))
}

// relPath returns target relative to the directory of dest, in forward-slash
// form for use in a Markdown link.
func relPath(dest, target string) (string, error) {
	rel, err := filepath.Rel(filepath.Dir(dest), target)
	if err != nil {
		return "", fmt.Errorf("relating %s to %s: %w", target, dest, err)
	}
	return filepath.ToSlash(rel), nil
}

// nextURL resolves a Confluence v2 pagination "next" link against host,
// returning "" when there is no next page.
func nextURL(host, next string) string {
	switch {
	case next == "":
		return ""
	case strings.HasPrefix(next, "http://"),
		strings.HasPrefix(next, "https://"):
		return next
	default:
		return host + next
	}
}
