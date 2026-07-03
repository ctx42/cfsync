// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/goccy/go-yaml"

	"github.com/ctx42/cfsync/pkg/adf"
	"github.com/ctx42/ring/pkg/ring"
)

// Confluence endpoints used to create a page and restrict who may see it.
const (
	// createPageEndpoint is the Confluence v2 path that creates a page. It is
	// [pageEndpoint] without the trailing id, as a POST rather than a GET.
	createPageEndpoint = "/wiki/api/v2/pages"

	// restrictionEndpoint is the Confluence v1 path whose PUT replaces a page's
	// content restrictions; the v2 API has no restriction resource. The single
	// verb formats in the numeric page id.
	restrictionEndpoint = "/wiki/rest/api/content/%s/restriction"
)

// createInput is a new page discovered on disk: a Markdown file whose
// frontmatter names a title but carries no page id, so it has no Confluence
// counterpart yet. classifyCreates fills it, deriving the space and parent from
// disk for a file under a managed root; the fields drive the up-front summary
// shown before confirmation.
type createInput struct {
	// Dest is the absolute path of the Markdown file to create the page from.
	Dest string

	// Title is the page title from the frontmatter.
	Title string

	// SpaceID is the numeric id of the space to create the page in.
	SpaceID string

	// ParentID is the numeric id of the parent page, empty for a space root.
	ParentID string

	// Folders are the ancestor directories, top-down, whose Confluence folders
	// must be created before the page; empty when every ancestor already
	// exists. ParentID is then the parent of the shallowest folder, and the page
	// attaches under the deepest.
	Folders []folderPlan
}

// folderPlan is one missing Confluence folder a create depends on: the local
// directory it represents and the de-slugged title to create it under. The
// directory doubles as the run-scoped dedupe key, so two pages sharing an
// ancestor create it once.
type folderPlan struct {
	// Dir is the absolute directory the folder mirrors.
	Dir string

	// Title is the folder's Confluence title, de-slugged from the directory
	// name so a later pull derives the same directory back.
	Title string
}

// createPlan records, for one push run, which discovered new pages the user
// confirmed and the author account created pages are restricted to. A nil plan
// means the run creates nothing; a dest absent from decided is an existing page
// pushed as an update, not a create.
type createPlan struct {
	// decided maps each create candidate's dest to whether to create it.
	decided map[string]bool

	// refused maps each dest whose space or parent could not be derived to the
	// reason, so the push reports it rather than creating or skipping it.
	refused map[string]error

	// inputs maps each candidate's dest to its resolved identity, carrying the
	// space and parent derived during planning through to the create.
	inputs map[string]createInput

	// accountID is the author every created page is restricted to. It is empty
	// when no candidate was confirmed, as no create then runs.
	accountID string
}

// wants reports whether the plan creates the page at dest, false for a skipped
// candidate or an update. A nil plan never creates.
func (pln *createPlan) wants(dest string) (create, isCand bool) {
	if pln == nil {
		return false, false
	}
	create, isCand = pln.decided[dest]
	return create, isCand
}

// refusal returns why the create at dest was refused during planning, nil when
// it was not refused. A nil plan refuses nothing.
func (pln *createPlan) refusal(dest string) error {
	if pln == nil {
		return nil
	}
	return pln.refused[dest]
}

