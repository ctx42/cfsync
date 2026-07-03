// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
)

// Folder listing request parameters.
const (
	// folderEndpoint is the Confluence v2 path prefix for a folder by id.
	folderEndpoint = "/wiki/api/v2/folders/"

	// childrenPath is the direct-children suffix appended to a folder path.
	childrenPath = "/direct-children"
)

// unsafeNameChars are the characters replaced with "_" when a Confluence title
// is derived into a local path segment.
const unsafeNameChars = `/\:?*"<>|`

// childNode models one entry in a Confluence v2 direct-children response. Only
// "page" and "folder" types are acted on. Status distinguishes current content
// from drafts, archived pages, and other non-current states, which a walk
// skips; see isCurrent.
type childNode struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// isCurrent reports whether a direct-children status denotes live content that
// belongs in a walk. The Confluence v2 endpoint returns drafts, archived
// pages, and other non-current nodes alongside current ones; only "current" is
// synced. An empty status is treated as current: the live endpoint always sets
// the field, so an absent status only arises where it is left unspecified.
func isCurrent(status string) bool {
	return status == "" || status == "current"
}

// childrenResponse models one page of a Confluence v2 folder direct-children
// response: the child nodes and the host-relative path of the next page, if
// any.
type childrenResponse struct {
	Results []childNode `json:"results"`
	Links   struct {
		Next string `json:"next"`
	} `json:"_links"`
}

// folderPage is a page discovered under a configured folder or space: its
// absolute Markdown destination under the work directory, its numeric
// Confluence id, its Confluence title, its canonical page URL (used to build
// the link index), the numeric id of its parent node in the walk (another
// page or a folder, empty for a space homepage), and, for a page discovered
// under a space, that space's key.
type folderPage struct {
	Dest     string
	ID       string
	Title    string
	URL      string
	ParentID string
	SpaceKey string
}

// discoverFolders walks every configured folder and returns its descendant
// pages with derived destinations, without writing anything. Folders are
// walked in a stable order; neither a page that could not be placed nor a
// folder that failed outright stops the walk. Every page that was placed is
// returned, and when any page or folder failed, a joined error naming each
// failure accompanies them.
func discoverFolders(
	ctx context.Context,
	client *http.Client,
	cfg *config,
) ([]folderPage, error) {

	if len(cfg.Folders) == 0 {
		return nil, nil
	}

	roots := make([]string, 0, len(cfg.Folders))
	for root := range cfg.Folders {
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
		found, err := discoverFolder(ctx, client, cfg, cfg.Folders[root], root)
		pages = append(pages, found...)
		if err != nil {
			rel := pageName(cfg.WorkDir, root)
			errs = append(errs, fmt.Errorf("%s: %w", rel, err))
		}
	}

	if len(errs) > 0 {
		format := "%d of %d folders failed:\n%w"
		joined := errors.Join(errs...)
		return pages, fmt.Errorf(format, len(errs), len(roots), joined)
	}
	return pages, nil
}

// discoverFolder returns the descendant pages of the folder identified by src,
// with destinations rooted at the absolute directory root. Pages that could not
// be placed are skipped; the pages that were placed are returned together with
// a joined error naming each skipped page, so a few bad pages do not lose the
// rest of the folder.
func discoverFolder(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	src string,
	root string,
) ([]folderPage, error) {

	id, err := folderID(src)
	if err != nil {
		return nil, err
	}
	wlk := &folderWalk{client: client, cfg: cfg, space: spaceKey(src)}
	wlk.walk(ctx, id, root)
	if len(wlk.errs) > 0 {
		return wlk.pages, errors.Join(wlk.errs...)
	}
	return wlk.pages, nil
}

// folderWalk carries the invariants of one folder walk: the HTTP client, the
// configuration, the space key used to build page URLs, the pages discovered so
// far, and the per-page errors collected along the way. A page that fails is
// recorded in errs and skipped, along with its subtree, rather than aborting
// the walk, so a single bad page does not lose the rest of the folder.
type folderWalk struct {
	client *http.Client
	cfg    *config
	space  string
	pages  []folderPage
	errs   []error
}

