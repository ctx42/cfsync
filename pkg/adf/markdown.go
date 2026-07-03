// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mattn/go-runewidth"

	"github.com/ctx42/cfsync/pkg/textwrap"
)

// Soft-wrap widths for rendered block text.
const (
	// wrapWidth is the display column at which block text is soft-wrapped.
	wrapWidth = 80

	// blockPrefixWidth is the display width of a block prefix such as "> " or
	// "- ", subtracted from wrapWidth so prefixed lines still fit.
	blockPrefixWidth = 2
)

// mdCtx carries the page-level state threaded through the render so leaf nodes
// can render correctly: the resolved image assets (see [ADF.MarshallMarkdown])
// and the set of ambiguous mention display names (a name that appears with more
// than one account id on the page), which force the inline id override form.
// Its zero value is a valid empty context.
type mdCtx struct {
	assets map[string]string
	ambig  map[string]bool
	links  Links
}

// MarshallMarkdown renders the document as Markdown: YAML frontmatter followed
// by the rendered body, ending with a single newline. It errors when the root
// node is not an ADF "doc".
//
// The assets map links each uploaded-file media node to its downloaded image:
// it maps a media node's localId (see [MediaRef.LocalID]) to the image path,
// relative to the Markdown file. A media node present in the map renders as a
// Markdown image and contributes a page_images frontmatter entry; one absent
// from it, including every node when assets is nil, renders as a read-only
// anchor directive (see [Node.renderAnchor]).
func (adf *ADF) MarshallMarkdown(assets map[string]string) ([]byte, error) {
	md, _, err := adf.marshallMapped(assets, nil)
	return md, err
}

// MarshallMarkdownLinks renders the document as [ADF.MarshallMarkdown] does,
// rewriting each link to a pulled Confluence page into its local Markdown link
// via links (see [Links]). A nil links renders identically to MarshallMarkdown.
func (adf *ADF) MarshallMarkdownLinks(
	assets map[string]string,
	links Links,
) ([]byte, error) {

	md, _, err := adf.marshallMapped(assets, links)
	return md, err
}

// frontmatter renders the YAML frontmatter block from the wrapper metadata and
// the resolved assets, without a trailing newline.
func (adf *ADF) frontmatter(assets map[string]string) string {
	const format = "" +
		"---\n" +
		"title: %q\n" +
		"page_path: %q\n" +
		"page_id: %q\n" +
		"page_version: %d\n" +
		"space_id: %q\n"
	var b strings.Builder
	_, _ = fmt.Fprintf(
		&b, format, adf.Title, adf.Name, adf.ID, adf.Version, adf.SpaceID)
	if adf.ParentID != "" {
		_, _ = fmt.Fprintf(&b, "parent_id: %q\n", adf.ParentID)
	}
	if adf.SpaceKey != "" {
		_, _ = fmt.Fprintf(&b, "space_key: %q\n", adf.SpaceKey)
	}
	if adf.Domain != "" {
		_, _ = fmt.Fprintf(&b, "cf_domain: %q\n", adf.Domain)
	}
	b.WriteString(adf.pageImages(assets))
	b.WriteString(adf.mentionList())
	b.WriteString("---")
	return b.String()
}

// pageImages renders the page_images frontmatter block: one entry per resolved
// media node, in document order, each recording its localId, image path and
// alt text. It returns "" when no media node resolves to an asset, so the
// frontmatter is unchanged for a document without downloaded images.
func (adf *ADF) pageImages(assets map[string]string) string {
	const item = "" +
		"  - local_id: %s\n" +
		"    file: %q\n" +
		"    alt: %q\n"
	var b strings.Builder
	for _, nod := range adf.Doc.fileMedia(nil) {
		localID := nod.mediaAssetKey()
		file, ok := assets[localID]
		if !ok {
			continue
		}
		if b.Len() == 0 {
			b.WriteString("page_images:\n")
		}
		_, _ = fmt.Fprintf(&b, item, localID, file, nod.attrStr("alt"))
	}
	return b.String()
}

// mentionList renders the mentions frontmatter block: one "name: account-id"
// entry per distinct mention display name, in first-occurrence order. It maps
// each rendered @[name] in the body back to the account id needed to rebuild
// its ADF node. A name that appears with more than one account id is ambiguous
// and omitted here, as it round-trips through the inline @[name|id] override
// instead; see [Node.renderInline]. It returns "" when the page has no
// unambiguous mention, so the frontmatter is unchanged for a mention-free page.
func (adf *ADF) mentionList() string {
	order, ids := adf.mentionIndex()
	var b strings.Builder
	for _, name := range order {
		list := ids[name]
		if len(list) != 1 {
			continue // ambiguous: carried inline as @[name|id]
		}
		if b.Len() == 0 {
			b.WriteString("mentions:\n")
		}
		_, _ = fmt.Fprintf(&b, "  %q: %q\n", name, list[0])
	}
	return b.String()
}

// ambiguousMentions returns the set of mention display names that appear on the
// page with more than one account id, which must therefore render with the
// inline id override rather than a bare @[name].
func (adf *ADF) ambiguousMentions() map[string]bool {
	_, ids := adf.mentionIndex()
	amb := make(map[string]bool)
	for name, list := range ids {
		if len(list) > 1 {
			amb[name] = true
		}
	}
	return amb
}

// mentionIndex walks the document once and returns the distinct mention display
// names in first-occurrence order together with, per name, the distinct account
// ids seen for it (also in first-occurrence order). A name mapped to more than
// one id is ambiguous.
func (adf *ADF) mentionIndex() ([]string, map[string][]string) {
	var order []string
	ids := make(map[string][]string)
	for _, nod := range adf.Doc.mentions(nil) {
		name := mentionName(nod)
		id := nod.attrStr("id")
		seen, ok := ids[name]
		if !ok {
			order = append(order, name)
		}
		if !slices.Contains(seen, id) {
			ids[name] = append(seen, id)
		}
	}
	return order, ids
}

// mentions appends every mention node at or below the node to out, in document
// order.
func (nod Node) mentions(out []Node) []Node {
	if nod.Type == "mention" {
		out = append(out, nod)
	}
	for _, child := range nod.Content {
		out = child.mentions(out)
	}
	return out
}

// mentionName is the display name of a mention: its text attribute without the
// leading "@", which is the body @[name] label and the mentions-map key.
func mentionName(nod Node) string {
	return strings.TrimPrefix(nod.attrStr("text"), "@")
}

