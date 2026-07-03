// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/ctx42/ring/pkg/ring/ringtest"
	"github.com/ctx42/testing/pkg/assert"
)

// clock is a controllable time source for progress tests.
type clock struct{ t time.Time }

// now returns the clock's current time.
func (clk *clock) now() time.Time { return clk.t }

// tick advances the clock by d.
func (clk *clock) tick(d time.Duration) { clk.t = clk.t.Add(d) }

// newClock returns a clock at a fixed, arbitrary base time.
func newClock() *clock { return &clock{t: time.Unix(1000, 0)} }

func Test_percent_tabular(t *testing.T) {
	tt := []struct {
		testN string
		pos   int
		total int
		want  int
	}{
		{"zero total", 3, 0, 0},
		{"negative total", 3, -1, 0},
		{"none done", 0, 10, 0},
		{"half done", 131, 262, 50},
		{"all done", 10, 10, 100},
		{"over total clamps", 12, 10, 100},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := percent(tc.pos, tc.total)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_renderBar(t *testing.T) {
	t.Run("half filled", func(t *testing.T) {
		// --- When ---
		have := renderBar(131, 262)

		// --- Then ---
		assert.Equal(t, "▕██████████░░░░░░░░░░▏", have)
	})

	t.Run("empty", func(t *testing.T) {
		// --- When ---
		have := renderBar(0, 10)

		// --- Then ---
		assert.Equal(t, "▕░░░░░░░░░░░░░░░░░░░░▏", have)
	})

	t.Run("full", func(t *testing.T) {
		// --- When ---
		have := renderBar(10, 10)

		// --- Then ---
		assert.Equal(t, "▕████████████████████▏", have)
	})
}

func Test_newTracker(t *testing.T) {
	// --- Given ---
	clk := newClock()

	// --- When ---
	have := newTracker(clk.now, "pulling")

	// --- Then ---
	assert.Equal(t, "pulling", have.verb)
	assert.Equal(t, clk.now(), have.start)
	assert.Equal(t, phaseDiscovering, have.phase)
	assert.Equal(t, progressThreshold, have.threshold)
	assert.Equal(t, progressInterval, have.interval)
}

func Test_tracker_recordFound(t *testing.T) {
	// --- Given ---
	trk := newTracker(newClock().now, "pulling")

	// --- When ---
	trk.recordFound()
	trk.recordFound()

	// --- Then ---
	assert.Equal(t, 2, trk.found)
}

func Test_tracker_recordTotal(t *testing.T) {
	// --- Given ---
	trk := newTracker(newClock().now, "pulling")

	// --- When ---
	trk.recordTotal(7)

	// --- Then ---
	assert.Equal(t, 7, trk.total)
	assert.Equal(t, phaseProcessing, trk.phase)
}

func Test_tracker_recordItem(t *testing.T) {
	// --- Given ---
	trk := newTracker(newClock().now, "pulling")

	// --- When ---
	trk.recordItem("setup.md")
	trk.recordItem("faq.md")

	// --- Then ---
	assert.Equal(t, 2, trk.pos)
	assert.Equal(t, "faq.md", trk.current)
}

func Test_tracker_active(t *testing.T) {
	t.Run("silent before the threshold", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		trk := newTracker(clk.now, "pulling")

		// --- When --- just short of the threshold.
		clk.tick(progressThreshold - time.Millisecond)

		// --- Then ---
		assert.False(t, trk.active())
	})

	t.Run("active at the threshold", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		trk := newTracker(clk.now, "pulling")

		// --- When ---
		clk.tick(progressThreshold)

		// --- Then ---
		assert.True(t, trk.active())
	})
}

func Test_tracker_bar(t *testing.T) {
	t.Run("discovering counts found pages", func(t *testing.T) {
		// --- Given ---
		trk := newTracker(newClock().now, "pulling")
		trk.recordFound()
		trk.recordFound()

		// --- When ---
		have := trk.bar()

		// --- Then ---
		assert.Equal(t, "discovering… 2 pages found", have)
	})

	t.Run("processing shows position bar and percent", func(t *testing.T) {
		// --- Given ---
		trk := newTracker(newClock().now, "pulling")
		trk.recordTotal(262)
		for range 131 {
			trk.recordItem("setup.md")
		}

		// --- When ---
		have := trk.bar()

		// --- Then ---
		want := "[131/262] pulling setup.md ▕██████████░░░░░░░░░░▏  50%"
		assert.Equal(t, want, have)
	})

	t.Run("position is padded to the total width", func(t *testing.T) {
		// --- Given ---
		trk := newTracker(newClock().now, "pushing")
		trk.recordTotal(263)
		trk.recordItem("a.md")

		// --- When ---
		have := trk.bar()

		// --- Then ---
		assert.Contain(t, "[  1/263] pushing a.md ", have)
	})
}

func Test_tracker_beat(t *testing.T) {
	t.Run("no beat before the threshold", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		trk := newTracker(clk.now, "pulling")

		// --- When ---
		line, ok := trk.beat()

		// --- Then ---
		assert.False(t, ok)
		assert.Equal(t, "", line)
	})

	t.Run("beats once past the threshold", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		trk := newTracker(clk.now, "pulling")
		trk.recordFound()

		// --- When ---
		clk.tick(progressThreshold)
		line, ok := trk.beat()

		// --- Then ---
		assert.True(t, ok)
		assert.Equal(t, "discovering… 1 pages found", line)
	})

	t.Run("does not beat again within the interval", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		trk := newTracker(clk.now, "pulling")
		clk.tick(progressThreshold)
		_, first := trk.beat()

		// --- When --- less than one interval later.
		clk.tick(progressInterval - time.Millisecond)
		_, second := trk.beat()

		// --- Then ---
		assert.True(t, first)
		assert.False(t, second)
	})

	t.Run("beats again after the interval", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		trk := newTracker(clk.now, "pulling")
		clk.tick(progressThreshold)
		_, first := trk.beat()

		// --- When ---
		clk.tick(progressInterval)
		_, second := trk.beat()

		// --- Then ---
		assert.True(t, first)
		assert.True(t, second)
	})
}

