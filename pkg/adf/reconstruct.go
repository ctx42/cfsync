// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strconv"
	"strings"
)

// Put back-ports the edits expressed in an edited Markdown body into the cached
// document and returns the new document, ready to push. It is the lens put of
// the push design: the result is what the edited Markdown expresses combined
// with everything else copied untouched from the cached ADF, so nothing the
// Markdown cannot express (localId, panel types, macros, table structure) is
// lost.
//
// body is the edited Markdown body only, with the frontmatter already stripped;
// mentions is the display-name→account-id map from that frontmatter, used to
// resolve [[@name]] mentions; assets is the same media map used to render the
// page on pull, so baseline blocks match. The result is a fresh document; the
// receiver is not modified.
//
// Put applies in-place edits and structural inserts/deletes that the Markdown
// can express — paragraphs, headings, lists, panels, tables, and images among
// them — and rejects a change that would be lossy rather than guessing. A
// modified block whose original inline does not round-trip is refused.
//
// Before returning, Put verifies both lens laws: an unchanged block re-renders
// byte-identically to the cached render (GetPut), and every block re-renders to
// the user's edit (PutGet). A violation is returned as an error, never pushed.
func (adf *ADF) Put(
	body string,
	mentions map[string]string,
	assets map[string]string,
	images []NewImage,
) (*ADF, error) {

	return adf.PutLinks(body, mentions, assets, images, nil)
}

