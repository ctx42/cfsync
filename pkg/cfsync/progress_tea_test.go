// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"testing"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/ctx42/ring/pkg/ring/ringtest"
	"github.com/ctx42/testing/pkg/assert"
)

func Test_teaReporter_lazyStart(t *testing.T) {
	t.Run("finish before any event never starts the display", func(t *testing.T) {
		// --- Given --- a reporter that saw no progress event.
		tst := ringtest.New(t)
		rng := tst.Ring()
		rep := newTeaReporter(rng, "pushing", nil)

		// --- When ---
		rep.finish()

		// --- Then --- the display never ran and nothing touched stderr, so a
		// prompt shown before the first event owns the terminal alone.
		assert.False(t, rep.started)
		assert.Equal(t, "", tst.Stderr())
	})

	t.Run("the first event starts the display", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		tst.WetStderr()
		rng := tst.Ring()
		rep := newTeaReporter(rng, "pushing", nil)

		// --- When ---
		rep.discovered(3)

		// --- Then --- the display is live and finish shuts it down cleanly,
		// having written its frames to stderr.
		assert.True(t, rep.started)
		rep.finish()
		assert.True(t, tst.Stderr() != "")
	})
}

// newModel returns a progressModel clocked by clk, labelled verb, with the
// given cancel func.
func newModel(clk *clock, verb string, cancel func()) progressModel {
	return progressModel{
		trk:    newTracker(clk.now, verb),
		spin:   spinner.New(),
		cancel: cancel,
	}
}

func Test_progressModel_Init(t *testing.T) {
	// --- Given ---
	mdl := newModel(newClock(), "pulling", nil)

	// --- When --- Init starts the spinner ticking.
	have := mdl.Init()

	// --- Then ---
	assert.NotNil(t, have)
}

func Test_progressModel_Update(t *testing.T) {
	t.Run("found increments the discovered count", func(t *testing.T) {
		// --- Given ---
		mdl := newModel(newClock(), "pulling", nil)

		// --- When ---
		mdl.Update(foundMsg{})
		mdl.Update(foundMsg{})

		// --- Then ---
		assert.Equal(t, 2, mdl.trk.found)
	})

	t.Run("total ends discovery", func(t *testing.T) {
		// --- Given ---
		mdl := newModel(newClock(), "pulling", nil)

		// --- When ---
		mdl.Update(totalMsg{7})

		// --- Then ---
		assert.Equal(t, 7, mdl.trk.total)
		assert.Equal(t, phaseProcessing, mdl.trk.phase)
	})

	t.Run("item advances to the named page", func(t *testing.T) {
		// --- Given ---
		mdl := newModel(newClock(), "pulling", nil)

		// --- When ---
		mdl.Update(itemMsg{"setup.md"})

		// --- Then ---
		assert.Equal(t, 1, mdl.trk.pos)
		assert.Equal(t, "setup.md", mdl.trk.current)
	})

	t.Run("ctrl-c cancels and quits", func(t *testing.T) {
		// --- Given ---
		canceled := false
		mdl := newModel(newClock(), "pulling", func() { canceled = true })

		// --- When ---
		have, cmd := mdl.Update(tea.KeyMsg{Type: tea.KeyCtrlC})

		// --- Then --- the run is canceled and the program quits.
		assert.True(t, canceled)
		assert.True(t, have.(progressModel).quitting)
		_, ok := cmd().(tea.QuitMsg)
		assert.True(t, ok)
	})

	t.Run("quit message tears the display down", func(t *testing.T) {
		// --- Given ---
		mdl := newModel(newClock(), "pulling", nil)

		// --- When ---
		have, cmd := mdl.Update(quitMsg{})

		// --- Then ---
		assert.True(t, have.(progressModel).quitting)
		_, ok := cmd().(tea.QuitMsg)
		assert.True(t, ok)
	})

	t.Run("an unrelated key is ignored", func(t *testing.T) {
		// --- Given ---
		mdl := newModel(newClock(), "pulling", nil)

		// --- When ---
		have, cmd := mdl.Update(tea.KeyMsg{Type: tea.KeyEnter})

		// --- Then ---
		assert.False(t, have.(progressModel).quitting)
		assert.Nil(t, cmd)
	})
}

func Test_progressModel_View(t *testing.T) {
	t.Run("silent before the threshold", func(t *testing.T) {
		// --- Given ---
		mdl := newModel(newClock(), "pulling", nil)
		mdl.trk.recordFound()

		// --- When ---
		have := mdl.View()

		// --- Then ---
		assert.Equal(t, "", have)
	})

	t.Run("nothing once quitting", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		mdl := newModel(clk, "pulling", nil)
		mdl.quitting = true
		clk.tick(progressThreshold)

		// --- When ---
		have := mdl.View()

		// --- Then ---
		assert.Equal(t, "", have)
	})

	t.Run("shows the discovery count once active", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		mdl := newModel(clk, "pulling", nil)
		mdl.trk.recordFound()
		clk.tick(progressThreshold)

		// --- When ---
		have := mdl.View()

		// --- Then ---
		assert.Contain(t, "discovering… 1 pages found", have)
	})

	t.Run("shows the bar during processing", func(t *testing.T) {
		// --- Given ---
		clk := newClock()
		mdl := newModel(clk, "pulling", nil)
		mdl.trk.recordTotal(3)
		mdl.trk.recordItem("a.md")
		clk.tick(progressThreshold)

		// --- When ---
		have := mdl.View()

		// --- Then ---
		assert.Contain(t, "[1/3] pulling a.md", have)
	})
}