// classifyCreates scans dests and splits the new pages to create from the
// rest, resolving each root create's space and parent from disk. A titled,
// id-less file under one of the roots needs only that title: its space_id and
// parent_id are derived by [deriveCreateFields], and one that cannot be
// resolved is returned in the refusals map keyed by its dest, so the push
// reports it instead of silently skipping it. A titled file outside every root
// is a Pages-mapped page that keeps the explicit requirement: it is a candidate
// only when its frontmatter also names a space, with no derivation. A file with
// a page id is an existing page; one with no frontmatter, no title, or that is
// unreadable is left to the update path, which reports the missing id.
func classifyCreates(
	dests []string,
	roots []string,
) ([]createInput, map[string]error) {

	var cands []createInput
	var refusals map[string]error
	for _, dest := range dests {
		data, err := os.ReadFile(dest) //nolint:gosec // dest is config-derived.
		if err != nil {
			continue
		}
		meta, _, err := splitFrontmatter(data)
		switch {
		case err != nil, meta.PageID != "", meta.Title == "":
			continue
		}

		if underAnyRoot(dest, roots) && filepath.Base(dest) == indexFile {
			// A title-only _index.md backs its own directory; creating a
			// page-backed directory is not supported yet, so refuse rather
			// than treating it as an ordinary child create.
			if refusals == nil {
				refusals = make(map[string]error)
			}
			refusals[dest] = errors.New(
				"page-backed directory index; creating one is unsupported")
			continue
		}

		if !underAnyRoot(dest, roots) {
			if meta.SpaceID == "" {
				continue // Pages-mapped file: explicit space required.
			}
			cands = append(cands, createInput{
				Dest:     dest,
				Title:    meta.Title,
				SpaceID:  meta.SpaceID,
				ParentID: meta.ParentID,
			})
			continue
		}

		parent, space, folders, err := placeUnderRoot(
			dest, meta.ParentID, meta.SpaceID, rootOf(dest, roots))
		if err != nil {
			if refusals == nil {
				refusals = make(map[string]error)
			}
			refusals[dest] = err
			continue
		}
		cands = append(cands, createInput{
			Dest:     dest,
			Title:    meta.Title,
			SpaceID:  space,
			ParentID: parent,
			Folders:  folders,
		})
	}
	return cands, refusals
}

// deriveCreateFields resolves the space and parent for a root create candidate
// at dest, disk-only, so the value is known before any prompt or request. For
// each field independently the first source wins: the explicit frontmatter
// value, else the same-directory _index.md (its page id is the parent, its
// space the space), else the stamped values of the sibling pages, which must
// all agree. When neither field can be resolved it refuses naming both fixes,
// and a field whose siblings disagree refuses naming them (see
// [resolveCreateField]), so the caller reports the file rather than creating it
// in the wrong place.
func deriveCreateFields(
	dest string,
	explicitParent string,
	explicitSpace string,
) (parent, space string, err error) {

	if explicitParent != "" && explicitSpace != "" {
		return explicitParent, explicitSpace, nil
	}
	return deriveDirPlacement(
		filepath.Dir(dest), dest, dest, explicitParent, explicitSpace)
}

// deriveDirPlacement resolves the parent and space a page inherits from dir —
// its own directory or an anchored ancestor of it. self is the candidate file
// excluded from the sibling scan, empty at ancestor levels; dest names the
// file in derivation errors. For each field the first source wins: the explicit
// value, else dir's _index.md, else the stamped siblings, which must agree (see
// [resolveCreateField]).
func deriveDirPlacement(
	dir string,
	self string,
	dest string,
	explicitParent string,
	explicitSpace string,
) (parent, space string, err error) {

	index, sibs := readDirMetas(dir, self)
	var indexParent, indexSpace string
	if index != nil {
		indexParent = index.PageID
		indexSpace = index.SpaceID
	}
	sibParents := make(map[string]string, len(sibs))
	sibSpaces := make(map[string]string, len(sibs))
	for path, meta := range sibs {
		base := filepath.Base(path)
		if meta.ParentID != "" {
			sibParents[base] = meta.ParentID
		}
		if meta.SpaceID != "" {
			sibSpaces[base] = meta.SpaceID
		}
	}

	var errs []error
	parent, err = resolveCreateField(
		"parent_id", dest, explicitParent, indexParent, sibParents)
	if err != nil {
		errs = append(errs, err)
	}
	space, err = resolveCreateField(
		"space_id", dest, explicitSpace, indexSpace, sibSpaces)
	if err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return "", "", errors.Join(errs...)
	}
	return parent, space, nil
}

