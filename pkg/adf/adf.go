// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Package adf represents an Atlassian Document Format (ADF) page pulled from
// Confluence, renders it to Markdown, and back-ports edits for push.
//
// The input is the cached wrapper JSON produced by a page pull, of the shape
//
//	{"name":…,"id":…,"title":…,"version":…,"space_id":…,"adf":{ADF doc}}
//
// [NewADF] parses it and [ADF.MarshallMarkdown] renders the whole document,
// YAML frontmatter included. [ADF.Put] and [ADF.Merge3] are the push lens:
// they rebuild ADF from an edited Markdown body while preserving structure the
// Markdown cannot express.
package adf

import (
	"encoding/json"
	"fmt"
)

// ADF is a Confluence page in Atlassian Document Format together with the
// wrapper metadata needed to render its Markdown frontmatter.
type ADF struct {
	// Name is the page's destination name, relative to the work directory and
	// ending in ".md". It is rendered as the page_path frontmatter field, the
	// path a user passes to "cfsync push".
	Name string `json:"name"`

	// ID is the numeric Confluence page identifier.
	ID string `json:"id"`

	// Title is the page title as stored in Confluence.
	Title string `json:"title"`

	// Version is the Confluence page version number.
	Version int `json:"version"`

	// SpaceID is the numeric identifier of the space the page belongs to.
	SpaceID string `json:"space_id"`

	// ParentID is the numeric identifier of the page's parent node — another
	// page or a folder — empty for a page with no parent, such as a space
	// homepage. It is rendered as the parent_id frontmatter field and omitted
	// when empty.
	ParentID string `json:"parent_id,omitempty"`

	// SpaceKey is the key of the space the page belongs to. It is set only for
	// a page pulled through a configured space and rendered as the space_key
	// frontmatter field; it is empty, and omitted from the frontmatter, for a
	// page pulled through pages: or folders:.
	SpaceKey string `json:"space_key,omitempty"`

	// Domain is the Confluence Site host the page was pulled from, such as
	// "example.atlassian.net". It is rendered as the cf_domain frontmatter
	// field and omitted when empty.
	Domain string `json:"cf_domain,omitempty"`

	// Doc is the root of the ADF document tree, a node of type "doc".
	Doc Node `json:"adf"`
}

// Node is a single node in the ADF document tree. The same struct models block
// nodes, inline nodes, and text leaves; which fields are populated depends on
// [Node.Type].
type Node struct {
	// Type is the ADF node type, such as "paragraph", "text" or "table".
	Type string `json:"type"`

	// Content holds the node's children, empty for leaf nodes.
	Content []Node `json:"content,omitempty"`

	// Text is the literal text of a "text" node, empty otherwise.
	Text string `json:"text,omitempty"`

	// Marks are the inline formatting marks applied to a "text" node.
	Marks []Mark `json:"marks,omitempty"`

	// Attrs holds the node's type-specific attributes.
	Attrs map[string]any `json:"attrs,omitempty"`
}

// Mark is an inline formatting mark applied to a text node, such as "strong",
// "em" or "link".
type Mark struct {
	// Type is the mark type.
	Type string `json:"type"`

	// Attrs holds the mark's type-specific attributes, such as a link "href".
	Attrs map[string]any `json:"attrs,omitempty"`
}

// NewADF parses the cached wrapper JSON into an [ADF] value.
func NewADF(data []byte) (*ADF, error) {
	var adf ADF
	if err := json.Unmarshal(data, &adf); err != nil {
		return nil, fmt.Errorf("decoding ADF page: %w", err)
	}
	return &adf, nil
}

// MediaRef identifies an uploaded-file image referenced by the document, the
// information a caller needs to fetch it and link the download back to its ADF
// node.
type MediaRef struct {
	// LocalID is the media node's ADF localId, the stable per-node anchor used
	// as the frontmatter key and the assets-map key in [ADF.MarshallMarkdown].
	LocalID string

	// FileID is the media node's attrs.id, equal to the Confluence attachment
	// fileId; it is the key that matches a node to a downloadable attachment.
	FileID string

	// Alt is the media node's attrs.alt, the original file name.
	Alt string
}

// FileMedia returns a [MediaRef] for every uploaded-file media node in the
// document, in document order, including those inside a mediaGroup and inline
// mediaInline file references. External media is omitted (it carries its own
// URL and is not downloaded). A node with
// neither a localId nor a fileId cannot be anchored to an asset and is omitted;
// one lacking only a localId falls back to its fileId as the anchor key (see
// [Node.mediaAssetKey]), so a file Confluence left without a localId is still
// downloaded and rendered rather than dropped to a placeholder.
func (adf *ADF) FileMedia() []MediaRef {
	nodes := adf.Doc.fileMedia(nil)
	refs := make([]MediaRef, 0, len(nodes))
	for _, nod := range nodes {
		key := nod.mediaAssetKey()
		if key == "" {
			continue // no localId and no fileId: nothing to anchor to
		}
		refs = append(refs, MediaRef{
			LocalID: key,
			FileID:  nod.attrStr("id"),
			Alt:     nod.attrStr("alt"),
		})
	}
	return refs
}

// mediaAssetKey is the key a file-media node is tracked under in the assets map
// and the page_images frontmatter: its localId when it has one, else its fileId
// as a fallback so a node Confluence left without a localId still resolves to a
// downloaded image. It is derived from the node identically on render and on
// the push baseline, so the two always agree.
func (nod Node) mediaAssetKey() string {
	if id := nod.attrStr("localId"); id != "" {
		return id
	}
	return nod.attrStr("id")
}

// fileMedia appends every uploaded-file media node at or below the node to out,
// in document order. Both a block "media" node and an inline "mediaInline"
// reference count when their attrs.type is "file", so an inline attachment's
// image is downloaded and tracked too; a mediaInline still renders as an inline
// directive (it is not turned into an image), so it stays editable.
func (nod Node) fileMedia(out []Node) []Node {
	if (nod.Type == "media" || nod.Type == "mediaInline") &&
		nod.attrStr("type") == "file" {
		out = append(out, nod)
	}
	for _, child := range nod.Content {
		out = child.fileMedia(out)
	}
	return out
}

// attrStr returns the string attribute named key, or "" when it is absent or
// not a string.
func (nod Node) attrStr(key string) string {
	s, _ := nod.Attrs[key].(string)
	return s
}

// attrInt returns the integer attribute named key, or 0 when it is absent or
// not a number. JSON numbers decode as float64, so the value is truncated.
func (nod Node) attrInt(key string) int {
	f, _ := nod.Attrs[key].(float64)
	return int(f)
}

// attrStr returns the string attribute named key, or "" when it is absent or
// not a string.
func (mrk Mark) attrStr(key string) string {
	s, _ := mrk.Attrs[key].(string)
	return s
}
