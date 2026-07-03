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
	"slices"
	"sort"
	"strings"

	"github.com/ctx42/ring/pkg/ring"
)

// Page pull request parameters.
const (
	// pageEndpoint is the Confluence v2 path prefix for a page by id.
	pageEndpoint = "/wiki/api/v2/pages/"

	// adfCacheDir is the cache directory created under the work directory.
	adfCacheDir = ".adf_cache"
)

// Per-page pull progress lines.
const (
	// okLine reports a page pulled at a new version.
	okLine = "pulling %s ... ok (v%d)\n"

	// skipLine reports a page whose version was already cached and whose
	// re-rendered Markdown differed, so the Markdown was rewritten.
	skipLine = "pulling %s ... skipped (v%d cached), md written\n"

	// unchangedLine reports a page whose version was already cached and whose
	// re-rendered Markdown matched, so nothing was written.
	unchangedLine = "pulling %s ... skipped (v%d cached), unchanged\n"
)

// pageState is the outcome of storing one pulled page, distinguishing a fresh
// fetch from a cache hit whose Markdown did or did not change on disk.
type pageState int

const (
	// pagePulled marks a page fetched at a version not yet cached.
	pagePulled pageState = iota

	// pageRerendered marks a cached page whose Markdown changed and was
	// rewritten.
	pageRerendered

	// pageUnchanged marks a cached page whose Markdown was already current, so
	// nothing was written.
	pageUnchanged
)

// pullStats tallies the outcomes of pulling a set of pages. pulled counts pages
// fetched at a version not yet cached; rendered counts already-cached pages
// whose Markdown was re-rendered and rewritten; unchanged counts already-cached
// pages whose re-rendered Markdown matched, so nothing was written. total is
// the number of pages attempted, so total less the three is the number that
// failed and is reported through the accompanying error.
type pullStats struct {
	pulled    int
	rendered  int
	unchanged int
	total     int
}

// add returns the element-wise sum of the two tallies, combining the counts of
// a run's configured and discovered pages.
func (sta pullStats) add(oth pullStats) pullStats {
	return pullStats{
		pulled:    sta.pulled + oth.pulled,
		rendered:  sta.rendered + oth.rendered,
		unchanged: sta.unchanged + oth.unchanged,
		total:     sta.total + oth.total,
	}
}

// pullSummary formats the closing summary of a completed pull: the pages
// fetched at a new version, those re-rendered from the cache, and those left
// unchanged. When any page was re-rendered it adds a line explaining that a
// re-render rewrites the Markdown from cached ADF without fetching, so those
// pages show up as changes in git even though no new version was pulled.
func pullSummary(sta pullStats) string {
	noun := plural(sta.total, "page", "pages")
	format := "cfsync: %d %s — %d pulled (new version), " +
		"%d re-rendered, %d unchanged\n"
	summary := fmt.Sprintf(format,
		sta.total, noun, sta.pulled, sta.rendered, sta.unchanged)
	if sta.rendered > 0 {
		summary += "" +
			"cfsync: a re-render rewrites Markdown from cached ADF without " +
			"fetching, so those pages show up as changes in git even though " +
			"no new version was pulled\n"
	}
	return summary
}

// canceledSummary formats the summary of a pull stopped by Ctrl-C, reporting
// what was pulled, re-rendered, and left unchanged before the interruption.
func canceledSummary(sta pullStats) string {
	format := "cfsync: canceled — %d pulled (new version), " +
		"%d re-rendered, %d unchanged\n"
	return fmt.Sprintf(format, sta.pulled, sta.rendered, sta.unchanged)
}

// pull loads the configuration from the path and pulls it with the default
// HTTP client. When selected is empty it pulls the whole configuration;
// otherwise selected names a single managed page — a work-dir-relative or
// absolute path to its Markdown file — and only that page is pulled. It shows
// progress for a long run, and returns the combined output to print and any
// error.
func pull(
	ctx context.Context,
	rng *ring.Ring,
	path string,
	selected string,
) (string, error) {

	cfg, err := loadConfig(rng, path)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg.report = newReporter(rng, "pulling", cancel)
	defer cfg.report.finish()

	if selected != "" {
		return pullSelected(ctx, http.DefaultClient, cfg, selected)
	}
	return pullConfig(ctx, http.DefaultClient, cfg)
}