// placeUnderRoot resolves where a create candidate at dest lands under the
// managed root, and the ancestor folders that must be created first. When the
// candidate's own directory anchors it — an explicit parent, an _index.md, or
// stamped siblings — no folder is missing and the result mirrors
// [deriveCreateFields]. Otherwise it walks up toward root: each directory
// lacking an anchor becomes a missing folder, returned top-down, and the
// nearest anchored ancestor supplies the parent the shallowest folder attaches
// to. A folder whose de-slugged title does not slug back to the directory name
// is refused, since the next pull would then diverge onto a sibling directory.
// With no anchored ancestor up to root it refuses exactly as
// [deriveCreateFields].
func placeUnderRoot(
	dest string,
	explicitParent string,
	explicitSpace string,
	root string,
) (parent, space string, folders []folderPlan, err error) {

	imm := filepath.Dir(dest)
	if explicitParent != "" || dirHasAnchor(imm, dest) {
		parent, space, err = deriveCreateFields(
			dest, explicitParent, explicitSpace)
		return parent, space, nil, err
	}
	if dirIsStale(imm, dest) {
		return "", "", nil, staleStampRefusal(imm)
	}

	var chain []string // Deepest first; reversed into top-down folders below.
	dir := imm
	for {
		if dir != imm && dirHasAnchor(dir, "") {
			parent, space, err = deriveDirPlacement(
				dir, "", dest, "", explicitSpace)
			if err != nil {
				return "", "", nil, err
			}
			break
		}
		if dir != imm && dirIsStale(dir, "") {
			return "", "", nil, staleStampRefusal(dir)
		}
		if dir == root {
			_, _, err = deriveCreateFields(dest, explicitParent, explicitSpace)
			return "", "", nil, err
		}
		chain = append(chain, dir)
		up := filepath.Dir(dir)
		if up == dir {
			// Reached the filesystem root without meeting the managed root;
			// refuse rather than loop.
			_, _, err = deriveCreateFields(dest, explicitParent, explicitSpace)
			return "", "", nil, err
		}
		dir = up
	}

	folders = make([]folderPlan, 0, len(chain))
	for i := len(chain) - 1; i >= 0; i-- {
		fdir := chain[i]
		name := filepath.Base(fdir)
		title := deSlugTitle(name)
		if have, hErr := deriveName(title); hErr != nil || have != name {
			rel := name
			if r, rErr := filepath.Rel(root, fdir); rErr == nil {
				rel = r
			}
			format := "folder %q title %q does not round-trip; " +
				"rename it to lowercase words joined by \"_\""
			return "", "", nil, fmt.Errorf(format, rel, title)
		}
		folders = append(folders, folderPlan{Dir: fdir, Title: title})
	}
	return parent, space, folders, nil
}

// dirHasAnchor reports whether dir carries a placement anchor for a child page:
// an _index.md, or a stamped sibling that names a parent. self, the candidate
// itself, is excluded. A directory holding only id-less candidates is not an
// anchor, so the caller walks up to create the missing folders.
func dirHasAnchor(dir, self string) bool {
	index, sibs := readDirMetas(dir, self)
	if index != nil && index.PageID != "" {
		return true
	}
	for _, meta := range sibs {
		if meta.ParentID != "" {
			return true
		}
	}
	return false
}

// dirIsStale reports whether dir holds a tracked sibling page — a page id but
// no parent_id — without an _index.md anchor of its own. Such a directory was
// pulled before parent_id stamping existed, so it looks unanchored though its
// pages already exist remotely; planning a folder for it would duplicate the
// remote chain. self, the candidate itself, is excluded.
func dirIsStale(dir, self string) bool {
	index, sibs := readDirMetas(dir, self)
	if index != nil && index.PageID != "" {
		return false
	}
	for _, meta := range sibs {
		if meta.PageID != "" && meta.ParentID == "" {
			return true
		}
	}
	return false
}

// staleStampRefusal builds the refusal for a directory whose pages were pulled
// before parent_id stamping (see [dirIsStale]), naming the fix.
func staleStampRefusal(dir string) error {
	format := "%s holds pages pulled before parent_id stamping; " +
		"re-pull the space before creating pages under it"
	return fmt.Errorf(format, filepath.Base(dir))
}

// deSlugTitle turns a slug directory name into a folder title: underscores
// become spaces and each word is capitalized. It inverts [deriveName] for the
// names deriveName can produce; a name it cannot invert is caught by the
// round-trip check in [placeUnderRoot].
func deSlugTitle(name string) string {
	words := strings.Split(name, "_")
	for i, word := range words {
		if word == "" {
			continue
		}
		runes := []rune(word)
		runes[0] = unicode.ToUpper(runes[0])
		words[i] = string(runes)
	}
	return strings.Join(words, " ")
}

