// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

// These integration tests hit the live Atlassian Site using the environment
// loaded by liveEnv (see live_test.go), and — unlike the smoke test in
// push_live_test.go — they MUTATE: each creates a throwaway page in the
// configured test space, round-trips it through pull/edit/push, verifies the
// result on the Site, and deletes the page on cleanup.
//
// Run with: go test -tags confluence -run Test_live_roundtrip ./pkg/cfsync/
package cfsync

import (
	"context"
	"encoding/base64"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ctx42/cfsync/pkg/adf"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testkit/pkg/oskit"
)

// liveRoundTrip is the shared harness: it creates a page with initialADF,
// pulls it into a fresh work dir, lets edit rewrite the pulled Markdown (edit
// receives the work dir so an image test can drop a file beside the .md),
// pushes, then fetches the page fresh from the Site and returns its parsed
// document for assertions. The page is deleted on cleanup.
func liveRoundTrip(
	t *testing.T,
	name, initialADF string,
	edit func(dir, md string) string,
) *adf.ADF {
	t.Helper()
	ctx, client, cfg, lp := liveEnv(t)

	spaceID := must.Value(spaceIDByKey(ctx, client, cfg, lp.space))
	id := must.Value(seedPage(
		ctx, client, cfg, spaceID, lp.folder, uniqueTitle(name), initialADF))
	t.Cleanup(func() {
		_ = purgePage(context.Background(), client, cfg, id)
	})

	dir := cfg.WorkDir
	dest := filepath.Join(dir, "page.md")
	src := "/wiki/spaces/" + lp.space + "/pages/" + id + "/it"
	cfg.Pages = map[string]string{dest: src}

	_, _, err := pullPages(ctx, client, cfg)
	must.Nil(err)

	md := oskit.ReadFileStr(t, dest)
	oskit.Create(t, edit(dir, md), dest)

	_, err = pushPages(ctx, client, cfg, "")
	must.Nil(err)

	fetched := must.Value(fetchPage(ctx, client, cfg, "page.md", src))
	return must.Value(fetched.doc())
}

