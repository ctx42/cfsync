// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/goccy/go-yaml"

	"github.com/ctx42/cfsync/pkg/adf"
	"github.com/ctx42/ring/pkg/ring"
)

// pushVersionMessage is the version comment attached to a pushed page.
const pushVersionMessage = "Updated by cfsync"

// push loads the configuration from the path and pushes configured pages whose
// local Markdown has been edited. When selected is empty, every edited page is
// pushed; otherwise selected names the single page to push, as a work-dir
// relative or absolute path to its Markdown file. Destinations are the
// configured Pages plus every Markdown file under Folders and Spaces roots. A
// new Markdown file under a folder or space root — one with a title and space
// but no page id — is created in Confluence after the user confirms it; yes
// skips that confirmation. It returns the progress output to print and any
// error.
func push(
	ctx context.Context,
	rng *ring.Ring,
	path string,
	selected string,
	yes bool,
) (string, error) {

	cfg, err := loadConfig(rng, path)
	if err != nil {
		return "", err
	}
	if cfg.links, err = loadLinkIndex(cfg); err != nil {
		return "", err
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg.report = newReporter(rng, "pushing", cancel)
	defer cfg.report.finish()

	return pushManaged(ctx, rng, http.DefaultClient, cfg, selected, yes)
}

// pushManaged pushes every managed Markdown file in cfg: the configured Pages
// keys and the files under Folders and Spaces roots (see [managedPushDests]).
// When selected is empty every edited page is pushed; otherwise selected must
// resolve to one of those destinations, and selecting a file marked cf_local
// is refused. Creates under roots are planned when present. It returns the
// per-page progress output and, when any page failed, a joined error naming
// each failure.
func pushManaged(
	ctx context.Context,
	rng *ring.Ring,
	client *http.Client,
	cfg *config,
	selected string,
	yes bool,
) (string, error) {

	dests := managedPushDests(cfg)
	if selected != "" {
		sel := resolvePagePath(cfg.WorkDir, selected)
		if destIsLocal(sel) {
			return "", fmt.Errorf("marked local: %s", selected)
		}
		if !slices.Contains(dests, sel) {
			return "", fmt.Errorf("not a managed page: %s", selected)
		}
		dests = []string{sel}
	} else if len(dests) == 0 {
		return "cfsync: no pages to push\n", nil
	}

	plan, err := planCreates(ctx, rng, client, cfg, dests, yes)
	if err != nil {
		return "", err
	}

	dir := filepath.Join(cfg.WorkDir, adfCacheDir)
	return pushDests(ctx, client, cfg, dir, dests, plan)
}

// managedPushDests returns the Markdown files push considers for cfg: each
// Pages key plus every pushable file under Folders and Spaces roots (see
// [pushableFiles]), unique and sorted. A root not yet pulled contributes
// nothing. Configured Pages keys are always included so a broken page is
// reported rather than skipped, except one marked cf_local, which is
// dropped silently, the same as a root file with the marker.
func managedPushDests(cfg *config) []string {
	seen := make(map[string]struct{}, len(cfg.Pages))
	dests := make([]string, 0, len(cfg.Pages))
	for dest := range cfg.Pages {
		if destIsLocal(dest) {
			continue
		}
		seen[dest] = struct{}{}
		dests = append(dests, dest)
	}
	for _, dest := range pushableFiles(managedPageFiles(cfg)) {
		if _, ok := seen[dest]; ok {
			continue
		}
		seen[dest] = struct{}{}
		dests = append(dests, dest)
	}
	sort.Strings(dests)
	return dests
}

// pushPages pushes edited pages in cfg back to the Site using client. When
// selected is empty every edited page is pushed; otherwise selected names the
// single page to push and must resolve to a configured page, else the run is
// refused. Pages are processed in a stable order; a page that fails or is
// refused does not stop the run. It returns the per-page progress output and,
// when any page failed, a joined error naming each failure.
func pushPages(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	selected string,
) (string, error) {

	dests := make([]string, 0, len(cfg.Pages))
	for dest := range cfg.Pages {
		dests = append(dests, dest)
	}
	sort.Strings(dests)

	if selected != "" {
		dest := resolvePagePath(cfg.WorkDir, selected)
		if _, ok := cfg.Pages[dest]; !ok {
			return "", fmt.Errorf("not a configured page: %s", selected)
		}
		dests = []string{dest}
	} else if len(dests) == 0 {
		return "cfsync: no pages to push\n", nil
	}

	dir := filepath.Join(cfg.WorkDir, adfCacheDir)
	return pushDests(ctx, client, cfg, dir, dests, nil)
}

// pushSpaces pushes edited Markdown under every configured folder and space
// root back to the Site using client. Pages under those roots are discovered on
// pull, not listed in the config, so push walks the on-disk roots for Markdown
// files. When selected is empty every edited page is pushed; otherwise selected
// names the single file to push and must resolve to a Markdown file under a
// root, else the run is refused. Files are processed in a stable order; one
// that fails does not stop the run. It returns the per-page progress output and,
// when any page failed, a joined error naming each failure.
//
// Prefer [pushManaged] when Pages may also be present: pushSpaces only walks
// Folders and Spaces roots.
func pushSpaces(
	ctx context.Context,
	rng *ring.Ring,
	client *http.Client,
	cfg *config,
	selected string,
	yes bool,
) (string, error) {

	roots := make([]string, 0, len(cfg.Spaces)+len(cfg.Folders))
	for root := range cfg.Spaces {
		roots = append(roots, root)
	}
	for root := range cfg.Folders {
		roots = append(roots, root)
	}
	dests := pushableFiles(mdFilesUnder(roots))

	if selected != "" {
		sel := resolvePagePath(cfg.WorkDir, selected)
		if !slices.Contains(dests, sel) {
			return "", fmt.Errorf("not a managed page: %s", selected)
		}
		dests = []string{sel}
	} else if len(dests) == 0 {
		return "cfsync: no pages to push\n", nil
	}

	plan, err := planCreates(ctx, rng, client, cfg, dests, yes)
	if err != nil {
		return "", err
	}

	dir := filepath.Join(cfg.WorkDir, adfCacheDir)
	return pushDests(ctx, client, cfg, dir, dests, plan)
}

// planCreates decides which new pages among dests to create this run. It finds
// the create candidates under the Folders and Spaces roots, deriving each one's
// space and parent from disk (see [classifyCreates]), confirms them with the
// user (see confirmCreates), and, when any is confirmed, resolves the author
// account created pages are restricted to. A candidate whose space or parent
// cannot be derived is recorded in the plan as a refusal, so [pushDests]
// reports it without a request. It returns a nil plan when no dest is a
// candidate or a refusal, so an all-updates run does no extra work.
func planCreates(
	ctx context.Context,
	rng *ring.Ring,
	client *http.Client,
	cfg *config,
	dests []string,
	yes bool,
) (*createPlan, error) {

	roots := make([]string, 0, len(cfg.Folders)+len(cfg.Spaces))
	for root := range cfg.Folders {
		roots = append(roots, root)
	}
	for root := range cfg.Spaces {
		roots = append(roots, root)
	}
	cands, refusals := classifyCreates(dests, roots)
	if len(cands) == 0 && len(refusals) == 0 {
		return nil, nil
	}
	decided, err := confirmCreates(rng, cfg.WorkDir, cands, yes)
	if err != nil {
		return nil, err
	}

	inputs := make(map[string]createInput, len(cands))
	for _, cnd := range cands {
		inputs[cnd.Dest] = cnd
	}
	plan := &createPlan{decided: decided, refused: refusals, inputs: inputs}
	for _, create := range decided {
		if create {
			account, err := currentAccountID(ctx, client, cfg)
			if err != nil {
				return nil, err
			}
			plan.accountID = account
			break
		}
	}
	return plan, nil
}

// pushDests pushes each Markdown file in dests in order, caching baselines under
// dir, using client. A dest the plan marks as a confirmed create is created and
// restricted rather than updated; one it marks as skipped is left untouched.
// A file that fails or is refused does not stop the run. It returns the per-page
// progress output and, when any file failed, a joined error naming each failure.
// dests must be non-empty; an empty run reports "no pages to push" from the
// caller instead.
func pushDests(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	dir string,
	dests []string,
	plan *createPlan,
) (string, error) {

	cfg.reporter().discovered(len(dests))

	// folderIDs tracks folders created this run so pages sharing a new ancestor
	// directory create it once (see [ensureFolders]).
	folderIDs := map[string]string{}
	var out strings.Builder
	var errs []error
	var pushed int
	for _, dest := range dests {
		if ctx.Err() != nil {
			break
		}
		name := pageName(cfg.WorkDir, dest)
		cfg.reporter().item(name)

		if err := plan.refusal(dest); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", name, err))
			continue
		}
		if create, isCand := plan.wants(dest); isCand {
			if !create {
				line := fmt.Sprintf("creating %s ... skipped\n", name)
				out.WriteString(line)
				cfg.reporter().log(line)
				continue
			}
			ver, reused, err := pushCreate(
				ctx, client, cfg, dir, plan.inputs[dest], plan.accountID,
				folderIDs)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", name, err))
				continue
			}
			pushed++
			var b strings.Builder
			_, _ = fmt.Fprintf(&b, "creating %s ... ok (v%d)\n", name, ver)
			// The create summary listed missing folders as new, planned from
			// disk before any lookup; report the ones that already existed and
			// were reused so the record matches what happened on the Site.
			for _, title := range reused {
				_, _ = fmt.Fprintf(&b, "      reused existing folder %q\n", title)
			}
			line := b.String()
			out.WriteString(line)
			cfg.reporter().log(line)
			continue
		}

		changed, ver, err := pushOne(ctx, client, cfg, dir, dest)
		switch {
		case err != nil:
			errs = append(errs, fmt.Errorf("%s: %w", name, err))
		case changed:
			pushed++
			line := fmt.Sprintf("pushing %s ... ok (v%d)\n", name, ver)
			out.WriteString(line)
			cfg.reporter().log(line)
		default:
			line := fmt.Sprintf("pushing %s ... no changes\n", name)
			out.WriteString(line)
			cfg.reporter().log(line)
		}
	}

	if ctx.Err() != nil {
		format := "cfsync: canceled — %d of %d pages pushed\n"
		summary := fmt.Sprintf(format, pushed, len(dests))
		return cfg.stdoutText(out.String(), summary), context.Canceled
	}
	if len(errs) > 0 {
		joined := errors.Join(errs...)
		format := "%d of %d pages failed:\n%w"
		err := fmt.Errorf(format, len(errs), len(dests), joined)
		return cfg.stdoutText(out.String(), ""), err
	}
	format := "cfsync: %d of %d pages pushed\n"
	summary := fmt.Sprintf(format, pushed, len(dests))
	return cfg.stdoutText(out.String(), summary), nil
}

