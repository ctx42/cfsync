// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ctx42/cfsync/pkg/adf"
)

// createAttachmentEndpoint is the Confluence v1 REST path for uploading a new
// attachment to a page; the v2 API has no equivalent multipart create.
const createAttachmentEndpoint = "/wiki/rest/api/content/%s/child/attachment"

// imageLineRE matches a Markdown block that is exactly one image, capturing its
// alt text and path. Only a lone-block image is a candidate for upload, because
// only such a block is spliced in as a mediaSingle node by the lens.
var imageLineRE = regexp.MustCompile(`^!\[([^\]]*)\]\(([^)]+)\)$`)

// inlineImageRE matches a Markdown image anywhere in a line, capturing its
// path, so an image embedded in a paragraph is told from a lone-block image.
var inlineImageRE = regexp.MustCompile(`!\[[^\]]*\]\(([^)]+)\)`)

// pendingImage is a user-added local image found in the edited body: the path
// as written, its alt text, and the resolved on-disk file to upload.
type pendingImage struct {
	path string
	alt  string
	abs  string
}

// uploadedImage records one attachment uploaded on a push, carrying what the
// two post-upload steps need: contentID deletes the orphan attachment if the
// push later fails (see [deleteAttachments]), and src is the local file to move
// into the shared assets directory once the push succeeds (see
// [canonicalizeImages]). localID keys both the media node and the assets map.
type uploadedImage struct {
	contentID string // v1 attachment content id, for cleanup
	localID   string // minted media node localId
	fileID    string // attachment fileId → media attrs.id
	src       string // absolute path of the user's local file
}

// uploadNewImages finds every user-added local image in the edited body and
// uploads each as a new attachment, returning the [adf.NewImage] descriptors
// the lens needs to splice them in and, in parallel, the [uploadedImage]
// records the caller uses to clean up on failure and to canonicalize on
// success. It also records each uploaded image in assets (localId to path) so
// the refreshed page_images frontmatter tracks it and a later push does not
// upload it again. With no new image it does no network I/O and returns nil.
func uploadNewImages(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pageID string,
	dest string,
	body string,
	assets map[string]string,
) ([]adf.NewImage, []uploadedImage, error) {

	// A user-added image embedded inline in a paragraph cannot be uploaded: it
	// would need an inline mediaInline node, which the lens cannot anchor, so the
	// push must reject it rather than silently push a link to a local file the
	// Site cannot resolve. Reject before uploading anything.
	inl, err := detectInlineNewImages(body, assets, dest)
	if err != nil {
		return nil, nil, err
	}
	if len(inl) > 0 {
		return nil, nil, fmt.Errorf(
			"push: inline image %q is not supported; put the image on its own "+
				"line to upload it", inl[0])
	}

	pending, err := detectNewImages(body, assets, dest)
	if err != nil {
		return nil, nil, err
	}
	if len(pending) == 0 {
		return nil, nil, nil
	}
	out := make([]adf.NewImage, 0, len(pending))
	ups := make([]uploadedImage, 0, len(pending))
	for _, p := range pending {
		fileID, contentID, err := uploadAttachment(ctx, client, cfg, pageID, p.abs)
		if err != nil {
			return nil, ups, err
		}
		// Record the attachment before minting the localId, so a failure in the
		// step below still hands the caller its contentID to delete (see
		// [deleteAttachments]); otherwise the uploaded attachment would leak.
		ups = append(ups, uploadedImage{
			contentID: contentID,
			fileID:    fileID,
			src:       p.abs,
		})
		localID, err := adf.NewLocalID()
		if err != nil {
			return nil, ups, err
		}
		ups[len(ups)-1].localID = localID
		out = append(out, adf.NewImage{
			Path:       p.path,
			Alt:        p.alt,
			FileID:     fileID,
			LocalID:    localID,
			Collection: "contentId-" + pageID,
		})
		assets[localID] = p.path
	}
	return out, ups, nil
}

// canonicalizeImages moves each uploaded image out of the user's working tree
// and into the shared assets directory under the same "{fileId}-{localId}{ext}"
// name a pull would have written, then repoints its assets entry at that path.
// Called only after a push succeeds, it makes the refreshed Markdown reference
// the canonical asset, so the local state matches a fresh pull and the next
// pull finds the file already on disk instead of re-downloading it. A move
// failure aborts the push refresh so the divergence surfaces rather than being
// silently left behind.
func canonicalizeImages(
	ups []uploadedImage,
	dest string,
	workDir string,
	assets map[string]string,
) error {

	dir := filepath.Join(workDir, assetsDir)
	for _, up := range ups {
		name := canonicalAssetName(up.fileID, up.localID, up.src)
		path := filepath.Join(dir, name)
		if err := moveFile(up.src, path); err != nil {
			return err
		}
		rel, err := relPath(dest, path)
		if err != nil {
			return err
		}
		assets[up.localID] = rel
	}
	return nil
}

// deleteAttachments best-effort removes the attachments uploaded for a push
// that then failed, so a rejected or errored push leaves no orphan attachment
// on the page. It runs on its own short-lived context, independent of the push
// context that may already be cancelled, and ignores per-attachment errors: the
// push has already failed, and a lingering attachment is a lesser fault than
// masking the original error. An attachment whose content id was not returned
// by the upload cannot be addressed and is skipped.
func deleteAttachments(
	client *http.Client,
	cfg *config,
	ups []uploadedImage,
) {
	if len(ups) == 0 {
		return
	}
	// Cleanup runs on a fresh context: the push ctx may already be cancelled.
	for _, up := range ups {
		if up.contentID == "" {
			continue
		}
		_ = deleteAttachment(context.Background(), client, cfg, up.contentID)
	}
}