// resolveCreateField resolves one create field, named field for its error
// text, for the candidate at dest. It returns explicit when set, else indexVal
// when set, else the single value the siblings agree on, where sibVals maps a
// sibling file name to its stamped value. Disagreeing siblings return an error
// naming every value sorted by file; no source at all returns an error naming
// both fixes.
func resolveCreateField(
	field string,
	dest string,
	explicit string,
	indexVal string,
	sibVals map[string]string,
) (string, error) {

	if explicit != "" {
		return explicit, nil
	}
	if indexVal != "" {
		return indexVal, nil
	}

	value := ""
	disagree := false
	for _, v := range sibVals {
		switch {
		case value == "":
			value = v
		case v != value:
			disagree = true
		}
	}
	if disagree {
		names := make([]string, 0, len(sibVals))
		for name := range sibVals {
			names = append(names, name)
		}
		sort.Strings(names)
		var b strings.Builder
		for i, name := range names {
			if i > 0 {
				b.WriteString(", ")
			}
			_, _ = fmt.Fprintf(&b, "%s=%s", name, sibVals[name])
		}
		format := "%s disagrees among siblings: %s"
		return "", fmt.Errorf(format, field, b.String())
	}
	if value != "" {
		return value, nil
	}
	format := "cannot derive %s for %s; re-pull the space or set %s explicitly"
	return "", fmt.Errorf(format, field, filepath.Base(dest), field)
}

// readDirMetas reads the Markdown files in dir for create derivation. It
// returns the parsed _index.md metadata, nil when absent or unparsable, and a
// map from each sibling page's path to its metadata. The candidate self, the
// _index.md, and any cf_local file are excluded from the siblings, so only
// stamped, pushable pages take part in the agreement.
func readDirMetas(dir, self string) (*mdMeta, map[string]*mdMeta) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil
	}
	var index *mdMeta
	sibs := make(map[string]*mdMeta)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path) //nolint:gosec // dir is config-derived.
		if err != nil {
			continue
		}
		meta, _, err := splitFrontmatter(data)
		if err != nil {
			continue
		}
		switch {
		case entry.Name() == indexFile:
			index = meta
		case path == self, meta.Local:
			continue
		default:
			sibs[path] = meta
		}
	}
	return index, sibs
}

// confirmCreates prints an up-front summary of every new page cands names and
// returns the user's decision for each, keyed by dest. With yes it confirms all
// without prompting; otherwise it asks per page on the terminal with the
// choices create, skip, all (create this and every later page) and skip-all
// (skip this and every later page). It refuses to prompt when input is not a
// terminal, so a non-interactive run must pass yes. An empty cands returns an
// empty decision without printing.
func confirmCreates(
	rng *ring.Ring,
	workDir string,
	cands []createInput,
	yes bool,
) (map[string]bool, error) {

	decided := make(map[string]bool, len(cands))
	if len(cands) == 0 {
		return decided, nil
	}
	_, _ = fmt.Fprint(rng.Stderr(), createSummary(workDir, cands))

	if yes {
		for _, cnd := range cands {
			decided[cnd.Dest] = true
		}
		return decided, nil
	}
	if !onTerminal(rng) {
		return nil, errors.New(
			"refusing to prompt without a terminal; re-run with --yes")
	}
	return promptCreates(rng, workDir, cands, decided)
}

// createSummary renders the human-readable list of new pages cands names, one
// per line under a heading, with each dest shown relative to workDir.
func createSummary(workDir string, cands []createInput) string {
	var out bytes.Buffer
	format := "cfsync: %d new page(s) to create:\n"
	_, _ = fmt.Fprintf(&out, format, len(cands))
	// A folder shared by several pages is planned once; list it as new under
	// the first page and as shared under the later ones, so the count of
	// distinct new folders reads true.
	listed := make(map[string]bool)
	for _, cnd := range cands {
		name := pageName(workDir, cnd.Dest)
		_, _ = fmt.Fprintf(&out, "  %s -> %q (space %s", name, cnd.Title,
			cnd.SpaceID)
		// A page with missing folders attaches under the deepest new folder, so
		// its parent id is not yet known; the folder lines report the placement
		// instead.
		if len(cnd.Folders) == 0 && cnd.ParentID != "" {
			_, _ = fmt.Fprintf(&out, ", parent %s", cnd.ParentID)
		}
		_, _ = fmt.Fprint(&out, ")\n")
		for _, fol := range cnd.Folders {
			if fol.Dir != "" && listed[fol.Dir] {
				_, _ = fmt.Fprintf(&out, "      + shared folder %q\n", fol.Title)
				continue
			}
			listed[fol.Dir] = true
			_, _ = fmt.Fprintf(&out, "      + new folder %q\n", fol.Title)
		}
	}
	return out.String()
}