// pushOne back-ports the edits in the Markdown at dest and, when they change
// the page, PUTs the new document to the Site. It reads the page identity and
// base version from the file frontmatter, reconstructs the new ADF from the
// cached baseline of that version (see [adf.ADF.Put]), refuses a push whose
// remote version has moved, and on success refreshes the cache and the
// rendered Markdown. It returns whether the page was changed (and thus pushed)
// and the resulting version.
func pushOne(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	dir string,
	dest string,
) (changed bool, ver int, err error) {

	meta, body, base, err := loadPushInput(cfg, dir, dest)
	if err != nil {
		return false, 0, err
	}
	name := pageName(cfg.WorkDir, dest)

	// Upload any user-added local images first, so the lens can splice them in
	// as media nodes; each is recorded in assets for the refreshed frontmatter,
	// so the map must be writable even when the page had no images before.
	assets := meta.writableAssets()
	images, uploaded, err := uploadNewImages(
		ctx, client, cfg, meta.PageID, dest, body, assets)
	if err != nil {
		deleteAttachments(client, cfg, uploaded)
		return false, 0, err
	}
	// Until the page is pushed, any attachment already uploaded is an orphan on
	// failure; delete it so a rejected push leaves nothing behind. Once the PUT
	// succeeds, uploaded is cleared, so a later refresh error never deletes an
	// attachment the pushed page now depends on.
	defer func() {
		if err != nil {
			deleteAttachments(client, cfg, uploaded)
		}
	}()

	links := cfg.linkMapper(dest)
	next, err := base.PutLinks(body, meta.Mentions, assets, images, links)
	if err != nil {
		return false, 0, err
	}

	docJSON, err := json.Marshal(next.Doc)
	if err != nil {
		return false, 0, fmt.Errorf("encoding new ADF: %w", err)
	}
	bodyChanged := !bytes.Equal(docJSON, canonicalDoc(base))
	titleChanged := meta.Title != base.Title
	if !bodyChanged && !titleChanged {
		return false, meta.PageVersion, nil // no changes to push
	}

	docJSON, newVer, err := pushDoc(
		ctx, client, cfg, name, meta, base, body, assets, images, links, docJSON)
	if err != nil {
		return false, 0, err
	}

	if err = putPage(ctx, client, cfg, meta, docJSON, newVer); err != nil {
		return false, 0, err
	}
	// The page is now live, so its attachments must survive; a later refresh
	// error is a local-only divergence, not cause to delete them.
	pushedImages := uploaded
	uploaded = nil

	// Move each pushed image into the shared assets directory under its
	// canonical name and repoint assets at it, so the refreshed Markdown matches
	// a fresh pull and the next pull reuses the file instead of re-downloading.
	err = canonicalizeImages(pushedImages, dest, cfg.WorkDir, assets)
	if err != nil {
		return false, 0, err
	}

	err = refreshAfterPush(dir, dest, name, meta, docJSON, newVer, assets, links)
	if err != nil {
		return false, 0, err
	}
	return true, newVer, nil
}

