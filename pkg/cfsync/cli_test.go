// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/ring/pkg/ring/ringtest"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_Main(t *testing.T) {
	t.Run("version prints to stdout and exits zero", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStdout()

		// --- When ---
		have := Main(ctx, tst.Ring("version"))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		assert.Equal(t, "cfsync dev\n", tst.Stdout())
	})

	t.Run("help prints general usage to stdout", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStdout()

		// --- When ---
		have := Main(ctx, tst.Ring("help"))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		assert.Contain(t, "Commands:", tst.Stdout())
	})

	t.Run("help for a command prints that command usage", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStdout()

		// --- When ---
		have := Main(ctx, tst.Ring("help", "pull"))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		assert.Contain(t, "cfsync pull", tst.Stdout())
	})

	t.Run("a command --help flag prints its usage to stdout", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStdout()

		// --- When ---
		have := Main(ctx, tst.Ring("pull", "--help"))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		assert.Contain(t, "cfsync pull", tst.Stdout())
	})

	t.Run("the -h alias on a command prints its usage", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStdout()

		// --- When ---
		have := Main(ctx, tst.Ring("push", "-h"))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		assert.Contain(t, "cfsync push", tst.Stdout())
	})

	t.Run("test dispatches the connection test", func(t *testing.T) {
		// --- Given --- a valid config whose host is a closed local port, so
		// the run passes config load and fails inside the connection test — an
		// outcome only test yields (every other command fails at config load,
		// so asserting on that shared failure would not prove dispatch).
		ctx := t.Context()
		env := []string{
			"CFSYNC_HOST=https://127.0.0.1:1",
			"CFSYNC_ACCOUNT=a@ex.com",
			"CFSYNC_TOKEN=secret",
			"CFSYNC_WORK_DIR=wd",
		}
		tst := ringtest.New(t, ring.WithEnv(env)).WetStderr()
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		have := Main(ctx, tst.Ring("test", "--config", path))

		// --- Then ---
		assert.Equal(t, exitErr, have)

		want := "connecting to https://127.0.0.1:1"
		assert.Contain(t, want, tst.Stderr())
	})

	t.Run("pull dispatches the page pull", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t, ring.WithEnv(secretEnv())).WetStdout()
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		have := Main(ctx, tst.Ring("pull", "--config", path))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		// Output unique to the pull path, proving pull was dispatched.
		assert.Contain(t, "nothing to pull", tst.Stdout())
	})

	t.Run("push dispatches the page push", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t, ring.WithEnv(secretEnv())).WetStdout()
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		have := Main(ctx, tst.Ring("push", "--config", path))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		// Output unique to the push path, proving push was dispatched.
		assert.Contain(t, "no pages to push", tst.Stdout())
	})

	t.Run("gc dispatches the asset scan", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t, ring.WithEnv(secretEnv())).WetStdout()
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		have := Main(ctx, tst.Ring("gc", "--config", path))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		// Output unique to the gc path, proving gc was dispatched.
		assert.Contain(t, "no orphaned assets", tst.Stdout())
	})

	t.Run("clean dispatches the cleanup", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t, ring.WithEnv(secretEnv())).WetStdout()
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		have := Main(ctx, tst.Ring("clean", "--config", path))

		// --- Then ---
		assert.Equal(t, exitOK, have)
		// Output unique to the clean path, proving clean was dispatched.
		assert.Contain(t, "nothing to clean", tst.Stdout())
	})

	t.Run("pull canceled by the user exits 130", func(t *testing.T) {
		// --- Given --- a context already canceled, as after Ctrl-C.
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		tst := ringtest.New(t, ring.WithEnv(secretEnv())).WetStdout()
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		have := Main(ctx, tst.Ring("pull", "--config", path))

		// --- Then ---
		assert.Equal(t, exitCancel, have)
		assert.Contain(t, "canceled", tst.Stdout())
	})

	t.Run("work-dir flag supplies work_dir absent from the env", func(t *testing.T) {
		// --- Given --- an environment without CFSYNC_WORK_DIR.
		ctx := t.Context()
		env := []string{
			"CFSYNC_HOST=https://ex.atlassian.net",
			"CFSYNC_ACCOUNT=a@ex.com",
			"CFSYNC_TOKEN=secret",
		}
		tst := ringtest.New(t, ring.WithEnv(env)).WetStdout()
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		args := tst.Ring("pull", "--config", path, "--work-dir", t.TempDir())
		have := Main(ctx, args)

		// --- Then --- the flag satisfied work_dir, so the pull ran.
		assert.Equal(t, exitOK, have)
		assert.Contain(t, "nothing to pull", tst.Stdout())
	})

	t.Run("env flag loads the secrets from the file", func(t *testing.T) {
		// --- Given --- an empty environment; secrets live only in the .env.
		ctx := t.Context()
		tst := ringtest.New(t, ring.WithEnv(nil)).WetStdout()
		dotenv := "" +
			"CFSYNC_HOST=https://ex.atlassian.net\n" +
			"CFSYNC_ACCOUNT=a@ex.com\n" +
			"CFSYNC_TOKEN=secret\n" +
			"CFSYNC_WORK_DIR=wd\n"
		envPath := oskit.Create(t, dotenv, t.TempDir(), envFile)
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		args := tst.Ring("pull", "--config", path, "--env", envPath)
		have := Main(ctx, args)

		// --- Then ---
		assert.Equal(t, exitOK, have)
		assert.Contain(t, "nothing to pull", tst.Stdout())
	})

	t.Run("default env file loads from beside the config file", func(t *testing.T) {
		// --- Given --- an empty environment and a .env sitting next to the
		// config file, with neither --env nor --work-dir given. Both files live
		// in a directory that is not the current one, so a CWD-relative default
		// would miss the .env and fail config validation.
		ctx := t.Context()
		tst := ringtest.New(t, ring.WithEnv(nil)).WetStdout()
		dir := t.TempDir()
		dotenv := "" +
			"CFSYNC_HOST=https://ex.atlassian.net\n" +
			"CFSYNC_ACCOUNT=a@ex.com\n" +
			"CFSYNC_TOKEN=secret\n" +
			"CFSYNC_WORK_DIR=wd\n"
		oskit.Create(t, dotenv, dir, envFile)
		path := oskit.Create(t, "", dir, configFile)

		// --- When ---
		have := Main(ctx, tst.Ring("pull", "--config", path))

		// --- Then --- the sibling .env supplied the secrets, so the pull ran.
		assert.Equal(t, exitOK, have)
		assert.Contain(t, "nothing to pull", tst.Stdout())
	})

	t.Run("error - an explicit env file is missing", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t, ring.WithEnv(nil)).WetStderr()
		missing := filepath.Join(t.TempDir(), "nope.env")

		// --- When ---
		have := Main(ctx, tst.Ring("pull", "--env", missing))

		// --- Then ---
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "reading env file", tst.Stderr())
	})

	t.Run("push refuses more than one page argument", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStderr()

		// --- When ---
		have := Main(ctx, tst.Ring("push", "one.md", "two.md"))

		// --- Then ---
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "push accepts at most one page", tst.Stderr())
	})

	t.Run("pull refuses more than one page argument", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStderr()

		// --- When ---
		have := Main(ctx, tst.Ring("pull", "one.md", "two.md"))

		// --- Then ---
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "pull accepts at most one page", tst.Stderr())
	})

	t.Run("error - no command prints usage to stderr", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStderr()

		// --- When ---
		have := Main(ctx, tst.Ring())

		// --- Then ---
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "Usage:", tst.Stderr())
	})

	t.Run("error - an unknown command prints to stderr", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStderr()

		// --- When ---
		have := Main(ctx, tst.Ring("frob"))

		// --- Then ---
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "unknown command: frob", tst.Stderr())
	})

	t.Run("error - an old flag form is an unknown command", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStderr()

		// --- When ---
		have := Main(ctx, tst.Ring("--pull"))

		// --- Then --- the hard break: --pull is no longer a flag.
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "unknown command: --pull", tst.Stderr())
	})

	t.Run("error - an unknown flag on a command prints to stderr", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStderr()

		// --- When ---
		have := Main(ctx, tst.Ring("pull", "--bogus"))

		// --- Then ---
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "flag provided but not defined: -bogus", tst.Stderr())
	})

	t.Run("error - help for an unknown command prints to stderr", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		tst := ringtest.New(t).WetStderr()

		// --- When ---
		have := Main(ctx, tst.Ring("help", "frob"))

		// --- Then ---
		assert.Equal(t, exitErr, have)
		assert.Contain(t, "unknown command: frob", tst.Stderr())
	})
}