// Choices returned by the per-page create prompt.
const (
	createYes     = "create"   // Create this page.
	createSkip    = "skip"     // Skip this page.
	createAll     = "all"      // Create this page and every later page.
	createSkipAll = "skip-all" // Skip this page and every later page.
)

// promptCreates asks the user, per candidate in order, whether to create it,
// recording each answer in decided. A create-all or skip-all answer settles
// every remaining candidate without another prompt. It assumes the caller has
// already printed the summary and verified a terminal.
func promptCreates(
	rng *ring.Ring,
	workDir string,
	cands []createInput,
	decided map[string]bool,
) (map[string]bool, error) {

	rd := bufio.NewReader(rng.Stdin())
	sticky := ""
	for _, cnd := range cands {
		if sticky != "" {
			decided[cnd.Dest] = sticky == createAll
			continue
		}
		choice, err := askCreate(rng, rd, pageName(workDir, cnd.Dest))
		if err != nil {
			return nil, err
		}
		switch choice {
		case createAll, createSkipAll:
			sticky = choice
			decided[cnd.Dest] = choice == createAll

		default:
			decided[cnd.Dest] = choice == createYes
		}
	}
	return decided, nil
}

// askCreate asks on the terminal whether to create the page named name,
// reading one answer line from rd, and returns the chosen constant. Case and
// surrounding spaces are ignored; an unrecognized answer asks again. A plain
// line read keeps the terminal line-buffered, so it coexists with anything
// else on the run — unlike a raw-mode selector, which fights the progress
// display for stdin. A read error, end of input included, is returned so a
// closed stdin cannot loop forever.
func askCreate(rng *ring.Ring, rd *bufio.Reader, name string) (string, error) {
	for {
		format := "Create %s? [y=yes, n=no, a=all, s=skip all]: "
		_, _ = fmt.Fprintf(rng.Stderr(), format, name)
		line, err := rd.ReadString('\n')
		if err != nil && line == "" {
			return "", fmt.Errorf("create prompt: %w", err)
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "y", "yes":
			return createYes, nil

		case "n", "no":
			return createSkip, nil

		case "a", "all":
			return createAll, nil

		case "s", "skip all", "skip-all":
			return createSkipAll, nil
		}
	}
}

// pushCreate creates the Confluence page for the new Markdown file at dest,
// restricts it to accountID so only the author can see or edit it, and refreshes
// the local cache and frontmatter so a later push updates it as an existing
// page. The body is rendered from an empty baseline, so every block is an
// insert: paragraphs, headings, lists, tables, code fences, panels, expands,
// blockquotes and the [[TOC]] marker are all built fresh. Only an image is
// rejected — uploading its attachment needs the page id, which does not exist
// until after the create; push the page first, then add images on a later
// push. It returns the new page version.
func pushCreate(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	dir string,
	in createInput,
	accountID string,
	folderIDs map[string]string,
) (int, []string, error) {

	parent, created, reused, err := ensureFolders(
		ctx, client, cfg, in, accountID, folderIDs)
	if err != nil {
		return 0, nil, err
	}
	// Any failure past this point must also unwind the folders created above, so
	// a rejected page leaves no orphan folder chain behind.
	fail := func(err error) (int, []string, error) {
		rollbackFolders(ctx, client, cfg, folderIDs, created)
		return 0, nil, err
	}

	dest := in.Dest
	edited, err := os.ReadFile(dest) //nolint:gosec // dest is config-derived.
	if err != nil {
		return fail(fmt.Errorf("reading %s: %w", dest, err))
	}
	meta, body, err := splitFrontmatter(edited)
	if err != nil {
		return fail(err)
	}
	// The space and parent were resolved during planning — from disk when the
	// file itself named neither, and the parent is the deepest new folder when
	// this page created its own ancestors — so use the resolved values, not the
	// possibly empty frontmatter, both to create the page and to stamp it back.
	meta.SpaceID = in.SpaceID
	meta.ParentID = parent
	name := pageName(cfg.WorkDir, dest)

	links := cfg.linkMapper(dest)
	assets := meta.writableAssets()
	base := &adf.ADF{Name: name, SpaceID: meta.SpaceID, Doc: adf.Node{Type: "doc"}}
	next, err := base.PutLinks(body, meta.Mentions, assets, nil, links)
	if err != nil {
		return fail(err)
	}
	docJSON, err := json.Marshal(next.Doc)
	if err != nil {
		return fail(fmt.Errorf("encoding new ADF: %w", err))
	}

	id, ver, err := createPage(ctx, client, cfg, meta, docJSON)
	if err != nil {
		return fail(err)
	}
	// The page exists but is world-visible until it is restricted — the one
	// state a create must not leave. When the restriction fails, delete the page
	// and unwind any folders this page created; surface a delete failure with
	// the restriction error so the unrestricted page is not silent.
	if err = restrictToAuthor(ctx, client, cfg, id, accountID); err != nil {
		if delErr := deletePage(ctx, client, cfg, id); delErr != nil {
			err = errors.Join(err, delErr)
		}
		return fail(err)
	}

	// Stamp the new identity onto the local file before the full refresh so a
	// later push updates this page even when refreshAfterPush fails mid-way. The
	// folders are live and the page depends on them, so a local-only failure
	// past here does not roll them back.
	meta.PageID = id
	meta.PageVersion = ver
	if err = stampCreateIdentity(dest, meta); err != nil {
		format := "page %s created but not tracked: %w"
		return 0, nil, fmt.Errorf(format, id, err)
	}
	err = refreshAfterPush(dir, dest, name, meta, docJSON, ver, assets, links)
	if err != nil {
		return 0, nil, err
	}
	return ver, reused, nil
}