// loadPushInput reads the edited Markdown at dest, splits its frontmatter, and
// loads the cached baseline ADF of the version the frontmatter records. It
// fails when the frontmatter lacks the page id or version needed to push.
func loadPushInput(
	cfg *config,
	dir string,
	dest string,
) (*mdMeta, string, *adf.ADF, error) {

	edited, err := os.ReadFile(dest) //nolint:gosec // dest is config-derived.
	if err != nil {
		return nil, "", nil, fmt.Errorf("reading %s: %w", dest, err)
	}
	meta, body, err := splitFrontmatter(edited)
	if err != nil {
		return nil, "", nil, err
	}
	if meta.PageID == "" || meta.PageVersion == 0 {
		return nil, "", nil, errors.New("frontmatter lacks page_id or page_version")
	}
	base, err := readCache(dir, pageName(cfg.WorkDir, dest), meta.PageVersion)
	if err != nil {
		return nil, "", nil, err
	}
	return meta, body, base, nil
}

// pushDoc fetches the live page and returns the document JSON and version to
// PUT. When the remote still matches the file's base version it pushes docJSON
// at the next version; when it has moved on it rebases the edits onto the live
// document with a block-level three-way merge (see mergeOntoLive), which
// refuses a block edited on both sides as a re-pull always could.
func pushDoc(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	name string,
	meta *mdMeta,
	base *adf.ADF,
	body string,
	assets map[string]string,
	images []adf.NewImage,
	links adf.Links,
	docJSON []byte,
) ([]byte, int, error) {

	live, err := fetchPageByID(ctx, client, cfg, name, meta.PageID)
	if err != nil {
		return nil, 0, err
	}
	if live.Version == meta.PageVersion {
		return docJSON, meta.PageVersion + 1, nil
	}
	liveDoc, err := live.doc()
	if err != nil {
		return nil, 0, err
	}
	return mergeOntoLive(base, liveDoc, meta, body, assets, images, links)
}