// pullConfig pulls every configured page and the pages of every configured
// folder and space into the ADF cache and writes their Markdown. It first
// discovers the folder and space pages and rejects the whole run, writing
// nothing, when any destination or any Confluence page is claimed by more than
// one entry. A page that fails does not stop the run; Ctrl-C stops it after the
// current page. It returns the combined output to print and any error, which is
// [context.Canceled] when the run was interrupted.
func pullConfig(
	ctx context.Context,
	client *http.Client,
	cfg *config,
) (string, error) {

	folders, folderErr := discoverFolders(ctx, client, cfg)
	spaces, spaceErr := discoverSpaces(ctx, client, cfg)
	discovered := slices.Concat(folders, spaces)
	discErr := errors.Join(folderErr, spaceErr)

	if err := cfg.collides(discovered); err != nil {
		return "", errors.Join(discErr, err)
	}

	// Build the index in memory so this run can still resolve cross-page links,
	// but persist it only when discovery was complete: a partial index written
	// over a prior complete one would drop the failed entry's pages, and a
	// later push could no longer restore links to them.
	cfg.links = buildLinkIndex(cfg, discovered)
	if discErr == nil {
		if err := cfg.links.write(); err != nil {
			return "", err
		}
	}

	cfg.reporter().discovered(len(cfg.Pages) + len(discovered))

	pagesOut, pSta, pagesErr := pullPages(ctx, client, cfg)
	treeOut, dSta, treeErr := pullDiscovered(ctx, client, cfg, discovered)

	logOut := pagesOut + treeOut
	sta := pSta.add(dSta)
	if ctx.Err() != nil {
		return cfg.stdoutText(logOut, canceledSummary(sta)), context.Canceled
	}
	if err := errors.Join(discErr, pagesErr, treeErr); err != nil {
		return cfg.stdoutText(logOut, ""), err
	}
	if sta.total == 0 {
		return cfg.stdoutText(logOut, "cfsync: nothing to pull\n"), nil
	}
	return cfg.stdoutText(logOut, pullSummary(sta)), nil
}

// pullSelected pulls the single managed page named by selected — a
// work-dir-relative or absolute path to its Markdown file — into the ADF cache
// and writes its Markdown. It resolves the page's Confluence source from the
// configuration or the link index without any folder or space discovery, so the
// persisted link index is loaded for link rewriting but never rewritten. It
// returns the output to print and any error, which is [context.Canceled] when
// the run was interrupted.
func pullSelected(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	selected string,
) (string, error) {

	var err error
	if cfg.links, err = loadLinkIndex(cfg); err != nil {
		return "", err
	}

	dest := resolvePagePath(cfg.WorkDir, selected)
	src, spaceKey, err := cfg.pageSource(dest)
	if err != nil {
		return "", err
	}

	name := pageName(cfg.WorkDir, dest)
	cfg.reporter().discovered(1)
	cfg.reporter().item(name)

	dir := filepath.Join(cfg.WorkDir, adfCacheDir)
	state, ver, err := pullOne(ctx, client, cfg, dir, dest, src, spaceKey)
	if ctx.Err() != nil {
		summary := "cfsync: canceled — the page was not pulled\n"
		return cfg.stdoutText("", summary), context.Canceled
	}
	if err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}

	var line, summary string
	switch state {
	case pageRerendered:
		line = fmt.Sprintf(skipLine, name, ver)
		summary = "" +
			"cfsync: 1 page re-rendered from cache — Markdown rewritten " +
			"from cached ADF, no new version pulled\n"

	case pageUnchanged:
		line = fmt.Sprintf(unchangedLine, name, ver)
		summary = "cfsync: 1 page already up to date — nothing written\n"

	default: // pagePulled
		line = fmt.Sprintf(okLine, name, ver)
		summary = "cfsync: 1 page pulled (new version)\n"
	}
	cfg.reporter().log(line)
	return cfg.stdoutText(line, summary), nil
}