// PutLinks is [ADF.Put] with a [Links] that maps local Markdown links in the
// edited body back to the Confluence hrefs to push, and renders the baseline
// with the same mapping so an unedited cross-linked block is not seen as a
// change. A nil links behaves exactly like Put.
func (adf *ADF) PutLinks(
	body string,
	mentions map[string]string,
	assets map[string]string,
	images []NewImage,
	links Links,
) (*ADF, error) {

	pc := parseCtx{mentions: mentions, links: links}
	baseBlocks, origins, err := adf.baselineBlocks(assets, links)
	if err != nil {
		return nil, err
	}
	userBlocks := segmentBody(body)
	edits := diffBlocks(baseBlocks, userBlocks)

	out, err := adf.clone()
	if err != nil {
		return nil, err
	}

	// A user-added image is spliced in as a media node that renders like any
	// resolved media, so index the new images by their Markdown path and add
	// each to the assets map used to render and validate the rebuilt document,
	// keyed by its minted localId. baseBlocks keep the original assets: the
	// baseline has no new image, and an unchanged block never references one.
	imgByPath := make(map[string]NewImage, len(images))
	full := assets
	if len(images) > 0 {
		full = make(map[string]string, len(assets)+len(images))
		maps.Copy(full, assets)
		for _, img := range images {
			imgByPath[img.Path] = img
			full[img.LocalID] = img.Path
		}
	}

	ctx := mdCtx{assets: full, ambig: adf.ambiguousMentions(), links: links}
	if hasStructural(edits) {
		err = applyStructural(out, origins, userBlocks, edits, ctx, pc, imgByPath)
	} else {
		err = applyInPlace(out, origins, userBlocks, edits, ctx, pc)
	}
	if err != nil {
		return nil, err
	}

	err = adf.validatePut(out, baseBlocks, userBlocks, edits, full, links)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// NewImage describes a user-added local image to splice into the document on
// push: the Markdown path as it appears in the edited body, the alt text, and
// the attributes of the Confluence attachment it was uploaded as. The lens
// turns each inserted ![alt](Path) block whose target is a NewImage into a
// mediaSingle+media node; any other inserted image is rejected, as it has no
// attachment to point at.
type NewImage struct {
	Path       string // the ![](path) target as written in the Markdown
	Alt        string // the ![alt] text
	FileID     string // attachment fileId → media attrs.id
	LocalID    string // minted node localId (see [NewLocalID])
	Collection string // media attrs.collection, e.g. "contentId-<pageID>"
}

// hasStructural reports whether the edit script inserts or deletes a block, as
// opposed to only keeping or modifying blocks in place.
func hasStructural(edits []edit) bool {
	for _, e := range edits {
		if e.Kind == opInsert || e.Kind == opDelete {
			return true
		}
	}
	return false
}

// applyInPlace applies a keep/modify-only edit script by rewriting each
// modified leaf in the cloned tree, leaving every other node — including
// non-rendered ones with no baseline block — exactly where it was. It is the
// round-1 path, used whenever no block is inserted or deleted.
func applyInPlace(
	out *ADF,
	origins []Origin,
	userBlocks []mdBlock,
	edits []edit,
	ctx mdCtx,
	pc parseCtx,
) error {
	for _, e := range edits {
		if e.Kind != opModify {
			continue // opKeep: the cloned node is already correct.
		}
		orig := origins[e.BaseIndex]
		node := &out.Doc.Content[orig.NodeIndex]
		txt := userBlocks[e.UserIndex].Text
		if err := editBlock(node, orig, e.BaseIndex, txt, ctx, pc); err != nil {
			return err
		}
	}
	return nil
}

// applyStructural rebuilds the document's top-level content in the user's order
// from an edit script that inserts, deletes, keeps or modifies blocks. A kept
// block is copied from the clone verbatim, a modified one is rebuilt in place,
// an inserted one is built fresh from its Markdown (see [buildBlock]), a
// deleted one is dropped. The read-only lockdown holds for deletes: only a
// paragraph or heading may be deleted.
//
// A non-rendered top-level node (one that renders to nothing, such as the empty
// trailing paragraph Confluence appends) carries no baseline block, so the edit
// script never names it. To avoid dropping it, each is anchored to the rendered
// block it precedes and travels with it, re-emitted verbatim just before that
// block wherever it lands; the non-rendered nodes after the last rendered block
// stay at the document's end. A deleted block's leading non-rendered nodes are
// kept in its place, so the rebuild is never lossy.
func applyStructural(
	out *ADF,
	origins []Origin,
	userBlocks []mdBlock,
	edits []edit,
	ctx mdCtx,
	pc parseCtx,
	images map[string]NewImage,
) error {
	preceding, tail := nonRenderedGroups(out.Doc.Content, origins)

	content := make([]Node, 0, len(userBlocks)+len(out.Doc.Content)-len(origins))
	for _, e := range edits {
		switch e.Kind {
		case opKeep:
			content = append(content, preceding[e.BaseIndex]...)
			content = append(content, out.Doc.Content[origins[e.BaseIndex].NodeIndex])

		case opModify:
			content = append(content, preceding[e.BaseIndex]...)
			orig := origins[e.BaseIndex]
			node := out.Doc.Content[orig.NodeIndex]
			txt := userBlocks[e.UserIndex].Text
			if err := editBlock(&node, orig, e.BaseIndex, txt, ctx, pc); err != nil {
				return err
			}
			content = append(content, node)

		case opInsert:
			node, err := buildBlock(
				userBlocks[e.UserIndex].Text, e.UserIndex, pc, images)
			if err != nil {
				return err
			}
			content = append(content, node)

		case opDelete:
			orig := origins[e.BaseIndex]
			if orig.Type != "paragraph" && orig.Type != "heading" {
				format := "" +
					"push: cannot delete %s block %d: only paragraph and " +
					"heading blocks can be deleted"
				return fmt.Errorf(format, orig.Type, e.BaseIndex)
			}
			// The block is dropped, but its non-rendered anchors are kept.
			content = append(content, preceding[e.BaseIndex]...)
		}
	}
	content = append(content, tail...)
	out.Doc.Content = content
	return nil
}

// nonRenderedGroups partitions the top-level nodes that render to nothing (and
// so have no [Origin]) by the rendered block they precede. preceding[b] holds
// the non-rendered nodes lying between rendered block b-1 and rendered block b,
// anchored to b; tail holds those after the last rendered block. Every node not
// named by origins falls in exactly one group, so [applyStructural] can re-emit
// them without loss when it rebuilds the content in the user's order.
func nonRenderedGroups(
	content []Node,
	origins []Origin,
) (preceding [][]Node, tail []Node) {

	preceding = make([][]Node, len(origins))
	prev := 0
	for b, o := range origins {
		preceding[b] = content[prev:o.NodeIndex]
		prev = o.NodeIndex + 1
	}
	return preceding, content[prev:]
}

// NewLocalID mints a fresh ADF node localId — six random bytes as twelve hex
// digits, matching the localId shape Confluence assigns — for a synthesized
// media node whose attachment has just been uploaded.
func NewLocalID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("minting localId: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// insertableAsLeaf reports whether an inserted block can be rebuilt as a plain
// paragraph or heading. It rejects a block whose first line carries a
// structured-block marker; top-level, such a block gets its own builder (see
// buildDispatch), while inside an inserted container it marks nesting the flat
// rebuild cannot express.
func insertableAsLeaf(text string) bool {
	line, _, _ := strings.Cut(text, "\n")
	line = strings.TrimLeft(line, " ")
	if orderedMarkerWidth(line) > 0 {
		return false
	}
	for _, p := range []string{"|", "- ", "* ", "+ ", "> ", "```", "![",
		"<!--", "[["} {
		if strings.HasPrefix(line, p) {
			return false
		}
	}
	return true
}

// clone returns a deep copy of the document by round-tripping it through its
// wrapper JSON, so mutating the copy never affects the receiver and numbers
// decode identically to the cached parse.
func (adf *ADF) clone() (*ADF, error) {
	data, err := json.Marshal(adf)
	if err != nil {
		return nil, fmt.Errorf("cloning document: %w", err)
	}
	return NewADF(data)
}

// leafEditable reports whether node is a text leaf whose text can be safely
// reparsed: a paragraph or heading whose every hard-break segment round-trips.
// A container (handled by [editBlock]), a read-only block, or a leaf holding an
// inexpressible inline node (an emoji, an unsupported mark) is not editable.
func leafEditable(node Node, ctx mdCtx, pc parseCtx) bool {
	if node.Type != "paragraph" && node.Type != "heading" {
		return false
	}
	for _, seg := range inlineSegmentsOf(node.Content) {
		if !inlineRoundTrips(seg, ctx, pc) {
			return false
		}
	}
	return true
}

// editRejectReason explains, for an error message, why a block is not editable.
func editRejectReason(node Node) string {
	if node.Type != "paragraph" && node.Type != "heading" {
		return "only paragraph and heading text is editable so far"
	}
	return "it contains formatting the Markdown cannot express losslessly"
}

// rebuildLeaf replaces node's inline content with the parse of userText,
// keeping node's type and attributes (localId and the rest) intact. Hard breaks
// are recovered from the segment separator appropriate to the node kind, and
// soft wrapping is undone before each segment is parsed.
func rebuildLeaf(node *Node, userText string, pc parseCtx) {
	sep := "\\\n" // a paragraph hard break: trailing backslash then newline
	text := userText
	level := 0
	switch node.Type {
	case "heading":
		sep = "<br>"
		if lvl := leadingHashes(text); lvl >= 1 && lvl <= 6 {
			if node.Attrs == nil {
				node.Attrs = map[string]any{}
			}
			node.Attrs["level"] = float64(lvl)
		}
		text = strings.TrimPrefix(strings.TrimLeft(text, "#"), " ")
	case "paragraph":
		level, text = stripIndentMarker(text)
	}

	node.Content = parseSegments(text, sep, pc)
	if node.Type == "paragraph" {
		setIndentation(node, level)
	}
}

// parseSegments splits text on the hard-break separator sep and parses each
// piece into inline nodes, undoing soft wrapping first and inserting a
// hardBreak node between pieces. It is the shared inline-rebuild core of
// [rebuildLeaf] and [rebuildInline].
func parseSegments(text, sep string, pc parseCtx) []Node {
	segments := strings.Split(text, sep)
	content := make([]Node, 0, len(segments))
	for i, seg := range segments {
		if i > 0 {
			content = append(content, Node{Type: "hardBreak"})
		}
		content = append(content, parseInline(unwrap(seg), pc)...)
	}
	return content
}

// rebuildInline replaces a leaf's inline content with the parse of text,
// recovering paragraph hard breaks. Unlike [rebuildLeaf] it interprets neither
// a heading level nor an indentation marker, so it suits a paragraph nested in
// a container, where those markers do not apply.
func rebuildInline(node *Node, text string, pc parseCtx) {
	node.Content = parseSegments(text, "\\\n", pc)
}

// editBlock applies a modify to a top-level block. It rebuilds an editable leaf
// (a paragraph or heading) in place, or recurses into an editable container (a
// bullet list, or a single-paragraph panel) to rebuild only the nested leaves
// the user changed while freezing the container's structure. Any other block —
// or a leaf holding inline the Markdown cannot express — is rejected. Both lens
// laws still gate the result, so a reverse-parse that does not perfectly mirror
// the render fails safely as a rejection rather than a corrupt push.
func editBlock(
	node *Node,
	orig Origin,
	baseIdx int,
	text string,
	ctx mdCtx,
	pc parseCtx,
) error {
	if leafEditable(*node, ctx, pc) {
		rebuildLeaf(node, text, pc)
		return nil
	}
	switch node.Type {
	case "bulletList":
		return rebuildBulletList(node, text, ctx, pc)
	case "orderedList":
		return rebuildOrderedList(node, text, ctx, pc)
	case "panel":
		return rebuildPanel(node, text, ctx, pc)
	case "blockquote":
		return rebuildBlockquote(node, text, ctx, pc)
	case "expand":
		return rebuildExpand(node, text, ctx, pc)
	case "table":
		return rebuildTable(node, text, ctx, pc)
	default:
		format := "push: cannot edit %s block %d: %s"
		return fmt.Errorf(format, orig.Type, baseIdx, editRejectReason(*node))
	}
}

// rebuildBulletList back-ports edits into a bullet list; see [rebuildList] for
// the alignment semantics. It splits the edited text into item bodies on the
// "- " marker (see [splitBulletItems]).
func rebuildBulletList(
	node *Node,
	text string,
	ctx mdCtx,
	pc parseCtx,
) error {
	return rebuildList(node, splitBulletItems(text), ctx, pc)
}

// rebuildOrderedList back-ports edits into a numbered list; see [rebuildList]
// for the alignment semantics. It splits the edited text into item bodies on
// the "N. " marker (see [splitOrderedItems]). The list's "order" start number
// and its structure are frozen, copied from the cached ADF.
func rebuildOrderedList(
	node *Node,
	text string,
	ctx mdCtx,
	pc parseCtx,
) error {
	return rebuildList(node, splitOrderedItems(text), ctx, pc)
}

// rebuildList back-ports edits into a list, item by item, given the edited item
// bodies already split from the rendered list. It aligns the edited items
// against the baseline items with the same LCS diff used at the top level (see
// [diffBlocks]), so an item may be kept, modified, inserted or deleted: a kept
// item is copied verbatim, a modified one has its paragraph rebuilt in place,
// an inserted one is a fresh single-paragraph item, a deleted one is dropped. A
// modified or inserted item that is not a single paragraph — one with more than
// one block, or inline the Markdown cannot express — is rejected. The list's
// own structure (its nesting) is otherwise frozen, and the top-level PutGet law
// still gates the rebuilt list.
func rebuildList(
	node *Node,
	items []string,
	ctx mdCtx,
	pc parseCtx,
) error {
	base := make([]mdBlock, len(node.Content))
	for i, li := range node.Content {
		base[i] = newBlock(listItemBody(li, ctx))
	}
	user := make([]mdBlock, len(items))
	for i, it := range items {
		user[i] = newBlock(it)
	}

	out := make([]Node, 0, len(items))
	for _, e := range diffBlocks(base, user) {
		switch e.Kind {
		case opKeep:
			out = append(out, node.Content[e.BaseIndex])

		case opModify:
			li := node.Content[e.BaseIndex]
			err := editListItem(&li, items[e.UserIndex], e.BaseIndex, ctx, pc)
			if err != nil {
				return err
			}
			out = append(out, li)

		case opInsert:
			li, err := buildListItem(items[e.UserIndex], e.UserIndex, pc)
			if err != nil {
				return fmt.Errorf("push: %w", err)
			}
			out = append(out, li)

		case opDelete:
			// The item is dropped by not appending it.
		}
	}
	node.Content = out
	return nil
}

// editListItem rebuilds a modified list item's paragraphs from its edited body,
// leaving the item's localId and attributes intact. The item's paragraph count
// is structure and frozen (adding or removing one is rejected, as a merged or
// split paragraph would not be caught by PutGet — a blank line normalizes to a
// space); a changed paragraph is rebuilt only if it is a single editable leaf,
// an unchanged one is left untouched. A non-paragraph child, or inline the
// Markdown cannot express, is rejected. idx names the item in the error.
func editListItem(
	li *Node,
	body string,
	idx int,
	ctx mdCtx,
	pc parseCtx,
) error {

	paras := splitBlankLineParagraphs(body)
	if len(paras) != len(li.Content) {
		format := "push: cannot add or remove a paragraph in list item %d"
		return fmt.Errorf(format, idx)
	}
	for i := range li.Content {
		para := &li.Content[i]
		if para.Type != "paragraph" {
			format := "push: cannot edit list item %d holding a %s"
			return fmt.Errorf(format, idx, para.Type)
		}
		// Compare in the hard-break form the body was rendered with (\\\n),
		// not inlineString's <br>, so an untouched hard-break sibling is
		// left alone rather than rebuilt.
		base := strings.Join(para.inlineSegments(ctx), "\\\n")
		if normalizeBlock(paras[i]) == normalizeBlock(base) {
			continue // this paragraph is unchanged
		}
		if !leafEditable(*para, ctx, pc) {
			format := "" +
				"push: cannot edit list item %d: it contains formatting " +
				"the Markdown cannot express losslessly"
			return fmt.Errorf(format, idx)
		}
		rebuildInline(para, paras[i], pc)
	}
	return nil
}

// buildListItem constructs a fresh list item holding a single paragraph parsed
// from an inserted item body. It carries no localId, so Confluence assigns one
// on save, as it does for an inserted top-level paragraph. A body that carries
// a structured-block marker (see [insertableAsLeaf]) or spans more than one
// paragraph has no lossless single-paragraph form and is rejected — a merge
// would slip past PutGet; idx names the item in the error. The error is a bare
// reason; each caller prefixes its own context.
func buildListItem(body string, idx int, pc parseCtx) (Node, error) {
	if !insertableAsLeaf(body) || len(splitBlankLineParagraphs(body)) > 1 {
		format := "" +
			"cannot insert list item %d: only single-paragraph " +
			"plain-text items can be inserted"
		return Node{}, fmt.Errorf(format, idx)
	}
	para := Node{Type: "paragraph"}
	rebuildInline(&para, body, pc)
	return Node{Type: "listItem", Content: []Node{para}}, nil
}

// splitBulletItems splits a rendered bullet list back into its item bodies, the
// inverse of [renderListItem]: a line beginning with a bullet marker ("- ",
// "* ", or "+ ", matching [isListStart]) starts an item and the following
// indented or blank lines continue it. Each returned body has its marker and
// continuation indentation removed but keeps its paragraph-separating blank
// lines, so a multi-paragraph item survives (split by
// [splitBlankLineParagraphs]).
func splitBulletItems(text string) []string {
	var items []string
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			items = append(items, strings.Join(cur, "\n"))
			cur = nil
		}
	}
	for ln := range strings.SplitSeq(text, "\n") {
		if body, ok := cutBulletMarker(ln); ok {
			flush()
			cur = append(cur, body)
		} else if isBlankLine(ln) {
			cur = append(cur, "")
		} else {
			cur = append(cur, strings.TrimLeft(ln, " "))
		}
	}
	flush()
	return items
}

