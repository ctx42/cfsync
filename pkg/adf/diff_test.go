// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"testing"

	"github.com/ctx42/testing/pkg/assert"
)

func Test_diffBlocks_tabular(t *testing.T) {
	tt := []struct {
		testN string
		base  []mdBlock
		user  []mdBlock
		want  []edit
	}{
		{
			"identical blocks all keep",
			blocksOf("a", "b", "c"),
			blocksOf("a", "b", "c"),
			[]edit{{opKeep, 0, 0}, {opKeep, 1, 1}, {opKeep, 2, 2}},
		},
		{
			"reflow-only change still keeps",
			blocksOf("one two three"),
			blocksOf("one two\nthree"),
			[]edit{{opKeep, 0, 0}},
		},
		{
			"a changed middle block is a modify",
			blocksOf("a", "b", "c"),
			blocksOf("a", "B!", "c"),
			[]edit{{opKeep, 0, 0}, {opModify, 1, 1}, {opKeep, 2, 2}},
		},
		{
			"an inserted block",
			blocksOf("a", "c"),
			blocksOf("a", "b", "c"),
			[]edit{{opKeep, 0, 0}, {opInsert, -1, 1}, {opKeep, 1, 2}},
		},
		{
			"a deleted block",
			blocksOf("a", "b", "c"),
			blocksOf("a", "c"),
			[]edit{{opKeep, 0, 0}, {opDelete, 1, -1}, {opKeep, 2, 1}},
		},
		{
			"append at the end",
			blocksOf("a"),
			blocksOf("a", "b"),
			[]edit{{opKeep, 0, 0}, {opInsert, -1, 1}},
		},
		{
			"everything deleted",
			blocksOf("a", "b"),
			blocksOf(),
			[]edit{{opDelete, 0, -1}, {opDelete, 1, -1}},
		},
		{
			"everything new",
			blocksOf(),
			blocksOf("a", "b"),
			[]edit{{opInsert, -1, 0}, {opInsert, -1, 1}},
		},
		{
			"two modifies in a row",
			blocksOf("a", "b", "c"),
			blocksOf("A", "B", "c"),
			[]edit{{opModify, 0, 0}, {opModify, 1, 1}, {opKeep, 2, 2}},
		},
		{
			"a delete and a differently-kinded insert do not pair",
			blocksOf("para one", "tail"),
			blocksOf("- list item", "tail"),
			// Leftover delete precedes the insert so NR anchors stay at the hole.
			[]edit{{opDelete, 0, -1}, {opInsert, -1, 0}, {opKeep, 1, 1}},
		},
		{
			"ordered list and paragraph do not pair",
			blocksOf("para one", "tail"),
			blocksOf("1. list item", "tail"),
			[]edit{{opDelete, 0, -1}, {opInsert, -1, 0}, {opKeep, 1, 1}},
		},
		{
			"a run pairs by kind and orders by user position",
			blocksOf("- old item", "tail"),
			blocksOf("new para", "- new item", "tail"),
			[]edit{{opInsert, -1, 0}, {opModify, 0, 1}, {opKeep, 1, 2}},
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := diffBlocks(tc.base, tc.user)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}