// renderedBlock is one rendered top-level block together with the index, in the
// parent's Content slice, of the ADF node that produced it. Blocks that render
// to nothing are omitted, so NodeIndex maps a rendered block back to its source
// node despite the gaps.
type renderedBlock struct {
	// NodeIndex is the position of the source node in the parent Content slice.
	NodeIndex int

	// Text is the block's rendered Markdown, without a trailing newline.
	Text string
}

// renderBlockList renders each block node and returns the non-empty results
// paired with their source-node index. It is the shared core of [renderBlocks]
// and the source-mapped render, so both segment blocks identically.
func renderBlockList(nodes []Node, ctx mdCtx) []renderedBlock {
	out := make([]renderedBlock, 0, len(nodes))
	for i, nod := range nodes {
		if s := nod.renderBlock(ctx); s != "" {
			out = append(out, renderedBlock{NodeIndex: i, Text: s})
		}
	}
	return out
}

// renderBlocks renders a sequence of block nodes and joins them with a blank
// line, dropping any block that renders to nothing. The render context is
// threaded through so leaf nodes render correctly; see [ADF.MarshallMarkdown].
func renderBlocks(nodes []Node, ctx mdCtx) string {
	blocks := renderBlockList(nodes, ctx)
	parts := make([]string, len(blocks))
	for i, b := range blocks {
		parts[i] = b.Text
	}
	return strings.Join(parts, "\n\n")
}

// renderBlock renders a single block node to Markdown without a trailing
// newline. An unsupported block type renders as a read-only anchor directive
// (see [Node.renderAnchor]).
func (nod Node) renderBlock(ctx mdCtx) string {
	switch nod.Type {
	case "heading":
		level := min(max(nod.attrInt("level"), 1), 6)
		return strings.Repeat("#", level) + " " + nod.inlineString(ctx)

	case "paragraph":
		return nod.renderParagraph(ctx)

	case "panel":
		return nod.renderPanel(ctx)

	case "blockquote":
		return nod.renderBlockquote(ctx)

	case "expand":
		return nod.renderExpand(ctx)

	case "table":
		return nod.renderTable(ctx)

	case "bulletList":
		return nod.renderBulletList(ctx)

	case "orderedList":
		return nod.renderOrderedList(ctx)

	case "codeBlock":
		return nod.renderCodeBlock()

	case "mediaSingle":
		return renderBlocks(nod.Content, ctx)

	case "mediaGroup":
		return nod.renderMediaGroup(ctx)

	case "media":
		return nod.renderMedia(ctx.assets)

	case "extension":
		return nod.renderExtension()

	default:
		return nod.renderAnchor()
	}
}

// renderExtension renders a block-level Confluence macro. The Table of Contents
// macro (extensionKey "toc"), present on nearly every page, becomes a "[[TOC]]"
// marker: distinctive enough never to collide with prose and stable across the
// round trip, since an unedited marker is matched by its source node's localId
// and copied back verbatim (editing it is rejected as read-only). Every other
// macro renders as a read-only anchor directive until it is specifically
// supported.
func (nod Node) renderExtension() string {
	if nod.attrStr("extensionKey") == "toc" {
		return "[[TOC]]"
	}
	return nod.renderAnchor()
}

// renderMedia renders a media node as a Markdown image. An external media node
// (`type:"external"`) carries its URL in an attribute, so it renders as
// ![alt](url) with no download. An uploaded file (`type:"file"`) is keyed by
// its localId in the assets map, downloaded on pull; a file with no downloaded
// asset — including every node when assets is nil — falls back to a read-only
// anchor directive (see [Node.renderAnchor]).
func (nod Node) renderMedia(assets map[string]string) string {
	if nod.attrStr("type") == "external" {
		if url := nod.attrStr("url"); url != "" {
			return "![" + nod.attrStr("alt") + "](" + url + ")"
		}
		return nod.renderAnchor()
	}
	file, ok := assets[nod.mediaAssetKey()]
	if !ok {
		return nod.renderAnchor()
	}
	return "![" + nod.attrStr("alt") + "](" + file + ")"
}

// renderMediaGroup renders a mediaGroup — a run of attached files — as one
// image per child on its own line, joined by single newlines so the whole group
// stays a single top-level block (a blank line would split it into separate
// blocks and break the push baseline; see [segmentBody]). Each child renders as
// [Node.renderMedia] does: a downloaded file as an image, an unresolved one as
// a read-only anchor directive. The group is read-only on push like all media.
func (nod Node) renderMediaGroup(ctx mdCtx) string {
	lines := make([]string, 0, len(nod.Content))
	for _, child := range nod.Content {
		if s := child.renderBlock(ctx); s != "" {
			lines = append(lines, s)
		}
	}
	return strings.Join(lines, "\n")
}

// renderParagraph renders a paragraph, encoding its indentation level as an
// "N> " marker on the first line with continuation lines aligned under the text
// (see [Node.indentLevel]). The marker begins with a digit, so no Markdown tool
// mistakes it for a blockquote, yet it survives the push round trip where
// leading spaces would be stripped. A non-indented paragraph whose own text
// would begin with such a marker is escaped with a leading backslash so it
// never re-parses as indented.
func (nod Node) renderParagraph(ctx mdCtx) string {
	segs := nod.inlineSegments(ctx)
	level := nod.indentLevel()
	if level == 0 {
		return escapeIndentMarker(wrapSegments(segs, wrapWidth))
	}
	marker := strconv.Itoa(level) + "> "
	pad := strings.Repeat(" ", len(marker))
	lines := strings.Split(wrapSegments(segs, wrapWidth-len(marker)), "\n")
	for i, ln := range lines {
		switch {
		case i == 0:
			lines[i] = marker + ln
		case ln != "":
			lines[i] = pad + ln
		}
	}
	return strings.Join(lines, "\n")
}

// indentLevel returns the level of the node's indentation mark, or 0 when it
// carries none. Confluence marks an indented paragraph both on the node and,
// redundantly, on its text; this reads the node-level mark, which the "N>"
// marker encodes.
func (nod Node) indentLevel() int {
	for _, mrk := range nod.Marks {
		if mrk.Type == "indentation" {
			f, _ := mrk.Attrs["level"].(float64)
			return int(f)
		}
	}
	return 0
}