// mergeOntoLive rebases the local edits onto the live remote version after the
// two diverged. It three-way merges the edited body against the live document
// over the cached common baseline (see [adf.ADF.Merge3]), reconstructs the
// merged ADF with the lens — so both lens laws still gate the result — and
// returns the encoded document and the version to push (live's plus one). A
// block, or the title, edited on both sides is a conflict, returned as the same
// version-naming refusal a re-pull would prompt. When only the remote changed
// the title, meta adopts it so the push does not revert it.
func mergeOntoLive(
	base, live *adf.ADF,
	meta *mdMeta,
	body string,
	assets map[string]string,
	images []adf.NewImage,
	links adf.Links,
) ([]byte, int, error) {

	conflict := func(err error) ([]byte, int, error) {
		return nil, 0, fmt.Errorf(
			"conflict: local base v%d but remote is v%d; re-pull first: %w",
			meta.PageVersion, live.Version, err)
	}

	switch {
	case meta.Title != base.Title && live.Title != base.Title &&
		meta.Title != live.Title:
		return conflict(fmt.Errorf("title changed both sides (local %q, "+
			"remote %q)", meta.Title, live.Title))
	case meta.Title == base.Title:
		meta.Title = live.Title // only the remote changed it; adopt it
	}

	merged, err := base.Merge3Links(live, body, assets, links)
	if err != nil {
		return conflict(err)
	}
	next, err := live.PutLinks(merged, meta.Mentions, assets, images, links)
	if err != nil {
		return conflict(err)
	}
	docJSON, err := json.Marshal(next.Doc)
	if err != nil {
		return nil, 0, fmt.Errorf("encoding merged ADF: %w", err)
	}
	return docJSON, live.Version + 1, nil
}

