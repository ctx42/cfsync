// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import "strings"

// A rendered Markdown body is a sequence of top-level blocks joined by a blank
// line (see [renderBlocks]). Push must split an edited body back into the same
// blocks to diff it against the baseline. segmentBody does that split; because
// the render never puts a blank line inside a block, splitting on blank lines
// is exact — with one guard: a fenced code region is kept whole even when it
// contains blank lines, so a frozen code block is never mis-split.

// mdBlock is one top-level Markdown block together with its normalized key. The
// key collapses all runs of whitespace to single spaces so that a block which
// differs from another only by soft-wrap or reflow compares equal; a change to
// the actual words or structure does not. It is the content key used to align
// an edited body against the baseline when no localId is available (the
// Markdown carries no anchors; see [Origin]).
type mdBlock struct {
	// Text is the block's Markdown, without surrounding blank lines.
	Text string

	// Key is the whitespace-normalized form of Text, used for equality.
	Key string
}

// newBlock builds an [mdBlock] from raw block text.
func newBlock(text string) mdBlock {
	return mdBlock{Text: text, Key: normalizeBlock(text)}
}

// normalizeBlock returns text with cosmetic layout removed so that two blocks
// differing only by soft-wrapping, reflow, or trailing spaces normalize to the
// same string; a difference in the words themselves, in a hard break (the "\"
// survives), or in block structure (the "#", ">", "-", "|" markers survive)
// does not. A table is canonicalized specially (see [normalizeTable]) because
// its cell padding and "---" separator width are a function of the cell
// contents, recomputed on every render, not something the user edits.
func normalizeBlock(text string) string {
	if isTableBlock(text) {
		return normalizeTable(text)
	}
	return strings.Join(strings.Fields(text), " ")
}

// isTableBlock reports whether a block is a rendered Markdown table: its first
// non-blank line begins with a "|" pipe.
func isTableBlock(text string) bool {
	for ln := range strings.SplitSeq(text, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		return strings.HasPrefix(ln, "|")
	}
	return false
}

// normalizeTable canonicalizes a rendered Markdown table so only its cell
// contents count for equality, not layout. Each row's cells are trimmed and
// whitespace-collapsed; the "---" separator row is reduced to a single token,
// so widening a cell — which lengthens the padding and the separator dashes —
// is not mistaken for an edit. A genuine change to any cell's words still
// changes the result.
func normalizeTable(text string) string {
	var rows []string
	for ln := range strings.SplitSeq(text, "\n") {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		cells := splitTableRow(ln)
		if isSeparatorRow(cells) {
			rows = append(rows, "|-|")
			continue
		}
		for i, c := range cells {
			cells[i] = strings.Join(strings.Fields(c), " ")
		}
		rows = append(rows, "|"+strings.Join(cells, "|")+"|")
	}
	return strings.Join(rows, " ")
}

// segmentBody splits a rendered Markdown body into its top-level blocks, in
// order. Blocks are separated by one or more blank lines, with two regions
// emitted whole even when they span blank lines: a fenced code region (opened
// and closed by a ``` line) and a bullet list (whose multi-paragraph items are
// blank-line separated — see [renderListItem]). A blank line inside a list is
// internal when the next non-blank line is an item continuation (indented) or
// the next item marker; otherwise it ends the list. The returned blocks carry
// no surrounding blank lines.
func segmentBody(body string) []mdBlock {
	lines := strings.Split(body, "\n")
	var blocks []mdBlock
	var cur []string
	inFence := false
	inList := false

	flush := func() {
		// Drop leading and trailing blank lines accumulated for the block.
		for len(cur) > 0 && isBlankLine(cur[0]) {
			cur = cur[1:]
		}
		for len(cur) > 0 && isBlankLine(cur[len(cur)-1]) {
			cur = cur[:len(cur)-1]
		}
		if len(cur) > 0 {
			blocks = append(blocks, newBlock(strings.Join(cur, "\n")))
		}
		cur = nil
		inList = false
	}

	for i, ln := range lines {
		if isFenceLine(ln) {
			inFence = !inFence
			cur = append(cur, ln)
			continue
		}
		if inFence {
			cur = append(cur, ln)
			continue
		}
		if isBlankLine(ln) {
			if inList && listContinues(lines, i) {
				cur = append(cur, ln) // internal blank of a loose list
				continue
			}
			flush()
			continue
		}
		if len(cur) == 0 && isListStart(ln) {
			inList = true
		}
		cur = append(cur, ln)
	}
	flush()
	return blocks
}

// isListStart reports whether ln begins a list item — a "- ", "* " or "+ "
// bullet marker, or a "N. " numbered marker (see [orderedMarkerWidth]) — at the
// start of the line.
func isListStart(ln string) bool {
	return strings.HasPrefix(ln, "- ") ||
		strings.HasPrefix(ln, "* ") ||
		strings.HasPrefix(ln, "+ ") ||
		orderedMarkerWidth(ln) > 0
}

// listContinues reports whether the list containing the blank line at index i
// keeps going: it does when the next non-blank line is an indented item
// continuation or the next item marker. A blank run at the end of the body ends
// the list.
func listContinues(lines []string, i int) bool {
	for j := i + 1; j < len(lines); j++ {
		if isBlankLine(lines[j]) {
			continue
		}
		return strings.HasPrefix(lines[j], " ") || isListStart(lines[j])
	}
	return false
}

// isBlankLine reports whether ln is a block separator: empty or only ASCII
// spaces, tabs and carriage returns. It deliberately does NOT treat other
// Unicode spaces as blank — a paragraph rendering to just a non-breaking space
// (U+00A0) is a real block the renderer keeps, so the segmenter must keep it
// too, or block counts diverge and a no-op push looks like a deletion.
func isBlankLine(ln string) bool {
	return strings.Trim(ln, " \t\r") == ""
}

// isFenceLine reports whether ln opens or closes a fenced code block: a line
// whose first non-space run (up to three leading spaces) is three backticks.
func isFenceLine(ln string) bool {
	trimmed := strings.TrimLeft(ln, " ")
	if len(ln)-len(trimmed) > 3 {
		return false
	}
	return strings.HasPrefix(trimmed, "```")
}

// baselineBlocks renders the document and returns its top-level blocks, each
// paired with the [Origin] linking it to the ADF node that produced it. It is
// the authoritative baseline for a push diff: the block text comes straight
// from the render and every block carries its source node index and localId.
// The assets map is threaded through so media blocks render as they did on
// pull.
func (adf *ADF) baselineBlocks(
	assets map[string]string,
	links Links,
) ([]mdBlock, []Origin, error) {

	md, sm, err := adf.marshallMapped(assets, links)
	if err != nil {
		return nil, nil, err
	}
	blocks := make([]mdBlock, len(sm.Origins))
	for i, o := range sm.Origins {
		blocks[i] = newBlock(string(md[o.Span.Start:o.Span.End]))
	}
	return blocks, sm.Origins, nil
}
