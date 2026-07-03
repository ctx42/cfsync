// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"net/http"
	"testing"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/httpkit"
)

func Test_checkConn(t *testing.T) {
	t.Run("error - configuration cannot be loaded", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		rng := ring.New(ring.WithEnv(nil))
		path := "does-not-exist.yaml"

		// --- When ---
		have, err := checkConn(ctx, rng, path)

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorRegexp(t, "reading config.*does-not-exist.yaml", err)
	})
}

func Test_connectionTest(t *testing.T) {
	t.Run("sends an authenticated GET to the user endpoint", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"accountId":"acc-1"}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := connectionTest(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "connected to", have)
		assert.Contain(t, "acc-1", have)

		req := srv.Request(0)
		assert.Equal(t, http.MethodGet, req.Method)
		assert.Equal(t, userEndpoint, req.URL.Path)

		user, pass, ok := req.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "a@ex.com", user)
		assert.Equal(t, "secret", pass)
	})

	t.Run("accepts a 2xx status other than 200", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t).
			Rsp(http.StatusCreated, []byte(`{"accountId":"acc-1"}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := connectionTest(ctx, client, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Contain(t, "acc-1", have)
	})

	t.Run("error - request cannot be sent", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		client := http.DefaultClient
		srv := httpkit.NewServer(t)
		host := srv.URL()
		_ = srv.Close() // Nothing listens on the address anymore.
		cfg := &config{Host: host, Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := connectionTest(ctx, client, cfg)

		// --- Then ---
		assert.Equal(t, "", have)
		assert.ErrorContain(t, "connecting to", err)
	})
}

func Test_connectionTest_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		status  int
		body    string
		wantErr string
	}{
		{
			"error - unauthorized",
			http.StatusUnauthorized,
			``,
			"authentication rejected",
		},
		{"error - forbidden", http.StatusForbidden, ``, "authentication rejected"},
		{"error - server error", http.StatusInternalServerError, ``, "HTTP 500"},
		{"error - not found", http.StatusNotFound, ``, "HTTP 404"},
		{"error - missing account id", http.StatusOK, `{}`, "no accountId"},
		{"error - invalid json", http.StatusOK, `{`, "invalid response"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			ctx := t.Context()
			client := http.DefaultClient
			srv := httpkit.NewServer(t).Rsp(tc.status, []byte(tc.body))
			cfg := &config{
				Host:    srv.URL(),
				Account: "a@ex.com",
				Token:   "secret",
			}

			// --- When ---
			have, err := connectionTest(ctx, client, cfg)

			// --- Then ---
			assert.Equal(t, "", have)
			assert.ErrorContain(t, tc.wantErr, err)
		})
	}
}

func Test_newUserRequest(t *testing.T) {
	t.Run("builds an authenticated current-user request", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		cfg := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
		}

		// --- When ---
		have, err := newUserRequest(ctx, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, http.MethodGet, have.Method)
		want := "https://ex.atlassian.net" + userEndpoint
		assert.Equal(t, want, have.URL.String())

		user, pass, ok := have.BasicAuth()
		assert.True(t, ok)
		assert.Equal(t, "a@ex.com", user)
		assert.Equal(t, "secret", pass)
	})

	t.Run("error - host is not a valid URL", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		cfg := &config{Host: "https://ex\x7f.net", Token: "secret"}

		// --- When ---
		have, err := newUserRequest(ctx, cfg)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "building request", err)
	})
}
