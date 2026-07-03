// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"context"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/ctx42/ring/pkg/ring"
)

var _ reporter = (*teaReporter)(nil)

// Bubble Tea messages carrying progress events into the display goroutine.
type (
	// foundMsg reports one page discovered during the walk.
	foundMsg struct{}

	// totalMsg ends the discovering phase with the page total.
	totalMsg struct{ n int }

	// itemMsg reports that processing of the named page has begun.
	itemMsg struct{ name string }

	// quitMsg tells the display to tear down.
	quitMsg struct{}
)

// teaReporter drives a Bubble Tea program that renders a live spinner and
// progress bar to an interactive stderr. Progress events are sent to the
// program's goroutine as messages; per-page log lines are printed above the
// bar only when stdout is also a terminal, otherwise they stay in the caller's
// buffer bound for a redirected stdout.
type teaReporter struct {
	prog   *tea.Program
	done   chan struct{}
	stream bool

	// started records that the display program is running. It is read and
	// written only from the single pull/push loop goroutine that emits every
	// progress event and the final finish, so it needs no lock.
	started bool
}

// newTeaReporter prepares the display program on rng.Stderr, labelling
// per-page work with verb. The program does not run — and stdin stays
// untouched — until the first progress event (see [teaReporter.start]), so a
// prompt asked before the work begins owns the terminal alone. cancel is
// invoked when the user interrupts the running program, which holds the
// terminal in raw mode and so receives the interrupt as a key rather than a
// signal.
func newTeaReporter(
	rng *ring.Ring,
	verb string,
	cancel context.CancelFunc,
) *teaReporter {

	spin := spinner.New()
	spin.Spinner = spinner.MiniDot
	mdl := progressModel{
		trk:    newTracker(rng.Clock(), verb),
		spin:   spin,
		cancel: cancel,
	}
	prog := tea.NewProgram(
		mdl,
		tea.WithOutput(rng.Stderr()),
		tea.WithInput(rng.Stdin()),
	)

	return &teaReporter{
		prog:   prog,
		done:   make(chan struct{}),
		stream: onTerminalWriter(rng.Stdout()),
	}
}

// start launches the display program on the first progress event. Deferring
// the launch keeps the terminal line-buffered through anything that runs
// before the work loop — the create confirmation prompt among them — which a
// raw-mode reader would otherwise starve of its keystrokes.
func (rep *teaReporter) start() {
	if rep.started {
		return
	}
	rep.started = true
	go func() {
		_, _ = rep.prog.Run()
		close(rep.done)
	}()
}

func (rep *teaReporter) found() {
	rep.start()
	rep.prog.Send(foundMsg{})
}

func (rep *teaReporter) discovered(total int) {
	rep.start()
	rep.prog.Send(totalMsg{total})
}

func (rep *teaReporter) item(name string) {
	rep.start()
	rep.prog.Send(itemMsg{name})
}

func (rep *teaReporter) log(line string) {
	if rep.stream {
		rep.start()
		rep.prog.Println(strings.TrimRight(line, "\n"))
	}
}

func (rep *teaReporter) finish() {
	if !rep.started {
		return
	}
	rep.prog.Send(quitMsg{})
	rep.prog.Quit()
	<-rep.done
}

func (rep *teaReporter) streamsLog() bool { return rep.stream }

// progressModel is the Bubble Tea model backing teaReporter. Its tracker is
// mutated only here, in the program's own goroutine, so it is free of the data
// races that direct mutation from the pull loop would cause.
type progressModel struct {
	trk      *tracker
	spin     spinner.Model
	cancel   context.CancelFunc
	quitting bool
}

// implements tea.Model.
func (mdl progressModel) Init() tea.Cmd { return mdl.spin.Tick }

// implements tea.Model.
func (mdl progressModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case foundMsg:
		mdl.trk.recordFound()
		return mdl, nil

	case totalMsg:
		mdl.trk.recordTotal(msg.n)
		return mdl, nil

	case itemMsg:
		mdl.trk.recordItem(msg.name)
		return mdl, nil

	case tea.KeyMsg:
		if msg.Type == tea.KeyCtrlC {
			mdl.cancel()
			mdl.quitting = true
			return mdl, tea.Quit
		}
		return mdl, nil

	case quitMsg:
		mdl.quitting = true
		return mdl, tea.Quit

	case spinner.TickMsg:
		var cmd tea.Cmd
		mdl.spin, cmd = mdl.spin.Update(msg)
		return mdl, cmd
	}
	return mdl, nil
}

// implements tea.Model.
func (mdl progressModel) View() string {
	if mdl.quitting || !mdl.trk.active() {
		return ""
	}
	if mdl.trk.phase == phaseDiscovering {
		return mdl.spin.View() + " " + mdl.trk.bar() + "\n"
	}
	return mdl.trk.bar() + "\n"
}
