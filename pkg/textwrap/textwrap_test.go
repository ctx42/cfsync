// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package textwrap

import (
	"testing"

	"github.com/ctx42/goldkit/pkg/goldkit"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
)

func Test_Wrap_tabular(t *testing.T) {
	tt := []struct {
		testN string
		file  string
	}{
		{"basic reflow", "testdata/basic.yml"},
		{"hyphenated word stays intact", "testdata/hyphenated.yml"},
		{"over-long token overflows its line", "testdata/overflow.yml"},
		{"double-width runes", "testdata/double_width.yml"},
		{"whitespace collapses", "testdata/collapse.yml"},
		{"width zero means no limit", "testdata/no_limit.yml"},
		{"empty input", "testdata/empty.yml"},
		{"all whitespace input", "testdata/whitespace.yml"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			gld := goldkit.Create(t, tc.file, nil)
			input := must.Value(gld.M().MetaGetString("input"))
			width := must.Value(gld.M().MetaGetInt("width"))

			// --- When ---
			have := Wrap(input, width)

			// --- Then ---
			gld.Assert([]byte(have))
		})
	}
}

func Test_WrapTokens_tabular(t *testing.T) {
	tt := []struct {
		testN string
		words []string
		width int
		want  string
	}{
		{
			"a token keeps its inner spaces intact",
			[]string{"see", "[Asset Data](url)", "now"},
			14,
			"see\n[Asset Data](url)\nnow",
		},
		{
			"an over-long token overflows its own line",
			[]string{"a", "[very long label](url)", "b"},
			5,
			"a\n[very long label](url)\nb",
		},
		{
			"width zero means no limit",
			[]string{"a", "b c", "d"},
			0,
			"a b c d",
		},
		{
			"negative width means no limit",
			[]string{"a", "b c", "d"},
			-1,
			"a b c d",
		},
		{
			"no words yields empty",
			nil,
			10,
			"",
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := WrapTokens(tc.words, tc.width)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}
