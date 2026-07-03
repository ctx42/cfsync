// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
)

// Space walk parameters.
const (
	// spacesEndpoint is the Confluence v2 path for listing spaces by key.
	spacesEndpoint = "/wiki/api/v2/spaces"

	// indexFile is the Markdown file holding a container page's own body: the
	// space homepage, and any page that has children.
	indexFile = "_index.md"

	// indexName is the reserved base name of indexFile. A sibling page whose
	// title derives to it is disambiguated rather than allowed to collide.
	indexName = "_index"
)

// spaceResponse models the fields cfsync reads from the Confluence v2
// spaces-by-key list response.
type spaceResponse struct {
	Results []struct {
		ID         string `json:"id"`
		HomepageID string `json:"homepageId"`
	} `json:"results"`
}

// spaceLinkKey extracts the space key from a link to a space root of the form
// ".../spaces/{KEY}", optionally followed by an "overview" segment, a query,
// or a fragment. It returns an error when link is not a space-root link,
// including page and folder links, which carry extra path segments.
func spaceLinkKey(link string) (string, error) {
	path := link
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}

	segs := strings.Split(strings.Trim(path, "/"), "/")
	for i := 0; i+1 < len(segs); i++ {
		if segs[i] != "spaces" {
			continue
		}
		key := segs[i+1]
		rest := segs[i+2:]
		switch {
		case key == "":
			// Fall through to the not-a-space-root error below.
		case len(rest) == 0, len(rest) == 1 && rest[0] == "overview":
			return key, nil
		}
		break
	}
	return "", fmt.Errorf("link %q is not a space root", link)
}

// discoverSpaces walks every configured space and returns its pages with
// derived destinations, without writing anything. Spaces are walked in a stable
// order; neither a page that could not be placed nor a space that failed
// outright stops the walk. Every page that was placed is returned, and when any
// page or space failed, a joined error naming each failure accompanies them.
func discoverSpaces(
	ctx context.Context,
	client *http.Client,
	cfg *config,
) ([]folderPage, error) {

	if len(cfg.Spaces) == 0 {
		return nil, nil
	}

	roots := make([]string, 0, len(cfg.Spaces))
	for root := range cfg.Spaces {
		roots = append(roots, root)
	}
	sort.Strings(roots)

	var pages []folderPage
	var errs []error
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		found, err := discoverSpace(ctx, client, cfg, cfg.Spaces[root], root)
		pages = append(pages, found...)
		if err != nil {
			rel := pageName(cfg.WorkDir, root)
			errs = append(errs, fmt.Errorf("%s: %w", rel, err))
		}
	}

	if len(errs) > 0 {
		format := "%d of %d spaces failed:\n%w"
		joined := errors.Join(errs...)
		return pages, fmt.Errorf(format, len(errs), len(roots), joined)
	}
	return pages, nil
}

// discoverSpace returns the pages of the space linked by src, with destinations
// rooted at the absolute directory root. The walk starts at the space homepage,
// which becomes root/_index.md. Pages that could not be placed are skipped; the
// pages that were placed are returned together with a joined error naming each
// skipped page, so a few bad pages do not lose the rest of the space.
func discoverSpace(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	src string,
	root string,
) ([]folderPage, error) {

	key, err := spaceLinkKey(src)
	if err != nil {
		return nil, err
	}
	_, homepage, err := resolveSpaceID(ctx, client, cfg, key)
	if err != nil {
		return nil, err
	}

	wlk := &spaceWalk{client: client, cfg: cfg, key: key}
	wlk.walk(ctx, "page", homepage, "", "", root, true, nil)
	if len(wlk.errs) > 0 {
		return wlk.pages, errors.Join(wlk.errs...)
	}
	return wlk.pages, nil
}