// createdFolder records a folder created during one [pushCreate] call so a
// later failure can delete it and forget its id.
type createdFolder struct {
	dir string
	id  string
}

// ensureFolders creates and restricts the ancestor folders in.Folders that do
// not yet exist this run, top-down, and returns the parent id the page attaches
// under, the folders it created (newest last), and the titles of folders that
// already existed in the space and were reused rather than created. A folder
// already in folderIDs is reused, not recreated, so pages sharing an ancestor
// create it once. On any failure it deletes the folders it created, in reverse,
// and forgets their ids.
func ensureFolders(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	in createInput,
	accountID string,
	folderIDs map[string]string,
) (string, []createdFolder, []string, error) {

	parent := in.ParentID
	var created []createdFolder
	var reused []string
	for _, fol := range in.Folders {
		if id, ok := folderIDs[fol.Dir]; ok {
			parent = id
			continue
		}
		id, err := createFolder(ctx, client, cfg, in.SpaceID, parent, fol.Title)
		if errors.Is(err, errFolderTitleTaken) {
			// A folder with this title already exists in the space. Reuse it
			// when it sits under this parent — the directory maps to it exactly
			// as a pull would, so a re-push is idempotent and its restrictions
			// are left as they are. When it lives elsewhere, per-space title
			// uniqueness makes the placement impossible; refuse rather than
			// misplace the page under an unrelated folder.
			existing, lookErr := childFolderTitled(
				ctx, client, cfg, parent, fol.Title)
			if lookErr != nil {
				rollbackFolders(ctx, client, cfg, folderIDs, created)
				return "", nil, nil, errors.Join(err, lookErr)
			}
			if existing != "" {
				folderIDs[fol.Dir] = existing
				reused = append(reused, fol.Title)
				parent = existing
				continue
			}
			rollbackFolders(ctx, client, cfg, folderIDs, created)
			format := "folder %q already exists elsewhere in the space; " +
				"Confluence folder titles are unique per space, so rename %s"
			return "", nil, nil, fmt.Errorf(format, fol.Title, fol.Dir)
		}
		if err != nil {
			rollbackFolders(ctx, client, cfg, folderIDs, created)
			return "", nil, nil, err
		}
		// A folder is world-visible until restricted, like a page; delete it and
		// unwind on failure so no unrestricted folder survives.
		if err = restrictToAuthor(ctx, client, cfg, id, accountID); err != nil {
			if delErr := deleteFolder(ctx, client, cfg, id); delErr != nil {
				err = errors.Join(err, delErr)
			}
			rollbackFolders(ctx, client, cfg, folderIDs, created)
			return "", nil, nil, err
		}
		folderIDs[fol.Dir] = id
		created = append(created, createdFolder{dir: fol.Dir, id: id})
		parent = id
	}
	return parent, created, reused, nil
}