// walk recurses the folder id whose children are placed under the absolute
// directory dir, deriving each page's Markdown destination into wlk.pages. A
// child page's ParentID is id, the folder whose children are being listed;
// a sub-folder emits no page of its own, so its own children carry its id as
// their ParentID instead. Children are visited in the order Confluence
// returns them, following pagination to completion.
//
// A child that cannot be placed — its title derives to an empty name, or its
// name collides with a sibling — is recorded in wlk.errs and skipped along with
// its subtree; sibling children still proceed. A failed children fetch is
// recorded and ends this folder's listing, leaving already-placed pages intact.
func (wlk *folderWalk) walk(ctx context.Context, id, dir string) {
	if err := ctx.Err(); err != nil {
		wlk.errs = append(wlk.errs, err)
		return
	}
	seenPages := make(map[string]bool)
	seenDirs := make(map[string]bool)

	path := folderEndpoint + id + childrenPath
	for path != "" {
		if err := ctx.Err(); err != nil {
			wlk.errs = append(wlk.errs, err)
			return
		}
		resp, err := fetchChildren(ctx, wlk.client, wlk.cfg, "folder", id, path)
		if err != nil {
			wlk.errs = append(wlk.errs, err)
			return
		}
		for _, child := range resp.Results {
			if !isCurrent(child.Status) {
				continue
			}
			switch child.Type {
			case "page":
				name, err := deriveName(child.Title)
				if err != nil {
					wlk.errs = append(wlk.errs,
						fmt.Errorf("page %s: %w", child.ID, err))
					continue
				}
				file := name + ".md"
				dest := filepath.Join(dir, file)
				if seenPages[file] {
					wlk.errs = append(wlk.errs,
						fmt.Errorf("name collision: %s", dest))
					continue
				}
				seenPages[file] = true
				wlk.pages = append(wlk.pages, folderPage{
					Dest:     dest,
					ID:       child.ID,
					Title:    child.Title,
					URL:      pageURL(wlk.space, child.ID),
					ParentID: id,
				})
				wlk.cfg.reporter().found()

			case "folder":
				name, err := deriveName(child.Title)
				if err != nil {
					wlk.errs = append(wlk.errs,
						fmt.Errorf("folder %s: %w", child.ID, err))
					continue
				}
				sub := filepath.Join(dir, name)
				if seenDirs[name] {
					wlk.errs = append(wlk.errs,
						fmt.Errorf("name collision: %s", sub))
					continue
				}
				seenDirs[name] = true
				wlk.walk(ctx, child.ID, sub)
			}
		}
		path = nextURL(wlk.cfg.Host, resp.Links.Next)
	}
}

// collides reports the first cross-entry collision among the configured pages
// and the discovered folder and space pages, naming it, or nil when there is
// none. Two kinds abort the run before any file is written: two entries that
// resolve to the same destination file, and a single Confluence page claimed by
// two entries (the same page id reached twice, however the entries overlap). A
// configured page whose source is not a single page URL contributes no id, so
// it takes part only in the destination check.
func (cfg *config) collides(folders []folderPage) error {
	seenDest := make(map[string]bool, len(cfg.Pages)+len(folders))
	seenID := make(map[string]string, len(cfg.Pages)+len(folders))
	for dest, src := range cfg.Pages {
		seenDest[dest] = true
		id, err := pageID(src)
		if err != nil {
			continue
		}
		if prev, ok := seenID[id]; ok {
			return dupPageErr(cfg.WorkDir, id, prev, dest)
		}
		seenID[id] = dest
	}
	for _, fol := range folders {
		if seenDest[fol.Dest] {
			name := pageName(cfg.WorkDir, fol.Dest)
			return fmt.Errorf(
				"destination %q is claimed by more than one entry", name,
			)
		}
		seenDest[fol.Dest] = true
		if prev, ok := seenID[fol.ID]; ok {
			return dupPageErr(cfg.WorkDir, fol.ID, prev, fol.Dest)
		}
		seenID[fol.ID] = fol.Dest
	}
	return nil
}

