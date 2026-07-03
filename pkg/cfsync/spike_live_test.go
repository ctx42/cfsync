// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

// This spike answers two questions the folder-parent plan items depend on:
// whether the v2 page-create API accepts a folder id as parentId, and
// whether the v1 restriction API can restrict a folder the way it restricts
// a page. It MUTATES: it creates one throwaway page under a test folder
// (deleted afterward) and attempts a restriction PUT against the folder
// (reverted on success). CFSYNC_TEST_FOLDER names a shared folder to reuse;
// when unset, the spike creates and deletes its own scratch folder so the
// two questions can still be answered live.
//
// Run with:
//
//	go test -tags confluence -run Test_live_folderParentSpike -v ./pkg/cfsync/
package cfsync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

// Test_live_folderParentSpike answers two questions against the live Site:
// whether POST /wiki/api/v2/pages accepts a folder id as parentId (and the
// created page reports parentType "folder"), and whether PUT
// /wiki/rest/api/content/{id}/restriction accepts a folder id. Both findings
// are logged regardless of outcome; a rejection of the restriction PUT is a
// valid finding, not a test failure.
func Test_live_folderParentSpike(t *testing.T) {
	ctx, client, cfg, lp := liveEnv(t)

	folderID, spaceID := resolveSpikeFolder(t, ctx, client, cfg, lp)

	// --- Finding 1: does a v2 page create accept a folder as parentId? ---

	meta := &mdMeta{
		Title:    uniqueTitle("folder-parent"),
		SpaceID:  spaceID,
		ParentID: folderID,
	}
	const doc = `{"type":"doc","content":[{"type":"paragraph","content":[` +
		`{"type":"text","text":"folder-parent spike"}]}]}`
	id, _, err := createPage(ctx, client, cfg, meta, []byte(doc))
	must.Nil(err)
	t.Cleanup(func() { _ = deletePage(context.Background(), client, cfg, id) })

	status, body := probeGet(ctx, client, cfg, pageEndpoint+id)
	assert.Equal(t, http.StatusOK, status)
	var have probeNode
	must.Nil(json.Unmarshal(body, &have))
	t.Logf(
		"finding 1 - folder as parentId: requested parent %s; created page "+
			"%s reports parentId=%s parentType=%q",
		folderID, id, have.ParentID, have.ParentType,
	)
	assert.Equal(t, folderID, have.ParentID)
	assert.Equal(t, "folder", have.ParentType)

	// --- Finding 2: does the v1 restriction PUT accept a folder id? ---

	accountID := must.Value(currentAccountID(ctx, client, cfg))
	status, body = putFolderRestriction(ctx, client, cfg, folderID, accountID)
	t.Logf(
		"finding 2 - folder restriction PUT: HTTP %d\n%s",
		status, pretty(body),
	)
	if status >= 200 && status < 300 {
		t.Cleanup(func() {
			s, b := deleteFolderRestriction(
				context.Background(), client, cfg, folderID)
			t.Logf("reverted folder restriction: HTTP %d\n%s", s, pretty(b))
		})
	}
}

// resolveSpikeFolder returns a live folder id to parent the spike's test
// page under, together with the test space's numeric id. lp.folder names a
// shared folder when set; otherwise this creates a scratch folder under the
// space's homepage for the run and registers its cleanup.
func resolveSpikeFolder(
	t *testing.T,
	ctx context.Context,
	client *http.Client,
	cfg *config,
	lp liveParams,
) (folderID, spaceID string) {
	t.Helper()

	status, body := probeGet(
		ctx, client, cfg, "/wiki/api/v2/spaces?keys="+lp.space)
	if status < 200 || status >= 300 {
		t.Fatalf(
			"resolving space %s: HTTP %d\n%s", lp.space, status, pretty(body))
	}
	spaceID, homepageID := firstSpace(t, body)
	if spaceID == "" {
		t.Fatalf("could not resolve space %q to an id", lp.space)
	}

	if lp.folder != "" {
		return lp.folder, spaceID
	}

	id, err := createFolder(
		ctx, client, cfg, spaceID, homepageID, uniqueTitle("folder-parent"))
	if err != nil {
		t.Fatalf("creating scratch folder: %v", err)
	}
	t.Cleanup(func() {
		if delErr := deleteFolder(
			context.Background(), client, cfg, id); delErr != nil {

			t.Logf("cleanup: deleting scratch folder %s: %v", id, delErr)
		}
	})
	return id, spaceID
}

// putFolderRestriction attempts the v1 content-restriction PUT against the
// folder id, restricting read and update to accountID exactly as
// [restrictToAuthor] does for a page. It returns the status and raw response
// body so the caller can record the outcome regardless of the result.
func putFolderRestriction(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	folderID, accountID string,
) (int, []byte) {

	user := []restrictionUser{{Type: "known", AccountID: accountID}}
	payload := restrictionUpdate{Results: []operationRestriction{
		{Operation: "read", Restrictions: restrictionSubjects{User: user}},
		{Operation: "update", Restrictions: restrictionSubjects{User: user}},
	}}
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, []byte(err.Error())
	}
	return restrictionRoundTrip(
		ctx, client, cfg, http.MethodPut, folderID, bytes.NewReader(data))
}

// deleteFolderRestriction resets every content restriction on the folder id
// via the v1 restriction DELETE, undoing a successful [putFolderRestriction].
func deleteFolderRestriction(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	folderID string,
) (int, []byte) {

	return restrictionRoundTrip(
		ctx, client, cfg, http.MethodDelete, folderID, http.NoBody)
}

// restrictionRoundTrip sends method to the v1 restriction endpoint for id
// with reqBody, and returns the status and raw response body. A transport or
// request-building error yields status 0 and the error text as the body,
// mirroring [probeGet].
func restrictionRoundTrip(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	method, id string,
	reqBody io.Reader,
) (int, []byte) {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	addr := cfg.Host + fmt.Sprintf(restrictionEndpoint, id)
	req, err := http.NewRequestWithContext(ctx, method, addr, reqBody)
	if err != nil {
		return 0, []byte(err.Error())
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return 0, []byte(err.Error())
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, respBody
}
