// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ctx42/cfsync/pkg/adf"
)

// linksFile is the link index written under the ADF cache directory. It maps
// the pulled pages between their Confluence identity and their local Markdown
// path, so a pull can rewrite cross-page links to local paths and a push can
// restore them.
const linksFile = "links.json"

// linkEntry records one pulled page for the link index: its Confluence id, its
// Markdown destination relative to the work directory (forward slashes), its
// canonical Confluence page URL, its title (used as the label when an
// inlineCard is rewritten into a link), and, for a page pulled through a space,
// that space's key (so a single-page re-pull can restore its space_key
// frontmatter without re-walking the space).
type linkEntry struct {
	ID       string `json:"id"`
	Dest     string `json:"dest"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	SpaceKey string `json:"space_key,omitempty"`
}

// linkIndex is the in-memory form of the link index: the entries keyed both by
// Confluence id (for rewriting a link on pull) and by absolute destination (for
// restoring it on push). WorkDir anchors the relative dests.
type linkIndex struct {
	workDir string
	byID    map[string]linkEntry
	byDest  map[string]linkEntry
}

// pageURL builds the canonical Confluence page URL for a page id in a space. A
// missing space still yields an id-addressable path, which Confluence resolves.
func pageURL(space, id string) string {
	if space == "" {
		return "/wiki/pages/viewpage.action?pageId=" + id
	}
	return "/wiki/spaces/" + space + "/pages/" + id
}

// buildLinkIndex assembles the link index for a pull from the configured pages
// and the discovered folder and space pages. A configured page whose source is
// not a page URL (a folder, or malformed) contributes nothing.
func buildLinkIndex(cfg *config, discovered []folderPage) *linkIndex {
	idx := &linkIndex{
		workDir: cfg.WorkDir,
		byID:    make(map[string]linkEntry),
		byDest:  make(map[string]linkEntry),
	}
	for dest, src := range cfg.Pages {
		id, err := pageID(src)
		if err != nil {
			continue
		}
		idx.add(linkEntry{
			ID:   id,
			Dest: filepath.ToSlash(pageName(cfg.WorkDir, dest)),
			URL:  src,
		})
	}
	for _, pag := range discovered {
		idx.add(linkEntry{
			ID:       pag.ID,
			Dest:     filepath.ToSlash(pageName(cfg.WorkDir, pag.Dest)),
			URL:      pag.URL,
			Title:    pag.Title,
			SpaceKey: pag.SpaceKey,
		})
	}
	return idx
}

// add indexes one entry by both id and absolute destination.
func (idx *linkIndex) add(ent linkEntry) {
	idx.byID[ent.ID] = ent
	abs := filepath.Join(idx.workDir, filepath.FromSlash(ent.Dest))
	idx.byDest[abs] = ent
}

// entries returns the index entries sorted by destination, for a stable file.
func (idx *linkIndex) entries() []linkEntry {
	out := make([]linkEntry, 0, len(idx.byID))
	for _, ent := range idx.byID {
		out = append(out, ent)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Dest < out[j].Dest })
	return out
}

// write persists the index to linksFile under the ADF cache directory. An empty
// index writes nothing: there are no pages to link between.
func (idx *linkIndex) write() error {
	entries := idx.entries()
	if len(entries) == 0 {
		return nil
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding links: %w", err)
	}
	path := filepath.Join(idx.workDir, adfCacheDir, linksFile)
	return writeFile(path, append(data, '\n'), 0o600)
}

// loadLinkIndex reads the link index written by the last pull. It returns nil
// when the file does not exist, so a push before any pull simply skips link
// restoration.
func loadLinkIndex(cfg *config) (*linkIndex, error) {
	path := filepath.Join(cfg.WorkDir, adfCacheDir, linksFile)
	data, err := os.ReadFile(path) //nolint:gosec // path is config-derived.
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading links: %w", err)
	}

	var entries []linkEntry
	if err = json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("parsing links: %w", err)
	}
	idx := &linkIndex{
		workDir: cfg.WorkDir,
		byID:    make(map[string]linkEntry, len(entries)),
		byDest:  make(map[string]linkEntry, len(entries)),
	}
	for _, ent := range entries {
		idx.add(ent)
	}
	return idx, nil
}

// linkMapper returns the [adf.Links] that rewrites links for the document at
// the absolute path dest, or nil when no link index is loaded (link rewriting
// off).
func (cfg *config) linkMapper(dest string) adf.Links {
	if cfg.links == nil {
		return nil
	}
	return &docLinks{
		idx:  cfg.links,
		dir:  filepath.Dir(dest),
		host: cfg.hostName(),
		site: strings.TrimSuffix(cfg.Host, "/"),
	}
}

// hostName is the host of the configured Site URL, used to recognize a link
// that points at this Site. It is "" when the host cannot be parsed.
func (cfg *config) hostName() string {
	u, err := url.Parse(cfg.Host)
	if err != nil {
		return ""
	}
	return u.Host
}

// docLinks implements [adf.Links] for one document at dir: it maps a Confluence
// page link to a work-dir-relative Markdown path and back, using the shared
// index. host scopes the match to this Site.
type docLinks struct {
	idx  *linkIndex
	dir  string
	host string // bare host, to recognize a link pointing at this Site
	site string // Site base URL, to absolutize a page href on push
}

// ToLocal maps a Confluence page href to the Markdown path of that page
// relative to this document, preserving any #fragment. The label is the target
// page's title, falling back to its file name, for an inlineCard rewrite.
func (dnk *docLinks) ToLocal(href string) (string, string, bool) {
	id, frag, ok := dnk.pageRef(href)
	if !ok {
		return "", "", false
	}
	ent, ok := dnk.idx.byID[id]
	if !ok {
		return "", "", false
	}
	abs := filepath.Join(dnk.idx.workDir, filepath.FromSlash(ent.Dest))
	rel, err := filepath.Rel(dnk.dir, abs)
	if err != nil {
		return "", "", false
	}
	target := filepath.ToSlash(rel)
	if frag != "" {
		target += "#" + frag
	}
	label := ent.Title
	if label == "" {
		label = strings.TrimSuffix(filepath.Base(ent.Dest), ".md")
	}
	return target, label, true
}

// ToRemote maps a work-dir-relative Markdown link back to the absolute
// Confluence URL of the page it names, preserving any #fragment. A target that
// is not a local path to an indexed page is left unchanged.
func (dnk *docLinks) ToRemote(target string) (string, bool) {
	path, frag, _ := strings.Cut(target, "#")
	if path == "" || strings.Contains(path, "://") {
		return "", false
	}
	abs := filepath.Join(dnk.dir, filepath.FromSlash(path))
	ent, ok := dnk.idx.byDest[abs]
	if !ok {
		return "", false
	}
	href := dnk.pageHref(ent)
	if frag != "" {
		href += "#" + frag
	}
	return href, true
}

// pageHref builds the absolute Confluence URL of an indexed page, matching the
// form Confluence stores in a link mark: the Site host, the page path, and the
// title slug. A discovered page's indexed URL has no slug, so it is appended
// from the title, url.QueryEscape mirroring Confluence's "+"-for-space slug; a
// configured page carries no title, so its URL — whose slug, if any, came from
// config — is used as-is. A host-relative URL is resolved against the Site,
// which an unset Site leaves relative. This inverts [docLinks.ToLocal], whose
// host- and slug-dropping is restored here.
func (dnk *docLinks) pageHref(ent linkEntry) string {
	href := ent.URL
	if ent.Title != "" {
		href += "/" + url.QueryEscape(ent.Title)
	}
	if dnk.site != "" && strings.HasPrefix(href, "/") {
		href = dnk.site + href
	}
	return href
}

// pageRef extracts the Confluence page id and fragment from an href that points
// at a page on this Site. It reports false for an href on another host or one
// that names no page. Both the path form (.../pages/{id}/...) and the query
// form (viewpage.action?pageId={id}) are accepted.
func (dnk *docLinks) pageRef(href string) (id, frag string, ok bool) {
	u, err := url.Parse(href)
	if err != nil {
		return "", "", false
	}
	if u.Host != "" && u.Host != dnk.host {
		return "", "", false
	}
	id, err = pageID(u.Path)
	if err == nil {
		return id, u.Fragment, true
	}
	// pageURL emits viewpage.action?pageId= when the space key is unknown.
	if q := u.Query().Get("pageId"); isDigits(q) {
		return q, u.Fragment, true
	}
	return "", "", false
}