// docText concatenates every text node in the document, so a test can assert a
// phrase survived the round trip regardless of block nesting.
func docText(doc *adf.ADF) string {
	var b strings.Builder
	var walk func(n adf.Node)
	walk = func(n adf.Node) {
		if n.Type == "text" {
			b.WriteString(n.Text)
			b.WriteByte('\n')
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(doc.Doc)
	return b.String()
}

// firstNode returns the first node of the given type in document order.
func firstNode(doc *adf.ADF, typ string) (adf.Node, bool) {
	var found adf.Node
	var ok bool
	var walk func(n adf.Node)
	walk = func(n adf.Node) {
		if ok {
			return
		}
		if n.Type == typ {
			found, ok = n, true
			return
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(doc.Doc)
	return found, ok
}

// textNodeWith returns the first text node whose content contains sub, so a
// test can inspect the marks a phrase carries after the round trip.
func textNodeWith(doc *adf.ADF, sub string) (adf.Node, bool) {
	var found adf.Node
	var ok bool
	var walk func(n adf.Node)
	walk = func(n adf.Node) {
		if ok {
			return
		}
		if n.Type == "text" && strings.Contains(n.Text, sub) {
			found, ok = n, true
			return
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(doc.Doc)
	return found, ok
}

// attr reads a string attribute off a node.
func attr(n adf.Node, key string) string {
	s, _ := n.Attrs[key].(string)
	return s
}

// 1x1 transparent PNG, so the uploaded attachment is a real image.
var onePixelPNG = must.Value(base64.StdEncoding.DecodeString(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk" +
		"+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="))

func Test_live_roundtrip_smoke(t *testing.T) {
	// Create, pull, and delete a page: exercises the test harness's own
	// create/delete/space plumbing before the feature round-trips rely on it.
	doc := liveRoundTrip(t, "smoke",
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"hello from cfsync"}]}]}`,
		func(_, md string) string { return md }) // no edit

	assert.Contain(t, "hello from cfsync", docText(doc))
}

func Test_live_roundtrip_paragraph(t *testing.T) {
	// A plain in-place text edit is applied on push.
	doc := liveRoundTrip(t, "para",
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"before edit"}]}]}`,
		func(_, md string) string {
			return strings.Replace(md, "before edit", "after edit", 1)
		})

	text := docText(doc)
	assert.Contain(t, "after edit", text)
	assert.NotContain(t, "before edit", text)
}

func Test_live_roundtrip_structuralInsert(t *testing.T) {
	// A newly appended paragraph is inserted as a new block.
	doc := liveRoundTrip(t, "insert",
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"first para"}]}]}`,
		func(_, md string) string { return md + "\n\nsecond para added" })

	assert.Contain(t, "second para added", docText(doc))
}

func Test_live_roundtrip_tableCell(t *testing.T) {
	// A single table cell's text is edited while the table structure is frozen.
	doc := liveRoundTrip(t, "table",
		`{"type":"doc","content":[{"type":"table","content":[`+
			`{"type":"tableRow","content":[`+
			`{"type":"tableHeader","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"Key"}]}]},`+
			`{"type":"tableHeader","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"Val"}]}]}]},`+
			`{"type":"tableRow","content":[`+
			`{"type":"tableCell","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"cellone"}]}]},`+
			`{"type":"tableCell","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"celltwo"}]}]}]}]}]}`,
		func(_, md string) string {
			return strings.Replace(md, "cellone", "celledited", 1)
		})

	if _, ok := firstNode(doc, "table"); !ok {
		t.Fatal("table structure was lost")
	}
	text := docText(doc)
	assert.Contain(t, "celledited", text)
	assert.Contain(t, "celltwo", text) // untouched cell survives
}

func Test_live_roundtrip_multiParagraphList(t *testing.T) {
	// One paragraph of a two-paragraph list item is edited; both survive.
	doc := liveRoundTrip(t, "mplist",
		`{"type":"doc","content":[{"type":"bulletList","content":[`+
			`{"type":"listItem","content":[`+
			`{"type":"paragraph","content":[{"type":"text","text":"lead para"}]},`+
			`{"type":"paragraph","content":[{"type":"text","text":"tail para"}]}]}]}]}`,
		func(_, md string) string {
			return strings.Replace(md, "tail para", "tail edited", 1)
		})

	text := docText(doc)
	assert.Contain(t, "lead para", text)
	assert.Contain(t, "tail edited", text)
}

func Test_live_roundtrip_orderedList(t *testing.T) {
	// One item of a three-item numbered list is edited; the others survive, the
	// node stays an orderedList, and the Site accepts the re-marshaled numbering.
	doc := liveRoundTrip(t, "olist",
		`{"type":"doc","content":[{"type":"orderedList",`+
			`"attrs":{"order":1},"content":[`+
			`{"type":"listItem","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"item one"}]}]},`+
			`{"type":"listItem","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"item two"}]}]},`+
			`{"type":"listItem","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"item three"}]}]}]}]}`,
		func(_, md string) string {
			// Sanity: the list renders as a numbered block, not an anchor.
			if !strings.Contains(md, "1. item one") {
				t.Fatalf("ordered list did not render numbered:\n%s", md)
			}
			return strings.Replace(md, "item two", "item edited", 1)
		})

	list, ok := firstNode(doc, "orderedList")
	if !ok {
		t.Fatal("ordered list became something else")
	}
	assert.Equal(t, 3, len(list.Content)) // item count frozen
	text := docText(doc)
	assert.Contain(t, "item one", text)
	assert.Contain(t, "item edited", text)
	assert.Contain(t, "item three", text)
	assert.NotContain(t, "item two", text)
}

func Test_live_roundtrip_multiParagraphCell(t *testing.T) {
	// One paragraph of a two-paragraph table cell is edited; the other paragraph,
	// the neighboring cell and the table structure all survive. The cell's two
	// paragraphs render joined by "<br>" (see cellText).
	doc := liveRoundTrip(t, "mpcell",
		`{"type":"doc","content":[{"type":"table","content":[`+
			`{"type":"tableRow","content":[`+
			`{"type":"tableHeader","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"Head"}]}]}]},`+
			`{"type":"tableRow","content":[`+
			`{"type":"tableCell","content":[`+
			`{"type":"paragraph","content":[{"type":"text","text":"cellone"}]},`+
			`{"type":"paragraph","content":[{"type":"text","text":"celltwo"}]}]}]}]}]}`,
		func(_, md string) string {
			// Sanity: the two paragraphs are joined by <br> in the rendered cell.
			if !strings.Contains(md, "cellone<br>celltwo") {
				t.Fatalf("cell did not render paragraphs joined by <br>:\n%s", md)
			}
			return strings.Replace(md, "cellone", "celledited", 1)
		})

	cell, ok := firstNode(doc, "tableCell")
	if !ok {
		t.Fatal("table cell was lost")
	}
	assert.Equal(t, 2, len(cell.Content)) // paragraph count frozen
	text := docText(doc)
	assert.Contain(t, "celledited", text)
	assert.Contain(t, "celltwo", text) // untouched paragraph survives
}

func Test_live_roundtrip_marks(t *testing.T) {
	// A run carrying underline and textColor marks round-trips: it renders as
	// nested HTML tags, an untouched neighboring word is edited, and both marks
	// survive on push.
	doc := liveRoundTrip(t, "marks",
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"keep "},`+
			`{"type":"text","text":"styled","marks":[`+
			`{"type":"underline"},`+
			`{"type":"textColor","attrs":{"color":"#ff0000"}}]}]}]}`,
		func(_, md string) string {
			if !strings.Contains(md, `<u>styled</u>`) ||
				!strings.Contains(md, `color:#ff0000`) {
				t.Fatalf("marks did not render as HTML tags:\n%s", md)
			}
			return strings.Replace(md, "keep", "KEEP", 1)
		})

	styled, ok := textNodeWith(doc, "styled")
	if !ok {
		t.Fatal("styled run was lost")
	}
	var hasU bool
	var color string
	for _, m := range styled.Marks {
		if m.Type == "underline" {
			hasU = true
		}
		if m.Type == "textColor" {
			color, _ = m.Attrs["color"].(string)
		}
	}
	assert.True(t, hasU)
	assert.Equal(t, "#ff0000", color)
	assert.Contain(t, "KEEP", docText(doc))
}