// escapeIndentMarker prefixes a backslash to flush-left text that would itself
// begin with an "N>" indentation marker, so it is never mistaken for one on the
// way back; [stripIndentMarker] is the inverse.
func escapeIndentMarker(text string) string {
	if indentMarkerLen(text) > 0 {
		return `\` + text
	}
	return text
}

// indentMarkerLen returns the byte length of a leading "N>" indentation marker
// at the start of s — one or more digits followed by ">" — or 0 when s does not
// begin with one.
func indentMarkerLen(s string) int {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i > 0 && i < len(s) && s[i] == '>' {
		return i + 1
	}
	return 0
}

// renderPanel renders a panel as a GitHub-style alert blockquote, mapping the
// panelType to an uppercased "[!TYPE]" tag. A panel whose type uppercases to
// "EXPAND" would collide with an expand's tag (see [Node.renderExpand]), so it
// falls back to a read-only anchor to keep "[!EXPAND]" unambiguous; no such
// Confluence panelType exists, so this guard is defensive.
func (nod Node) renderPanel(ctx mdCtx) string {
	label := strings.ToUpper(nod.attrStr("panelType"))
	if label == "" {
		label = "NOTE"
	}
	if label == "EXPAND" {
		return nod.renderAnchor()
	}
	lines := append([]string{"[!" + label + "]"},
		quotedContentLines(nod.Content, ctx)...)
	return strings.Join(quotePrefix(lines), "\n")
}

// renderBlockquote renders a blockquote as a plain GitHub-style quote: every
// content line carries a "> " marker, with no "[!TYPE]" tag line — that tag is
// the one thing distinguishing a panel (see [Node.renderPanel]) from a bare
// blockquote in the shared "> " shape. Its single-paragraph body is editable on
// push; a multi-paragraph quote is frozen (see [rebuildBlockquote]).
func (nod Node) renderBlockquote(ctx mdCtx) string {
	return strings.Join(
		quotePrefix(quotedContentLines(nod.Content, ctx)), "\n")
}

// renderExpand renders an expand as a GitHub-style alert blockquote tagged
// "[!EXPAND]", with its title as the rest of the tag line. An empty title
// leaves a bare "[!EXPAND]" tag. The tag identifies the container; the title is
// editable prose the reverse parse reads back (see [rebuildExpand]), unlike a
// panel's frozen type tag. The body renders like a panel's, so an expand's
// single-paragraph body is editable on push and a richer body is frozen (see
// [rebuildQuotedBody]).
func (nod Node) renderExpand(ctx mdCtx) string {
	tag := "[!EXPAND]"
	if title := nod.attrStr("title"); title != "" {
		tag += " " + title
	}
	lines := append([]string{tag}, quotedContentLines(nod.Content, ctx)...)
	return strings.Join(quotePrefix(lines), "\n")
}

// quotedContentLines renders a node's block children to soft-wrapped lines,
// narrowed by the "> " marker width, ready for [quotePrefix]. It is the shared
// body of a panel and a blockquote render. Consecutive paragraphs are separated
// by a blank line — which [quotePrefix] turns into a bare ">" line — so a
// multi-paragraph container keeps its paragraph boundaries across the round
// trip (see [splitQuotedParagraphs]).
func quotedContentLines(content []Node, ctx mdCtx) []string {
	var lines []string
	for i, child := range content {
		if i > 0 {
			lines = append(lines, "")
		}
		if child.Type == "paragraph" {
			wrapped := wrapSegments(
				child.inlineSegments(ctx), wrapWidth-blockPrefixWidth)
			lines = append(lines, strings.Split(wrapped, "\n")...)
			continue
		}
		// Nested lists, code blocks, tables, and the like keep their block
		// shape under the quote marker rather than being flattened to inline.
		body := strings.TrimRight(child.renderBlock(ctx), "\n")
		if body != "" {
			lines = append(lines, strings.Split(body, "\n")...)
		}
	}
	return lines
}

// quotePrefix prefixes each line with the blockquote "> " marker, using a bare
// ">" for an empty line, and returns the slice for joining.
func quotePrefix(lines []string) []string {
	for i, ln := range lines {
		if ln == "" {
			lines[i] = ">"
			continue
		}
		lines[i] = "> " + ln
	}
	return lines
}

// renderBulletList renders a bullet list, one item per [renderListItem], each
// prefixed with a "- " marker.
func (nod Node) renderBulletList(ctx mdCtx) string {
	return renderList(nod.Content, func(int) string { return "- " }, ctx)
}

// renderOrderedList renders a numbered list, one item per [renderListItem].
// Items are numbered sequentially from the list's "order" attribute (the start
// number, default 1), so the rendered numbers match what Confluence displays.
// The "order" attribute is frozen on push (the list structure is copied from
// the cached ADF), so the numbering re-renders identically and PutGet holds.
func (nod Node) renderOrderedList(ctx mdCtx) string {
	start := max(nod.attrInt("order"), 1)
	return renderList(nod.Content, func(i int) string {
		return strconv.Itoa(start+i) + ". "
	}, ctx)
}

// renderList renders a list's items, joined one per line, prefixing item i with
// marker(i). It is the shared core of [Node.renderBulletList] and
// [Node.renderOrderedList].
func renderList(items []Node, marker func(int) string, ctx mdCtx) string {
	out := make([]string, 0, len(items))
	for i, li := range items {
		out = append(out, renderListItem(li, marker(i), ctx))
	}
	return strings.Join(out, "\n")
}

// renderListItem renders one list item. Its first line is prefixed with the
// given marker ("- " for a bullet, "N. " for a numbered item), its continuation
// lines indented to align under the text. The body comes from [listItemBody];
// this function only prefixes and indents it.
func renderListItem(li Node, marker string, ctx mdCtx) string {
	pad := strings.Repeat(" ", len(marker))
	lines := strings.Split(listItemBody(li, ctx), "\n")
	for i, ln := range lines {
		switch {
		case i == 0:
			lines[i] = marker + ln
		case ln == "":
			// a paragraph-separating blank line stays bare
		default:
			lines[i] = pad + ln
		}
	}
	return strings.Join(lines, "\n")
}

// listItemBody renders a list item's children as its un-prefixed body: a
// paragraph as wrapped inline text, a nested block (a sub-list or code block)
// as its own block render, joined by a blank line. It is what [renderListItem]
// prefixes for display and the diff key [rebuildBulletList] matches an edited
// item against, so the two never disagree. A multi-paragraph item keeps its
// boundaries across the round trip (the continuation shape [segmentBody] keeps
// whole and [splitBulletItems] reverses); a single-paragraph item renders
// exactly as before. An item holding a nested block renders it faithfully but
// stays read-only on push (see [editListItem]).
func listItemBody(li Node, ctx mdCtx) string {
	blocks := make([]string, 0, len(li.Content))
	for _, child := range li.Content {
		if child.Type == "paragraph" {
			blocks = append(blocks, wrapSegments(
				child.inlineSegments(ctx), wrapWidth-blockPrefixWidth))
			continue
		}
		blocks = append(blocks, child.renderBlock(ctx))
	}
	return strings.Join(blocks, "\n\n")
}

// spanMarker fills a table position covered by a neighboring cell's colspan or
// rowspan. GFM has no cell spans, so the origin cell keeps the value and every
// other position it covers shows this marker instead of a silent empty cell, so
// the merge is visible rather than read as missing data.
const spanMarker = "«"

// cellPad is the display width a rendered cell adds around its content — the
// single space on each side of the "| a |" layout — so a column's separator
// dashes span the full cell, not just the content.
const cellPad = 2

// renderTable renders the node as a column-aligned GitHub-flavored Markdown
// table. Cell padding and separator dashes are sized to each column's widest
// cell. A table whose first row is entirely tableHeader cells uses that row as
// the GFM header. A key/value table (a tableHeader in the first column of every
// row, no header row) has no GFM equivalent, so it renders with a blank header
// row and its header cells bolded inline; the same fallback covers a table with
// no header cells at all. Cell spans degrade via [spanMarker].
func (nod Node) renderTable(ctx mdCtx) string {
	text, head := buildTableGrid(nod, ctx)
	if len(text) == 0 || len(text[0]) == 0 {
		return ""
	}
	rows, cols := len(text), len(text[0])

	// The first row is the GFM header only when every one of its cells is a
	// header; otherwise header cells are bolded as data under a blank header.
	headerRow := rowAllHeader(head[0])

	display := make([][]string, rows)
	for r := range text {
		display[r] = make([]string, cols)
		for c, v := range text[r] {
			v = escapeTableCell(v)
			if head[r][c] && !(headerRow && r == 0) &&
				v != "" && v != spanMarker {
				v = "**" + v + "**"
			}
			display[r][c] = v
		}
	}

	widths := make([]int, cols)
	for _, row := range display {
		for j, c := range row {
			if w := runewidth.StringWidth(c); w > widths[j] {
				widths[j] = w
			}
		}
	}

	var b strings.Builder
	writeRow := func(cells []string) {
		for j := range cols {
			cell := ""
			if j < len(cells) {
				cell = cells[j]
			}
			b.WriteString("| ")
			b.WriteString(runewidth.FillRight(cell, widths[j]))
			b.WriteByte(' ')
		}
		b.WriteString("|\n")
	}

	data := display
	if headerRow {
		writeRow(display[0])
		data = display[1:]
	} else {
		writeRow(make([]string, cols)) // blank synthetic header
	}
	for j := range cols {
		b.WriteByte('|')
		b.WriteString(strings.Repeat("-", widths[j]+cellPad))
	}
	b.WriteString("|\n")
	for _, cells := range data {
		writeRow(cells)
	}
	return strings.TrimRight(b.String(), "\n")
}

// escapeTableCell escapes a cell's rendered text so it survives transport in a
// "|"-delimited GFM table row: a backslash becomes "\\" and a "|" becomes "\|".
// A cell holding a literal pipe — most often the "|" that separates an inline
// directive's content from its attributes, as in "[[!Done|color=green]]" — is
// then not misread as a column boundary. Escaping the backslash too keeps the
// split unambiguous, since directive content can itself emit "\\";
// [splitTableRow] reverses both.
func escapeTableCell(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `|`, `\|`)
	return s
}

// buildTableGrid lays an ADF table out as a rectangular grid: cell text by row
// and column, positions covered by a colspan or rowspan filled with
// [spanMarker], and a parallel grid recording which positions came from a
// tableHeader cell. The row and column counts follow the spans, so a spanning
// cell widens or deepens the grid rather than displacing its neighbors.
func buildTableGrid(nod Node, ctx mdCtx) (text [][]string, head [][]bool) {
	type cell struct {
		text string
		head bool
	}
	placed := map[int]map[int]cell{}
	put := func(r, c int, v cell) {
		if placed[r] == nil {
			placed[r] = map[int]cell{}
		}
		placed[r][c] = v
	}
	taken := func(r, c int) bool {
		_, ok := placed[r][c]
		return ok
	}

	maxRow, maxCol := -1, -1
	for r, row := range nod.Content {
		c := 0
		for _, cel := range row.Content {
			for taken(r, c) { // skip positions held by a rowspan from above
				c++
			}
			cs, rs := max(cel.attrInt("colspan"), 1), max(cel.attrInt("rowspan"), 1)
			val, isHead := cel.cellText(ctx), cel.Type == "tableHeader"
			for dr := range rs {
				for dc := range cs {
					v := cell{text: val, head: isHead}
					if dr != 0 || dc != 0 {
						v.text = spanMarker
					}
					put(r+dr, c+dc, v)
					maxRow, maxCol = max(maxRow, r+dr), max(maxCol, c+dc)
				}
			}
			c += cs
		}
	}
	if maxRow < 0 || maxCol < 0 {
		return nil, nil
	}

	rows, cols := maxRow+1, maxCol+1
	text, head = make([][]string, rows), make([][]bool, rows)
	for r := range rows {
		text[r], head[r] = make([]string, cols), make([]bool, cols)
		for c := range cols {
			if v, ok := placed[r][c]; ok {
				text[r][c], head[r][c] = v.text, v.head
			}
		}
	}
	return text, head
}

// rowAllHeader reports whether every cell in a materialized table row came from
// a tableHeader (an empty row is not a header row).
func rowAllHeader(row []bool) bool {
	for _, h := range row {
		if !h {
			return false
		}
	}
	return len(row) > 0
}

// renderCodeBlock renders a codeBlock as a fenced code block, the language (if
// any) on the opening fence. The body is the node's literal text, embedded
// newlines and all. A code block is read-only on push: [segmentBody] keeps the
// fenced region whole, and neither an insert nor an edit of it is accepted.
func (nod Node) renderCodeBlock() string {
	var b strings.Builder
	b.WriteString("```")
	b.WriteString(nod.attrStr("language"))
	b.WriteByte('\n')
	b.WriteString(nod.codeText())
	b.WriteString("\n```")
	return b.String()
}

// codeText concatenates the literal text of a code block's children, preserving
// the embedded newlines that separate its lines.
func (nod Node) codeText() string {
	var b strings.Builder
	for _, child := range nod.Content {
		if child.Type == "text" {
			b.WriteString(child.Text)
		}
	}
	return b.String()
}

// cellText renders a table cell's children as one inline string, joined by a
// "<br>". GFM gives a cell no block structure, so the break is the only way to
// keep a multi-paragraph cell's paragraph boundaries across the round trip (see
// [editTableCell]); a single-paragraph cell renders exactly as its lone
// paragraph, unchanged. A hardBreak inside a paragraph also renders as "<br>",
// so a cell whose paragraph carries one is indistinguishable coming back and
// stays read-only. A non-paragraph child (a nested list or code block) is
// rendered as its block form with its newlines flattened to "<br>", so it shows
// faithfully within the one-line cell; such a cell is read-only on push.
func (nod Node) cellText(ctx mdCtx) string {
	parts := make([]string, 0, len(nod.Content))
	for _, child := range nod.Content {
		if child.Type == "paragraph" {
			parts = append(parts, child.inlineString(ctx))
			continue
		}
		flat := strings.ReplaceAll(child.renderBlock(ctx), "\n", "<br>")
		parts = append(parts, flat)
	}
	return strings.TrimSpace(strings.Join(parts, "<br>"))
}

// inlineString renders the node's inline children to a single string, with no
// wrapping and no line breaks. A hardBreak, which cannot be a real newline in a
// one-line context such as a heading or table cell, renders as an HTML "<br>".
// For flowing block text that may span lines, prefer [Node.inlineSegments].
func (nod Node) inlineString(ctx mdCtx) string {
	return strings.Join(nod.inlineSegments(ctx), "<br>")
}

// inlineSegments renders the node's inline children to one string per
// hardBreak-delimited segment, with no wrapping; a node with no hardBreak
// yields a single segment. Splitting on hardBreak lets a caller soft-wrap each
// segment on its own and rejoin them with a Markdown hard line break, so the
// break stays semantic while soft wrapping does not. Spaces between segments
// come from the text nodes themselves. Consecutive plain text nodes render as
// one run so a formatting mark shared across the boundary is emitted once.
func (nod Node) inlineSegments(ctx mdCtx) []string {
	var segments []string
	var b strings.Builder
	var run []Node
	flush := func() {
		if len(run) == 0 {
			return
		}
		b.WriteString(renderTextRun(run))
		run = nil
	}
	cut := func() {
		flush()
		segments = append(segments, b.String())
		b.Reset()
	}
	for _, child := range nod.Content {
		switch {
		case child.Type == "hardBreak":
			cut()
		case child.Type == "text" && !child.hasLink():
			run = append(run, child)
		default:
			flush()
			b.WriteString(child.renderInline(ctx))
		}
	}
	cut()
	return segments
}

// renderTextRun renders consecutive text nodes as one inline string, keeping a
// formatting mark open across the boundary whenever adjacent nodes share it.
// Delimiters stay balanced, so a mark that spans nodes never degenerates into
// an empty run like "~~~~"; splitting a marked span across text nodes is
// meaningless in ADF, so the merge round-trips.
func renderTextRun(run []Node) string {
	var b strings.Builder
	var open []string
	for _, nod := range run {
		want := nod.formatMarks()
		keep := commonPrefix(open, want)
		for i := len(open) - 1; i >= keep; i-- {
			b.WriteString(markClose(open[i]))
		}
		open = open[:keep]
		for _, kind := range want[keep:] {
			b.WriteString(markOpen(kind))
			open = append(open, kind)
		}
		b.WriteString(nod.escapedText())
	}
	for i := len(open) - 1; i >= 0; i-- {
		b.WriteString(markClose(open[i]))
	}
	return b.String()
}

// commonPrefix returns the length of the longest shared prefix of a and b.
func commonPrefix(a, b []string) int {
	i := 0
	for i < min(len(a), len(b)) && a[i] == b[i] {
		i++
	}
	return i
}

// renderInline renders a single inline node. Unsupported inline types render as
// a placeholder comment.
func (nod Node) renderInline(ctx mdCtx) string {
	switch nod.Type {
	case "text":
		return nod.renderText(ctx)

	case "inlineCard":
		return nod.renderInlineCard(ctx)

	case "mention":
		return nod.renderMention(ctx)

	case "status", "date", "emoji":
		return nod.renderDirective()

	default:
		// Any other inline node round-trips as a generic directive, provided
		// its attributes are all strings; one with a non-string attribute (a
		// number, a nested object) cannot be expressed by the key=value grammar
		// and keeps the faithful read-only placeholder.
		if allStringAttrs(nod) {
			return nod.renderDirective()
		}
		return nod.placeholder()
	}
}

// dirAttr is one attribute of a rendered inline directive: a key and its value,
// emitted as key=value in the directive's "|key=value;…" attribute tail.
type dirAttr struct {
	key string
	val string
}

// rendersAsDirective reports whether an inline node renders as a directive
// rather than as literal text or a read-only placeholder. It mirrors
// [Node.renderInline]: text, mentions and inlineCards have their own encodings;
// status, date and emoji are always directives; any other node is a directive
// only when its attributes are all strings, so it can round-trip through the
// key=value grammar. It is how [inlineSig] keys a directive token.
func rendersAsDirective(nod Node) bool {
	switch nod.Type {
	case "text", "mention", "inlineCard", "hardBreak":
		return false
	case "status", "date", "emoji":
		return true
	default:
		return allStringAttrs(nod)
	}
}

// allStringAttrs reports whether every attribute of the node is a string, so
// the node can be rendered as a directive without losing a non-string value.
func allStringAttrs(nod Node) bool {
	for _, v := range nod.Attrs {
		if _, ok := v.(string); !ok {
			return false
		}
	}
	return true
}

// renderDirective renders an inline node that has no plain-Markdown equivalent
// as a "[[…]]" directive, the encoding specified in dev/inline-directives.md.
// A sigil'd type renders as sugar — status "[[!content|attrs]]", date
// "[[#…]]", emoji "[[:…]]" — and every other type as the generic
// "[[*type:content|attrs]]". content is the node's human-readable text, and
// every other round-tripped attribute rides after the "|" — in a per-type
// canonical order for status, date and emoji, else the remaining string
// attributes sorted by key — so the output is deterministic and re-parses to
// the same node (see [inlineParser.parseDirective]).
func (nod Node) renderDirective() string {
	content, attrs := directiveParts(nod)
	switch nod.Type {
	case "status":
		return "[[!" + directiveBody(content, attrs) + "]]"
	case "date":
		return "[[#" + directiveBody(content, attrs) + "]]"
	case "emoji":
		return "[[:" + directiveBody(content, attrs) + "]]"
	default:
		return "[[*" + nod.Type + ":" + directiveBody(content, attrs) + "]]"
	}
}

// directiveBody renders the "content|key=value;key=value" tail shared by every
// directive form: the escaped content, then, when the node has any attribute,
// a "|" and the attributes joined by ";". Each value is quoted only when a bare
// token would not re-parse (see [quoteDirectiveValue]).
func directiveBody(content string, attrs []dirAttr) string {
	var b strings.Builder
	b.WriteString(escapeDirectiveContent(content))
	if len(attrs) > 0 {
		b.WriteByte('|')
		for i, a := range attrs {
			if i > 0 {
				b.WriteByte(';')
			}
			b.WriteString(a.key)
			b.WriteByte('=')
			b.WriteString(quoteDirectiveValue(a.val))
		}
	}
	return b.String()
}

// directiveParts returns the content text and the canonically-ordered
// attributes of an inline directive node, per the mappings in
// dev/inline-directives.md. A status carries its label plus color (defaulting
// to "neutral") and a non-default style; a date shows its human day with the
// authoritative epoch-ms in ts=; an emoji shows its shortName (colons stripped)
// as the content, the authoritative field, with the id when present. The emoji
// glyph is not rendered — the shortName is the readable form.
func directiveParts(nod Node) (string, []dirAttr) {
	switch nod.Type {
	case "status":
		color := nod.attrStr("color")
		if color == "" {
			color = "neutral"
		}
		attrs := []dirAttr{{"color", color}}
		if style := nod.attrStr("style"); style != "" && style != "default" {
			attrs = append(attrs, dirAttr{"style", style})
		}
		return nod.attrStr("text"), attrs

	case "date":
		ts := nod.dateTimestamp()
		return humanDate(ts), []dirAttr{{"ts", ts}}

	case "emoji":
		var attrs []dirAttr
		if id := nod.attrStr("id"); id != "" {
			attrs = append(attrs, dirAttr{"id", id})
		}
		return emojiContent(nod.attrStr("shortName")), attrs

	default:
		return nod.attrStr("text"), genericAttrs(nod)
	}
}

// emojiContent is the readable content of an emoji directive: the shortName
// with its surrounding colons stripped, so ":smile:" renders as "[[:smile]]". A
// shortName not wrapped in colons is returned unchanged. [buildDirective]
// rewraps it on the way back.
func emojiContent(short string) string {
	if len(short) >= 2 && short[0] == ':' && short[len(short)-1] == ':' {
		return short[1 : len(short)-1]
	}
	return short
}

// genericAttrs returns a node's attributes as directive attributes in a
// deterministic order: every attribute except the text content and the dropped
// localId, keyed lexically. It is the fallback for a node type without a
// canonical attr order.
func genericAttrs(nod Node) []dirAttr {
	keys := make([]string, 0, len(nod.Attrs))
	for k := range nod.Attrs {
		if k == "text" || k == "localId" {
			continue
		}
		keys = append(keys, k)
	}
	slices.Sort(keys)
	attrs := make([]dirAttr, 0, len(keys))
	for _, k := range keys {
		attrs = append(attrs, dirAttr{k, nod.attrStr(k)})
	}
	return attrs
}

// renderAnchor renders a read-only node as a generic "[[*type:content|attrs]]"
// directive that carries its localId, the anchor the merge matches to copy the
// frozen node back verbatim. It is the counterpart to [Node.renderDirective]
// for block nodes and for inline nodes that cannot round-trip through the
// key=value grammar: unlike an editable inline directive it keeps localId, and
// it drops any non-string attribute, which the merge restores from the cached
// ADF. content is the node's text attribute, empty for most blocks.
func (nod Node) renderAnchor() string {
	body := directiveBody(nod.attrStr("text"), anchoredAttrs(nod))
	return "[[*" + nod.Type + ":" + body + "]]"
}

// anchoredAttrs returns a node's string attributes as directive attributes in
// lexical order, keeping localId (the merge anchor) but dropping the text
// content and any non-string value. It is the read-only counterpart to
// [genericAttrs], which drops localId because an editable inline leaf carries
// no anchor.
func anchoredAttrs(nod Node) []dirAttr {
	keys := make([]string, 0, len(nod.Attrs))
	for k, v := range nod.Attrs {
		if k == "text" {
			continue
		}
		if _, ok := v.(string); !ok {
			continue
		}
		keys = append(keys, k)
	}
	slices.Sort(keys)
	attrs := make([]dirAttr, 0, len(keys))
	for _, k := range keys {
		attrs = append(attrs, dirAttr{k, nod.attrStr(k)})
	}
	return attrs
}

// dateTimestamp returns the node's timestamp attribute as a string, whether it
// decoded as a string or a JSON number.
func (nod Node) dateTimestamp() string {
	if s := nod.attrStr("timestamp"); s != "" {
		return s
	}
	if f, ok := nod.Attrs["timestamp"].(float64); ok {
		return strconv.FormatInt(int64(f), 10)
	}
	return ""
}

// humanDate renders epoch-millisecond ts as a UTC "YYYY-MM-DD" day, the
// cosmetic content of a date directive. An unparseable ts is returned verbatim,
// so the render stays deterministic and the ts attribute stays authoritative.
func humanDate(ts string) string {
	ms, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return ts
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02")
}

// escapeDirectiveContent escapes the characters that would otherwise end or
// misparse a directive's content: a backslash, the "|" that begins the
// attribute list, and a "]" (which could pair with a following "]" to close the
// directive early). Escaping every "]" is more than the grammar strictly needs
// but keeps the rule simple and always re-parses; see [scanDirectiveTail].
func escapeDirectiveContent(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `]`, `\]`)
	s = strings.ReplaceAll(s, `|`, `\|`)
	return s
}