func Test_tracker_heartbeat(t *testing.T) {
	t.Run("discovering", func(t *testing.T) {
		// --- Given ---
		trk := newTracker(newClock().now, "pulling")
		trk.recordFound()

		// --- When ---
		have := trk.heartbeat()

		// --- Then ---
		assert.Equal(t, "discovering… 1 pages found", have)
	})

	t.Run("processing omits the bar", func(t *testing.T) {
		// --- Given ---
		trk := newTracker(newClock().now, "pushing")
		trk.recordTotal(263)
		trk.recordItem("a.md")

		// --- When ---
		have := trk.heartbeat()

		// --- Then ---
		assert.Equal(t, "[  1/263] pushing…", have)
	})
}

func Test_noopReporter(t *testing.T) {
	// --- Given ---
	var rep noopReporter

	// --- When --- every event is a safe no-op.
	rep.found()
	rep.discovered(3)
	rep.item("a")
	rep.log("line")
	rep.finish()

	// --- Then ---
	assert.False(t, rep.streamsLog())
}

func Test_config_reporter(t *testing.T) {
	t.Run("nil report yields a noop reporter", func(t *testing.T) {
		// --- Given ---
		cfg := &config{}

		// --- When ---
		have := cfg.reporter()

		// --- Then ---
		assert.Equal(t, noopReporter{}, have)
	})

	t.Run("returns the set reporter", func(t *testing.T) {
		// --- Given ---
		rep := &plainReporter{}
		cfg := &config{report: rep}

		// --- When ---
		have := cfg.reporter()

		// --- Then ---
		assert.Equal(t, rep, have)
	})
}

func Test_config_stdoutText(t *testing.T) {
	t.Run("prepends the log when not streamed", func(t *testing.T) {
		// --- Given ---
		cfg := &config{report: noopReporter{}}

		// --- When ---
		have := cfg.stdoutText("log\n", "summary\n")

		// --- Then ---
		assert.Equal(t, "log\nsummary\n", have)
	})

	t.Run("summary only when streamed", func(t *testing.T) {
		// --- Given ---
		cfg := &config{report: streamReporter{}}

		// --- When ---
		have := cfg.stdoutText("log\n", "summary\n")

		// --- Then ---
		assert.Equal(t, "summary\n", have)
	})
}

// streamReporter is a noopReporter that claims to have streamed the log, for
// exercising the streaming branch of [config.stdout].
type streamReporter struct{ noopReporter }

func (streamReporter) streamsLog() bool { return true }

func Test_newPlainReporter(t *testing.T) {
	// --- Given ---
	clk := newClock()
	var buf bytes.Buffer

	// --- When ---
	have := newPlainReporter(clk.now, "pulling", &buf)

	// --- Then ---
	assert.Equal(t, "pulling", have.trk.verb)
	assert.False(t, have.streamsLog())
}

func Test_plainReporter(t *testing.T) {
	t.Run("silent before the threshold", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		var buf bytes.Buffer
		rep := newPlainReporter(clk.now, "pulling", &buf)

		// --- When ---
		rep.found()
		rep.item("a")

		// --- Then ---
		assert.Equal(t, "", buf.String())
	})

	t.Run("writes a discovery heartbeat past the threshold", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		var buf bytes.Buffer
		rep := newPlainReporter(clk.now, "pulling", &buf)

		// --- When ---
		clk.tick(progressThreshold)
		rep.found()

		// --- Then ---
		assert.Equal(t, "discovering… 1 pages found\n", buf.String())
	})

	t.Run("writes a processing heartbeat", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		var buf bytes.Buffer
		rep := newPlainReporter(clk.now, "pulling", &buf)
		rep.discovered(3)

		// --- When ---
		clk.tick(progressThreshold)
		rep.item("a")

		// --- Then ---
		assert.Equal(t, "[1/3] pulling…\n", buf.String())
	})

	t.Run("log writes nothing and does not stream", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		var buf bytes.Buffer
		rep := newPlainReporter(clk.now, "pulling", &buf)
		clk.tick(progressThreshold)

		// --- When ---
		rep.log("pulling a ... ok (v1)\n")

		// --- Then ---
		assert.Equal(t, "", buf.String())
		assert.False(t, rep.streamsLog())
	})
}

func Test_onTerminalWriter(t *testing.T) {
	// --- Given --- a buffer is never a terminal.
	var buf bytes.Buffer

	// --- When ---
	have := onTerminalWriter(&buf)

	// --- Then ---
	assert.False(t, have)
}

func Test_newReporter(t *testing.T) {
	// --- Given --- a ring whose stderr is a buffer, not a terminal.
	rng := ringtest.New(t).Ring()

	// --- When ---
	have := newReporter(rng, "pulling", context.CancelFunc(func() {}))

	// --- Then --- the non-terminal path yields a plain reporter.
	_, ok := have.(*plainReporter)
	assert.True(t, ok)
	assert.False(t, have.streamsLog())
}
