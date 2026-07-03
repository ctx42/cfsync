// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"errors"
	"fmt"
	"strings"
)

// ErrMergeConflict is wrapped by every conflict [ADF.Merge3] returns, so a
// caller can distinguish a genuine three-way-merge conflict from a lens-law or
// other push failure with errors.Is.
var ErrMergeConflict = errors.New("push: merge conflict")

// blockOp records how one baseline block fared in a two-way block diff against
// one side (local or remote): kept, modified (with the new text), or deleted.
// The zero value is an opKeep, matching a block a diff left untouched.
type blockOp struct {
	kind editKind
	text string
}

// classifyEdits reduces a baseline→side edit script to two lookups: how each
// baseline block fared (kept/modified/deleted), keyed by baseline index, and
// the block texts inserted after each anchor baseline block (-1 for the slot
// before the first block), in document order. Every baseline block appears in
// the first map, since a diff classifies each exactly once.
func classifyEdits(
	edits []edit,
	side []mdBlock,
) (map[int]blockOp, map[int][]string) {
	ofBase := make(map[int]blockOp)
	insAfter := make(map[int][]string)
	anchor := -1
	for _, e := range edits {
		switch e.Kind {
		case opKeep:
			ofBase[e.BaseIndex] = blockOp{kind: opKeep}
			anchor = e.BaseIndex
		case opModify:
			ofBase[e.BaseIndex] = blockOp{
				kind: opModify,
				text: side[e.UserIndex].Text,
			}
			anchor = e.BaseIndex
		case opDelete:
			ofBase[e.BaseIndex] = blockOp{kind: opDelete}
			anchor = e.BaseIndex
		case opInsert:
			insAfter[anchor] = append(insAfter[anchor], side[e.UserIndex].Text)
		}
	}
	return ofBase, insAfter
}

// Merge3 performs a block-level three-way merge. The receiver is the common
// baseline (the cached version the local Markdown was edited from); remote is
// the current live document; body is the edited local Markdown. A push carries
// that baseline version as the common ancestor when the remote has moved:
// Merge3 rebases the local edits onto remote so non-overlapping edits combine
// and only a block edited on both sides is a conflict. It returns a merged body
// to Put against remote: a block changed on only one side takes that side's
// version, a block changed the same way on both sides takes it once, and a
// block changed incompatibly — or a spot where both sides inserted — is a
// conflict. The merge is deterministic and never mutates a document;
// correctness of the resulting ADF is still gated by the lens laws when the
// merged body is Put.
func (adf *ADF) Merge3(
	remote *ADF,
	body string,
	assets map[string]string,
) (string, error) {

	return adf.Merge3Links(remote, body, assets, nil)
}

// Merge3Links is [ADF.Merge3] with a [Links] so the baseline and remote renders
// use the same local-link rewriting as the edited body; a nil links behaves
// exactly like Merge3.
func (adf *ADF) Merge3Links(
	remote *ADF,
	body string,
	assets map[string]string,
	links Links,
) (string, error) {

	baseBlocks, _, err := adf.baselineBlocks(assets, links)
	if err != nil {
		return "", err
	}
	remoteBlocks, _, err := remote.baselineBlocks(assets, links)
	if err != nil {
		return "", err
	}
	localBlocks := segmentBody(body)

	localOf, localIns := classifyEdits(
		diffBlocks(baseBlocks, localBlocks), localBlocks)
	remoteOf, remoteIns := classifyEdits(
		diffBlocks(baseBlocks, remoteBlocks), remoteBlocks)

	var out []string
	emitInserts := func(anchor int) error {
		l, r := localIns[anchor], remoteIns[anchor]
		if len(l) > 0 && len(r) > 0 {
			format := "%w: both sides inserted a block at the same place"
			return fmt.Errorf(format, ErrMergeConflict)
		}
		out = append(out, l...)
		out = append(out, r...)
		return nil
	}

	if err := emitInserts(-1); err != nil {
		return "", err
	}
	for bi := range baseBlocks {
		text, keep, err := mergeBlock(baseBlocks[bi], localOf[bi], remoteOf[bi], bi)
		if err != nil {
			return "", err
		}
		if keep {
			out = append(out, text)
		}
		if err := emitInserts(bi); err != nil {
			return "", err
		}
	}
	return strings.Join(out, "\n\n"), nil
}

// mergeBlock combines the local and remote fates of one baseline block. It
// returns the merged block text and whether the block survives (a delete drops
// it), or a conflict error when the two sides changed the block incompatibly. A
// block changed on one side only takes that side's outcome; the same edit on
// both sides (identical modified text, or a delete on both) is concordant.
func mergeBlock(baseB mdBlock, lo, ro blockOp, bi int) (string, bool, error) {
	lChanged := lo.kind == opModify || lo.kind == opDelete
	rChanged := ro.kind == opModify || ro.kind == opDelete
	switch {
	case !lChanged && !rChanged:
		return baseB.Text, true, nil
	case lChanged && !rChanged:
		return lo.text, lo.kind == opModify, nil
	case !lChanged && rChanged:
		return ro.text, ro.kind == opModify, nil
	case lo.kind == opModify && ro.kind == opModify &&
		normalizeBlock(lo.text) == normalizeBlock(ro.text):
		return lo.text, true, nil // the same edit on both sides
	case lo.kind == opDelete && ro.kind == opDelete:
		return "", false, nil // deleted on both sides
	default:
		format := "%w at block %d: edited both locally and remotely"
		return "", false, fmt.Errorf(format, ErrMergeConflict, bi)
	}
}
