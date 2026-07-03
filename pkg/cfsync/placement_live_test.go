// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

// This integration test proves the page-placement feature end-to-end against
// the live Atlassian Site using the environment loaded by liveEnv (see
// live_test.go). It MUTATES: it creates a scratch folder under the test space
// homepage, seeds one page inside it, then pushes a title-only Markdown file
// nested two new directories deep, which creates two Confluence folders and a
// page beneath them. Everything it creates lives under the scratch folder and
// is deleted on cleanup (pages first, then folders deepest-first, then the
// scratch folder), so a clean run leaves the space as it was found.
//
// Run with:
//
//	go test -tags confluence -run Test_live_placement -v ./pkg/cfsync/
package cfsync

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testkit/pkg/oskit"
)

// Test_live_placement drives the whole placement pipeline against the Site:
// pull stamps parent_id onto a discovered page; a title-only file nested under
// two new local directories pushes as two restricted folders plus a restricted
// page chained beneath them; and a fresh pull converges on the same directory
// layout with the same parent ids, while re-pulling the pushed tree rewrites
// nothing.
func Test_live_placement(t *testing.T) {
	ctx, client, cfg, lp := liveEnv(t)

	spaceID := must.Value(spaceIDByKey(ctx, client, cfg, lp.space))
	accountID := must.Value(currentAccountID(ctx, client, cfg))

	// --- Step 1: seed a scratch folder with one page inside it. ---

	_, spaceBody := probeGet(
		ctx, client, cfg, "/wiki/api/v2/spaces?keys="+lp.space)
	_, homepageID := firstSpace(t, spaceBody)
	if homepageID == "" {
		t.Fatalf("could not resolve homepage for space %q", lp.space)
	}

	rootID := must.Value(createFolder(
		ctx, client, cfg, spaceID, homepageID, uniqueTitle("placement-root")))
	t.Cleanup(func() {
		if err := deleteFolder(context.Background(), client, cfg, rootID); err != nil {
			t.Logf("cleanup: deleting scratch folder %s: %v", rootID, err)
		}
	})

	seedTitle := uniqueTitle("placement-seed")
	seedID := must.Value(seedPage(ctx, client, cfg, spaceID, rootID, seedTitle,
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"placement seed"}]}]}`))
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, seedID) })

	// --- Step 2: pull the scratch folder; the seeded page is stamped with
	// parent_id equal to the scratch folder id. ---

	cfg.Folders = map[string]string{
		cfg.WorkDir: "/wiki/spaces/" + lp.space + "/folder/" + rootID,
	}
	_, err := pullConfig(ctx, client, cfg)
	must.Nil(err)

	seedName := must.Value(deriveName(seedTitle))
	seedDest := filepath.Join(cfg.WorkDir, seedName+".md")
	assert.FileExist(t, seedDest)
	seedMeta, _, err := splitFrontmatter([]byte(oskit.ReadFileStr(t, seedDest)))
	must.Nil(err)
	assert.Equal(t, rootID, seedMeta.ParentID)
	assert.Equal(t, spaceID, seedMeta.SpaceID)

	// --- Step 3: author a title-only file two new directories deep. Folder
	// titles are unique per space on the Site, so the directory names carry a
	// per-run tag; they still round-trip through deriveName(deSlugTitle(...)). ---

	run := must.Value(deriveName(uniqueTitle("plc")))
	alphaDir := "alpha_beta_" + run
	gammaDir := "gamma_delta_" + run
	alphaTitle := deSlugTitle(alphaDir)
	gammaTitle := deSlugTitle(gammaDir)

	leafTitle := uniqueTitle("placement-leaf")
	leafName := must.Value(deriveName(leafTitle))
	pageDir := filepath.Join(cfg.WorkDir, alphaDir, gammaDir)
	must.Nil(os.MkdirAll(pageDir, 0o755))
	leafDest := filepath.Join(pageDir, leafName+".md")
	oskit.Create(t, "---\ntitle: "+leafTitle+"\n---\n\nplacement leaf body\n", leafDest)

	// --- Step 4: push. Two folders and the page are created and restricted,
	// chained root -> Alpha Beta -> Gamma Delta -> page. ---

	out, err := pushManaged(ctx, ring.New(), client, cfg, "", true)
	must.Nil(err)
	assert.Contain(t, "ok", out)

	alphaID := childFolderID(t, ctx, client, cfg, rootID, alphaTitle)
	if alphaID == "" {
		t.Fatalf("push did not create the %q folder under %s", alphaTitle, rootID)
	}
	t.Cleanup(func() {
		if err := deleteFolder(context.Background(), client, cfg, alphaID); err != nil {
			t.Logf("cleanup: deleting folder %q %s: %v", alphaTitle, alphaID, err)
		}
	})

	gammaID := childFolderID(t, ctx, client, cfg, alphaID, gammaTitle)
	if gammaID == "" {
		t.Fatalf("push did not create the %q folder under %s", gammaTitle, alphaID)
	}
	t.Cleanup(func() {
		if err := deleteFolder(context.Background(), client, cfg, gammaID); err != nil {
			t.Logf("cleanup: deleting folder %q %s: %v", gammaTitle, gammaID, err)
		}
	})

	// The pushed file was stamped with its new identity on create.
	leafMeta, _, err := splitFrontmatter([]byte(oskit.ReadFileStr(t, leafDest)))
	must.Nil(err)
	assert.NotEqual(t, "", leafMeta.PageID)
	assert.Equal(t, gammaID, leafMeta.ParentID)
	assert.Equal(t, spaceID, leafMeta.SpaceID)
	pageID := leafMeta.PageID
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, pageID) })

	// The page hangs off the deepest folder, reported as a folder parent.
	status, pageBody := probeGet(ctx, client, cfg, pageEndpoint+pageID)
	assert.Equal(t, http.StatusOK, status)
	var pageNode probeNode
	must.Nil(json.Unmarshal(pageBody, &pageNode))
	assert.Equal(t, gammaID, pageNode.ParentID)
	assert.Equal(t, "folder", pageNode.ParentType)

	// Both folders and the page are restricted to the author account.
	assertRestrictedTo(t, ctx, client, cfg, alphaID, accountID)
	assertRestrictedTo(t, ctx, client, cfg, gammaID, accountID)
	assertRestrictedTo(t, ctx, client, cfg, pageID, accountID)

	// --- Step 5: a fresh pull reproduces the created folders as the same
	// directories with the page beneath them, and a second pull of that tree
	// rewrites nothing. ---

	fresh := &config{
		Host:    cfg.Host,
		Account: cfg.Account,
		Token:   cfg.Token,
		WorkDir: t.TempDir(),
	}
	fresh.Folders = map[string]string{
		fresh.WorkDir: "/wiki/spaces/" + lp.space + "/folder/" + rootID,
	}
	_, err = pullConfig(ctx, client, fresh)
	must.Nil(err)

	freshLeaf := filepath.Join(fresh.WorkDir, alphaDir, gammaDir, leafName+".md")
	assert.FileExist(t, freshLeaf)
	freshMeta, _, err := splitFrontmatter([]byte(oskit.ReadFileStr(t, freshLeaf)))
	must.Nil(err)
	assert.Equal(t, pageID, freshMeta.PageID)
	assert.Equal(t, gammaID, freshMeta.ParentID)

	// A second pull of the same tree is a no-op: the file pull just wrote is
	// byte-for-byte what the next pull renders, so the skip-unchanged path
	// fires and the working copy is stable.
	before := oskit.ReadFileStr(t, freshLeaf)
	_, err = pullConfig(ctx, client, fresh)
	must.Nil(err)
	after := oskit.ReadFileStr(t, freshLeaf)
	assert.Equal(t, before, after)
}

// Test_live_placement_reuse proves the per-space folder-title uniqueness fix:
// when the folder a push would create already exists under the intended parent,
// push reuses it instead of failing, and the page lands under the existing
// folder. It seeds a folder directly, leaves its local directory unanchored,
// and pushes a title-only page into it.
func Test_live_placement_reuse(t *testing.T) {
	ctx, client, cfg, lp := liveEnv(t)

	spaceID := must.Value(spaceIDByKey(ctx, client, cfg, lp.space))

	_, body := probeGet(ctx, client, cfg, "/wiki/api/v2/spaces?keys="+lp.space)
	_, homepageID := firstSpace(t, body)
	if homepageID == "" {
		t.Fatalf("could not resolve homepage for space %q", lp.space)
	}

	rootID := must.Value(createFolder(
		ctx, client, cfg, spaceID, homepageID, uniqueTitle("reuse-root")))
	t.Cleanup(func() {
		if err := deleteFolder(context.Background(), client, cfg, rootID); err != nil {
			t.Logf("cleanup: deleting scratch folder %s: %v", rootID, err)
		}
	})

	// A stamped sibling at the root so derivation resolves the root's parent.
	seedID := must.Value(seedPage(ctx, client, cfg, spaceID, rootID,
		uniqueTitle("reuse-seed"),
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"reuse seed"}]}]}`))
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, seedID) })

	// A folder that already exists under the root; its local directory will be
	// unanchored, so the push plans to create it and must reuse this one.
	run := must.Value(deriveName(uniqueTitle("rz")))
	subDir := "reuse_me_" + run
	subTitle := deSlugTitle(subDir)
	subID := must.Value(createFolder(ctx, client, cfg, spaceID, rootID, subTitle))
	t.Cleanup(func() {
		if err := deleteFolder(context.Background(), client, cfg, subID); err != nil {
			t.Logf("cleanup: deleting existing folder %s: %v", subID, err)
		}
	})

	cfg.Folders = map[string]string{
		cfg.WorkDir: "/wiki/spaces/" + lp.space + "/folder/" + rootID,
	}
	_, err := pullConfig(ctx, client, cfg)
	must.Nil(err)

	// Author a title-only page inside the unanchored directory and push.
	leafTitle := uniqueTitle("reuse-leaf")
	leafName := must.Value(deriveName(leafTitle))
	pageDir := filepath.Join(cfg.WorkDir, subDir)
	must.Nil(os.MkdirAll(pageDir, 0o755))
	leafDest := filepath.Join(pageDir, leafName+".md")
	oskit.Create(t, "---\ntitle: "+leafTitle+"\n---\n\nreuse leaf body\n", leafDest)

	out, err := pushManaged(ctx, ring.New(), client, cfg, "", true)
	must.Nil(err)
	assert.Contain(t, "ok", out)
	assert.Contain(t, `reused existing folder "`+subTitle+`"`, out)

	// The pre-existing folder was reused: the page's parent is subID, and the
	// root still has exactly one folder titled subTitle.
	leafMeta, _, err := splitFrontmatter([]byte(oskit.ReadFileStr(t, leafDest)))
	must.Nil(err)
	pageID := leafMeta.PageID
	assert.NotEqual(t, "", pageID)
	assert.Equal(t, subID, leafMeta.ParentID)
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, pageID) })

	assert.Equal(t, subID, childFolderID(t, ctx, client, cfg, rootID, subTitle))
}

