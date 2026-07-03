// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// panelTypes lists the Confluence panel types an inserted "[!TYPE]" tag may
// name. A "custom" panel carries color and emoji attributes the Markdown tag
// cannot express, so it is deliberately absent.
var panelTypes = map[string]bool{
	"info":    true,
	"note":    true,
	"success": true,
	"warning": true,
	"error":   true,
}

// buildBlock constructs a new top-level node from an inserted Markdown block,
// the inverse of [Node.renderBlock] for every shape the renderer emits: a
// "[[TOC]]" marker, a fenced code block, a pipe table, a bullet or numbered
// list, a "> "-quoted panel, expand or blockquote, an added image, and the
// plain paragraph or heading fallback. idx names the block in error messages.
// A block that cannot be rebuilt losslessly — one nesting another structured
// block among them — is rejected rather than guessed, and the lens laws still
// gate whatever is built.
func buildBlock(
	text string,
	idx int,
	pc parseCtx,
	images map[string]NewImage,
) (Node, error) {

	node, err := buildDispatch(text, pc, images)
	if err != nil {
		return Node{}, fmt.Errorf("push: cannot insert block %d: %w", idx, err)
	}
	return node, nil
}

// buildDispatch picks the builder matching the inserted block's marker and
// runs it; see [buildBlock] for the shapes. Its errors are bare reasons, left
// to buildBlock to prefix with the block's position.
func buildDispatch(
	text string,
	pc parseCtx,
	images map[string]NewImage,
) (Node, error) {

	line, _, _ := strings.Cut(text, "\n")
	switch {
	case strings.TrimSpace(text) == "[[TOC]]":
		return buildTOC(), nil

	case isFenceLine(line):
		return buildCodeBlock(text), nil

	case strings.HasPrefix(line, "|"):
		return buildTable(text, pc)

	case strings.HasPrefix(line, "- "):
		return buildBulletList(text, pc)

	case orderedMarkerWidth(line) > 0:
		return buildOrderedList(text, pc)

	case strings.HasPrefix(line, "* "), strings.HasPrefix(line, "+ "):
		return Node{}, errors.New(`write bullet items with a "- " marker`)

	case strings.HasPrefix(line, "> "):
		return buildQuoted(text, pc)
	}

	if alt, path, ok := parseImageBlock(text); ok {
		if img, found := images[path]; found {
			return mediaSingleNode(img, alt), nil
		}
		return Node{}, fmt.Errorf("image %q has no uploaded attachment", path)
	}
	if !insertableAsLeaf(text) {
		msg := "a directive, comment or unsupported marker block " +
			"cannot be inserted"
		return Node{}, errors.New(msg)
	}
	node := Node{Type: "paragraph"}
	if lvl := leadingHashes(text); lvl >= 1 && lvl <= 6 {
		node.Type = "heading"
	}
	rebuildLeaf(&node, text, pc)
	return node, nil
}

// buildTOC synthesizes the extension node for a Table of Contents macro, the
// inverse of the "[[TOC]]" marker [Node.renderExtension] emits. It carries no
// macroId or localId; Confluence assigns both on save, as it does for an
// inserted paragraph.
func buildTOC() Node {
	return Node{Type: "extension", Attrs: map[string]any{
		"layout":        "default",
		"extensionType": "com.atlassian.confluence.macro.core",
		"extensionKey":  "toc",
	}}
}

// buildCodeBlock constructs a codeBlock from an inserted fenced block, the
// inverse of [Node.renderCodeBlock]: the language comes off the opening fence
// and the body is kept literal, fences stripped. A body whose own text breaks
// the fence shape cannot re-render to the user's block, so the lens laws
// reject it downstream.
func buildCodeBlock(text string) Node {
	lines := strings.Split(text, "\n")
	node := Node{Type: "codeBlock"}
	lang := strings.TrimSpace(strings.TrimPrefix(
		strings.TrimLeft(lines[0], " "), "```"))
	if lang != "" {
		node.Attrs = map[string]any{"language": lang}
	}
	if len(lines) > 2 {
		body := strings.Join(lines[1:len(lines)-1], "\n")
		if body != "" {
			node.Content = []Node{{Type: "text", Text: body}}
		}
	}
	return node
}

// buildBulletList constructs a bullet list from an inserted "- "-marked
// block, the inverse of [Node.renderBulletList]: one single-paragraph item
// per marker (see [buildListItem]).
func buildBulletList(text string, pc parseCtx) (Node, error) {
	isItem := func(ln string) bool { return strings.HasPrefix(ln, "- ") }
	if err := checkListNesting(text, isItem); err != nil {
		return Node{}, err
	}
	node := Node{Type: "bulletList"}
	for i, item := range splitBulletItems(text) {
		li, err := buildListItem(item, i, pc)
		if err != nil {
			return Node{}, err
		}
		node.Content = append(node.Content, li)
	}
	return node, nil
}

