// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"os"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_NewADF(t *testing.T) {
	t.Run("parses wrapper metadata and doc", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "id": "7",
		   "title": "T",
		   "version": 3,
		   "space_id": "9",
		   "adf":{
		      "type": "doc",
		      "content": []
		   }
		}`

		// --- When ---
		have, err := NewADF([]byte(data))

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "7", have.ID)
		assert.Equal(t, "T", have.Title)
		assert.Equal(t, 3, have.Version)
		assert.Equal(t, "9", have.SpaceID)
		assert.Equal(t, "doc", have.Doc.Type)
	})

	t.Run("error - invalid JSON", func(t *testing.T) {
		// --- Given ---
		data := []byte("not-json")

		// --- When ---
		have, err := NewADF(data)

		// --- Then ---
		assert.ErrorContain(t, "decoding ADF page", err)
		assert.Nil(t, have)
	})
}

func Test_ADF_FileMedia(t *testing.T) {
	t.Run("returns file-media refs in document order", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "adf": {
		      "type": "doc",
		      "content": [
		         {
		            "type": "mediaSingle",
		            "content": [
		               {
		                  "type": "media",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F1",
		                     "localId": "L1",
		                     "alt": "a.jpg"
		                  }
		               }
		            ]
		         },
		         {
		            "type": "mediaSingle",
		            "content": [
		               {
		                  "type": "media",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F2",
		                     "localId": "L2",
		                     "alt": "b.png"
		                  }
		               }
		            ]
		         }
		      ]
		   }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := adf.FileMedia()

		// --- Then ---
		want := []MediaRef{
			{LocalID: "L1", FileID: "F1", Alt: "a.jpg"},
			{LocalID: "L2", FileID: "F2", Alt: "b.png"},
		}
		assert.Equal(t, want, have)
	})

	t.Run("anchors a localId-less file by fileId", func(t *testing.T) {
		// --- Given --- an external node (never downloaded) and a file node with
		// no localId (anchored by its fileId as a fallback).
		data := `{
		   "adf": {
		      "type": "doc",
		      "content": [
		         {
		            "type": "media",
		            "attrs": { "type": "external", "id": "F1", "localId": "L1" }
		         },
		         {
		            "type": "media",
		            "attrs": { "type": "file", "id": "F2" }
		         }
		      ]
		   }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := adf.FileMedia()

		// --- Then --- the external node is omitted; the file node falls back to
		// its fileId as the anchor key.
		assert.Equal(t, []MediaRef{{LocalID: "F2", FileID: "F2", Alt: ""}}, have)
	})

	t.Run("collects an inline mediaInline file reference", func(t *testing.T) {
		// --- Given --- a paragraph holding an inline file attachment reference.
		data := `{
		   "adf": {
		      "type": "doc",
		      "content": [
		         {
		            "type": "paragraph",
		            "content": [
		               { "type": "text", "text": "see " },
		               {
		                  "type": "mediaInline",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F7",
		                     "localId": "L7",
		                     "alt": "inline.png"
		                  }
		               }
		            ]
		         }
		      ]
		   }
		}`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := adf.FileMedia()

		// --- Then --- the inline reference is downloaded like a block file media.
		assert.Equal(t,
			[]MediaRef{{LocalID: "L7", FileID: "F7", Alt: "inline.png"}}, have)
	})

	t.Run("omits a file node with neither localId nor fileId", func(t *testing.T) {
		// --- Given --- a file media node carrying no id at all.
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "media", "attrs": { "type": "file" } } ] } }`
		adf := must.Value(NewADF([]byte(data)))

		// --- When ---
		have := adf.FileMedia()

		// --- Then --- there is nothing to anchor it to, so it is dropped.
		assert.Equal(t, []MediaRef{}, have)
	})
}

func Test_ADF_MarshallMarkdown(t *testing.T) {
	t.Run("renders the root page example", func(t *testing.T) {
		// --- Given ---
		const base = "root_page_1.v5"
		data := must.Value(os.ReadFile("testdata/" + base + ".json"))
		adf := must.Value(NewADF(data))

		// --- When ---
		have, err := adf.MarshallMarkdown(nil)

		// --- Then ---
		assert.NoError(t, err)
		want := oskit.ReadFileStr(t, "testdata/"+base+".md")
		assert.Equal(t, want, string(have))
	})

	t.Run("renders images and page_images from assets", func(t *testing.T) {
		// --- Given ---
		data := `{
		   "title": "T",
		   "id": "1",
		   "version": 2,
		   "space_id": "9",
		   "adf": {
		      "type": "doc",
		      "content": [
		         {
		            "type": "mediaSingle",
		            "attrs": { "layout": "center" },
		            "content": [
		               {
		                  "type": "media",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F1",
		                     "localId": "L1",
		                     "alt": "pic.jpg"
		                  }
		               }
		            ]
		         }
		      ]
		   }
		}`
		adf := must.Value(NewADF([]byte(data)))
		assets := map[string]string{"L1": "../_assets/F1-L1.jpg"}

		// --- When ---
		have, err := adf.MarshallMarkdown(assets)

		// --- Then ---
		assert.NoError(t, err)
		want := "" +
			"---\n" +
			"title: \"T\"\n" +
			"page_path: \"\"\n" +
			"page_id: \"1\"\n" +
			"page_version: 2\n" +
			"space_id: \"9\"\n" +
			"page_images:\n" +
			"  - local_id: L1\n" +
			"    file: \"../_assets/F1-L1.jpg\"\n" +
			"    alt: \"pic.jpg\"\n" +
			"---\n" +
			"\n" +
			"![pic.jpg](../_assets/F1-L1.jpg)\n"
		assert.Equal(t, want, string(have))
	})

	t.Run("renders a mediaGroup as one image per line", func(t *testing.T) {
		// --- Given --- a group of two attached files, both downloaded.
		data := `{
		   "title": "T",
		   "id": "1",
		   "version": 2,
		   "space_id": "9",
		   "adf": {
		      "type": "doc",
		      "content": [
		         {
		            "type": "mediaGroup",
		            "content": [
		               {
		                  "type": "media",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F1",
		                     "localId": "L1",
		                     "alt": "a.png"
		                  }
		               },
		               {
		                  "type": "media",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F2",
		                     "localId": "L2",
		                     "alt": "b.png"
		                  }
		               }
		            ]
		         }
		      ]
		   }
		}`
		adf := must.Value(NewADF([]byte(data)))
		assets := map[string]string{
			"L1": "../_assets/F1-L1.png", "L2": "../_assets/F2-L2.png"}

		// --- When ---
		have, err := adf.MarshallMarkdown(assets)

		// --- Then --- the two images sit on their own lines in one block, with
		// no blank line between them, so the group stays a single block.
		assert.NoError(t, err)
		assert.Contain(t,
			"![a.png](../_assets/F1-L1.png)\n![b.png](../_assets/F2-L2.png)\n",
			string(have))
	})

	t.Run("renders a localId-less file via its fileId", func(t *testing.T) {
		// --- Given --- a file media node with no localId, downloaded under its
		// fileId fallback key.
		data := `{
		   "title": "T",
		   "id": "1",
		   "version": 2,
		   "space_id": "9",
		   "adf": {
		      "type": "doc",
		      "content": [
		         {
		            "type": "mediaSingle",
		            "content": [
		               {
		                  "type": "media",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F9",
		                     "alt": "x.png"
		                  }
		               }
		            ]
		         }
		      ]
		   }
		}`
		adf := must.Value(NewADF([]byte(data)))
		assets := map[string]string{"F9": "../_assets/F9-F9.png"}

		// --- When ---
		have, err := adf.MarshallMarkdown(assets)

		// --- Then --- it renders as an image and is tracked under its fileId.
		assert.NoError(t, err)
		assert.Contain(t, "![x.png](../_assets/F9-F9.png)", string(have))
		assert.Contain(t, "local_id: F9\n", string(have))
	})

	t.Run("tracks a mediaInline file as a directive", func(t *testing.T) {
		// --- Given --- a paragraph with an inline file attachment reference, its
		// image resolved in the assets map.
		data := `{
		   "title": "T",
		   "id": "1",
		   "version": 2,
		   "space_id": "9",
		   "adf": {
		      "type": "doc",
		      "content": [
		         {
		            "type": "paragraph",
		            "content": [
		               { "type": "text", "text": "see " },
		               {
		                  "type": "mediaInline",
		                  "attrs": {
		                     "type": "file",
		                     "id": "F7",
		                     "localId": "L7"
		                  }
		               }
		            ]
		         }
		      ]
		   }
		}`
		adf := must.Value(NewADF([]byte(data)))
		assets := map[string]string{"L7": "../_assets/F7-L7.png"}

		// --- When ---
		have, err := adf.MarshallMarkdown(assets)

		// --- Then --- the reference renders inline as an editable directive (not
		// an image), yet the fetched file is tracked in page_images so --gc keeps
		// it.
		assert.NoError(t, err)
		assert.Contain(t, "[[*mediaInline:", string(have))
		assert.Contain(t, "local_id: L7\n", string(have))
		assert.Contain(t, "../_assets/F7-L7.png", string(have))
	})

	t.Run("error - root node is not a doc", func(t *testing.T) {
		// --- Given ---
		adf := must.Value(NewADF([]byte(`{"adf":{"type":"paragraph"}}`)))

		// --- When ---
		have, err := adf.MarshallMarkdown(nil)

		// --- Then ---
		assert.ErrorContain(t, `root node is "paragraph", want doc`, err)
		assert.Nil(t, have)
	})
}