// childFolderID returns the id of the direct child folder of parentID whose
// title is title, or "" when no such child folder exists.
func childFolderID(
	t *testing.T,
	ctx context.Context,
	client *http.Client,
	cfg *config,
	parentID, title string,
) string {

	t.Helper()
	status, body := probeGet(
		ctx, client, cfg, folderEndpoint+parentID+childrenPath)
	assert.Equal(t, http.StatusOK, status)
	var resp probeResp
	must.Nil(json.Unmarshal(body, &resp))
	for _, child := range resp.Results {
		if child.Type == "folder" && child.Title == title {
			return child.ID
		}
	}
	return ""
}

// assertRestrictedTo fails the test unless the content id carries a read
// restriction naming accountID, proving [restrictToAuthor] ran against it.
func assertRestrictedTo(
	t *testing.T,
	ctx context.Context,
	client *http.Client,
	cfg *config,
	id, accountID string,
) {

	t.Helper()
	path := "/wiki/rest/api/content/" + id + "/restriction/byOperation/read"
	status, body := probeGet(ctx, client, cfg, path)
	assert.Equal(t, http.StatusOK, status)
	if !strings.Contains(string(body), accountID) {
		t.Errorf("content %s is not read-restricted to %s\n%s",
			id, accountID, pretty(body))
	}
}