// putPage sends the authenticated update request for the page and verifies the
// Site accepted it.
func putPage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	meta *mdMeta,
	docJSON []byte,
	version int,
) error {

	payload := pushPayload{
		ID:      meta.PageID,
		Status:  "current",
		Title:   meta.Title,
		Version: pushVersion{Number: version, Message: pushVersionMessage},
		Body: pushBody{
			Representation: "atlas_doc_format",
			Value:          string(docJSON),
		},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encoding push payload: %w", err)
	}

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + pageEndpoint + meta.PageID
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPut, addr, bytes.NewReader(data),
	)
	if err != nil {
		return fmt.Errorf("building push request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("pushing page %s: %w", meta.PageID, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("push page %s: HTTP %d", meta.PageID, resp.StatusCode)
	}
	return nil
}

// refreshAfterPush rewrites the ADF cache and the rendered Markdown for the new
// version, so the local state matches what was pushed and the next push has a
// correct baseline.
func refreshAfterPush(
	dir string,
	dest string,
	name string,
	meta *mdMeta,
	docJSON []byte,
	version int,
	assets map[string]string,
	links adf.Links,
) error {

	p := &page{
		Name:     name,
		ID:       meta.PageID,
		Title:    meta.Title,
		Version:  version,
		SpaceID:  meta.SpaceID,
		SpaceKey: meta.SpaceKey,
		ParentID: meta.ParentID,
		Domain:   meta.Domain,
		ADF:      json.RawMessage(docJSON),
	}
	adfPath := filepath.Join(dir, p.cacheFile())
	if err := p.write(adfPath); err != nil {
		return err
	}

	doc, err := p.doc()
	if err != nil {
		return err
	}
	md, err := doc.MarshallMarkdownLinks(assets, links)
	if err != nil {
		return err
	}
	mdCache := strings.TrimSuffix(adfPath, ".json") + ".md"
	if err := writeFile(mdCache, md, 0o644); err != nil {
		return err
	}
	return writeFile(dest, md, 0o644)
}

// resolvePagePath resolves a user-supplied page path to the absolute, cleaned
// form used as a key in the configured Pages map. A relative path anchors to
// workDir, matching how the configuration resolves its own page keys, so the
// path a user types is looked up the same way it was stored.
func resolvePagePath(workDir, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(workDir, path)
}

