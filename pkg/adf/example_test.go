// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf_test

import (
	"fmt"

	"github.com/ctx42/cfsync/pkg/adf"
)

func ExampleADF_MarshallMarkdown() {
	data := `{
	   "name": "demo.md",
	   "title": "Demo",
	   "id": "1",
	   "version": 1,
	   "space_id": "2",
	   "adf": {
	      "type": "doc",
	      "content": [
	         {
	            "type": "heading",
	            "attrs": { "level": 1 },
	            "content": [ { "type": "text", "text": "Hello" } ]
	         },
	         {
	            "type": "paragraph",
	            "content": [
	               {
	                  "type": "text",
	                  "text": "Bold",
	                  "marks": [ { "type": "strong" } ]
	               },
	               { "type": "text", "text": " and plain." }
	            ]
	         }
	      ]
	   }
	}`

	doc, err := adf.NewADF([]byte(data))
	if err != nil {
		panic(err)
	}
	md, err := doc.MarshallMarkdown(nil)
	if err != nil {
		panic(err)
	}
	fmt.Print(string(md))
	// Output:
	// ---
	// title: "Demo"
	// page_path: "demo.md"
	// page_id: "1"
	// page_version: 1
	// space_id: "2"
	// ---
	//
	// # Hello
	//
	// **Bold** and plain.
}

func ExampleADF_Put() {
	// The document pulled from Confluence and cached.
	data := `{
	   "name": "demo.md", "title": "Demo", "id": "1", "version": 1, "space_id": "2",
	   "adf": { "type": "doc", "content": [
	      { "type": "paragraph", "attrs": { "localId": "p" },
	        "content": [ { "type": "text", "text": "The original text." } ] } ] }
	}`
	doc, err := adf.NewADF([]byte(data))
	if err != nil {
		panic(err)
	}

	// The user edited the rendered Markdown body; back-port that edit into the
	// cached document, ready to push.
	edited, err := doc.Put("The edited text.", nil, nil, nil)
	if err != nil {
		panic(err)
	}

	md, err := edited.MarshallMarkdown(nil)
	if err != nil {
		panic(err)
	}
	fmt.Print(string(md))
	// Output:
	// ---
	// title: "Demo"
	// page_path: "demo.md"
	// page_id: "1"
	// page_version: 1
	// space_id: "2"
	// ---
	//
	// The edited text.
}

func ExampleADF_Merge3() {
	// tpl builds a two-paragraph document with stable localIds so blocks match
	// across the baseline and the remote.
	tpl := func(first, second string) *adf.ADF {
		data := `{ "adf": { "type": "doc", "content": [
		   { "type": "paragraph", "attrs": { "localId": "p1" },
		     "content": [ { "type": "text", "text": "` + first + `" } ] },
		   { "type": "paragraph", "attrs": { "localId": "p2" },
		     "content": [ { "type": "text", "text": "` + second + `" } ] } ] } }`
		doc, err := adf.NewADF([]byte(data))
		if err != nil {
			panic(err)
		}
		return doc
	}

	base := tpl("alpha", "beta")          // the cached baseline
	remote := tpl("alpha", "beta remote") // the live page changed the second

	// The local edit changed only the first paragraph. Merge3 rebases it onto
	// the remote, keeping the remote's change to the second.
	merged, err := base.Merge3(remote, "alpha local\n\nbeta", nil)
	if err != nil {
		panic(err)
	}
	fmt.Println(merged)
	// Output:
	// alpha local
	//
	// beta remote
}