// quoteDirectiveValue returns an attribute value unchanged when it is a bare
// token, or double-quoted with '"' and '\' escaped when it is empty or contains
// a character that would break the attribute grammar: a space, tab, quote, the
// ";" pair separator, or a "]" that could close the directive early.
func quoteDirectiveValue(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\";]") {
		r := strings.ReplaceAll(s, `\`, `\\`)
		r = strings.ReplaceAll(r, `"`, `\"`)
		return `"` + r + `"`
	}
	return s
}

// renderInlineCard renders an inlineCard (a Confluence smart link) as a
// CommonMark autolink "<url>". That is distinct from a plain link
// "[label](href)", so it re-parses back to an inlineCard instead of collapsing
// into a link, while still displaying as a clickable URL. A url that cannot sit
// inside an autolink (empty, or containing whitespace or ">") falls back to the
// read-only placeholder rather than emitting something that would misparse.
func (nod Node) renderInlineCard(ctx mdCtx) string {
	url := nod.attrStr("url")
	// A card that targets a pulled page becomes a normal "[title](path)" link:
	// a card cannot carry a local file target, and Confluence has no title in
	// the node, so the resolver supplies the label. The card is not restored on
	// push; it stays a link.
	if ctx.links != nil {
		if target, label, ok := ctx.links.ToLocal(url); ok {
			return "[" + escapeLinkLabel(label) + "](" + target + ")"
		}
	}
	if url == "" || strings.ContainsAny(url, " \t\n>") {
		return nod.placeholder()
	}
	return "<" + url + ">"
}

