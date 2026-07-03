// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"sort"
	"strings"
)

// The push diff aligns the user's edited blocks against the baseline blocks and
// classifies each into an edit op. It works on the whitespace-normalized block
// keys (see [normalizeBlock]) so reflow is not mistaken for an edit, and it
// uses a longest-common-subsequence alignment so a moved or inserted block does
// not cascade every following block into a spurious modify.

// editKind is the classification of one block in a push diff.
type editKind int

const (
	// opKeep is a block present, unchanged, in both baseline and user text.
	opKeep editKind = iota

	// opModify is a block whose text changed but which aligns, in position, to a
	// single baseline block; its ADF node is reused and its inline text reparsed.
	opModify

	// opInsert is a block present only in the user text; a new ADF node.
	opInsert

	// opDelete is a block present only in the baseline; its ADF node is dropped.
	opDelete
)

// edit is one entry of a push edit script. BaseIndex indexes the baseline
// blocks and UserIndex the user blocks; the one not applicable to the op is -1.
type edit struct {
	Kind      editKind
	BaseIndex int
	UserIndex int
}

// diffBlocks aligns user against base by their normalized keys and returns the
// edit script in document order. Unchanged blocks become opKeep; a baseline
// block replaced in place becomes opModify; a block only in user becomes
// opInsert and one only in base becomes opDelete. The alignment is LCS-based,
// so a single insertion or deletion shifts nothing else.
func diffBlocks(base, user []mdBlock) []edit {
	n, m := len(base), len(user)

	// lcs[i][j] is the length of the longest common subsequence of base[i:] and
	// user[j:], compared on the normalized keys.
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if base[i].Key == user[j].Key {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}

	var raw []edit
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case base[i].Key == user[j].Key:
			raw = append(raw, edit{opKeep, i, j})
			i++
			j++
		case lcs[i+1][j] >= lcs[i][j+1]:
			raw = append(raw, edit{opDelete, i, -1})
			i++
		default:
			raw = append(raw, edit{opInsert, -1, j})
			j++
		}
	}
	for ; i < n; i++ {
		raw = append(raw, edit{opDelete, i, -1})
	}
	for ; j < m; j++ {
		raw = append(raw, edit{opInsert, -1, j})
	}

	return pairModifies(raw, base, user)
}

// pairModifies rewrites each maximal run of adjacent deletes and inserts (a run
// bounded by keeps or the ends) into modifies. A delete pairs with an insert
// only when the two blocks are the same kind (see [blockKind]) — a list with a
// list, a paragraph with a paragraph — so an inserted block sitting next to a
// modified block of another kind is no longer mispaired into a lossy modify.
// A replaced-in-place block thus reads as one opModify; a block with no
// same-kind partner stays a delete or an insert. Within a run the keep, modify
// and insert edits are emitted in the user's block order so the reconstruction
// rebuilds the document in that order; leftover deletes follow.
func pairModifies(in []edit, base, user []mdBlock) []edit {
	out := make([]edit, 0, len(in))
	for i := 0; i < len(in); {
		if in[i].Kind == opKeep {
			out = append(out, in[i])
			i++
			continue
		}
		var dels, inss []edit
		j := i
		for j < len(in) && in[j].Kind != opKeep {
			if in[j].Kind == opDelete {
				dels = append(dels, in[j])
			} else {
				inss = append(inss, in[j])
			}
			j++
		}
		out = append(out, resolveRun(dels, inss, base, user)...)
		i = j
	}
	return out
}

// resolveRun folds a run's deletes and inserts into an edit list. Each delete
// is matched to the first not-yet-used insert of the same [blockKind], in
// order, and the pair becomes an opModify; a delete with no same-kind insert
// stays an opDelete and an unmatched insert stays an opInsert. Modifies and
// inserts are sorted by user index (the document order the user wrote).
// Leftover deletes are interleaved by BaseIndex so their non-rendered anchors
// re-emit at the baseline hole rather than after every insert in the run.
func resolveRun(dels, inss []edit, base, user []mdBlock) []edit {
	used := make([]bool, len(inss))
	var placed []edit // modifies and inserts, ordered by user index below
	var leftoverDels []edit
	for _, d := range dels {
		kind := blockKind(base[d.BaseIndex].Text)
		match := -1
		for x, ins := range inss {
			if !used[x] && blockKind(user[ins.UserIndex].Text) == kind {
				match = x
				break
			}
		}
		if match < 0 {
			leftoverDels = append(leftoverDels, d)
			continue
		}
		used[match] = true
		placed = append(placed,
			edit{opModify, d.BaseIndex, inss[match].UserIndex})
	}
	for x, ins := range inss {
		if !used[x] {
			placed = append(placed, ins)
		}
	}
	sort.Slice(placed, func(a, b int) bool {
		return placed[a].UserIndex < placed[b].UserIndex
	})
	sort.Slice(leftoverDels, func(a, b int) bool {
		return leftoverDels[a].BaseIndex < leftoverDels[b].BaseIndex
	})
	return mergeLeftoverDels(placed, leftoverDels)
}

// mergeLeftoverDels inserts leftover deletes into the user-ordered placed list
// so each delete lands before the next modify whose BaseIndex is greater, or
// before trailing inserts when no later modify remains. That keeps a deleted
// block's non-rendered predecessors at its baseline hole.
func mergeLeftoverDels(placed, dels []edit) []edit {
	if len(dels) == 0 {
		return placed
	}
	out := make([]edit, 0, len(placed)+len(dels))
	di := 0
	for i, e := range placed {
		nextMod := -1
		for _, f := range placed[i:] {
			if f.Kind == opModify {
				nextMod = f.BaseIndex
				break
			}
		}
		for di < len(dels) && (nextMod < 0 || dels[di].BaseIndex < nextMod) {
			out = append(out, dels[di])
			di++
		}
		out = append(out, e)
	}
	return append(out, dels[di:]...)
}

// blockKind classifies a top-level Markdown block by the marker its first line
// carries, so the diff can pair a modified block only with an insert of the
// same shape. The label need not equal the ADF node type; it need only be
// stable between a block and its edited form, since only same-labeled blocks
// pair.
func blockKind(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	line = strings.TrimLeft(line, " ")
	switch {
	case leadingHashes(line) >= 1 && leadingHashes(line) <= 6:
		return "heading"
	case strings.HasPrefix(line, "- "),
		strings.HasPrefix(line, "* "),
		strings.HasPrefix(line, "+ "),
		orderedMarkerWidth(line) > 0:
		return "list"
	case strings.HasPrefix(line, "|"):
		return "table"
	case strings.HasPrefix(line, "> "):
		// A panel, expand, and blockquote share the "> " marker; the "[!…]"
		// tag on the first line tells them apart.
		tag := strings.TrimPrefix(line, "> ")
		switch {
		case strings.HasPrefix(tag, "[!EXPAND]"):
			return "expand"
		case strings.HasPrefix(tag, "[!"):
			return "panel"
		}
		return "quote"
	case strings.HasPrefix(line, "```"):
		return "code"
	case strings.HasPrefix(line, "!["):
		return "media"
	case strings.HasPrefix(line, "[["):
		return "macro"
	case strings.HasPrefix(line, "<!--"):
		return "placeholder"
	default:
		return "paragraph"
	}
}