// cutBulletMarker strips a leading "- ", "* ", or "+ " bullet marker.
func cutBulletMarker(ln string) (string, bool) {
	for _, m := range []string{"- ", "* ", "+ "} {
		if body, ok := strings.CutPrefix(ln, m); ok {
			return body, true
		}
	}
	return "", false
}

// splitOrderedItems splits a rendered numbered list back into its item bodies,
// the inverse of [renderListItem] for an ordered list: a line beginning with an
// "N. " marker (see [orderedMarkerWidth]) starts an item and the following
// indented or blank lines continue it. Each returned body has its marker and
// continuation indentation removed but keeps its paragraph-separating blank
// lines, so a multi-paragraph item survives (split by
// [splitBlankLineParagraphs]). The numbers themselves are dropped: they are
// re-derived from the list's frozen "order" attribute on render, never parsed.
func splitOrderedItems(text string) []string {
	var items []string
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			items = append(items, strings.Join(cur, "\n"))
			cur = nil
		}
	}
	for ln := range strings.SplitSeq(text, "\n") {
		if w := orderedMarkerWidth(ln); w > 0 {
			flush()
			cur = append(cur, ln[w:])
		} else if isBlankLine(ln) {
			cur = append(cur, "")
		} else {
			cur = append(cur, strings.TrimLeft(ln, " "))
		}
	}
	flush()
	return items
}