// resolveSpaceID looks up the numeric space id and homepage id for a space key
// using the Confluence v2 spaces-by-key endpoint. It bounds the request with
// the configured timeout.
func resolveSpaceID(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	key string,
) (string, string, error) {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + spacesEndpoint + "?keys=" + url.QueryEscape(key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, http.NoBody)
	if err != nil {
		return "", "", fmt.Errorf("building request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)

	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("requesting space %q: %w", key, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("space %q: HTTP %d", key, resp.StatusCode)
	}

	var sr spaceResponse
	if err = json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		return "", "", fmt.Errorf("decoding space %q: %w", key, err)
	}
	if len(sr.Results) == 0 {
		return "", "", fmt.Errorf("space %q not found", key)
	}
	home := sr.Results[0].HomepageID
	if home == "" {
		return "", "", fmt.Errorf("space %q has no homepage", key)
	}
	return sr.Results[0].ID, home, nil
}

// spaceWalk carries the invariants of one space walk: the HTTP client, the
// configuration, the space key used to build page URLs, the pages discovered so
// far, and the per-page errors collected along the way. A page that fails is
// recorded in errs and skipped, along with its subtree, rather than aborting
// the walk, so a single bad page does not lose the rest of the space.
type spaceWalk struct {
	client *http.Client
	cfg    *config
	key    string
	pages  []folderPage
	errs   []error
}

// walk recurses the node of the given kind ("page" or "folder") and id whose
// children are placed under parentDir, deriving each page's Markdown
// destination into wlk.pages. parentID is the id of the node's own parent —
// another page or a folder — recorded as the page's ParentID, empty for the
// space homepage, which has none. When root is true the node is the space
// homepage: its body goes to parentDir/_index.md and its children directly
// under parentDir. seen guards sibling name collisions within parentDir and
// is nil for the root, which has no siblings. Children visit in the order
// Confluence returns them, each carrying id as its own parentID; a folder
// emits no page of its own, so its children still carry its id as their
// parentID.
//
// A node that cannot be placed — its title derives to an empty name, its
// children cannot be fetched, or its name collides with a sibling — is recorded
// in wlk.errs and skipped along with its subtree; sibling nodes still proceed.
func (wlk *spaceWalk) walk(
	ctx context.Context,
	kind string,
	id string,
	parentID string,
	title string,
	parentDir string,
	root bool,
	seen map[string]bool,
) {

	if err := ctx.Err(); err != nil {
		wlk.errs = append(wlk.errs, err)
		return
	}

	name := ""
	if !root {
		derived, err := deriveName(title)
		if err != nil {
			wlk.errs = append(wlk.errs, fmt.Errorf("%s %s: %w", kind, id, err))
			return
		}
		name = derived
		if name == indexName {
			name += "-" + id
		}
	}

	kids, err := wlk.children(ctx, kind, id)
	if err != nil {
		wlk.errs = append(wlk.errs, err)
		return
	}

	var ownDir, dest string
	switch {
	case root:
		ownDir = parentDir
		dest = filepath.Join(parentDir, indexFile)
	case kind == "folder":
		ownDir = filepath.Join(parentDir, name)
	case len(kids) > 0: // container page
		ownDir = filepath.Join(parentDir, name)
		dest = filepath.Join(ownDir, indexFile)
	default: // leaf page
		dest = filepath.Join(parentDir, name+".md")
	}

	if !root && !wlk.claim(name, dest, ownDir, seen) {
		return
	}

	if dest != "" {
		wlk.pages = append(wlk.pages, folderPage{
			Dest:     dest,
			ID:       id,
			Title:    title,
			URL:      pageURL(wlk.key, id),
			ParentID: parentID,
			SpaceKey: wlk.key,
		})
		wlk.cfg.reporter().found()
	}

	childSeen := make(map[string]bool)
	for _, kid := range kids {
		wlk.walk(ctx, kid.Type, kid.ID, id, kid.Title, ownDir, false, childSeen)
	}
}

// claim marks name's sibling slot in seen and reports whether it was free. A
// page and a directory occupy separate slots, so a page and a sub-folder of the
// same name do not collide. ownDir is set for a directory-bearing node and
// selects the directory slot; dest and ownDir name the clashing path in the
// recorded error. A taken slot records a collision and returns false.
func (wlk *spaceWalk) claim(
	name string,
	dest string,
	ownDir string,
	seen map[string]bool,
) bool {

	slot := "f:" + name
	clash := dest
	if ownDir != "" {
		slot = "d:" + name
		clash = ownDir
	}
	if seen[slot] {
		format := "name collision: %s"
		wlk.errs = append(wlk.errs,
			fmt.Errorf(format, pageName(wlk.cfg.WorkDir, clash)))
		return false
	}
	seen[slot] = true
	return true
}

// children returns the live page and folder direct-children of the node of the
// given kind and id, following pagination to completion. Non-current children
// (drafts, archived, and the like) and other content types are skipped.
func (wlk *spaceWalk) children(
	ctx context.Context,
	kind string,
	id string,
) ([]childNode, error) {

	var out []childNode
	path := childrenLink(kind, id)
	for path != "" {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		resp, err := fetchChildren(ctx, wlk.client, wlk.cfg, kind, id, path)
		if err != nil {
			return nil, err
		}
		for _, kid := range resp.Results {
			if !isCurrent(kid.Status) {
				continue
			}
			if kid.Type == "page" || kid.Type == "folder" {
				out = append(out, kid)
			}
		}
		path = nextURL(wlk.cfg.Host, resp.Links.Next)
	}
	return out, nil
}

// childrenLink builds the direct-children path for the node of the given kind
// ("page" or "folder") and id.
func childrenLink(kind, id string) string {
	if kind == "folder" {
		return folderEndpoint + id + childrenPath
	}
	return pageEndpoint + id + childrenPath
}
