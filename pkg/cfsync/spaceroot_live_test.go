// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

package cfsync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// probeNode is the union of fields the walk cares about across the space pages
// endpoint (parentType/parentId, no type) and the direct-children endpoint
// (type page|folder). Absent fields decode to "".
type probeNode struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Title      string `json:"title"`
	Status     string `json:"status"`
	ParentID   string `json:"parentId"`
	ParentType string `json:"parentType"`
	SpaceID    string `json:"spaceId"`
}

// probeResp models a paginated v2 list response for the fields the walk reads.
type probeResp struct {
	Results []probeNode `json:"results"`
	Links   struct {
		Next string `json:"next"`
	} `json:"_links"`
}

// Test_live_spaceWalk is the contract test for the spaces: traversal model: it
// proves the homepage-rooted walk reaches every page in the space. It resolves
// the test space key to its id and homepage in one call, recursively follows
// page and folder direct-children from the homepage, and compares the set of
// pages found against the flat spaces/{id}/pages listing. The two must match
// for the walk to be complete — the guard against a space exposing content as
// a sibling of the homepage rather than beneath it. It also logs the derived
// tree with each page classified as a container (has children -> _index.md) or
// a leaf (-> name.md).
func Test_live_spaceWalk(t *testing.T) {
	ctx, client, cfg, lp := liveEnv(t)

	_, body := probeGet(ctx, client, cfg, "/wiki/api/v2/spaces?keys="+lp.space)
	spaceID, homepageID := firstSpace(t, body)
	if spaceID == "" || homepageID == "" {
		t.Fatalf("could not resolve space %q to id/homepage", lp.space)
	}

	// Flat truth set: every page id the space lists, following pagination.
	flat := map[string]bool{}
	path := "/wiki/api/v2/spaces/" + spaceID + "/pages?limit=250"
	for path != "" {
		status, b := probeGet(ctx, client, cfg, path)
		if status < 200 || status >= 300 {
			t.Fatalf("flat pages: HTTP %d\n%s", status, pretty(b))
		}
		var resp probeResp
		if err := json.Unmarshal(b, &resp); err != nil {
			t.Fatalf("flat pages decode: %v", err)
		}
		for _, n := range resp.Results {
			flat[n.ID] = true
		}
		path = resp.Links.Next
	}

	// Walked set: pages reached from the homepage via direct-children.
	walked := map[string]bool{}
	var tree strings.Builder
	walkNode(t, ctx, client, cfg, "page", homepageID, "(homepage)", 0,
		walked, &tree)

	t.Logf("tree:\n%s", strings.TrimRight(tree.String(), "\n"))
	t.Logf("flat pages=%d  walked pages=%d", len(flat), len(walked))

	for id := range flat {
		if !walked[id] {
			t.Errorf("page %s is in the flat listing but the walk missed it", id)
		}
	}
	for id := range walked {
		if !flat[id] {
			t.Errorf("walk found page %s absent from the flat listing", id)
		}
	}
}

// walkNode records the page (when kind is "page"), fetches its direct children,
// and recurses into child pages and folders, appending an indented tree line
// tagging each page as a container or a leaf. Folders contribute a tree line
// but no page id.
func walkNode(
	t *testing.T,
	ctx context.Context,
	client *http.Client,
	cfg *config,
	kind string,
	id string,
	title string,
	depth int,
	walked map[string]bool,
	tree *strings.Builder,
) {
	t.Helper()

	endpoint := "/wiki/api/v2/pages/"
	if kind == "folder" {
		endpoint = folderEndpoint
	}

	var kids []probeNode
	path := endpoint + id + childrenPath + "?limit=250"
	for path != "" {
		status, body := probeGet(ctx, client, cfg, path)
		if status < 200 || status >= 300 {
			t.Errorf("%s %s children: HTTP %d\n%s", kind, id, status, pretty(body))
			return
		}
		var resp probeResp
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Errorf("%s %s children decode: %v", kind, id, err)
			return
		}
		kids = append(kids, resp.Results...)
		path = resp.Links.Next
	}

	tag := kind
	if kind == "page" {
		walked[id] = true
		if len(kids) > 0 {
			tag = "page/_index" // container: has children
		} else {
			tag = "page/leaf"
		}
	}
	fmt.Fprintf(tree, "%s%-13s %-12s %q\n",
		strings.Repeat("  ", depth), tag, id, title)

	for _, k := range kids {
		if k.Type == "page" || k.Type == "folder" {
			walkNode(t, ctx, client, cfg, k.Type, k.ID, k.Title, depth+1,
				walked, tree)
		}
	}
}

// probeGet performs an authenticated GET for the host-relative path and returns
// the status code and body. A transport error yields status 0 and the error
// text as the body.
func probeGet(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	path string,
) (int, []byte) {

	ctx, cancel := context.WithTimeout(ctx, cfg.reqTimeout())
	defer cancel()

	addr := cfg.Host + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, http.NoBody)
	if err != nil {
		return 0, []byte(err.Error())
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return 0, []byte(err.Error())
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

// firstSpace extracts the id and homepageId of the first space in a
// "spaces?keys=" style response body. Missing fields decode to "".
func firstSpace(t *testing.T, body []byte) (id, homepage string) {
	t.Helper()
	var resp struct {
		Results []struct {
			ID         string `json:"id"`
			HomepageID string `json:"homepageId"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Logf("firstSpace decode: %v", err)
		return "", ""
	}
	if len(resp.Results) == 0 {
		return "", ""
	}
	return resp.Results[0].ID, resp.Results[0].HomepageID
}

// pretty re-indents a JSON body for logging, falling back to the raw bytes.
func pretty(body []byte) string {
	var buf strings.Builder
	var v any
	if json.Unmarshal(body, &v) != nil {
		return string(body)
	}
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if enc.Encode(v) != nil {
		return string(body)
	}
	return strings.TrimRight(buf.String(), "\n")
}