// orderedMarkerWidth returns the byte width of the numbered-list marker at the
// start of ln — one or more ASCII digits followed by ". " — or 0 when ln does
// not begin with such a marker. It is how both the segmenter ([isListStart])
// and the push splitter ([splitOrderedItems]) recognize an ordered-list item.
func orderedMarkerWidth(ln string) int {
	digits := 0
	for digits < len(ln) && ln[digits] >= '0' && ln[digits] <= '9' {
		digits++
	}
	if digits == 0 || !strings.HasPrefix(ln[digits:], ". ") {
		return 0
	}
	return digits + len(". ")
}

// rebuildPanel back-ports an edit into a panel's body. The "[!TYPE]" tag line
// is structure and stays frozen (a changed tag is caught by PutGet and
// rejected); only the body paragraphs are editable. See [rebuildQuotedBody].
func rebuildPanel(node *Node, text string, ctx mdCtx, pc parseCtx) error {
	// Drop the frozen "[!TYPE]" tag line; the rest is the quoted body.
	return rebuildQuotedBody(node, strings.Split(text, "\n")[1:], "panel", ctx, pc)
}

// rebuildExpand back-ports an edit into an expand. Unlike a panel's frozen
// "[!TYPE]" tag, the "[!EXPAND] title" tag line carries an editable title: the
// title text is parsed off it and written back to the node, so retitling an
// expand pushes. The body below the tag is rebuilt like a panel's (see
// [rebuildQuotedBody]). The title is left untouched when unchanged, so an
// absent title is not turned into an empty one by a body-only edit.
func rebuildExpand(node *Node, text string, ctx mdCtx, pc parseCtx) error {
	lines := strings.Split(text, "\n")
	if title := parseExpandTitle(lines[0]); title != node.attrStr("title") {
		if node.Attrs == nil {
			node.Attrs = map[string]any{}
		}
		node.Attrs["title"] = title
	}
	return rebuildQuotedBody(node, lines[1:], "expand", ctx, pc)
}