// escapeLinkLabel backslash-escapes the characters that would break a Markdown
// link label: "\", "[" and "]". It is used for a synthetic label, such as a
// page title spliced in when an inlineCard is rewritten into a link.
func escapeLinkLabel(s string) string {
	r := strings.ReplaceAll(s, `\`, `\\`)
	r = strings.ReplaceAll(r, "[", `\[`)
	return strings.ReplaceAll(r, "]", `\]`)
}

// renderMention renders a mention as "[[@name]]", the account id being
// recovered from the mentions frontmatter map on the way back; see
// [ADF.mentionList]. When the display name is ambiguous on the page (it appears
// with more than one account id, so the frontmatter map cannot key it), the id
// is carried inline as "[[@name|id=…]]" instead.
func (nod Node) renderMention(ctx mdCtx) string {
	name := mentionName(nod)
	body := escapeDirectiveContent(name)
	if ctx.ambig[name] {
		return "[[@" + body + "|id=" + quoteDirectiveValue(nod.attrStr("id")) + "]]"
	}
	return "[[@" + body + "]]"
}

// renderText renders a single text node with its marks. Formatting marks nest
// in canonical order with "strong" innermost; a link mark wraps the result.
func (nod Node) renderText(ctx mdCtx) string {
	s := nod.escapedText()
	marks := nod.formatMarks()
	for i := len(marks) - 1; i >= 0; i-- {
		s = markOpen(marks[i]) + s + markClose(marks[i])
	}
	if href, ok := nod.linkHref(); ok {
		s = "[" + s + "](" + localLink(ctx.links, href) + ")"
	}
	return s
}

// formatMarks returns the node's formatting marks as delimiter codes in
// canonical nesting order, outermost first, ignoring links and the layout-only
// marks ("indentation", and node-level "alignment"/"breakout") that have no
// inline delimiter. A code is normally the mark type; a textColor carries its
// color so two differently-colored spans neither merge nor round-trip as equal
// (see [markCode]). The fixed order makes the render deterministic, so an
// unedited node re-renders byte-identically after a parse.
func (nod Node) formatMarks() []string {
	// Canonical nesting order, outermost first.
	order := []string{"strike", "textColor", "underline", "em", "code", "strong"}
	out := make([]string, 0, len(nod.Marks))
	for _, kind := range order {
		for _, mrk := range nod.Marks {
			if mrk.Type == kind {
				out = append(out, markCode(mrk))
				break
			}
		}
	}
	return out
}

// markCode is the delimiter code a mark renders under: its type, except a
// textColor, which appends its color as "textColor=<color>" so the color rides
// through the render/parse round trip and distinguishes two spans of different
// colors. [markOpen] and [markClose] map a code back to its opening and closing
// delimiters.
func markCode(mrk Mark) string {
	if mrk.Type == "textColor" {
		return "textColor=" + mrk.attrStr("color")
	}
	return mrk.Type
}

// linkHref reports the href of the node's link mark, if any.
func (nod Node) linkHref() (string, bool) {
	for _, mrk := range nod.Marks {
		if mrk.Type == "link" {
			return mrk.attrStr("href"), true
		}
	}
	return "", false
}

// hasLink reports whether the node carries a link mark.
func (nod Node) hasLink() bool {
	_, ok := nod.linkHref()
	return ok
}

// markOpen returns the opening delimiter for a formatting-mark code (see
// [markCode]). The inline marks strong, em, strike and code use a symmetric
// Markdown delimiter; underline and textColor, which Markdown cannot express,
// use an HTML tag ("<u>", "<span style=\"color:…\">"), matched by the parser
// (see [inlineParser.parseRun]). A code with no delimiter renders as "".
func markOpen(code string) string {
	if color, ok := strings.CutPrefix(code, "textColor="); ok {
		return `<span style="color:` + color + `">`
	}
	switch code {
	case "strong":
		return "**"
	case "em":
		return "*"
	case "strike":
		return "~~"
	case "code":
		return "`"
	case "underline":
		return "<u>"
	default:
		return ""
	}
}