// dupPageErr reports that the Confluence page id would be written to two
// destinations, naming the page and both destinations relative to workDir.
func dupPageErr(workDir, id, destA, destB string) error {
	return fmt.Errorf(
		"page %s is claimed by more than one entry: %q and %q",
		id, pageName(workDir, destA), pageName(workDir, destB),
	)
}

// pullDiscovered pulls every discovered page — from a folder or a space — into
// the cache under cfg.WorkDir using client, one by one in the given order. A
// page that fails does not stop the run. It returns the per-page progress
// output, a tally of the pages pulled, re-rendered, and attempted, and, when
// any page failed, a joined error naming each failure. It writes no summary
// line; pullConfig combines the tallies across configured and discovered pages.
func pullDiscovered(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pages []folderPage,
) (string, pullStats, error) {

	if len(pages) == 0 {
		return "", pullStats{}, nil
	}

	dir := filepath.Join(cfg.WorkDir, adfCacheDir)

	var out strings.Builder
	var errs []error
	sta := pullStats{total: len(pages)}
	for _, pag := range pages {
		if ctx.Err() != nil {
			break
		}
		name := pageName(cfg.WorkDir, pag.Dest)
		cfg.reporter().item(name)
		state, ver, err := pullDiscoveredPage(ctx, client, cfg, dir, pag)
		switch {
		case err != nil:
			errs = append(errs, fmt.Errorf("%s: %w", name, err))

		case state == pageRerendered:
			sta.rendered++
			line := fmt.Sprintf(skipLine, name, ver)
			out.WriteString(line)
			cfg.reporter().log(line)

		case state == pageUnchanged:
			sta.unchanged++
			line := fmt.Sprintf(unchangedLine, name, ver)
			out.WriteString(line)
			cfg.reporter().log(line)

		default: // pagePulled
			sta.pulled++
			line := fmt.Sprintf(okLine, name, ver)
			out.WriteString(line)
			cfg.reporter().log(line)
		}
	}

	if len(errs) > 0 {
		format := "%d of %d pages failed:\n%w"
		joined := errors.Join(errs...)
		err := fmt.Errorf(format, len(errs), len(pages), joined)
		return out.String(), sta, err
	}
	return out.String(), sta, nil
}

// pullDiscoveredPage fetches the discovered page pag into its destination, the
// absolute Markdown path under the work directory, and writes it to the cache
// under dir via [page.store]. Its ParentID overrides whatever the page GET
// itself reports, so a walk-discovered page's parent always comes from the
// walk. A page discovered under a space carries that space's key into its
// rendered frontmatter; the Site host is carried in as cf_domain. Each HTTP
// call is bounded by the configured per-request timeout; the parent ctx only
// cancels the overall run.
func pullDiscoveredPage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	dir string,
	pag folderPage,
) (pageState, int, error) {

	name := pageName(cfg.WorkDir, pag.Dest)
	p, err := fetchPageByID(ctx, client, cfg, name, pag.ID)
	if err != nil {
		return pagePulled, 0, err
	}
	p.ParentID = pag.ParentID
	p.SpaceKey = pag.SpaceKey
	p.Domain = cfg.domain()
	return p.store(ctx, client, cfg, dir, pag.Dest)
}

// fetchChildren requests one page of the direct children of the node of the
// given kind ("page" or "folder") and id from the host-relative path, which
// carries any pagination cursor, bounding the request with the configured
// timeout. kind names the node only in error messages.
func fetchChildren(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	kind string,
	id string,
	path string,
) (*childrenResponse, error) {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	req, err := newChildrenRequest(ctx, cfg, path)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("requesting %s %s children: %w", kind, id, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		format := "%s %s children: HTTP %d"
		return nil, fmt.Errorf(format, kind, id, resp.StatusCode)
	}

	var children childrenResponse
	if err = json.NewDecoder(resp.Body).Decode(&children); err != nil {
		return nil, fmt.Errorf("decoding %s %s children: %w", kind, id, err)
	}
	return &children, nil
}