func Test_live_roundtrip_mediaGroup(t *testing.T) {
	// A mediaGroup of two real attachments renders as one image per line in a
	// single block (see renderMediaGroup), and — being read-only — pushes back as
	// a no-op, confirming the group survives the render→segment→diff→Put pipeline.
	ctx, client, cfg, lp := liveEnv(t)
	spaceID := must.Value(spaceIDByKey(ctx, client, cfg, lp.space))

	title := uniqueTitle("group")
	id := must.Value(seedPage(ctx, client, cfg, spaceID, lp.folder, title,
		`{"type":"doc","content":[{"type":"paragraph","content":[]}]}`))
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, id) })

	// Upload two real attachments to reference from the group.
	dir := t.TempDir()
	f1 := filepath.Join(dir, "a.png")
	f2 := filepath.Join(dir, "b.png")
	oskit.Create(t, onePixelPNG, f1)
	oskit.Create(t, onePixelPNG, f2)
	fid1, _, err := uploadAttachment(ctx, client, cfg, id, f1)
	must.Nil(err)
	fid2, _, err := uploadAttachment(ctx, client, cfg, id, f2)
	must.Nil(err)

	// Replace the page body with a mediaGroup referencing both attachments.
	lid1 := must.Value(adf.NewLocalID())
	lid2 := must.Value(adf.NewLocalID())
	coll := "contentId-" + id
	group := fmt.Sprintf(`{"type":"doc","content":[{"type":"mediaGroup",`+
		`"content":[`+
		`{"type":"media","attrs":{"type":"file","id":%q,"collection":%q,`+
		`"localId":%q}},`+
		`{"type":"media","attrs":{"type":"file","id":%q,"collection":%q,`+
		`"localId":%q}}]}]}`, fid1, coll, lid1, fid2, coll, lid2)

	src := "/wiki/spaces/" + lp.space + "/pages/" + id + "/it"
	live := must.Value(fetchPage(ctx, client, cfg, "page.md", src))
	meta := &mdMeta{Title: title, PageID: id, SpaceID: spaceID}
	must.Nil(putPage(ctx, client, cfg, meta, []byte(group), live.Version+1))

	// Pull the page and confirm both images render on adjacent lines, one block.
	cfg.WorkDir = dir
	dest := filepath.Join(dir, "page.md")
	cfg.Pages = map[string]string{dest: src}
	_, _, err = pullPages(ctx, client, cfg)
	must.Nil(err)

	md := oskit.ReadFileStr(t, dest)
	assert.Contain(t, fid1, md)
	assert.Contain(t, fid2, md)
	assert.Equal(t, 2, strings.Count(md, "!["))
	// The two images sit on consecutive lines with no blank line between them.
	assert.True(t, strings.Contains(md, "png)\n!["),
		"mediaGroup images are not adjacent in one block:\n%s", md)

	// Read-only: pushing it back unchanged is a no-op (GetPut holds).
	out, err := pushPages(ctx, client, cfg, "")
	must.Nil(err)
	assert.Contain(t, "no changes", out)
}

func Test_live_roundtrip_panel(t *testing.T) {
	// A panel body paragraph is edited while its type stays frozen.
	doc := liveRoundTrip(t, "panel",
		`{"type":"doc","content":[{"type":"panel",`+
			`"attrs":{"panelType":"info"},"content":[`+
			`{"type":"paragraph","content":[{"type":"text","text":"note body"}]}]}]}`,
		func(_, md string) string {
			return strings.Replace(md, "note body", "note revised", 1)
		})

	panel, ok := firstNode(doc, "panel")
	if !ok {
		t.Fatal("panel was lost")
	}
	assert.Equal(t, "info", attr(panel, "panelType"))
	assert.Contain(t, "note revised", docText(doc))
}