// markClose returns the closing delimiter for a formatting-mark code, the
// counterpart of [markOpen]. The symmetric Markdown marks close with the same
// delimiter they open with; the HTML marks close with their end tag.
func markClose(code string) string {
	if strings.HasPrefix(code, "textColor=") {
		return "</span>"
	}
	switch code {
	case "underline":
		return "</u>"
	default:
		return markOpen(code)
	}
}

// escapedText returns a text node's content ready to emit inline: backslash-
// escaped so it re-parses literally (see [escapeInline]), except inside a code
// span, whose content is literal and takes no escapes.
func (nod Node) escapedText() string {
	if nod.hasCodeMark() {
		return nod.Text
	}
	return escapeInline(nod.Text)
}

// hasCodeMark reports whether the node carries a code mark, which renders it as
// a backtick code span.
func (nod Node) hasCodeMark() bool {
	for _, mrk := range nod.Marks {
		if mrk.Type == "code" {
			return true
		}
	}
	return false
}

// escapeInline backslash-escapes the characters in a text node's content that
// the inline parser would otherwise read as markup, so the text re-parses
// literally (see [inlineParser.parseRun]). The escaping is contextual and
// minimal: "*", a backtick, and a backslash itself are always escaped, while
// "~", "[" and "<" are escaped only where they would actually begin a
// construct — a "~~" run, a "[label](url)" link, a "[[@…]]" directive or a
// "<url>" autolink. Ordinary punctuation (a lone tilde, a non-link bracket, a
// stray "<") is left untouched so the Markdown stays clean.
func escapeInline(s string) string {
	if !strings.ContainsAny(s, "\\`*~[<") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 8)
	for i := range len(s) {
		if escapeAt(s, i) {
			b.WriteByte('\\')
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// escapeAt reports whether the byte at index i in s must be backslash-escaped.
// The multi-character triggers mirror the parser's opener checks exactly, so a
// character is escaped precisely when leaving it raw would start a construct.
func escapeAt(s string, i int) bool {
	switch s[i] {
	case '\\', '`', '*':
		return true
	case '~':
		return i+1 < len(s) && s[i+1] == '~'
	case '[':
		return startsLink(s[i:]) || startsDirective(s[i:])
	case '<':
		return startsAutolink(s[i:]) ||
			startsUnderline(s[i:]) || startsColorSpan(s[i:])
	}
	return false
}

// startsUnderline reports whether s begins the "<u>" underline opener,
// mirroring [inlineParser.parseRun], so a literal "<u>" in prose is escaped and
// stays text rather than opening an underline span.
func startsUnderline(s string) bool {
	return strings.HasPrefix(s, "<u>")
}

// startsColorSpan reports whether s begins a well-formed textColor opener
// '<span style="color:COLOR">', mirroring [inlineParser.parseColorSpan], so a
// literal one in prose is escaped exactly when it would otherwise parse.
func startsColorSpan(s string) bool {
	const open = `<span style="color:`
	if !strings.HasPrefix(s, open) {
		return false
	}
	after := s[len(open):]
	end := strings.Index(after, `">`)
	return end > 0 && !strings.ContainsAny(after[:end], `"<>`)
}

// startsLink reports whether s begins a "[label](url)" link, mirroring
// [inlineParser.parseLink]: a "](" followed by a closing ")".
func startsLink(s string) bool {
	_, after, ok := strings.Cut(s, "](")
	return ok && strings.IndexByte(after, ')') >= 0
}

// startsDirective reports whether s begins an inline directive "[[" followed by
// a dispatch character (a sigil "@", "!", "#", ":" or the generic "*") and a
// closing "]]", mirroring [inlineParser.parseDirective] so a literal
// directive-looking span in prose is escaped exactly when it would otherwise
// parse.
func startsDirective(s string) bool {
	if !strings.HasPrefix(s, "[[") || len(s) < 3 {
		return false
	}
	switch s[2] {
	case '@', '!', '#', ':', '*':
		return strings.Contains(s[3:], "]]")
	}
	return false
}

// startsAutolink reports whether s begins a "<url>" autolink, mirroring
// [inlineParser.parseAutolink].
func startsAutolink(s string) bool {
	end := strings.IndexByte(s, '>')
	if end < 0 {
		return false
	}
	url := s[1:end]
	return url != "" && !strings.ContainsAny(url, " \t") &&
		strings.Contains(url, "://")
}

// wrap soft-wraps s at width columns, keeping each Markdown link whole even
// when its label contains spaces.
func wrap(s string, width int) string {
	return textwrap.WrapTokens(splitTokens(s), width)
}

// wrapSegments soft-wraps each hardBreak-delimited segment to width columns and
// joins them with a Markdown hard line break: a trailing backslash then a
// newline. The break ends a line with a visible "\" and survives formatters,
// while soft wrapping within a segment stays non-semantic and reflowable.
func wrapSegments(segments []string, width int) string {
	lines := make([]string, len(segments))
	for i, seg := range segments {
		lines[i] = wrap(seg, width)
	}
	return strings.Join(lines, "\\\n")
}

// splitTokens splits s into space-separated tokens, keeping a Markdown link
// "[label](url)" whole so a space inside its label never becomes a wrap point.
// An inline directive "[[…]]" is kept whole by the same bracket-depth tracking,
// so a directive such as "[[!In Review|color=yellow;style=bold]]" whose content
// contains a space stays on one line.
func splitTokens(s string) []string {
	var tokens []string
	var cur strings.Builder
	// depth is 1 inside a link label, 2 inside a link URL, 3 inside a literal
	// "{…}" group in the text, 0 otherwise; a space ends a token only at depth
	// 0. A "[[…]]" directive is held together by the link-label depth (its
	// leading "[").
	depth := 0
	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, cur.String())
			cur.Reset()
		}
	}
	for _, r := range s {
		switch {
		case depth == 0 && r == ' ':
			flush()
			continue

		case depth == 0 && r == '[':
			depth = 1

		case depth == 1 && r == ']':
			depth = 0

		case depth == 0 && r == '(' && strings.HasSuffix(cur.String(), "]"):
			depth = 2

		case depth == 2 && r == ')':
			depth = 0

		case depth == 0 && r == '{':
			depth = 3

		case depth == 3 && r == '}':
			depth = 0
		}
		cur.WriteRune(r)
	}
	flush()
	return tokens
}

// placeholder renders an unsupported node as an HTML comment carrying its type
// and a few identifying attributes, so nothing is dropped silently.
func (nod Node) placeholder() string {
	var attrs []string
	switch nod.Type {
	case "extension":
		attrs = nod.placeholderAttrs("extensionKey", "localId")
	case "media":
		attrs = nod.placeholderAttrs("alt", "id")
	default:
		attrs = nod.placeholderAttrs("localId")
	}
	head := "<!-- adf:" + nod.Type
	if len(attrs) > 0 {
		head += " " + strings.Join(attrs, " ")
	}
	return head + " -->"
}

// placeholderAttrs formats the named string attributes as key="value" pairs,
// skipping any that are absent.
func (nod Node) placeholderAttrs(keys ...string) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		if v := nod.attrStr(k); v != "" {
			out = append(out, fmt.Sprintf("%s=%q", k, v))
		}
	}
	return out
}
