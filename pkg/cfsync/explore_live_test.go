// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

//go:build confluence

package cfsync

import (
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/ctx42/cfsync/pkg/adf"
)

// Test_live_explore fetches each page listed in CFSYNC_TEST_EXPLORE_PAGES and
// runs the lens over it read-only — a no-op Put plus a probe edit — to harden
// the round-trip against real content. It never pushes, so nothing is written.
func Test_live_explore(t *testing.T) {
	ctx, client, cfg, lp := liveEnv(t)

	if strings.TrimSpace(lp.explore) == "" {
		t.Skipf("set %s to a comma-separated list of page ids to run",
			envExplorePages)
	}
	var pages []string
	for _, id := range strings.Split(lp.explore, ",") {
		if id = strings.TrimSpace(id); id != "" {
			pages = append(pages, id)
		}
	}

	types := map[string]int{}
	marks := map[string]int{}
	var noopFails, editOK, editReject, editErr, noEditable int

	for _, id := range pages {
		src := "/wiki/spaces/X/pages/" + id + "/t"
		p, err := fetchPage(ctx, client, cfg, "x.md", src)
		if err != nil {
			t.Logf("fetch %s: %v", id, err)
			continue
		}
		doc, err := p.doc()
		if err != nil {
			t.Logf("parse %s: %v", id, err)
			continue
		}
		collectTypes(doc.Doc, types, marks)

		md, err := doc.MarshallMarkdown(nil)
		if err != nil {
			t.Logf("render %s: %v", id, err)
			continue
		}
		_, body, err := splitFrontmatter(md)
		if err != nil {
			t.Logf("frontmatter %s: %v", id, err)
			continue
		}

		// No-op: pushing the baseline unchanged must always hold.
		if _, err := doc.Put(body, nil, nil, nil); err != nil {
			noopFails++
			t.Logf("NOOP FAIL %s: %v", id, err)
		}

		// Edit: append a word to the first plain paragraph and re-run the lens.
		edited, ok := editFirstParagraph(body)
		if !ok {
			noEditable++
			continue
		}
		switch _, err := doc.Put(edited, nil, nil, nil); {
		case err == nil:
			editOK++
		case strings.Contains(err.Error(), "did not round-trip"),
			strings.Contains(err.Error(), "cannot edit"),
			strings.Contains(err.Error(), "not supported"):
			editReject++
		default:
			editErr++
			t.Logf("EDIT ERR %s: %v", id, err)
		}
	}

	t.Logf("pages=%d noopFails=%d editOK=%d editReject=%d editErr=%d noEditable=%d",
		len(pages), noopFails, editOK, editReject, editErr, noEditable)
	t.Logf("node types: %s", histogram(types))
	t.Logf("mark types: %s", histogram(marks))
}

// collectTypes tallies every node type and mark type at or below nod.
func collectTypes(nod adf.Node, types, marks map[string]int) {
	types[nod.Type]++
	for _, m := range nod.Marks {
		marks[m.Type]++
	}
	for _, c := range nod.Content {
		collectTypes(c, types, marks)
	}
}

// editFirstParagraph appends a marker to the first top-level block that looks
// like a plain paragraph, returning the edited body and whether one was found.
func editFirstParagraph(body string) (string, bool) {
	blocks := strings.Split(body, "\n\n")
	for i, b := range blocks {
		tb := strings.TrimSpace(b)
		if tb == "" {
			continue
		}
		switch tb[0] {
		case '#', '|', '>', '-', '!', '<', '`', '*':
			continue
		}
		if strings.Contains(b, "\n|") || strings.Contains(b, "\n>") {
			continue
		}
		blocks[i] = b + " EDITMARKER"
		return strings.Join(blocks, "\n\n"), true
	}
	return "", false
}

// histogram renders a count map as a "key=count" list sorted by descending
// count.
func histogram(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return m[keys[i]] > m[keys[j]] })
	var b strings.Builder
	for _, k := range keys {
		if b.Len() > 0 {
			b.WriteString(" ")
		}
		b.WriteString(k)
		b.WriteString("=")
		b.WriteString(strconv.Itoa(m[k]))
	}
	return b.String()
}
