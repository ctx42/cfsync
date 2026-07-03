// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

package cfsync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// spaceIDByKey resolves a space key to its numeric id.
func spaceIDByKey(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	key string,
) (string, error) {

	addr := cfg.Host + "/wiki/api/v2/spaces?keys=" + key
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, http.NoBody)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("space %s: HTTP %d", key, resp.StatusCode)
	}
	var out struct {
		Results []struct {
			ID string `json:"id"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Results) == 0 {
		return "", fmt.Errorf("space %s not found", key)
	}
	return out.Results[0].ID, nil
}

// seedPage creates a page in the given space and folder with the ADF body and
// returns its numeric id. The body is a raw atlas_doc_format document.
func seedPage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	spaceID, parentID, title, adfJSON string,
) (string, error) {

	payload := map[string]any{
		"spaceId":  spaceID,
		"status":   "current",
		"title":    title,
		"parentId": parentID,
		"body": map[string]string{
			"representation": "atlas_doc_format",
			"value":          adfJSON,
		},
	}
	data, _ := json.Marshal(payload)
	addr := cfg.Host + "/wiki/api/v2/pages"
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, addr, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := readAllString(resp)
		return "", fmt.Errorf("create page: HTTP %d: %s", resp.StatusCode, body)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// purgePage deletes the page by id. It is used from a cleanup, so it tolerates
// an already-missing page.
func purgePage(
	ctx context.Context,
	client *http.Client,
	cfg *config,
	id string,
) error {

	addr := cfg.Host + pageEndpoint + id
	req, err := http.NewRequestWithContext(
		ctx, http.MethodDelete, addr, http.NoBody)
	if err != nil {
		return err
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("delete page %s: HTTP %d", id, resp.StatusCode)
	}
	return nil
}

func readAllString(resp *http.Response) (string, error) {
	data, err := io.ReadAll(resp.Body)
	return string(data), err
}

// uniqueTitle builds a collision-free page title for a test run.
func uniqueTitle(name string) string {
	return "cfsync-it " + name + " " + strconv.FormatInt(time.Now().UnixNano(), 36)
}
