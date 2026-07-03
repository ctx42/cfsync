// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

package cfsync

import (
	"context"
	"net/http"
	"testing"

	"github.com/ctx42/ring/pkg/ring"
)

// Environment variables that configure the live integration tests. All carry
// the CFSYNC_TEST_ prefix so they never collide with the production CFSYNC_*
// configuration read by [config.override].
const (
	envTestHost    = "CFSYNC_TEST_HOST"
	envTestAccount = "CFSYNC_TEST_ACCOUNT"
	envTestToken   = "CFSYNC_TEST_TOKEN" //nolint:gosec // Var name, not a secret.
	envTestSpace   = "CFSYNC_TEST_SPACE"
	envTestFolder  = "CFSYNC_TEST_FOLDER"
	// envExplorePages is a comma-separated list of page ids for the read-only
	// exploration test; empty skips that test.
	envExplorePages = "CFSYNC_TEST_EXPLORE_PAGES"
)

// liveEnvFile is an optional dotenv file at the repository root supplying the
// live-test environment. A value already set in the environment wins over it.
const liveEnvFile = "../../.env"

// liveParams is the live-test target read from the environment.
type liveParams struct {
	// space is the Confluence space key throwaway test pages are created in.
	space string

	// folder is an optional parent folder id under space; an empty value
	// parents created pages to the space root.
	folder string

	// explore is a comma-separated list of page ids for the read-only
	// exploration test; empty skips that test.
	explore string
}

// liveEnv loads the optional dotenv file, then returns a context, client, and
// config built from the CFSYNC_* environment together with the test target. It
// skips the test when host, account, token, or test space is unset, so the
// integration tests run only when the environment (or .env) supplies
// them.
func liveEnv(t *testing.T) (context.Context, *http.Client, *config, liveParams) {
	t.Helper()
	rng := ring.New()
	if err := loadEnvFile(rng, liveEnvFile, false); err != nil {
		t.Fatalf("loading %s: %s", liveEnvFile, err)
	}

	host := rng.EnvGet(envTestHost)
	account := rng.EnvGet(envTestAccount)
	token := rng.EnvGet(envTestToken)
	space := rng.EnvGet(envTestSpace)
	if host == "" || account == "" || token == "" || space == "" {
		t.Skipf("live tests need %s, %s, %s and %s (or a %s file)",
			envTestHost, envTestAccount, envTestToken, envTestSpace, liveEnvFile)
	}

	cfg := &config{
		Host:    host,
		Account: account,
		Token:   token,
		WorkDir: t.TempDir(),
	}
	lp := liveParams{
		space:   space,
		folder:  rng.EnvGet(envTestFolder),
		explore: rng.EnvGet(envExplorePages),
	}
	return t.Context(), http.DefaultClient, cfg, lp
}
