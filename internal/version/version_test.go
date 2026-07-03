// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package version

import (
	"runtime/debug"
	"testing"
	"time"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/testing/pkg/assert"
)

func Test_Line(t *testing.T) {
	t.Run("nil info falls back to dev", func(t *testing.T) {
		// --- When ---
		have := Line("cfsync", nil)

		// --- Then ---
		assert.Equal(t, "cfsync dev", have)
	})

	t.Run("module version only", func(t *testing.T) {
		// --- Given ---
		info := &debug.BuildInfo{Main: debug.Module{Version: "v1.2.3"}}

		// --- When ---
		have := Line("cfsync", info)

		// --- Then ---
		assert.Equal(t, "cfsync v1.2.3", have)
	})

	t.Run("vcs metadata renders every field", func(t *testing.T) {
		// --- Given ---
		info := &debug.BuildInfo{
			Main: debug.Module{Version: "(devel)"},
			Settings: []debug.BuildSetting{
				{Key: "vcs.revision", Value: "abc1234def567"},
				{Key: "vcs.time", Value: "2026-07-09T12:00:00Z"},
				{Key: "vcs.modified", Value: "true"},
			},
		}

		// --- When ---
		have := Line("cfsync", info)

		// --- Then ---
		want := "cfsync dev, hash: abc1234, " +
			"build date: 2026-07-09T12:00:00Z, scm state: dirty"
		assert.Equal(t, want, have)
	})

	t.Run("vcs.modified false is clean", func(t *testing.T) {
		// --- Given ---
		info := &debug.BuildInfo{
			Settings: []debug.BuildSetting{
				{Key: "vcs.modified", Value: "false"},
			},
		}

		// --- When ---
		have := Line("cfsync", info)

		// --- Then ---
		assert.Equal(t, "cfsync dev, scm state: clean", have)
	})

	t.Run("short hash is kept as-is", func(t *testing.T) {
		// --- Given ---
		info := &debug.BuildInfo{
			Settings: []debug.BuildSetting{
				{Key: "vcs.revision", Value: "abc"},
			},
		}

		// --- When ---
		have := Line("cfsync", info)

		// --- Then ---
		assert.Equal(t, "cfsync dev, hash: abc", have)
	})

	t.Run("vcs fields only omit missing version via dev", func(t *testing.T) {
		// --- Given ---
		info := &debug.BuildInfo{
			Settings: []debug.BuildSetting{
				{Key: "vcs.revision", Value: "deadbeef"},
				{Key: "vcs.time", Value: "2026-01-01T00:00:00Z"},
			},
		}

		// --- When ---
		have := Line("cfsync", info)

		// --- Then ---
		want := "cfsync dev, hash: deadbee, build date: 2026-01-01T00:00:00Z"
		assert.Equal(t, want, have)
	})

	t.Run("injected build vars win over build info", func(t *testing.T) {
		// --- Given ---
		saveBuildVars(t)
		buildRev = "v9.9.9"
		buildHash = "feedfac"
		buildDate = "2026-02-02T00:00:00Z"
		buildState = "clean"
		info := &debug.BuildInfo{Main: debug.Module{Version: "v1.2.3"}}

		// --- When ---
		have := Line("cfsync", info)

		// --- Then ---
		want := "cfsync v9.9.9, hash: feedfac, " +
			"build date: 2026-02-02T00:00:00Z, scm state: clean"
		assert.Equal(t, want, have)
	})
}

func Test_LDFlags(t *testing.T) {
	t.Run("emits an -X definition per known field", func(t *testing.T) {
		// --- Given ---
		fixed := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
		rng := ring.New(ring.WithClock(func() time.Time { return fixed }))
		info := &debug.BuildInfo{
			Main: debug.Module{Version: "v1.2.3"},
			Settings: []debug.BuildSetting{
				{Key: "vcs.revision", Value: "abc1234def567"},
				{Key: "vcs.modified", Value: "false"},
			},
		}

		// --- When ---
		have := LDFlags(rng, info)

		// --- Then ---
		want := "-X github.com/ctx42/cfsync/internal/version.buildRev=v1.2.3 " +
			"-X github.com/ctx42/cfsync/internal/version.buildHash=abc1234 " +
			"-X github.com/ctx42/cfsync/internal/version." +
			"buildDate=2026-07-09T12:00:00Z " +
			"-X github.com/ctx42/cfsync/internal/version.buildState=clean"
		assert.Equal(t, want, have)
	})

	t.Run("omits fields the build info lacks", func(t *testing.T) {
		// --- Given --- a devel build info: no version, no vcs settings.
		fixed := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
		rng := ring.New(ring.WithClock(func() time.Time { return fixed }))
		info := &debug.BuildInfo{Main: debug.Module{Version: "(devel)"}}

		// --- When ---
		have := LDFlags(rng, info)

		// --- Then --- only the build date is known.
		want := "-X github.com/ctx42/cfsync/internal/version." +
			"buildDate=2026-07-09T12:00:00Z"
		assert.Equal(t, want, have)
	})

	t.Run("nil info still stamps build date", func(t *testing.T) {
		// --- Given ---
		fixed := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
		rng := ring.New(ring.WithClock(func() time.Time { return fixed }))

		// --- When ---
		have := LDFlags(rng, nil)

		// --- Then ---
		want := "-X github.com/ctx42/cfsync/internal/version." +
			"buildDate=2026-07-09T12:00:00Z"
		assert.Equal(t, want, have)
	})
}