// pageSource returns the Confluence source URL and space key for the managed
// page at dest, its absolute Markdown path. A page configured under pages:
// resolves from the configuration and has no space key; a folder or space page
// resolves from the loaded link index, which the last full pull populated, and
// a space page carries its space key so a re-pull can restore its space_key
// frontmatter. It returns an error naming dest when it is not a managed page:
// when no link index is loaded the error points at pulling the containing
// folder or space root first.
func (cfg *config) pageSource(dest string) (string, string, error) {
	if src, ok := cfg.Pages[dest]; ok {
		return src, "", nil
	}
	name := pageName(cfg.WorkDir, dest)
	if cfg.links == nil {
		format := "%s: not a managed page; pull its folder or space root first"
		return "", "", fmt.Errorf(format, name)
	}
	if ent, ok := cfg.links.byDest[dest]; ok {
		return ent.URL, ent.SpaceKey, nil
	}
	return "", "", fmt.Errorf("%s: not a managed page", name)
}

// pullPages pulls every configured page in cfg into the cache under
// cfg.WorkDir using client, one by one in a stable order. A page that fails
// does not stop the run. It returns the per-page progress output, a tally of
// the pages pulled, re-rendered, and attempted, and, when any page failed, a
// joined error naming each failure. It writes no summary line; pullConfig
// combines the tallies across configured and discovered pages.
func pullPages(
	ctx context.Context,
	client *http.Client,
	cfg *config,
) (string, pullStats, error) {

	if len(cfg.Pages) == 0 {
		return "", pullStats{}, nil
	}

	dests := make([]string, 0, len(cfg.Pages))
	for dest := range cfg.Pages {
		dests = append(dests, dest)
	}
	sort.Strings(dests)

	dir := filepath.Join(cfg.WorkDir, adfCacheDir)

	var out strings.Builder
	var errs []error
	sta := pullStats{total: len(dests)}
	for _, dest := range dests {
		if ctx.Err() != nil {
			break
		}
		name := pageName(cfg.WorkDir, dest)
		cfg.reporter().item(name)
		state, ver, err := pullOne(ctx, client, cfg, dir, dest, cfg.Pages[dest], "")
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
		err := fmt.Errorf(format, len(errs), len(dests), joined)
		return out.String(), sta, err
	}
	return out.String(), sta, nil
}

// pullOne fetches the page at the source src for dest, the absolute Markdown
// path under the work directory, and writes it to the cache under dir via
// [page.store]. A non-empty spaceKey is carried into the rendered frontmatter
// for a page pulled through a space; the Site host is carried in as cf_domain.
// Each HTTP call is bounded by the configured per-request timeout; the parent
// ctx only cancels the overall run.
func pullOne(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	dir string,
	dest string,
	src string,
	spaceKey string,
) (pageState, int, error) {

	name := pageName(cfg.WorkDir, dest)
	p, err := fetchPage(ctx, client, cfg, name, src)
	if err != nil {
		return pagePulled, 0, err
	}
	p.SpaceKey = spaceKey
	p.Domain = cfg.domain()
	return p.store(ctx, client, cfg, dir, dest)
}