// readCache reads and parses the cached ADF wrapper for name at version from
// the cache directory dir.
func readCache(dir, name string, version int) (*adf.ADF, error) {
	base := strings.TrimSuffix(name, ".md")
	path := filepath.Join(dir, fmt.Sprintf("%s.v%d.json", base, version))
	data, err := os.ReadFile(path) //nolint:gosec // path is config-derived.
	if err != nil {
		return nil, fmt.Errorf("reading cached baseline v%d: %w", version, err)
	}
	return adf.NewADF(data)
}

// canonicalDoc returns the canonical JSON of a document's ADF body, for the
// no-change comparison. A marshal error is impossible for a document parsed
// from JSON, so it is dropped.
func canonicalDoc(a *adf.ADF) []byte {
	data, _ := json.Marshal(a.Doc)
	return data
}

// pushPayload is the Confluence v2 page-update request body.
type pushPayload struct {
	ID      string      `json:"id"`
	Status  string      `json:"status"`
	Title   string      `json:"title"`
	Version pushVersion `json:"version"`
	Body    pushBody    `json:"body"`
}

type pushVersion struct {
	Number  int    `json:"number"`
	Message string `json:"message,omitempty"`
}

type pushBody struct {
	Representation string `json:"representation"`
	Value          string `json:"value"`
}

// mdMeta is the frontmatter cfsync reads from an edited Markdown file to push
// it.
type mdMeta struct {
	Title       string            `yaml:"title"`
	PageID      string            `yaml:"page_id"`
	PageVersion int               `yaml:"page_version"`
	SpaceID     string            `yaml:"space_id"`
	SpaceKey    string            `yaml:"space_key"`
	ParentID    string            `yaml:"parent_id"`
	Domain      string            `yaml:"cf_domain"`
	Local       bool              `yaml:"cf_local"`
	Mentions    map[string]string `yaml:"mentions"`
	PageImages  []struct {
		LocalID string `yaml:"local_id"`
		File    string `yaml:"file"`
		Alt     string `yaml:"alt"`
	} `yaml:"page_images"`
}

// assets rebuilds the localId→image-path map from the page_images frontmatter,
// so the baseline render on push matches the render on pull.
func (mta *mdMeta) assets() map[string]string {
	if len(mta.PageImages) == 0 {
		return nil
	}
	out := make(map[string]string, len(mta.PageImages))
	for _, img := range mta.PageImages {
		out[img.LocalID] = img.File
	}
	return out
}

// writableAssets returns the page's asset map, never nil, so a newly uploaded
// image can be recorded even when the page had none before.
func (mta *mdMeta) writableAssets() map[string]string {
	if out := mta.assets(); out != nil {
		return out
	}
	return map[string]string{}
}

// splitFrontmatter separates the YAML frontmatter of an edited Markdown file
// from its body, returning the parsed metadata and the body with the
// frontmatter and surrounding blank lines removed.
func splitFrontmatter(md []byte) (*mdMeta, string, error) {
	s := string(md)
	if !strings.HasPrefix(s, "---\n") {
		return nil, "", errors.New("file has no frontmatter")
	}
	rest := s[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return nil, "", errors.New("file has unterminated frontmatter")
	}
	front := rest[:end+1]
	body := strings.Trim(rest[end+len("\n---"):], "\n")

	var meta mdMeta
	if err := yaml.Unmarshal([]byte(front), &meta); err != nil {
		return nil, "", fmt.Errorf("parsing frontmatter: %w", err)
	}
	return &meta, body, nil
}

// spaceKey extracts the space key from a page source URL of the form
// ".../spaces/{KEY}/pages/...". It returns "" when no space segment is present.
func spaceKey(src string) string {
	segs := strings.Split(src, "/")
	for i := 0; i+1 < len(segs); i++ {
		if segs[i] == "spaces" {
			return segs[i+1]
		}
	}
	return ""
}
