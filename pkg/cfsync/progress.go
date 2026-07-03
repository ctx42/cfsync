// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/ctx42/ring/pkg/ring"
)

// onTerminalWriter reports whether w is an interactive terminal. A non-file
// writer (a test buffer, a pipe, a redirect) is never a terminal.
func onTerminalWriter(w io.Writer) bool {
	file, ok := w.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}

// Progress display tuning.
const (
	// progressThreshold is the minimum elapsed time before any progress is
	// shown, so a quick pull or push stays silent.
	progressThreshold = 1500 * time.Millisecond

	// progressInterval is the minimum gap between successive non-terminal
	// heartbeat lines.
	progressInterval = 1 * time.Second

	// progressBarWidth is the cell width of the drawn progress bar.
	progressBarWidth = 20
)

// reporter receives progress events during a long-running pull or push. The
// pull and push flows drive it at four points: found for each page discovered
// during the walk, discovered once the walk finishes and the total is known,
// item as each page starts processing, and log as each page's result line is
// produced. finish tears down any live display. streamsLog reports whether the
// reporter already emitted the per-page log itself, so the caller omits that
// log from stdout to avoid printing it twice.
type reporter interface {
	found()
	discovered(total int)
	item(name string)
	log(line string)
	finish()
	streamsLog() bool
}

var (
	_ reporter = noopReporter{}
	_ reporter = (*plainReporter)(nil)
)

// newReporter builds the progress reporter for a pull or push whose per-page
// lines use verb. It renders a live bar to an interactive stderr and drives
// cancel when the user interrupts it there; otherwise it falls back to
// time-gated heartbeat lines on a non-terminal stderr. cancel stops the run
// from within the terminal display, which holds the terminal in raw mode and
// so never sees the interrupt signal itself.
func newReporter(
	rng *ring.Ring,
	verb string,
	cancel context.CancelFunc,
) reporter {

	if onTerminalWriter(rng.Stderr()) {
		return newTeaReporter(rng, verb, cancel)
	}
	return newPlainReporter(rng.Clock(), verb, rng.Stderr())
}

// progressPhase distinguishes the discovery walk, whose size is unknown until
// it ends, from the page-processing pass, whose total is known.
type progressPhase int

const (
	phaseDiscovering progressPhase = iota
	phaseProcessing
)

// tracker is the pure progress model shared by the terminal and non-terminal
// reporters. It counts discovery and processing events, decides when enough
// time has elapsed to show progress, and renders the status lines. It performs
// no I/O; the clock is injected so its timing is testable.
type tracker struct {
	now       func() time.Time
	threshold time.Duration
	interval  time.Duration
	verb      string

	start    time.Time
	phase    progressPhase
	found    int
	total    int
	pos      int
	current  string
	lastBeat time.Time
	beaten   bool
}

// newTracker returns a tracker started at now, whose per-page lines use verb
// ("pulling" or "pushing"). It begins in the discovering phase.
func newTracker(now func() time.Time, verb string) *tracker {
	return &tracker{
		now:       now,
		threshold: progressThreshold,
		interval:  progressInterval,
		verb:      verb,
		start:     now(),
		phase:     phaseDiscovering,
	}
}

// recordFound counts one page discovered during the walk.
func (trk *tracker) recordFound() { trk.found++ }

// recordTotal ends the discovering phase, fixing the number of pages that the
// processing pass will handle.
func (trk *tracker) recordTotal(total int) {
	trk.total = total
	trk.phase = phaseProcessing
}

// recordItem advances to the page named name.
func (trk *tracker) recordItem(name string) {
	trk.pos++
	trk.current = name
}

// active reports whether progress has run long enough to be shown.
func (trk *tracker) active() bool {
	return trk.now().Sub(trk.start) >= trk.threshold
}

// bar renders the full-width status line for a terminal: a running count of
// discovered pages during the walk, or the position, current page, drawn bar,
// and percent during processing.
func (trk *tracker) bar() string {
	if trk.phase == phaseDiscovering {
		return fmt.Sprintf("discovering… %d pages found", trk.found)
	}
	width := len(strconv.Itoa(trk.total))
	bar := renderBar(trk.pos, trk.total)
	pct := percent(trk.pos, trk.total)
	format := "[%*d/%d] %s %s %s %3d%%"
	return fmt.Sprintf(
		format, width, trk.pos, trk.total, trk.verb, trk.current, bar, pct,
	)
}

// beat returns the next non-terminal heartbeat line and true when one is due:
// progress has passed the threshold and the interval since the last beat has
// elapsed. It records the beat time as a side effect.
func (trk *tracker) beat() (string, bool) {
	now := trk.now()
	if now.Sub(trk.start) < trk.threshold {
		return "", false
	}
	if trk.beaten && now.Sub(trk.lastBeat) < trk.interval {
		return "", false
	}
	trk.lastBeat = now
	trk.beaten = true
	return trk.heartbeat(), true
}

// heartbeat renders the compact, bar-free status line written to a
// non-terminal stderr.
func (trk *tracker) heartbeat() string {
	if trk.phase == phaseDiscovering {
		return fmt.Sprintf("discovering… %d pages found", trk.found)
	}
	width := len(strconv.Itoa(trk.total))
	format := "[%*d/%d] %s…"
	return fmt.Sprintf(format, width, trk.pos, trk.total, trk.verb)
}

// percent returns pos as a whole-number percentage of total, clamped to 100,
// or 0 when total is not positive.
func percent(pos, total int) int {
	if total <= 0 {
		return 0
	}
	if pos >= total {
		return 100
	}
	return pos * 100 / total
}

// renderBar draws a progress bar of progressBarWidth cells filled to the pos of
// total ratio.
func renderBar(pos, total int) string {
	filled := percent(pos, total) * progressBarWidth / 100
	return "▕" +
		strings.Repeat("█", filled) +
		strings.Repeat("░", progressBarWidth-filled) +
		"▏"
}

// noopReporter is the reporter used when nothing should be displayed: every
// command path that is not a long-running pull or push, and the zero-value
// fallback for a config with no reporter set.
type noopReporter struct{}

func (noopReporter) found()           {}
func (noopReporter) discovered(int)   {}
func (noopReporter) item(string)      {}
func (noopReporter) log(string)       {}
func (noopReporter) finish()          {}
func (noopReporter) streamsLog() bool { return false }

// plainReporter writes time-gated heartbeat lines to a non-terminal stderr. It
// does not stream the per-page log: those lines stay in the caller's buffer and
// reach stdout unchanged.
type plainReporter struct {
	trk *tracker
	err io.Writer
}

// newPlainReporter returns a plainReporter tracking verb-labelled progress,
// clocked by now, writing heartbeats to err.
func newPlainReporter(
	now func() time.Time,
	verb string,
	err io.Writer,
) *plainReporter {

	return &plainReporter{trk: newTracker(now, verb), err: err}
}

func (rep *plainReporter) found() {
	rep.trk.recordFound()
	rep.beat()
}

func (rep *plainReporter) discovered(total int) { rep.trk.recordTotal(total) }

func (rep *plainReporter) item(name string) {
	rep.trk.recordItem(name)
	rep.beat()
}

func (rep *plainReporter) log(string) {}

func (rep *plainReporter) finish() {}

func (rep *plainReporter) streamsLog() bool { return false }

// beat writes one heartbeat line to stderr when the tracker says one is due.
func (rep *plainReporter) beat() {
	if line, ok := rep.trk.beat(); ok {
		_, _ = fmt.Fprintln(rep.err, line)
	}
}