// deleteAttachment deletes the attachment with the given v1 content id. It uses
// the v1 content endpoint, the counterpart of the multipart create in
// [uploadAttachment], which the v2 API has no equivalent for.
func deleteAttachment(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	contentID string,
) error {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + "/wiki/rest/api/content/" + contentID
	req, err := http.NewRequestWithContext(
		ctx, http.MethodDelete, addr, http.NoBody)
	if err != nil {
		return fmt.Errorf("building delete request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("X-Atlassian-Token", "no-check")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("deleting attachment %s: %w", contentID, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("delete attachment %s: HTTP %d", contentID, resp.StatusCode)
	}
	return nil
}

// detectNewImages scans the edited body for lone-block images whose path is a
// local file not already tracked in assets, resolving each path relative to the
// Markdown file's directory. A URL, an already-tracked image, or a path with no
// file on disk is skipped, and a path is reported at most once. A Stat error
// other than not-exist is returned so permission failures are not silent.
func detectNewImages(
	body string,
	assets map[string]string,
	dest string,
) ([]pendingImage, error) {

	tracked := make(map[string]bool, len(assets))
	for _, p := range assets {
		tracked[p] = true
	}
	dir := filepath.Dir(dest)
	seen := make(map[string]bool)
	var out []pendingImage
	for ln := range strings.SplitSeq(body, "\n") {
		m := imageLineRE.FindStringSubmatch(strings.TrimSpace(ln))
		if m == nil {
			continue
		}
		alt, path := m[1], m[2]
		if isURL(path) || tracked[path] || seen[path] {
			continue
		}
		abs := path
		if !filepath.IsAbs(path) {
			abs = filepath.Join(dir, path)
		}
		ok, err := fileExists(abs)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue // not a local file we can upload
		}
		seen[path] = true
		out = append(out, pendingImage{path: path, alt: alt, abs: abs})
	}
	return out, nil
}

// detectInlineNewImages reports the paths of user-added local images embedded
// inline in a paragraph (not on their own line). Such an image cannot be
// uploaded — it has no lone-block form for the lens to splice as a media node —
// so the push must reject it. A lone-block image (see [detectNewImages]),
// a URL, an already-tracked path, or a path with no local file is not reported.
// A Stat error other than not-exist is returned so permission failures surface.
func detectInlineNewImages(
	body string,
	assets map[string]string,
	dest string,
) ([]string, error) {

	tracked := make(map[string]bool, len(assets))
	for _, p := range assets {
		tracked[p] = true
	}
	dir := filepath.Dir(dest)
	seen := make(map[string]bool)
	var out []string
	for ln := range strings.SplitSeq(body, "\n") {
		if imageLineRE.MatchString(strings.TrimSpace(ln)) {
			continue // a lone-block image: a candidate for upload, not inline
		}
		for _, m := range inlineImageRE.FindAllStringSubmatch(ln, -1) {
			path := m[1]
			if isURL(path) || tracked[path] || seen[path] {
				continue
			}
			abs := path
			if !filepath.IsAbs(path) {
				abs = filepath.Join(dir, path)
			}
			ok, err := fileExists(abs)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue // not a local file, so not a new inline image
			}
			seen[path] = true
			out = append(out, path)
		}
	}
	return out, nil
}

// isURL reports whether path is an http(s) URL rather than a local file.
func isURL(path string) bool {
	return strings.HasPrefix(path, "http://") ||
		strings.HasPrefix(path, "https://")
}

// attachmentCreateResult is the Confluence v1 create-attachment response. The
// media file id lives under the created attachment's extensions; the top-level
// id is the attachment's content id, the handle needed to delete it again.
type attachmentCreateResult struct {
	Results []struct {
		ID         string `json:"id"`
		Extensions struct {
			FileID string `json:"fileId"`
		} `json:"extensions"`
	} `json:"results"`
}

// uploadAttachment uploads filePath as a new attachment on the page and returns
// its fileId — the value a media node carries as attrs.id — and its content id,
// used to delete the attachment if the push later fails ("" when the response
// omits it). The request is the multipart form the v1 API expects, with the
// CSRF-exempting header it needs.
func uploadAttachment(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pageID string,
	filePath string,
) (string, string, error) {

	file, err := os.Open(filePath) //nolint:gosec // path is body-derived, local.
	if err != nil {
		return "", "", fmt.Errorf("opening image %s: %w", filePath, err)
	}
	defer func() { _ = file.Close() }()

	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	part, err := form.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		return "", "", fmt.Errorf("building upload form: %w", err)
	}
	if _, err = io.Copy(part, file); err != nil {
		return "", "", fmt.Errorf("reading image %s: %w", filePath, err)
	}
	if err = form.Close(); err != nil {
		return "", "", fmt.Errorf("finalizing upload form: %w", err)
	}

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + fmt.Sprintf(createAttachmentEndpoint, pageID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, addr, &buf)
	if err != nil {
		return "", "", fmt.Errorf("building upload request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("X-Atlassian-Token", "no-check")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("uploading %s: %w", filePath, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("upload %s: HTTP %d", filePath, resp.StatusCode)
	}
	var out attachmentCreateResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", fmt.Errorf("decoding upload response: %w", err)
	}
	if len(out.Results) == 0 || out.Results[0].Extensions.FileID == "" {
		return "", "", fmt.Errorf("upload %s: response carried no fileId", filePath)
	}
	return out.Results[0].Extensions.FileID, out.Results[0].ID, nil
}