// rollbackFolders deletes the folders created during a failed create, in
// reverse of their creation, and forgets their ids so a later page does not
// reuse a deleted folder. A delete failure is dropped: the create already
// failed, and a leftover empty folder is a lesser harm than masking the cause.
func rollbackFolders(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	folderIDs map[string]string,
	created []createdFolder,
) {

	for i := len(created) - 1; i >= 0; i-- {
		delete(folderIDs, created[i].dir)
		_ = deleteFolder(ctx, client, cfg, created[i].id)
	}
}

// stampCreateIdentity writes the new page id and version into dest's
// frontmatter, keeping title, space, and parent so the file is no longer a
// create candidate if the subsequent refresh fails.
func stampCreateIdentity(dest string, meta *mdMeta) error {
	data, err := os.ReadFile(dest) //nolint:gosec // dest is config-derived.
	if err != nil {
		return fmt.Errorf("reading %s: %w", dest, err)
	}
	_, body, err := splitFrontmatter(data)
	if err != nil {
		return err
	}
	// Only the fields needed to track the remote page — a full refresh replaces
	// this file on success.
	front := struct {
		Title       string `yaml:"title"`
		PageID      string `yaml:"page_id"`
		PageVersion int    `yaml:"page_version"`
		SpaceID     string `yaml:"space_id"`
		ParentID    string `yaml:"parent_id,omitempty"`
	}{
		Title:       meta.Title,
		PageID:      meta.PageID,
		PageVersion: meta.PageVersion,
		SpaceID:     meta.SpaceID,
		ParentID:    meta.ParentID,
	}
	yamlBytes, err := yaml.Marshal(front)
	if err != nil {
		return fmt.Errorf("encoding frontmatter: %w", err)
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.Write(yamlBytes)
	b.WriteString("---\n")
	if body != "" {
		b.WriteString(body)
		b.WriteByte('\n')
	}
	return writeFile(dest, []byte(b.String()), 0o644)
}

// createPage POSTs a new page to the Site from meta and the rendered ADF body,
// and returns the new numeric id and version. A response without an id is an
// error, as the page cannot then be restricted or tracked.
func createPage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	meta *mdMeta,
	docJSON []byte,
) (string, int, error) {

	payload := createPayload{
		SpaceID:  meta.SpaceID,
		Status:   "current",
		Title:    meta.Title,
		ParentID: meta.ParentID,
		Body: pushBody{
			Representation: "atlas_doc_format",
			Value:          string(docJSON),
		},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", 0, fmt.Errorf("encoding create payload: %w", err)
	}

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + createPageEndpoint
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, addr, bytes.NewReader(data),
	)
	if err != nil {
		return "", 0, fmt.Errorf("building create request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("creating page %q: %w", meta.Title, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		format := "create page %q: HTTP %d: %s"
		return "", 0, fmt.Errorf(format, meta.Title, resp.StatusCode, body)
	}

	var res createResult
	if err = json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", 0, fmt.Errorf("decoding create response: %w", err)
	}
	if res.ID == "" {
		return "", 0, fmt.Errorf("create page %q: response has no id", meta.Title)
	}
	ver := res.Version.Number
	if ver == 0 {
		ver = 1
	}
	return res.ID, ver, nil
}

// restrictToAuthor replaces the page's content restrictions so only accountID
// may read or update it, via the v1 restriction endpoint. Space and site admins
// retain access regardless, and an ancestor's own view restriction still binds,
// so the page is visible to the author plus those admins, never to nobody else.
func restrictToAuthor(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pageID string,
	accountID string,
) error {

	user := []restrictionUser{{Type: "known", AccountID: accountID}}
	payload := restrictionUpdate{Results: []operationRestriction{
		{Operation: "read", Restrictions: restrictionSubjects{User: user}},
		{Operation: "update", Restrictions: restrictionSubjects{User: user}},
	}}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encoding restriction payload: %w", err)
	}

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + fmt.Sprintf(restrictionEndpoint, pageID)
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPut, addr, bytes.NewReader(data),
	)
	if err != nil {
		return fmt.Errorf("building restriction request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("restricting page %s: %w", pageID, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("restrict page %s: HTTP %d", pageID, resp.StatusCode)
	}
	return nil
}