// parseExpandTitle reads the title off an expand's tag line, the inverse of the
// tag [Node.renderExpand] emits: the "> " quote marker and the "[!EXPAND]"
// token are stripped and the remainder trimmed, so a bare "> [!EXPAND]" yields
// the empty title.
func parseExpandTitle(line string) string {
	body := strings.TrimPrefix(line, "> ")
	return strings.TrimSpace(strings.TrimPrefix(body, "[!EXPAND]"))
}

// rebuildQuotedBody back-ports edits into the paragraphs of a "> "-quoted
// container — a panel's body or a whole blockquote — from its body lines, each
// still carrying its "> " (or bare ">") marker. A paragraph is a run of
// non-empty quoted lines; a bare ">" line separates two paragraphs (see
// [quotedContentLines]). The paragraph count is structure and frozen: adding or
// removing one is rejected. A changed paragraph is rebuilt only when it is a
// single editable leaf; an unchanged one is left untouched, so a body the
// Markdown cannot express is not disturbed when only a neighboring line moved.
// kind names the container in error messages.
func rebuildQuotedBody(
	node *Node,
	lines []string,
	kind string,
	ctx mdCtx,
	pc parseCtx,
) error {

	userParas := splitQuotedParagraphs(lines)
	if len(userParas) != len(node.Content) {
		format := "push: cannot add or remove a paragraph in a %s"
		return fmt.Errorf(format, kind)
	}
	for i := range node.Content {
		para := &node.Content[i]
		if para.Type != "paragraph" {
			format := "push: cannot edit a %s holding a %s"
			return fmt.Errorf(format, kind, para.Type)
		}
		// Hard-break form matches the quoted body render and rebuildInline.
		base := strings.Join(para.inlineSegments(ctx), "\\\n")
		if normalizeBlock(userParas[i]) == normalizeBlock(base) {
			continue // this paragraph is unchanged
		}
		if !leafEditable(*para, ctx, pc) {
			format := "" +
				"push: cannot edit %s text: it contains formatting the " +
				"Markdown cannot express losslessly"
			return fmt.Errorf(format, kind)
		}
		rebuildInline(para, userParas[i], pc)
	}
	return nil
}

