// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/ctx42/ring/pkg/ring"
)

// userEndpoint is the Confluence path returning the authenticated user.
const userEndpoint = "/wiki/rest/api/user/current"

// checkConn loads the configuration from the path and runs the connection
// test, returning the success message to print and any error.
func checkConn(
	ctx context.Context,
	rng *ring.Ring,
	path string,
) (string, error) {

	cfg, err := loadConfig(rng, path)
	if err != nil {
		return "", err
	}

	return connectionTest(ctx, http.DefaultClient, cfg)
}

// atlassianUser models the fields cfsync reads from the Confluence
// current-user response.
type atlassianUser struct {
	AccountID string `json:"accountId"`
}

// connectionTest sends the authenticated current-user request described by cfg
// using client and returns the success message to print and any error.
func connectionTest(
	ctx context.Context,
	client *http.Client,
	cfg *config,
) (string, error) {

	account, err := currentAccountID(ctx, client, cfg)
	if err != nil {
		return "", err
	}
	format := "cfsync: connected to %s as %s\n"
	return fmt.Sprintf(format, cfg.Host, account), nil
}

// currentAccountID sends the authenticated current-user request described by
// cfg using client and returns the account id of the authenticated user. It is
// the account a created page is restricted to, so the page is visible only to
// the credentialed author (see restrictToAuthor).
func currentAccountID(
	ctx context.Context,
	client *http.Client,
	cfg *config,
) (string, error) {

	ctx, cancel := cfg.withReqTimeout(ctx)
	defer cancel()

	req, err := newUserRequest(ctx, cfg)
	if err != nil {
		return "", fmt.Errorf("connecting to %s: %w", cfg.Host, err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("connecting to %s: %w", cfg.Host, err)
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusUnauthorized,
		resp.StatusCode == http.StatusForbidden:
		format := "authentication rejected by %s (HTTP %d)"
		return "", fmt.Errorf(format, cfg.Host, resp.StatusCode)

	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		format := "connecting to %s: HTTP %d"
		return "", fmt.Errorf(format, cfg.Host, resp.StatusCode)
	}

	var user atlassianUser
	if err = json.NewDecoder(resp.Body).Decode(&user); err != nil {
		format := "connecting to %s: invalid response: %w"
		return "", fmt.Errorf(format, cfg.Host, err)
	}
	if user.AccountID == "" {
		format := "connecting to %s: response has no accountId"
		return "", fmt.Errorf(format, cfg.Host)
	}
	return user.AccountID, nil
}

// newUserRequest builds the authenticated current-user GET request for cfg.
func newUserRequest(ctx context.Context, cfg *config) (*http.Request, error) {
	url := cfg.Host + userEndpoint
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	req.SetBasicAuth(cfg.Account, cfg.Token)
	return req, nil
}