// deletePage deletes the page with the numeric id from the Site, used to roll
// back a page created but not restricted.
func deletePage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	pageID string,
) error {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + pageEndpoint + pageID
	req, err := http.NewRequestWithContext(
		ctx, http.MethodDelete, addr, http.NoBody,
	)
	if err != nil {
		return fmt.Errorf("building delete request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("deleting page %s: %w", pageID, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("delete page %s: HTTP %d", pageID, resp.StatusCode)
	}
	return nil
}

// errFolderTitleTaken reports that a folder create was rejected because a
// folder with the same title already exists in the space. Confluence requires
// folder titles to be unique per space, not merely per parent, so the caller
// reuses the existing folder when it sits under the intended parent and refuses
// otherwise. Matched with [errors.Is].
var errFolderTitleTaken = errors.New(
	"a folder with this title already exists in the space")

// createFolder POSTs a new folder titled title in spaceID under parentID and
// returns its numeric id. It parents new local sub-directories in Confluence so
// a page created inside one has a real parent; the folder is restricted to the
// author separately, like a page. A response without an id is an error, as the
// folder cannot then be restricted or used as a parent. A rejection for a
// duplicate title wraps [errFolderTitleTaken].
func createFolder(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	spaceID string,
	parentID string,
	title string,
) (string, error) {

	payload := folderPayload{SpaceID: spaceID, Title: title, ParentID: parentID}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encoding folder payload: %w", err)
	}

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + strings.TrimSuffix(folderEndpoint, "/")
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, addr, bytes.NewReader(data),
	)
	if err != nil {
		return "", fmt.Errorf("building folder request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("creating folder %q: %w", title, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode == http.StatusBadRequest &&
			bytes.Contains(bytes.ToLower(body), []byte("same title")) {
			format := "create folder %q: %w: %s"
			return "", fmt.Errorf(format, title, errFolderTitleTaken, body)
		}
		format := "create folder %q: HTTP %d: %s"
		return "", fmt.Errorf(format, title, resp.StatusCode, body)
	}

	var res folderResult
	if err = json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", fmt.Errorf("decoding folder response: %w", err)
	}
	if res.ID == "" {
		return "", fmt.Errorf("create folder %q: response has no id", title)
	}
	return res.ID, nil
}

// deleteFolder deletes the folder with the numeric id from the Site, used to
// roll back folders created for a page whose own create then failed. An
// already-absent folder is not an error.
func deleteFolder(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	folderID string,
) error {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + folderEndpoint + folderID
	req, err := http.NewRequestWithContext(
		ctx, http.MethodDelete, addr, http.NoBody,
	)
	if err != nil {
		return fmt.Errorf("building folder delete request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("deleting folder %s: %w", folderID, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("delete folder %s: HTTP %d", folderID, resp.StatusCode)
	}
	return nil
}

// createPayload is the Confluence v2 page-create request body.
type createPayload struct {
	SpaceID  string   `json:"spaceId"`
	Status   string   `json:"status"`
	Title    string   `json:"title"`
	ParentID string   `json:"parentId,omitempty"`
	Body     pushBody `json:"body"`
}

// folderPayload is the Confluence v2 folder-create request body.
type folderPayload struct {
	SpaceID  string `json:"spaceId"`
	Title    string `json:"title"`
	ParentID string `json:"parentId,omitempty"`
}

// folderResult is the part of the Confluence v2 folder-create response cfsync
// reads: the new id.
type folderResult struct {
	ID string `json:"id"`
}

// createResult is the part of the Confluence v2 page-create response cfsync
// reads: the new id and version.
type createResult struct {
	ID      string `json:"id"`
	Version struct {
		Number int `json:"number"`
	} `json:"version"`
}

// restrictionUpdate is the Confluence v1 restriction-replace request body: one
// entry per restricted operation.
type restrictionUpdate struct {
	Results []operationRestriction `json:"results"`
}

// operationRestriction restricts a single operation ("read" or "update") to a
// set of subjects.
type operationRestriction struct {
	Operation    string              `json:"operation"`
	Restrictions restrictionSubjects `json:"restrictions"`
}

// restrictionSubjects lists the users a restriction grants the operation to.
type restrictionSubjects struct {
	User []restrictionUser `json:"user"`
}

// restrictionUser identifies one user a restriction applies to by account id.
type restrictionUser struct {
	Type      string `json:"type"`
	AccountID string `json:"accountId"`
}