func Test_envFilePath(t *testing.T) {
	t.Run("explicit env flag is used as given and is explicit", func(t *testing.T) {
		// --- When ---
		have, explicit := envFilePath("cfg/.cfsync.yaml", "secrets/.env")

		// --- Then ---
		assert.Equal(t, "secrets/.env", have)
		assert.True(t, explicit)
	})

	t.Run("default env sits beside the config file, not explicit", func(t *testing.T) {
		// --- When ---
		have, explicit := envFilePath("cfg/.cfsync.yaml", "")

		// --- Then ---
		assert.Equal(t, filepath.Join("cfg", envFile), have)
		assert.False(t, explicit)
	})

	t.Run("empty config falls back to the current directory", func(t *testing.T) {
		// --- When ---
		have, explicit := envFilePath("", "")

		// --- Then --- filepath.Dir(configFile) is ".", so the default is ./.env.
		assert.Equal(t, envFile, have)
		assert.False(t, explicit)
	})
}

func Test_writeUsage(t *testing.T) {
	// --- Given ---
	var buf strings.Builder

	// --- When ---
	writeUsage(&buf)

	// --- Then ---
	out := buf.String()
	assert.Contain(t, "Usage:", out)
	assert.Contain(t, "Commands:", out)
	assert.Contain(t, "test", out)
	assert.Contain(t, "pull", out)
	assert.Contain(t, "push", out)
	assert.Contain(t, "gc", out)
	assert.Contain(t, "clean", out)
	assert.Contain(t, "version", out)
	assert.Contain(t, "help", out)
}

func Test_commandUsage(t *testing.T) {
	t.Run("returns the usage for a known command", func(t *testing.T) {
		// --- When ---
		have, ok := commandUsage("pull")

		// --- Then ---
		assert.True(t, ok)
		assert.Contain(t, "cfsync pull", have)
	})

	t.Run("reports an unknown command", func(t *testing.T) {
		// --- When ---
		have, ok := commandUsage("frob")

		// --- Then ---
		assert.False(t, ok)
		assert.Equal(t, "", have)
	})
}
