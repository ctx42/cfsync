// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package install

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_installTo(t *testing.T) {
	t.Run("devel embeds fixed build date", func(t *testing.T) {
		// --- Given --- the module root as the build source and a fresh
		// destination; a devel build info so the source is the working tree, and
		// a fixed clock so the embedded build date is deterministic.
		fixed := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
		rng := ring.New(ring.WithClock(func() time.Time { return fixed }))
		src := must.Value(filepath.Abs("../.."))
		dst := t.TempDir()
		info := &debug.BuildInfo{Main: debug.Module{Version: "(devel)"}}

		// --- When ---
		err := installTo(context.Background(), rng, info, src, dst)

		// --- Then --- the binary reports the injected build date, proving the
		// ldflags injection supplied it rather than the vcs.time fallback (which
		// would show the real commit time, not the fixed clock).
		assert.NoError(t, err)

		bin := filepath.Join(dst, binaryName())
		assert.FileExist(t, bin)

		out := must.Value(exec.Command(bin, "version").Output())
		assert.Contain(t, "build date: 2026-07-09T12:00:00Z", string(out))
	})
}

func Test_Main(t *testing.T) {
	t.Run("error - nil build info", func(t *testing.T) {
		// --- When ---
		err := Main(context.Background(), ring.New(), nil)

		// --- Then ---
		assert.ErrorContain(t, "build info unavailable", err)
	})
}

func Test_sourceDir(t *testing.T) {
	t.Run("devel uses module root", func(t *testing.T) {
		// --- Given ---
		rng := ring.New()
		info := &debug.BuildInfo{Main: debug.Module{Version: "(devel)"}}
		want := must.Value(filepath.Abs("../.."))

		// --- When ---
		have, err := sourceDir(context.Background(), rng, info)

		// --- Then --- not the package cwd; ./cmd/cfsync must resolve.
		assert.NoError(t, err)
		assert.Equal(t, want, have)
	})
}

func Test_goBinPath(t *testing.T) {
	t.Run("GOBIN set", func(t *testing.T) {
		// --- Given --- an environment whose only GOBIN is the one under test.
		env := slices.DeleteFunc(os.Environ(), func(e string) bool {
			return strings.HasPrefix(e, "GOBIN=")
		})
		env = append(env, "GOBIN="+filepath.FromSlash("/custom/bin"))
		rng := ring.New(ring.WithEnv(env))

		// --- When ---
		have, err := goBinPath(context.Background(), rng)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, filepath.FromSlash("/custom/bin"), have)
	})

	t.Run("GOPATH fallback", func(t *testing.T) {
		// --- Given --- an environment with no GOBIN and a known GOPATH; GOENV=off
		// keeps a user go env config file from reintroducing GOBIN.
		env := slices.DeleteFunc(os.Environ(), func(e string) bool {
			return strings.HasPrefix(e, "GOBIN=") ||
				strings.HasPrefix(e, "GOPATH=")
		})
		env = append(env,
			"GOENV=off", "GOPATH="+filepath.FromSlash("/custom/go"))
		rng := ring.New(ring.WithEnv(env))

		// --- When ---
		have, err := goBinPath(context.Background(), rng)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, filepath.FromSlash("/custom/go/bin"), have)
	})

	t.Run("multi-entry GOPATH uses first", func(t *testing.T) {
		// --- Given ---
		env := slices.DeleteFunc(os.Environ(), func(e string) bool {
			return strings.HasPrefix(e, "GOBIN=") ||
				strings.HasPrefix(e, "GOPATH=")
		})
		gopath := filepath.FromSlash("/first/go") + string(os.PathListSeparator) +
			filepath.FromSlash("/second/go")
		env = append(env, "GOENV=off", "GOPATH="+gopath)
		rng := ring.New(ring.WithEnv(env))

		// --- When ---
		have, err := goBinPath(context.Background(), rng)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, filepath.FromSlash("/first/go/bin"), have)
	})

}

func Test_binaryName(t *testing.T) {
	// --- Given ---
	want := "cfsync"
	if runtime.GOOS == "windows" {
		want = "cfsync.exe"
	}

	// --- When ---
	have := binaryName()

	// --- Then ---
	assert.Equal(t, want, have)
}
