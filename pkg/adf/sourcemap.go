// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"fmt"
	"strings"
)

// Span is the half-open byte range [Start, End) that a rendered block occupies
// in the Markdown produced by [ADF.MarshallMarkdownMapped]. The offsets index
// the returned byte slice, frontmatter included.
type Span struct {
	Start int
	End   int
}

// Origin links one rendered top-level block back to the ADF node that produced
// it. It is the invisible anchor that makes push possible: on push, cfsync
// re-renders the cached ADF, aligns the user's edited Markdown blocks against
// those origins by normalized content (LCS via [diffBlocks]), and rebuilds the
// ADF from the cached tree plus the expressed edits using [Origin.NodeIndex].
// No marker is written into the Markdown itself.
type Origin struct {
	// NodeIndex is the position, in the document's top-level Content slice, of the
	// source node. Blocks that render to nothing have no origin, so indices are
	// not necessarily contiguous. Put matches edits by content and applies them
	// through this index.
	NodeIndex int

	// Type is the source node's ADF type, such as "paragraph" or "table".
	Type string

	// LocalID is the source node's localId attribute, or "" when it has none.
	// It is recorded for tooling and diagnostics; push matching uses content
	// alignment, not this field.
	LocalID string

	// Span is the block's byte range in the rendered Markdown.
	Span Span
}

// SourceMap is the ordered origin table for one render: the byte where the body
// begins and, per non-empty top-level block, the [Origin] linking it to its
// source node. Its zero value describes a document with no rendered body.
type SourceMap struct {
	// BodyStart is the byte offset at which the rendered body begins, just after
	// the frontmatter and its separating blank line. It equals the length of the
	// output when the document has no rendered body.
	BodyStart int

	// Origins holds one entry per non-empty top-level block, in document order.
	Origins []Origin
}

// MarshallMarkdownMapped renders the document exactly as [ADF.MarshallMarkdown]
// does and additionally returns a [SourceMap] describing where each top-level
// block landed in the output and which ADF node produced it. The byte slice it
// returns is identical to what MarshallMarkdown returns for the same input; the
// map is the side table push needs to back-port edits without writing any
// anchor into the Markdown. See [Origin] for the role it plays.
func (adf *ADF) MarshallMarkdownMapped(
	assets map[string]string,
) ([]byte, *SourceMap, error) {

	return adf.marshallMapped(assets, nil)
}

// marshallMapped is [ADF.MarshallMarkdownMapped] with an optional [Links] to
// rewrite page links; a nil links renders every link unchanged.
func (adf *ADF) marshallMapped(
	assets map[string]string,
	links Links,
) ([]byte, *SourceMap, error) {

	if adf.Doc.Type != "doc" {
		return nil, nil, fmt.Errorf("root node is %q, want doc", adf.Doc.Type)
	}

	ctx := mdCtx{assets: assets, ambig: adf.ambiguousMentions(), links: links}
	blocks := renderBlockList(adf.Doc.Content, ctx)

	var b strings.Builder
	b.WriteString(adf.frontmatter(assets))

	sm := &SourceMap{}
	if len(blocks) > 0 {
		b.WriteString("\n\n")
		sm.BodyStart = b.Len()
		sm.Origins = make([]Origin, 0, len(blocks))
		for i, blk := range blocks {
			if i > 0 {
				b.WriteString("\n\n")
			}
			start := b.Len()
			b.WriteString(blk.Text)
			node := adf.Doc.Content[blk.NodeIndex]
			sm.Origins = append(sm.Origins, Origin{
				NodeIndex: blk.NodeIndex,
				Type:      node.Type,
				LocalID:   node.attrStr("localId"),
				Span:      Span{Start: start, End: b.Len()},
			})
		}
	} else {
		sm.BodyStart = b.Len()
	}
	b.WriteByte('\n')

	return []byte(b.String()), sm, nil
}