// childFolderTitled returns the id of the direct child folder of parentID
// titled title, or "" when no such folder exists. parentID may be a page or a
// folder, so the folder direct-children endpoint is tried first and the page
// endpoint second; a 404 from one means parentID is the other kind.
func childFolderTitled(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	parentID string,
	title string,
) (string, error) {

	for _, base := range []string{folderEndpoint, pageEndpoint} {
		id, matched, err := scanChildFolders(
			ctx, client, cfg, base+parentID+childrenPath, title)
		if err != nil {
			return "", err
		}
		if matched {
			return id, nil
		}
	}
	return "", nil
}

// scanChildFolders pages through the direct-children listing at path and
// returns the id of the first current folder titled title. matched reports
// whether the endpoint fit the node kind: a 404 yields false so the caller can
// try the other endpoint, while a 2xx yields true even when no folder matches
// (id ""). A non-404 error status or a decode failure is returned as an error.
func scanChildFolders(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	path string,
	title string,
) (string, bool, error) {

	for path != "" {
		children, status, err := getChildren(ctx, client, cfg, path)
		if err != nil {
			return "", false, err
		}
		if status == http.StatusNotFound {
			return "", false, nil
		}
		if status < 200 || status >= 300 {
			return "", false, fmt.Errorf("listing children: HTTP %d", status)
		}
		for _, child := range children.Results {
			if child.Type == "folder" && isCurrent(child.Status) &&
				child.Title == title {

				return child.ID, true, nil
			}
		}
		path = nextURL(cfg.Host, children.Links.Next)
	}
	return "", true, nil
}

// getChildren performs one authenticated GET of the direct-children listing at
// path, bounded by the configured timeout, and returns the decoded response
// together with the HTTP status. A non-2xx status returns a nil response and
// the status with no error, so the caller can distinguish a 404 from a real
// failure; only a transport or decode error is returned as an error.
func getChildren(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	path string,
) (*childrenResponse, int, error) {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	req, err := newChildrenRequest(ctx, cfg, path)
	if err != nil {
		return nil, 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("listing children: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, nil
	}
	var children childrenResponse
	if err = json.NewDecoder(resp.Body).Decode(&children); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("decoding children: %w", err)
	}
	return &children, resp.StatusCode, nil
}

// newChildrenRequest builds the authenticated GET request for path, which is
// either host-relative or already absolute (see [nextURL] for pagination).
func newChildrenRequest(
	ctx context.Context,
	cfg *config,
	path string,
) (*http.Request, error) {

	addr := path
	if !strings.HasPrefix(path, "http://") && !strings.HasPrefix(path, "https://") {
		addr = cfg.Host + path
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	return req, nil
}

// folderID extracts the numeric Confluence folder id from a source path of the
// form ".../folder/{id}...". It returns an error when src is not a folder path.
func folderID(src string) (string, error) {
	path := src
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}

	segs := strings.Split(strings.Trim(path, "/"), "/")
	for i := 0; i+1 < len(segs); i++ {
		if segs[i] == "folder" && isDigits(segs[i+1]) {
			return segs[i+1], nil
		}
	}
	return "", fmt.Errorf("source %q is not a folder", src)
}

// deriveName turns a Confluence title into a local path segment: lower-cased,
// with runs of whitespace collapsed to a single "_", filesystem-unsafe and
// control characters replaced with "_", and leading or trailing dots replaced
// with "_". Non-ASCII characters are kept verbatim. It returns an error when
// the title derives to an empty name.
func deriveName(title string) (string, error) {
	name := strings.Join(strings.Fields(strings.ToLower(title)), "_")
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(unsafeNameChars, r) {
			return '_'
		}
		return r
	}, name)

	b := []byte(name)
	for i := 0; i < len(b) && b[i] == '.'; i++ {
		b[i] = '_'
	}
	for i := len(b) - 1; i >= 0 && b[i] == '.'; i-- {
		b[i] = '_'
	}
	name = string(b)

	if name == "" {
		return "", fmt.Errorf("title %q derives to an empty name", title)
	}
	return name, nil
}