// splitQuotedParagraphs turns the body lines of a "> "-quoted container into
// one unwrapped string per paragraph. Each line's "> " (or bare ">") marker is
// stripped, then the un-marked lines are split into paragraphs on their blank
// (former bare-">") lines. It is the inverse of the line shape
// [quotedContentLines] emits.
func splitQuotedParagraphs(lines []string) []string {
	plain := make([]string, len(lines))
	for i, ln := range lines {
		body := strings.TrimPrefix(ln, "> ")
		if body == ln { // no "> " prefix, so a bare ">" or a stray line
			body = strings.TrimPrefix(ln, ">")
		}
		plain[i] = body
	}
	return splitBlankLineParagraphs(strings.Join(plain, "\n"))
}

// splitBlankLineParagraphs splits text into one unwrapped string per paragraph,
// a paragraph being a run of non-blank lines and a blank line the separator. Soft
// wraps collapse to spaces; Markdown hard breaks (a trailing "\") are kept as
// "\\\n" so [rebuildInline] can recover them. It is the shared paragraph
// splitter for a list item's and a quoted container's multi-paragraph body.
func splitBlankLineParagraphs(text string) []string {
	var paras []string
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			paras = append(paras, joinSoftWrapLines(cur))
			cur = nil
		}
	}
	for ln := range strings.SplitSeq(text, "\n") {
		if isBlankLine(ln) {
			flush()
			continue
		}
		cur = append(cur, ln)
	}
	flush()
	return paras
}