// buildOrderedList constructs a numbered list from an inserted "N. "-marked
// block, the inverse of [Node.renderOrderedList]: one single-paragraph item
// per marker (see [buildListItem]). The renderer regenerates the numbers from
// the start recorded in the "order" attribute, so the items must be numbered
// sequentially; the attribute is set only for a start past one, matching the
// render's default.
func buildOrderedList(text string, pc parseCtx) (Node, error) {
	isItem := func(ln string) bool { return orderedMarkerWidth(ln) > 0 }
	if err := checkListNesting(text, isItem); err != nil {
		return Node{}, err
	}
	start, err := listStartNumber(text)
	if err != nil {
		return Node{}, err
	}
	node := Node{Type: "orderedList"}
	if start != 1 {
		node.Attrs = map[string]any{"order": float64(start)}
	}
	for i, item := range splitOrderedItems(text) {
		li, err := buildListItem(item, i, pc)
		if err != nil {
			return Node{}, err
		}
		node.Content = append(node.Content, li)
	}
	return node, nil
}

// checkListNesting rejects an inserted list block whose continuation line
// begins a structured block of its own — a nested list, table, quote or code
// fence. Such a line's indentation is exactly what the flat item split
// discards, so building it would silently flatten the nesting; isItem
// recognizes the lines that start a new item and are exempt.
func checkListNesting(text string, isItem func(string) bool) error {
	for ln := range strings.SplitSeq(text, "\n") {
		if isItem(ln) || isBlankLine(ln) {
			continue
		}
		trimmed := strings.TrimLeft(ln, " ")
		if isListStart(trimmed) || strings.HasPrefix(trimmed, "|") ||
			strings.HasPrefix(trimmed, "> ") ||
			strings.HasPrefix(trimmed, "```") {
			return errors.New("a nested block cannot be inserted")
		}
	}
	return nil
}

// listStartNumber reads the numbers off the block's "N. " item markers,
// verifies they run sequentially — the renderer regenerates them from the
// start, so any other numbering cannot round-trip — and returns the first as
// the list's start, at least one.
func listStartNumber(text string) (int, error) {
	start, prev, first := 0, 0, true
	for ln := range strings.SplitSeq(text, "\n") {
		w := orderedMarkerWidth(ln)
		if w == 0 {
			continue
		}
		n, err := strconv.Atoi(ln[:w-len(". ")])
		if err != nil {
			return 0, fmt.Errorf("parsing an item number: %w", err)
		}
		if first {
			start, prev, first = n, n, false
			continue
		}
		if n != prev+1 {
			return 0, errors.New("items must be numbered sequentially")
		}
		prev = n
	}
	return max(start, 1), nil
}

// buildQuoted constructs the node for an inserted "> "-quoted block, keyed by
// its first line's tag: "[!EXPAND]" is an expand whose tag line carries the
// title, another "[!TYPE]" tag is a panel of that type, and no tag is a plain
// blockquote. See [buildQuotedParagraphs] for the shared body shape.
func buildQuoted(text string, pc parseCtx) (Node, error) {
	lines := strings.Split(text, "\n")
	first := strings.TrimPrefix(lines[0], "> ")
	switch {
	case strings.HasPrefix(first, "[!EXPAND]"):
		return buildExpand(lines, pc)

	case strings.HasPrefix(first, "[!"):
		return buildPanel(lines, first, pc)

	default:
		paras, err := buildQuotedParagraphs(lines, "a blockquote", pc)
		if err != nil {
			return Node{}, err
		}
		return Node{Type: "blockquote", Content: paras}, nil
	}
}

// buildExpand constructs an expand from its quoted lines, the inverse of
// [Node.renderExpand]: the title comes off the "[!EXPAND]" tag line and is
// recorded only when present, so a bare tag re-renders bare.
func buildExpand(lines []string, pc parseCtx) (Node, error) {
	paras, err := buildQuotedParagraphs(lines[1:], "an expand", pc)
	if err != nil {
		return Node{}, err
	}
	node := Node{Type: "expand", Content: paras}
	if title := parseExpandTitle(lines[0]); title != "" {
		node.Attrs = map[string]any{"title": title}
	}
	return node, nil
}