func Test_live_roundtrip_blockquote(t *testing.T) {
	// A blockquote body is edited while it stays a blockquote (not a panel).
	doc := liveRoundTrip(t, "quote",
		`{"type":"doc","content":[{"type":"blockquote","content":[`+
			`{"type":"paragraph","content":[{"type":"text","text":"quoted words"}]}]}]}`,
		func(_, md string) string {
			return strings.Replace(md, "quoted words", "quoted edited", 1)
		})

	if _, ok := firstNode(doc, "blockquote"); !ok {
		t.Fatal("blockquote became something else")
	}
	assert.Contain(t, "quoted edited", docText(doc))
}

func Test_live_roundtrip_expand(t *testing.T) {
	// An expand's body paragraph is edited while its title stays frozen and the
	// node stays an expand. The title rides the "[!EXPAND] title" tag line, which
	// the reverse parse leaves untouched when unedited (see rebuildExpand).
	doc := liveRoundTrip(t, "expand",
		`{"type":"doc","content":[{"type":"expand",`+
			`"attrs":{"title":"more detail"},"content":[`+
			`{"type":"paragraph","content":[`+
			`{"type":"text","text":"hidden body"}]}]}]}`,
		func(_, md string) string {
			// Sanity: the expand renders as its tagged blockquote, title and all.
			if !strings.Contains(md, "[!EXPAND] more detail") {
				t.Fatalf("expand did not render its tag line:\n%s", md)
			}
			return strings.Replace(md, "hidden body", "body revised", 1)
		})

	expand, ok := firstNode(doc, "expand")
	if !ok {
		t.Fatal("expand became something else")
	}
	assert.Equal(t, "more detail", attr(expand, "title")) // title frozen
	text := docText(doc)
	assert.Contain(t, "body revised", text)
	assert.NotContain(t, "hidden body", text)
}

func Test_live_roundtrip_externalMedia(t *testing.T) {
	// Pull-direction: an external media node renders as ![alt](url) in the
	// Markdown, with no download. Create the page, pull it, read the .md.
	ctx, client, cfg, lp := liveEnv(t)
	spaceID := must.Value(spaceIDByKey(ctx, client, cfg, lp.space))
	id := must.Value(seedPage(ctx, client, cfg, spaceID, lp.folder,
		uniqueTitle("external"),
		`{"type":"doc","content":[{"type":"mediaSingle","content":[`+
			`{"type":"media","attrs":{"type":"external",`+
			`"url":"https://example.com/pic.png","alt":"ext pic"}}]}]}`))
	t.Cleanup(func() { _ = purgePage(context.Background(), client, cfg, id) })

	dir := cfg.WorkDir
	dest := filepath.Join(dir, "page.md")
	cfg.Pages = map[string]string{
		dest: "/wiki/spaces/" + lp.space + "/pages/" + id + "/it"}
	_, _, err := pullPages(ctx, client, cfg)
	must.Nil(err)

	assert.Contain(t,
		"![ext pic](https://example.com/pic.png)", oskit.ReadFileStr(t, dest))
}

func Test_live_roundtrip_uploadImage(t *testing.T) {
	// The headline confirmation: a user-added image is uploaded as an attachment
	// and spliced in as a media node that the Site accepts. If the create-
	// attachment response shape or the media node were wrong, the push would
	// fail (HTTP error or PutGet rejection) and the harness's must.Nil would
	// stop the test here.
	doc := liveRoundTrip(t, "image",
		`{"type":"doc","content":[{"type":"paragraph","content":[`+
			`{"type":"text","text":"look below"}]}]}`,
		func(dir, md string) string {
			oskit.Create(t, onePixelPNG, dir, "shot.png")
			return md + "\n\n![a shot](shot.png)"
		})

	media, ok := firstNode(doc, "media")
	if !ok {
		t.Fatal("uploaded image did not become a media node on the Site")
	}
	assert.Equal(t, "file", attr(media, "type"))
	assert.NotEqual(t, "", attr(media, "id")) // the real Confluence fileId
	// The media node lives inside a mediaSingle wrapper.
	if _, ok := firstNode(doc, "mediaSingle"); !ok {
		t.Fatal("media node is not wrapped in a mediaSingle")
	}
	t.Logf("uploaded media: id=%q collection=%q alt=%q",
		attr(media, "id"), attr(media, "collection"), attr(media, "alt"))
}