// joinSoftWrapLines joins a paragraph's physical lines: soft wraps become
// spaces, and a trailing backslash hard break is re-emitted as "\\\n" between
// segments so it matches [wrapSegments] and [rebuildInline].
func joinSoftWrapLines(lines []string) string {
	var segs []string
	var soft []string
	for _, ln := range lines {
		if hardBreakLine(ln) {
			soft = append(soft, strings.TrimSuffix(ln, `\`))
			segs = append(segs, unwrap(strings.Join(soft, " ")))
			soft = nil
			continue
		}
		soft = append(soft, ln)
	}
	if len(soft) > 0 {
		segs = append(segs, unwrap(strings.Join(soft, " ")))
	}
	return strings.Join(segs, "\\\n")
}

// hardBreakLine reports whether ln ends in a Markdown hard break: an odd number
// of trailing backslashes (a single "\" is the break; "\\" is a literal).
func hardBreakLine(ln string) bool {
	n := 0
	for i := len(ln) - 1; i >= 0 && ln[i] == '\\'; i-- {
		n++
	}
	return n%2 == 1
}

// rebuildTable back-ports edits into a table cell by cell. The table's shape —
// its rows, columns, colspans, rowspans and which cells are headers — is
// structure and stays frozen; only the text inside a cell is editable. It
// re-derives the same rendered grid [renderTable] produced (see
// [buildTableGrid]), parses the user's edited Markdown table back into the same
// grid, and for every cell whose rendered value changed rebuilds that cell's
// paragraph in place. A changed cell that is not a single editable paragraph is
// rejected. Because the render is lossy in several ways — header-column cells
// are bolded, a blank synthetic header and its separator are injected, and
// colspan/rowspan-covered positions show the "«" span marker — the reverse
// parse cannot be perfect in every case; the top-level PutGet law gates the
// result, so an imperfect reverse parse fails as a safe rejection, never a
// corrupt push.
func rebuildTable(node *Node, text string, ctx mdCtx, pc parseCtx) error {
	gridText, gridHead := buildTableGrid(*node, ctx)
	if len(gridText) == 0 || len(gridText[0]) == 0 {
		return errors.New("push: cannot edit an empty table")
	}
	rows, cols := len(gridText), len(gridText[0])
	headerRow := rowAllHeader(gridHead[0])

	userGrid, err := parseUserTable(text)
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	// A table with no all-header first row renders a blank synthetic header row
	// above the separator; drop it so the remaining rows align to the grid.
	if !headerRow {
		userGrid = userGrid[1:]
	}
	if len(userGrid) != rows {
		format := "push: cannot change the number of table rows (have %d, want %d)"
		return fmt.Errorf(format, len(userGrid), rows)
	}
	for _, ur := range userGrid {
		if len(ur) != cols {
			return errors.New("push: cannot change the number of table columns")
		}
	}

	// Walk the cells in document order, tracking each origin's grid position
	// exactly as buildTableGrid does, and rebuild the ones the user changed.
	placed := map[int]map[int]bool{}
	taken := func(r, c int) bool { return placed[r] != nil && placed[r][c] }
	mark := func(r, c int) {
		if placed[r] == nil {
			placed[r] = map[int]bool{}
		}
		placed[r][c] = true
	}
	for r := range node.Content {
		row := &node.Content[r]
		c := 0
		for ci := range row.Content {
			cell := &row.Content[ci]
			for taken(r, c) { // skip positions held by a rowspan from above
				c++
			}
			cs := max(cell.attrInt("colspan"), 1)
			rs := max(cell.attrInt("rowspan"), 1)
			for dr := range rs {
				for dc := range cs {
					mark(r+dr, c+dc)
				}
			}
			if err := editTableCellIfChanged(
				cell, gridText[r][c], gridHead[r][c], headerRow && r == 0,
				userGrid[r][c], r, c, ctx, pc); err != nil {
				return err
			}
			c += cs
		}
	}
	return nil
}

// editTableCellIfChanged compares a cell's rendered display value against the
// user's edited value for the same grid position and, when they differ,
// rebuilds the cell's paragraph. base is the cell's rendered text and head
// whether it came from a tableHeader; inHeaderRow marks the top row of an
// all-header-first-row table, whose cells are not bolded. A header cell not in
// that row is displayed bolded, so the bold wrapping is stripped before the new
// body is parsed; a cell the user did not touch is left untouched.
func editTableCellIfChanged(
	cell *Node,
	base string,
	head, inHeaderRow bool,
	user string,
	r, c int,
	ctx mdCtx,
	pc parseCtx,
) error {

	bolded := head && !inHeaderRow && base != "" && base != spanMarker
	display := base
	if bolded {
		display = "**" + base + "**"
	}
	if user == display {
		return nil // this cell is unchanged
	}
	body := user
	if bolded && len(user) >= 4 &&
		strings.HasPrefix(user, "**") && strings.HasSuffix(user, "**") {
		body = user[2 : len(user)-2]
	}
	return editTableCell(cell, body, r, c, ctx, pc)
}

// editTableCell rebuilds the changed paragraphs of a table cell from its edited
// body, the "<br>"-separated inverse of [Node.cellText], leaving the cell's
// type (tableHeader or tableCell), its span attributes and its localId intact.
// The cell's paragraph count is structure and frozen: adding or removing one is
// rejected, since a merged or split paragraph would slip past PutGet. A changed
// paragraph is rebuilt only when it is a single editable leaf; an unchanged one
// is left alone, so a paragraph the Markdown cannot express is not disturbed
// when a neighbor changed. A non-paragraph child (a nested list or code block)
// is rejected rather than rebuilt lossily; r and c name the cell in the error.
func editTableCell(
	cell *Node,
	body string,
	r, c int,
	ctx mdCtx,
	pc parseCtx,
) error {

	// A cell holding a nested block (a sub-list or code block) renders that block
	// with its newlines flattened to "<br>" (see [Node.cellText]), which the
	// per-paragraph split below cannot reverse; freeze the whole cell rather than
	// mis-split it.
	for _, child := range cell.Content {
		if child.Type != "paragraph" {
			format := "push: cannot edit a multi-block table cell (row %d, col %d)"
			return fmt.Errorf(format, r, c)
		}
	}
	paras := strings.Split(body, "<br>")
	if len(paras) != len(cell.Content) {
		format := "push: cannot add or remove a paragraph in table cell " +
			"(row %d, col %d)"
		return fmt.Errorf(format, r, c)
	}
	for i := range cell.Content {
		para := &cell.Content[i]
		body := unwrap(paras[i])
		if normalizeBlock(body) == normalizeBlock(para.inlineString(ctx)) {
			continue // this paragraph is unchanged
		}
		if !leafEditable(*para, ctx, pc) {
			format := "" +
				"push: cannot edit table cell (row %d, col %d): it " +
				"contains formatting the Markdown cannot express losslessly"
			return fmt.Errorf(format, r, c)
		}
		rebuildInline(para, body, pc)
	}
	return nil
}

// parseUserTable parses a Markdown table body into a grid of trimmed cell
// strings, one slice per row, dropping the "---" separator row. It is the
// reverse of [Node.renderTable]'s row writer. The separator must be the second
// line, as the renderer always emits it, so a table missing it is rejected.
// Errors are bare reasons; each caller prefixes its own context.
func parseUserTable(text string) ([][]string, error) {
	var lines []string
	for ln := range strings.SplitSeq(text, "\n") {
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	if len(lines) < 2 {
		return nil, errors.New("a table needs a header and a separator row")
	}
	if !isSeparatorRow(splitTableRow(lines[1])) {
		msg := "the table is missing its '---' separator row"
		return nil, errors.New(msg)
	}
	grid := make([][]string, 0, len(lines)-1)
	for i, ln := range lines {
		if i == 1 {
			continue // the separator row
		}
		grid = append(grid, splitTableRow(ln))
	}
	return grid, nil
}

// splitTableRow splits one Markdown table line into its trimmed cell strings,
// the inverse of the padded "| a | b |" the renderer writes. It splits only on
// an unescaped "|", so a "\|" inside a cell — the escape [escapeTableCell]
// writes for a literal pipe, such as an inline directive's "content|attrs"
// separator — stays within its cell, and each cell is then unescaped back to
// its rendered text.
func splitTableRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	var cells []string
	var b strings.Builder
	for i := 0; i < len(line); i++ {
		switch c := line[i]; {
		case c == '\\' && i+1 < len(line):
			b.WriteByte(line[i+1])
			i++
		case c == '|':
			cells = append(cells, strings.TrimSpace(b.String()))
			b.Reset()
		default:
			b.WriteByte(c)
		}
	}
	cells = append(cells, strings.TrimSpace(b.String()))
	return cells
}

// isSeparatorRow reports whether every cell of a table line is a GFM separator
// token — a run of '-' with optional ':' alignment markers — as the renderer
// writes for the line under the header.
func isSeparatorRow(cells []string) bool {
	if len(cells) == 0 {
		return false
	}
	for _, cel := range cells {
		if cel == "" {
			return false
		}
		for _, r := range cel {
			if r != '-' && r != ':' {
				return false
			}
		}
	}
	return true
}

// rebuildBlockquote back-ports an edit into a blockquote's paragraphs. It is
// the tag-less sibling of [rebuildPanel]: the whole rendered text is the quoted
// body, with no "[!TYPE]" tag line to drop. See [rebuildQuotedBody].
func rebuildBlockquote(node *Node, text string, ctx mdCtx, pc parseCtx) error {
	return rebuildQuotedBody(
		node, strings.Split(text, "\n"), "blockquote", ctx, pc)
}

// stripIndentMarker removes a leading "N>" indentation marker from a
// paragraph's edited text and returns the level it encodes with the remaining
// text. A marker escaped as "\N>" is unescaped to literal text at level 0, the
// inverse of [escapeIndentMarker]. Text with no marker returns level 0
// unchanged.
func stripIndentMarker(text string) (int, string) {
	if strings.HasPrefix(text, `\`) && indentMarkerLen(text[1:]) > 0 {
		return 0, text[1:]
	}
	n := indentMarkerLen(text)
	if n == 0 {
		return 0, text
	}
	// indentMarkerLen guarantees digits then '>'; Atoi can only fail if that
	// invariant is broken, in which case treat the marker as absent.
	level, err := strconv.Atoi(text[:n-1])
	if err != nil {
		return 0, text
	}
	return level, strings.TrimPrefix(text[n:], " ")
}

// setIndentation rewrites node's indentation to level: it drops any existing
// indentation mark and, when level is positive, applies a fresh one to the node
// and to each of its text children, mirroring how Confluence marks an indented
// paragraph. This makes the "N>" marker the source of truth on push, so
// changing or removing it re-indents or de-indents the paragraph.
func setIndentation(node *Node, level int) {
	node.Marks = dropIndentation(node.Marks)
	if level <= 0 {
		return
	}
	node.Marks = append(node.Marks, indentMark(level))
	for i := range node.Content {
		if node.Content[i].Type == "text" {
			node.Content[i].Marks =
				append(dropIndentation(node.Content[i].Marks), indentMark(level))
		}
	}
}

// dropIndentation returns marks with every indentation mark removed, leaving a
// fresh slice so the original is not mutated.
func dropIndentation(marks []Mark) []Mark {
	var out []Mark
	for _, m := range marks {
		if m.Type != "indentation" {
			out = append(out, m)
		}
	}
	return out
}

// indentMark builds an indentation mark for the given level.
func indentMark(level int) Mark {
	return Mark{
		Type:  "indentation",
		Attrs: map[string]any{"level": float64(level)},
	}
}

// leadingHashes counts the run of "#" at the start of s, the Markdown heading
// level.
func leadingHashes(s string) int {
	n := 0
	for n < len(s) && s[n] == '#' {
		n++
	}
	return n
}

// unwrap collapses a soft-wrapped segment back to one logical line: runs of
// whitespace (the wrap newlines and indentation) become single spaces.
func unwrap(seg string) string {
	return strings.Join(strings.Fields(seg), " ")
}

// inlineSegmentsOf splits an inline content slice into segments at hardBreak
// nodes, dropping the breaks. Each segment is a run the round-trip check and
// the parser treat as one logical line.
func inlineSegmentsOf(content []Node) [][]Node {
	var segs [][]Node
	var cur []Node
	for _, nod := range content {
		if nod.Type == "hardBreak" {
			segs = append(segs, cur)
			cur = nil
			continue
		}
		cur = append(cur, nod)
	}
	return append(segs, cur)
}

// validatePut checks both lens laws against the rebuilt document and returns an
// error identifying the first block that fails. GetPut: a kept block must
// re-render byte-identically to its cached render. PutGet: every block must
// re-render to the user's edit (compared normalized, so soft-wrap differences
// do not count). This is the last gate before a push.
func (adf *ADF) validatePut(
	out *ADF,
	baseBlocks, userBlocks []mdBlock,
	edits []edit,
	assets map[string]string,
	links Links,
) error {

	newBlocks, _, err := out.baselineBlocks(assets, links)
	if err != nil {
		return err
	}
	if len(newBlocks) != len(userBlocks) {
		format := "push: rebuilt document has %d blocks, want %d (PutGet failed)"
		return fmt.Errorf(format, len(newBlocks), len(userBlocks))
	}

	// With only keep/modify edits the new document keeps the baseline order, so
	// new block i corresponds to user block i.
	for i := range newBlocks {
		if normalizeBlock(newBlocks[i].Text) != userBlocks[i].Key {
			format := "push: block %d did not round-trip (PutGet failed)"
			return fmt.Errorf(format, i)
		}
	}
	for _, e := range edits {
		if e.Kind != opKeep {
			continue
		}
		if newBlocks[e.UserIndex].Text != baseBlocks[e.BaseIndex].Text {
			format := "push: unchanged block %d was altered (GetPut failed)"
			return fmt.Errorf(format, e.BaseIndex)
		}
	}
	return nil
}