// store caches pag's ADF under dir, renders its Markdown, downloads its images,
// and writes the Markdown to both the cache and dest. The ADF wrapper is cached
// at dir/{name}.vN.json, written only when that version is not already cached.
// The Markdown is re-rendered on every pull but written only where its content
// differs, both to dest and, next to the ADF file, at dir/{name}.vN.md, so an
// unchanged render leaves the working tree untouched. It returns the page state
// — pulled, re-rendered, or unchanged — and the page version.
func (pag *page) store(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	dir string,
	dest string,
) (pageState, int, error) {

	adfPath := filepath.Join(dir, pag.cacheFile())
	exists, err := fileExists(adfPath)
	if err != nil {
		return pagePulled, 0, err
	}
	if !exists {
		if err = pag.write(adfPath); err != nil {
			return pagePulled, 0, err
		}
	}

	// Render the Markdown on every pull, even on a cache hit; a render failure
	// fails this page but leaves any cached ADF in place. The page's images are
	// downloaded first so the render can link them.
	doc, err := pag.doc()
	if err != nil {
		return pagePulled, 0, err
	}
	assets, err := downloadImages(ctx, client, cfg, pag.ID, dest, doc.FileMedia())
	if err != nil {
		return pagePulled, 0, err
	}
	md, err := doc.MarshallMarkdownLinks(assets, cfg.linkMapper(dest))
	if err != nil {
		return pagePulled, 0, err
	}
	mdCache := strings.TrimSuffix(adfPath, ".json") + ".md"
	wroteCache, err := writeFileIfChanged(mdCache, md, 0o644)
	if err != nil {
		return pagePulled, 0, err
	}
	wroteDest, err := writeFileIfChanged(dest, md, 0o644)
	if err != nil {
		return pagePulled, 0, err
	}

	switch {
	case !exists:
		return pagePulled, pag.Version, nil
	case wroteCache || wroteDest:
		return pageRerendered, pag.Version, nil
	default:
		return pageUnchanged, pag.Version, nil
	}
}

// pageResponse models the fields cfsync reads from the Confluence v2
// page-by-id response.
type pageResponse struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	SpaceID  string `json:"spaceId"`
	ParentID string `json:"parentId"`
	Version  struct {
		Number int `json:"number"`
	} `json:"version"`
	Body struct {
		AtlasDocFormat struct {
			Value string `json:"value"`
		} `json:"atlas_doc_format"`
	} `json:"body"`
}

// fetchPage requests the page identified by src from the Site using client and
// returns it tagged with the destination name. The src must be a single page
// URL; folder sources are rejected.
func fetchPage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	name string,
	src string,
) (*page, error) {

	id, err := pageID(src)
	if err != nil {
		return nil, err
	}
	return fetchPageByID(ctx, client, cfg, name, id)
}

// fetchPageByID requests the page with the numeric id from the Site using
// client and returns it tagged with the destination name. The request is
// bounded by the configured per-request timeout.
func fetchPageByID(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	name string,
	id string,
) (*page, error) {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	req, err := newPageRequest(ctx, cfg, id)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("requesting page %s: %w", id, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("page %s: HTTP %d", id, resp.StatusCode)
	}

	var pr pageResponse
	if err = json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return nil, fmt.Errorf("decoding page %s: %w", id, err)
	}

	adf := json.RawMessage(pr.Body.AtlasDocFormat.Value)
	if !json.Valid(adf) {
		return nil, fmt.Errorf("page %s: invalid ADF body", id)
	}

	return &page{
		Name:     name,
		ID:       pr.ID,
		Title:    pr.Title,
		Version:  pr.Version.Number,
		SpaceID:  pr.SpaceID,
		ParentID: pr.ParentID,
		ADF:      adf,
	}, nil
}

// newPageRequest builds the authenticated GET request for the page id, asking
// for the body in Atlassian Document Format.
func newPageRequest(
	ctx context.Context,
	cfg *config,
	id string,
) (*http.Request, error) {

	addr := cfg.Host + pageEndpoint + id + "?body-format=atlas_doc_format"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	return req, nil
}

// pageID extracts the numeric Confluence page id from a source path of the
// form ".../pages/{id}/...". The id may follow "pages" directly or after an
// action segment, as in the edit URL form ".../pages/edit-v2/{id}", so the
// first all-numeric segment after "pages" is taken. It returns an error when
// src is not a single page URL, which currently includes folder sources.
func pageID(src string) (string, error) {
	path := src
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}

	segs := strings.Split(strings.Trim(path, "/"), "/")
	for i := 0; i+1 < len(segs); i++ {
		if segs[i] != "pages" {
			continue
		}
		for _, seg := range segs[i+1:] {
			if isDigits(seg) {
				return seg, nil
			}
		}
	}

	format := "source %q is not a single page URL"
	return "", fmt.Errorf(format, src)
}

// pageName returns dest relative to workDir, falling back to dest when it
// cannot be made relative.
func pageName(workDir, dest string) string {
	name, err := filepath.Rel(workDir, dest)
	if err != nil {
		return dest
	}
	return name
}