// buildPanel constructs a panel from its quoted lines and its already
// unquoted "[!TYPE]" tag, the inverse of [Node.renderPanel]. The tag must
// name a type from panelTypes; anything else — a malformed tag included — is
// rejected rather than guessed.
func buildPanel(lines []string, tag string, pc parseCtx) (Node, error) {
	label, ok := strings.CutSuffix(strings.TrimPrefix(tag, "[!"), "]")
	typ := strings.ToLower(label)
	if !ok || !panelTypes[typ] {
		return Node{}, fmt.Errorf("unknown panel type %q", tag)
	}
	paras, err := buildQuotedParagraphs(lines[1:], "a panel", pc)
	if err != nil {
		return Node{}, err
	}
	return Node{
		Type:    "panel",
		Attrs:   map[string]any{"panelType": typ},
		Content: paras,
	}, nil
}

// buildQuotedParagraphs constructs the paragraph children of an inserted
// quoted container from its "> "-marked body lines, one node per
// blank-separated paragraph (see [splitQuotedParagraphs]). A body is
// required, and each paragraph must be plain inline text: a nested structured
// block has no lossless place in a fresh container. kind names the container,
// article included, in error messages.
func buildQuotedParagraphs(
	lines []string,
	kind string,
	pc parseCtx,
) ([]Node, error) {

	texts := splitQuotedParagraphs(lines)
	if len(texts) == 0 {
		return nil, fmt.Errorf("%s needs a body", kind)
	}
	out := make([]Node, 0, len(texts))
	for _, txt := range texts {
		if !insertableAsLeaf(txt) {
			return nil, errors.New("a nested block cannot be inserted")
		}
		para := Node{Type: "paragraph"}
		rebuildInline(&para, txt, pc)
		out = append(out, para)
	}
	return out, nil
}

// buildTable constructs a table from an inserted Markdown pipe table, the
// inverse of [Node.renderTable]. A first row with any content becomes a row
// of header cells, the GFM header; an all-blank first row is the synthetic
// header the renderer writes for a headerless table, and is dropped. Every
// row must have the same cell count — the render pads every row to the full
// grid, so a ragged table cannot round-trip — and a cell showing the "«" span
// marker is rejected, as GFM cannot express the span behind it.
func buildTable(text string, pc parseCtx) (Node, error) {
	grid, err := parseUserTable(text)
	if err != nil {
		return Node{}, err
	}
	cols := len(grid[0])
	for _, row := range grid {
		if len(row) != cols {
			return Node{}, fmt.Errorf("every table row needs %d cells", cols)
		}
		for _, cel := range row {
			if strings.Contains(cel, spanMarker) {
				return Node{}, errors.New("cell spans cannot be inserted")
			}
		}
	}

	header := false
	for _, cel := range grid[0] {
		if cel != "" {
			header = true
		}
	}
	if !header {
		grid = grid[1:]
		if len(grid) == 0 {
			return Node{}, errors.New("a table needs at least one row")
		}
	}

	node := Node{Type: "table"}
	for r, row := range grid {
		typ := "tableCell"
		if header && r == 0 {
			typ = "tableHeader"
		}
		tr := Node{Type: "tableRow"}
		for _, cel := range row {
			tr.Content = append(tr.Content, buildTableCell(cel, typ, pc))
		}
		node.Content = append(node.Content, tr)
	}
	return node, nil
}

// buildTableCell constructs one cell of an inserted table, of the tableHeader
// or tableCell type typ, holding one paragraph per "<br>"-separated piece of
// the cell text — the inverse of the join [Node.cellText] renders.
func buildTableCell(text, typ string, pc parseCtx) Node {
	cell := Node{Type: typ}
	for txt := range strings.SplitSeq(text, "<br>") {
		para := Node{Type: "paragraph"}
		rebuildInline(&para, txt, pc)
		cell.Content = append(cell.Content, para)
	}
	return cell
}

// parseImageBlock parses a lone image block "![alt](path)" into its alt text
// and path, the inverse of [Node.renderMedia] for a block-level image. A block
// that is not exactly one image reports false.
func parseImageBlock(text string) (alt, path string, ok bool) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "![") || !strings.HasSuffix(text, ")") {
		return "", "", false
	}
	inner := text[2 : len(text)-1] // between "![" and the closing ")"
	alt, path, ok = strings.Cut(inner, "](")
	if !ok {
		return "", "", false
	}
	return alt, path, true
}

// mediaSingleNode synthesizes the mediaSingle+media node for a user-added
// image, mirroring the shape Confluence uses for an uploaded file (see a pulled
// ADF). The alt is taken from the Markdown so the node re-renders to the exact
// block the user wrote; the file id, collection and localId come from the
// upload.
func mediaSingleNode(img NewImage, alt string) Node {
	return Node{
		Type:  "mediaSingle",
		Attrs: map[string]any{"layout": "center"},
		Content: []Node{{
			Type: "media",
			Attrs: map[string]any{
				"type":       "file",
				"id":         img.FileID,
				"collection": img.Collection,
				"localId":    img.LocalID,
				"alt":        alt,
			},
		}},
	}
}
