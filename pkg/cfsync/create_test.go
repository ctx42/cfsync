// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ctx42/ring/pkg/ring/ringtest"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testkit/pkg/httpkit"
	"github.com/ctx42/testkit/pkg/oskit"
)

// newPageMD is the Markdown of a page that does not exist in Confluence yet:
// frontmatter with a title and space but no page id, and a plain body.
const newPageMD = "---\n" +
	"title: \"New Page\"\n" +
	"space_id: \"9\"\n" +
	"parent_id: \"77\"\n" +
	"---\n\n" +
	"# Heading\n\n" +
	"A paragraph.\n"

func Test_classifyCreates(t *testing.T) {
	t.Run("finds only the new-page files", func(t *testing.T) {
		// --- Given --- one new page, one existing page, one file with no
		// frontmatter, and one lacking a space.
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team")
		create := oskit.Create(t, newPageMD, dir, "team", "new.md")
		update := oskit.Create(t,
			"---\ntitle: \"T\"\npage_id: \"1\"\nspace_id: \"9\"\n---\nx\n",
			dir, "team", "old.md")
		oskit.Create(t, "no frontmatter", dir, "team", "plain.md")
		oskit.Create(t,
			"---\ntitle: \"T\"\n---\nx\n", dir, "team", "nospace.md")
		dests := []string{
			create,
			update,
			filepath.Join(dir, "team", "plain.md"),
			filepath.Join(dir, "team", "nospace.md"),
		}

		// --- When --- with no managed roots, only explicit-frontmatter creates.
		have, refused := classifyCreates(dests, nil)

		// --- Then --- only the new page is a candidate, with its fields read.
		assert.Len(t, 1, have)
		assert.Equal(t, create, have[0].Dest)
		assert.Equal(t, "New Page", have[0].Title)
		assert.Equal(t, "9", have[0].SpaceID)
		assert.Equal(t, "77", have[0].ParentID)
		assert.Len(t, 0, refused)
	})

	t.Run("no candidates yields nil", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		update := oskit.Create(t,
			"---\ntitle: \"T\"\npage_id: \"1\"\n---\nx\n", dir, "old.md")

		// --- When ---
		have, refused := classifyCreates([]string{update}, nil)

		// --- Then ---
		assert.Nil(t, have)
		assert.Len(t, 0, refused)
	})

	t.Run("derives space and parent from _index under a root", func(t *testing.T) {
		// --- Given --- a title-only page beside a parent _index.md.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t,
			"---\ntitle: \"Home\"\npage_id: \"100\"\nspace_id: \"9\"\n---\nx\n",
			dir, "team", "_index.md")
		create := oskit.Create(t,
			"---\ntitle: \"New\"\n---\n\nbody\n", dir, "team", "new.md")

		// --- When ---
		have, refused := classifyCreates([]string{create}, []string{root})

		// --- Then --- the _index page is the parent and its space the space.
		assert.Len(t, 0, refused)
		assert.Len(t, 1, have)
		assert.Equal(t, "New", have[0].Title)
		assert.Equal(t, "9", have[0].SpaceID)
		assert.Equal(t, "100", have[0].ParentID)
	})

	t.Run("derives from agreeing siblings under a folder root", func(t *testing.T) {
		// --- Given --- a title-only page in a folder directory (no _index.md)
		// beside stamped siblings that agree on parent and space.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		sib := "---\ntitle: \"Sib\"\npage_id: \"%s\"\n" +
			"space_id: \"9\"\nparent_id: \"50\"\n---\nx\n"
		oskit.Create(t, fmt.Sprintf(sib, "201"), dir, "team", "a.md")
		oskit.Create(t, fmt.Sprintf(sib, "202"), dir, "team", "b.md")
		create := oskit.Create(t,
			"---\ntitle: \"New\"\n---\n\nbody\n", dir, "team", "new.md")

		// --- When ---
		have, refused := classifyCreates([]string{create}, []string{root})

		// --- Then --- the shared folder id becomes the parent.
		assert.Len(t, 0, refused)
		assert.Len(t, 1, have)
		assert.Equal(t, "50", have[0].ParentID)
		assert.Equal(t, "9", have[0].SpaceID)
	})

	t.Run("refuses conflicting siblings naming both files", func(t *testing.T) {
		// --- Given --- two siblings that disagree on parent_id.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t,
			"---\ntitle: \"A\"\npage_id: \"1\"\nspace_id: \"9\"\n"+
				"parent_id: \"50\"\n---\nx\n", dir, "team", "a.md")
		oskit.Create(t,
			"---\ntitle: \"B\"\npage_id: \"2\"\nspace_id: \"9\"\n"+
				"parent_id: \"60\"\n---\nx\n", dir, "team", "b.md")
		create := oskit.Create(t,
			"---\ntitle: \"New\"\n---\n\nbody\n", dir, "team", "new.md")

		// --- When ---
		have, refused := classifyCreates([]string{create}, []string{root})

		// --- Then --- the candidate is refused, naming both disagreeing files.
		assert.Len(t, 0, have)
		assert.ErrorRegexp(t, "parent_id disagrees.*a.md.*b.md", refused[create])
	})

	t.Run("refuses an index-less sibling-less directory", func(t *testing.T) {
		// --- Given --- a title-only page alone under a root.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		create := oskit.Create(t,
			"---\ntitle: \"New\"\n---\n\nbody\n", dir, "team", "new.md")

		// --- When ---
		have, refused := classifyCreates([]string{create}, []string{root})

		// --- Then --- refused, naming both fixes.
		assert.Len(t, 0, have)
		assert.ErrorRegexp(t,
			"cannot derive parent_id.*re-pull the space.*set parent_id",
			refused[create])
	})

	t.Run("plans folders for a page in a new sub-directory", func(t *testing.T) {
		// --- Given --- an anchored root and a page one new directory deep.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha")
		oskit.Create(t,
			"---\ntitle: \"Home\"\npage_id: \"100\"\nspace_id: \"9\"\n---\nx\n",
			dir, "team", "_index.md")
		create := oskit.Create(t,
			"---\ntitle: \"New\"\n---\n\nbody\n", dir, "team", "alpha", "new.md")

		// --- When ---
		have, refused := classifyCreates([]string{create}, []string{root})

		// --- Then --- the candidate carries its missing folder chain.
		assert.Len(t, 0, refused)
		assert.Len(t, 1, have)
		assert.Equal(t, "100", have[0].ParentID)
		assert.Equal(t, "9", have[0].SpaceID)
		assert.Len(t, 1, have[0].Folders)
		assert.Equal(t, "Alpha", have[0].Folders[0].Title)
	})

	t.Run("refuses an id-less _index under a root", func(t *testing.T) {
		// --- Given --- a title-only _index.md with no page id under a root.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		index := oskit.Create(t,
			"---\ntitle: \"Home\"\nspace_id: \"9\"\n---\n\nbody\n",
			dir, "team", "_index.md")

		// --- When ---
		have, refused := classifyCreates([]string{index}, []string{root})

		// --- Then --- refused as a page-backed directory, not a candidate.
		assert.Len(t, 0, have)
		assert.ErrorContain(t, "page-backed directory", refused[index])
	})

	t.Run("explicit space with derived parent under a root", func(t *testing.T) {
		// --- Given --- an explicit space_id but no parent_id, with an _index.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t,
			"---\ntitle: \"Home\"\npage_id: \"100\"\nspace_id: \"9\"\n---\nx\n",
			dir, "team", "_index.md")
		create := oskit.Create(t,
			"---\ntitle: \"New\"\nspace_id: \"42\"\n---\n\nbody\n",
			dir, "team", "new.md")

		// --- When ---
		have, refused := classifyCreates([]string{create}, []string{root})

		// --- Then --- the explicit space wins, the parent is derived.
		assert.Len(t, 0, refused)
		assert.Len(t, 1, have)
		assert.Equal(t, "42", have[0].SpaceID)
		assert.Equal(t, "100", have[0].ParentID)
	})
}

func Test_deriveCreateFields(t *testing.T) {
	t.Run("explicit values skip the disk entirely", func(t *testing.T) {
		// --- Given --- both fields explicit, in a directory with no sources.
		dest := filepath.Join(t.TempDir(), "missing", "new.md")

		// --- When ---
		parent, space, err := deriveCreateFields(dest, "77", "9")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "77", parent)
		assert.Equal(t, "9", space)
	})

	t.Run("index beats siblings", func(t *testing.T) {
		// --- Given --- an _index.md and a sibling that disagree.
		dir := t.TempDir()
		oskit.Create(t,
			"---\ntitle: \"H\"\npage_id: \"100\"\nspace_id: \"9\"\n---\nx\n",
			dir, "_index.md")
		oskit.Create(t,
			"---\ntitle: \"S\"\npage_id: \"1\"\nspace_id: \"9\"\n"+
				"parent_id: \"999\"\n---\nx\n", dir, "sib.md")
		dest := filepath.Join(dir, "new.md")

		// --- When ---
		parent, space, err := deriveCreateFields(dest, "", "")

		// --- Then --- the _index page id wins over the sibling parent.
		assert.NoError(t, err)
		assert.Equal(t, "100", parent)
		assert.Equal(t, "9", space)
	})

	t.Run("a cf_local sibling is ignored", func(t *testing.T) {
		// --- Given --- a stamped sibling and a cf_local sibling that disagree.
		dir := t.TempDir()
		oskit.Create(t,
			"---\ntitle: \"S\"\npage_id: \"1\"\nspace_id: \"9\"\n"+
				"parent_id: \"50\"\n---\nx\n", dir, "sib.md")
		oskit.Create(t,
			"---\ntitle: \"L\"\npage_id: \"2\"\nspace_id: \"9\"\n"+
				"parent_id: \"60\"\ncf_local: true\n---\nx\n", dir, "local.md")
		dest := filepath.Join(dir, "new.md")

		// --- When ---
		parent, space, err := deriveCreateFields(dest, "", "")

		// --- Then --- only the non-local sibling takes part, so no conflict.
		assert.NoError(t, err)
		assert.Equal(t, "50", parent)
		assert.Equal(t, "9", space)
	})

	t.Run("refuses both fields when the directory has no sources", func(t *testing.T) {
		// --- Given --- a lone file in an otherwise empty directory.
		dir := t.TempDir()
		dest := filepath.Join(dir, "new.md")
		oskit.Create(t, "---\ntitle: \"N\"\n---\nx\n", dest)

		// --- When ---
		parent, space, err := deriveCreateFields(dest, "", "")

		// --- Then --- both fields are reported unresolved.
		assert.Equal(t, "", parent)
		assert.Equal(t, "", space)
		assert.ErrorRegexp(t, "cannot derive parent_id", err)
		assert.ErrorRegexp(t, "cannot derive space_id", err)
	})

	t.Run("a resolvable space still refuses on an unresolvable parent", func(t *testing.T) {
		// --- Given --- a sibling stamped with a space but no parent_id, so
		// only the space field has a source.
		dir := t.TempDir()
		oskit.Create(t,
			"---\ntitle: \"S\"\npage_id: \"1\"\nspace_id: \"9\"\n---\nx\n",
			dir, "sib.md")
		dest := filepath.Join(dir, "new.md")

		// --- When ---
		_, _, err := deriveCreateFields(dest, "", "")

		// --- Then --- the parent alone refuses; the space, resolvable on its
		// own, is not named among the fixes.
		assert.ErrorRegexp(t, "cannot derive parent_id", err)
		assert.NotContain(t, "space_id", err.Error())
	})
}

func Test_resolveCreateField(t *testing.T) {
	t.Run("explicit wins", func(t *testing.T) {
		// --- When ---
		have, err := resolveCreateField(
			"parent_id", "/wd/new.md", "77", "100",
			map[string]string{"a.md": "200"})

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "77", have)
	})

	t.Run("index beats siblings", func(t *testing.T) {
		// --- When ---
		have, err := resolveCreateField(
			"parent_id", "/wd/new.md", "", "100",
			map[string]string{"a.md": "200"})

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "100", have)
	})

	t.Run("agreeing siblings resolve", func(t *testing.T) {
		// --- Given ---
		sibs := map[string]string{"a.md": "50", "b.md": "50"}

		// --- When ---
		have, err := resolveCreateField("parent_id", "/wd/new.md", "", "", sibs)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "50", have)
	})

	t.Run("error - disagreeing siblings name every file sorted", func(t *testing.T) {
		// --- Given ---
		sibs := map[string]string{"b.md": "60", "a.md": "50"}

		// --- When ---
		_, err := resolveCreateField("parent_id", "/wd/new.md", "", "", sibs)

		// --- Then ---
		want := "parent_id disagrees among siblings: a.md=50, b.md=60"
		assert.ErrorEqual(t, want, err)
	})

	t.Run("error - no source names both fixes", func(t *testing.T) {
		// --- When ---
		_, err := resolveCreateField("space_id", "/wd/new.md", "", "", nil)

		// --- Then ---
		want := "cannot derive space_id for new.md; " +
			"re-pull the space or set space_id explicitly"
		assert.ErrorEqual(t, want, err)
	})
}

func Test_placeUnderRoot(t *testing.T) {
	const index = "---\ntitle: \"Home\"\npage_id: \"100\"\n" +
		"space_id: \"9\"\n---\nx\n"
	const titleOnly = "---\ntitle: \"P\"\n---\n\nbody\n"

	t.Run("plans missing folders up to an anchored ancestor", func(t *testing.T) {
		// --- Given --- an anchored root and a page two new directories deep.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha", "beta")
		oskit.Create(t, index, dir, "team", "_index.md")
		dest := oskit.Create(t, titleOnly, dir, "team", "alpha", "beta", "p.md")

		// --- When ---
		parent, space, folders, err := placeUnderRoot(dest, "", "", root)

		// --- Then --- both directories become folders, top-down, under the root.
		assert.NoError(t, err)
		assert.Equal(t, "100", parent)
		assert.Equal(t, "9", space)
		assert.Len(t, 2, folders)
		assert.Equal(t, filepath.Join(root, "alpha"), folders[0].Dir)
		assert.Equal(t, "Alpha", folders[0].Title)
		assert.Equal(t, filepath.Join(root, "alpha", "beta"), folders[1].Dir)
		assert.Equal(t, "Beta", folders[1].Title)
	})

	t.Run("de-slugs an underscored directory name", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "meeting_notes")
		oskit.Create(t, index, dir, "team", "_index.md")
		dest := oskit.Create(t, titleOnly, dir, "team", "meeting_notes", "p.md")

		// --- When ---
		_, _, folders, err := placeUnderRoot(dest, "", "", root)

		// --- Then ---
		assert.NoError(t, err)
		assert.Len(t, 1, folders)
		assert.Equal(t, "Meeting Notes", folders[0].Title)
	})

	t.Run("an anchored immediate directory creates no folder", func(t *testing.T) {
		// --- Given --- a page beside an _index.md, as Task 4 handles.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team")
		oskit.Create(t, index, dir, "team", "_index.md")
		dest := oskit.Create(t, titleOnly, dir, "team", "p.md")

		// --- When ---
		parent, space, folders, err := placeUnderRoot(dest, "", "", root)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "100", parent)
		assert.Equal(t, "9", space)
		assert.Nil(t, folders)
	})

	t.Run("error - a folder name that does not round-trip", func(t *testing.T) {
		// --- Given --- an uppercase directory name deriveName would mangle.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "MeetingNotes")
		oskit.Create(t, index, dir, "team", "_index.md")
		dest := oskit.Create(t, titleOnly, dir, "team", "MeetingNotes", "p.md")

		// --- When ---
		_, _, folders, err := placeUnderRoot(dest, "", "", root)

		// --- Then --- refused, naming the directory.
		assert.Nil(t, folders)
		assert.ErrorRegexp(t, "MeetingNotes.*does not round-trip", err)
	})

	t.Run("error - a stale-stamped directory refuses instead of a folder", func(t *testing.T) {
		// --- Given --- an anchored root and a sub-directory holding a sibling
		// stamped with a page id and space but no parent_id, as pages pulled
		// before parent_id stamping carry. The directory already exists
		// remotely, so planning a folder for it would duplicate the chain.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha")
		oskit.Create(t, index, dir, "team", "_index.md")
		oskit.Create(t,
			"---\ntitle: \"Sib\"\npage_id: \"201\"\nspace_id: \"9\"\n---\nx\n",
			dir, "team", "alpha", "sib.md")
		dest := oskit.Create(t, titleOnly, dir, "team", "alpha", "p.md")

		// --- When ---
		_, _, folders, err := placeUnderRoot(dest, "", "", root)

		// --- Then --- refused naming the re-pull fix; no folder planned.
		assert.Nil(t, folders)
		assert.ErrorContain(t, "re-pull", err)
	})

	t.Run("an id-less index does not anchor its directory", func(t *testing.T) {
		// --- Given --- an anchored root and a sub-directory whose only files
		// are an id-less _index.md and the title-only page; the id-less index
		// must not anchor, so a folder is planned from the root anchor.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha")
		oskit.Create(t, index, dir, "team", "_index.md")
		oskit.Create(t,
			"---\ntitle: \"Sub\"\nspace_id: \"9\"\n---\n\nx\n",
			dir, "team", "alpha", "_index.md")
		dest := oskit.Create(t, titleOnly, dir, "team", "alpha", "p.md")

		// --- When ---
		parent, _, folders, err := placeUnderRoot(dest, "", "", root)

		// --- Then --- folders planned past the id-less index, from the anchor.
		assert.NoError(t, err)
		assert.Equal(t, "100", parent)
		assert.Len(t, 1, folders)
		assert.Equal(t, "Alpha", folders[0].Title)
	})

	t.Run("explicit space survives an ancestor that resolves only the parent", func(t *testing.T) {
		// --- Given --- an ancestor anchored by a sibling with a parent_id but
		// no space_id, a new sub-directory below it, and an explicit space on
		// the page.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha")
		oskit.Create(t,
			"---\ntitle: \"Sib\"\npage_id: \"1\"\nparent_id: \"50\"\n---\nx\n",
			dir, "team", "sib.md")
		dest := oskit.Create(t,
			"---\ntitle: \"P\"\nspace_id: \"42\"\n---\n\nbody\n",
			dir, "team", "alpha", "p.md")

		// --- When ---
		parent, space, folders, err := placeUnderRoot(dest, "", "42", root)

		// --- Then --- the ancestor parent and the explicit space both resolve.
		assert.NoError(t, err)
		assert.Equal(t, "50", parent)
		assert.Equal(t, "42", space)
		assert.Len(t, 1, folders)
		assert.Equal(t, "Alpha", folders[0].Title)
	})

	t.Run("error - no anchored ancestor refuses like Task 4", func(t *testing.T) {
		// --- Given --- a page deep under a root with no anchor anywhere.
		dir := t.TempDir()
		root := filepath.Join(dir, "team")
		oskit.MkdirAll(t, dir, "team", "alpha")
		dest := oskit.Create(t, titleOnly, dir, "team", "alpha", "p.md")

		// --- When ---
		_, _, folders, err := placeUnderRoot(dest, "", "", root)

		// --- Then --- the Task 4 refusal, before any folder is planned.
		assert.Nil(t, folders)
		assert.ErrorRegexp(t, "cannot derive parent_id", err)
	})
}

func Test_deSlugTitle_tabular(t *testing.T) {
	tt := []struct {
		testN string
		name  string
		want  string
	}{
		{"single word", "team", "Team"},
		{"underscores to spaces", "meeting_notes", "Meeting Notes"},
		{"already lower word", "alpha", "Alpha"},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := deSlugTitle(tc.name)

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_createSummary(t *testing.T) {
	t.Run("lists the missing folders under the page", func(t *testing.T) {
		// --- Given --- a page whose create depends on two new folders.
		cands := []createInput{{
			Dest:     "/wd/team/alpha/beta/p.md",
			Title:    "Page",
			SpaceID:  "9",
			ParentID: "100",
			Folders:  []folderPlan{{Title: "Alpha"}, {Title: "Beta"}},
		}}

		// --- When ---
		have := createSummary("/wd", cands)

		// --- Then --- the page line omits the parent and each folder is listed.
		assert.Contain(t, "1 new page(s) to create", have)
		assert.Contain(t, `team/alpha/beta/p.md -> "Page" (space 9)`, have)
		assert.Contain(t, `+ new folder "Alpha"`, have)
		assert.Contain(t, `+ new folder "Beta"`, have)
	})

	t.Run("marks a folder shared between two pages", func(t *testing.T) {
		// --- Given --- two pages that depend on the same new folder.
		shared := folderPlan{Dir: "/wd/team/alpha", Title: "Alpha"}
		cands := []createInput{
			{Dest: "/wd/team/alpha/one.md", Title: "One", SpaceID: "9",
				Folders: []folderPlan{shared}},
			{Dest: "/wd/team/alpha/two.md", Title: "Two", SpaceID: "9",
				Folders: []folderPlan{shared}},
		}

		// --- When ---
		have := createSummary("/wd", cands)

		// --- Then --- the first page lists it new, the second as shared once.
		assert.Contain(t, `+ new folder "Alpha"`, have)
		assert.Contain(t, `+ shared folder "Alpha"`, have)
		assert.Equal(t, 1, strings.Count(have, `+ new folder "Alpha"`))
	})

	t.Run("shows the parent for a page with no missing folders", func(t *testing.T) {
		// --- Given ---
		cands := []createInput{
			{Dest: "/wd/a.md", Title: "A", SpaceID: "9", ParentID: "77"},
		}

		// --- When ---
		have := createSummary("/wd", cands)

		// --- Then ---
		assert.Contain(t, `a.md -> "A" (space 9, parent 77)`, have)
	})
}

func Test_readDirMetas(t *testing.T) {
	t.Run("returns the index and excludes self, index, and cf_local", func(t *testing.T) {
		// --- Given ---
		dir := t.TempDir()
		oskit.Create(t,
			"---\ntitle: \"H\"\npage_id: \"100\"\nspace_id: \"9\"\n---\nx\n",
			dir, "_index.md")
		oskit.Create(t,
			"---\ntitle: \"S\"\npage_id: \"1\"\nspace_id: \"9\"\n---\nx\n",
			dir, "sib.md")
		oskit.Create(t,
			"---\ntitle: \"L\"\npage_id: \"2\"\ncf_local: true\n---\nx\n",
			dir, "local.md")
		self := oskit.Create(t, "---\ntitle: \"N\"\n---\nx\n", dir, "new.md")

		// --- When ---
		index, sibs := readDirMetas(dir, self)

		// --- Then --- only the plain sibling is kept.
		assert.NotNil(t, index)
		assert.Equal(t, "100", index.PageID)
		assert.Len(t, 1, sibs)
		assert.NotNil(t, sibs[filepath.Join(dir, "sib.md")])
	})

	t.Run("a missing directory yields nil sources", func(t *testing.T) {
		// --- Given ---
		dir := filepath.Join(t.TempDir(), "missing")

		// --- When ---
		index, sibs := readDirMetas(dir, filepath.Join(dir, "new.md"))

		// --- Then ---
		assert.Nil(t, index)
		assert.Len(t, 0, sibs)
	})
}

func Test_confirmCreates(t *testing.T) {
	t.Run("yes confirms every candidate and prints the summary", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		tst.WetStderr()
		rng := tst.Ring()
		cands := []createInput{
			{Dest: "/wd/a.md", Title: "A", SpaceID: "9", ParentID: "77"},
			{Dest: "/wd/b.md", Title: "B", SpaceID: "9"},
		}

		// --- When ---
		have, err := confirmCreates(rng, "/wd", cands, true)

		// --- Then --- both are confirmed and the summary lists each page.
		assert.NoError(t, err)
		assert.True(t, have["/wd/a.md"])
		assert.True(t, have["/wd/b.md"])

		out := tst.Stderr()
		assert.Contain(t, "2 new page(s) to create", out)
		assert.Contain(t, `a.md -> "A" (space 9, parent 77)`, out)
		assert.Contain(t, `b.md -> "B" (space 9)`, out)
	})

	t.Run("empty candidates yields an empty decision", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		rng := tst.Ring()

		// --- When ---
		have, err := confirmCreates(rng, "/wd", nil, false)

		// --- Then --- nothing is decided and nothing is printed.
		assert.NoError(t, err)
		assert.Len(t, 0, have)
		assert.Equal(t, "", tst.Stderr())
	})

	t.Run("error - refuses to prompt without a terminal", func(t *testing.T) {
		// --- Given --- a buffered, non-terminal input and no --yes.
		tst := ringtest.New(t)
		tst.WetStderr()
		rng := tst.Ring()
		cands := []createInput{{Dest: "/wd/a.md", Title: "A", SpaceID: "9"}}

		// --- When ---
		_, err := confirmCreates(rng, "/wd", cands, false)

		// --- Then --- the summary still prints before the run is refused.
		assert.ErrorContain(t, "refusing to prompt without a terminal", err)
		assert.Contain(t, "1 new page(s) to create", tst.Stderr())
	})
}

func Test_promptCreates(t *testing.T) {
	t.Run("decides each page from its answer", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		tst.WetStderr()
		tst.SetStdin(bytes.NewBufferString("y\nn\n"))
		rng := tst.Ring()
		cands := []createInput{
			{Dest: "/wd/a.md", Title: "A", SpaceID: "9"},
			{Dest: "/wd/b.md", Title: "B", SpaceID: "9"},
		}
		decided := map[string]bool{}

		// --- When ---
		have, err := promptCreates(rng, "/wd", cands, decided)

		// --- Then ---
		assert.NoError(t, err)
		assert.True(t, have["/wd/a.md"])
		assert.False(t, have["/wd/b.md"])

		want := "Create a.md? [y=yes, n=no, a=all, s=skip all]: "
		assert.Contain(t, want, tst.Stderr())
	})

	t.Run("all creates every remaining page", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		tst.WetStderr()
		tst.SetStdin(bytes.NewBufferString("a\n"))
		rng := tst.Ring()
		cands := []createInput{
			{Dest: "/wd/a.md", Title: "A", SpaceID: "9"},
			{Dest: "/wd/b.md", Title: "B", SpaceID: "9"},
			{Dest: "/wd/c.md", Title: "C", SpaceID: "9"},
		}
		decided := map[string]bool{}

		// --- When ---
		have, err := promptCreates(rng, "/wd", cands, decided)

		// --- Then --- one answer decides all three without another prompt.
		assert.NoError(t, err)
		assert.True(t, have["/wd/a.md"])
		assert.True(t, have["/wd/b.md"])
		assert.True(t, have["/wd/c.md"])
		assert.Equal(t, 1, strings.Count(tst.Stderr(), "Create "))
	})

	t.Run("skip all skips every remaining page", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		tst.WetStderr()
		tst.SetStdin(bytes.NewBufferString("y\ns\n"))
		rng := tst.Ring()
		cands := []createInput{
			{Dest: "/wd/a.md", Title: "A", SpaceID: "9"},
			{Dest: "/wd/b.md", Title: "B", SpaceID: "9"},
			{Dest: "/wd/c.md", Title: "C", SpaceID: "9"},
		}
		decided := map[string]bool{}

		// --- When ---
		have, err := promptCreates(rng, "/wd", cands, decided)

		// --- Then --- the skip-all answer settles b and c in one prompt.
		assert.NoError(t, err)
		assert.True(t, have["/wd/a.md"])
		assert.False(t, have["/wd/b.md"])
		assert.False(t, have["/wd/c.md"])
		assert.Equal(t, 2, strings.Count(tst.Stderr(), "Create "))
	})
}

func Test_askCreate_tabular(t *testing.T) {
	tt := []struct {
		testN string
		input string
		want  string
	}{
		{"y creates", "y\n", createYes},
		{"yes creates", "yes\n", createYes},
		{"uppercase is accepted", "Y\n", createYes},
		{"n skips", "n\n", createSkip},
		{"a creates all", "a\n", createAll},
		{"s skips all", "s\n", createSkipAll},
		{"answer without a trailing newline", "y", createYes},
		{"surrounding spaces are ignored", " y \n", createYes},
		{"an unknown answer re-asks", "x\ny\n", createYes},
	}
	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			tst := ringtest.New(t)
			tst.WetStderr()
			tst.SetStdin(bytes.NewBufferString(tc.input))
			rng := tst.Ring()
			rd := bufio.NewReader(rng.Stdin())

			// --- When ---
			have, err := askCreate(rng, rd, "a.md")

			// --- Then ---
			assert.NoError(t, err)
			assert.Equal(t, tc.want, have)
			assert.Contain(t, "Create a.md?", tst.Stderr())
		})
	}
}

func Test_askCreate(t *testing.T) {
	t.Run("re-asking prints the prompt again", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		tst.WetStderr()
		tst.SetStdin(bytes.NewBufferString("x\ny\n"))
		rng := tst.Ring()
		rd := bufio.NewReader(rng.Stdin())

		// --- When ---
		_, err := askCreate(rng, rd, "a.md")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, 2, strings.Count(tst.Stderr(), "Create a.md?"))
	})

	t.Run("error - end of input", func(t *testing.T) {
		// --- Given ---
		tst := ringtest.New(t)
		tst.WetStderr()
		tst.SetStdin(bytes.NewBufferString(""))
		rng := tst.Ring()
		rd := bufio.NewReader(rng.Stdin())

		// --- When ---
		_, err := askCreate(rng, rd, "a.md")

		// --- Then --- the prompt printed once before the input ended.
		assert.ErrorContain(t, "create prompt", err)
		assert.Contain(t, "Create a.md?", tst.Stderr())
	})
}

func Test_createPage(t *testing.T) {
	t.Run("posts the page and returns its id and version", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		meta := &mdMeta{Title: "New Page", SpaceID: "9", ParentID: "77"}
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		id, ver, err := createPage(ctx, http.DefaultClient, cfg, meta,
			[]byte(`{"type":"doc"}`))

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "555", id)
		assert.Equal(t, 1, ver)

		req := srv.Request(0)
		assert.Equal(t, http.MethodPost, req.Method)
		assert.Equal(t, "/wiki/api/v2/pages", req.URL.Path)
		body := string(must.Value(io.ReadAll(req.Body)))
		assert.Contain(t, `"spaceId":"9"`, body)
		assert.Contain(t, `"title":"New Page"`, body)
		assert.Contain(t, `"parentId":"77"`, body)
		assert.Contain(t, `"representation":"atlas_doc_format"`, body)
	})

	t.Run("error - non-2xx status", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		meta := &mdMeta{Title: "New Page", SpaceID: "9"}
		srv := httpkit.NewServer(t).Rsp(http.StatusBadRequest, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, _, err := createPage(ctx, http.DefaultClient, cfg, meta,
			[]byte(`{"type":"doc"}`))

		// --- Then ---
		assert.ErrorContain(t, `create page "New Page": HTTP 400`, err)
	})

	t.Run("error - response has no id", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		meta := &mdMeta{Title: "New Page", SpaceID: "9"}
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, _, err := createPage(ctx, http.DefaultClient, cfg, meta,
			[]byte(`{"type":"doc"}`))

		// --- Then ---
		assert.ErrorContain(t, "response has no id", err)
	})
}

func Test_restrictToAuthor(t *testing.T) {
	t.Run("puts read and update restrictions for the author", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		err := restrictToAuthor(ctx, http.DefaultClient, cfg, "555", "acc-1")

		// --- Then ---
		assert.NoError(t, err)

		req := srv.Request(0)
		assert.Equal(t, http.MethodPut, req.Method)
		assert.Equal(t, "/wiki/rest/api/content/555/restriction", req.URL.Path)
		body := string(must.Value(io.ReadAll(req.Body)))
		assert.Contain(t, `"operation":"read"`, body)
		assert.Contain(t, `"operation":"update"`, body)
		assert.Contain(t, `"accountId":"acc-1"`, body)
	})

	t.Run("error - non-2xx status", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusForbidden, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		err := restrictToAuthor(ctx, http.DefaultClient, cfg, "555", "acc-1")

		// --- Then ---
		assert.ErrorContain(t, "restrict page 555: HTTP 403", err)
	})
}

func Test_deletePage(t *testing.T) {
	t.Run("deletes the page by id", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusNoContent, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		err := deletePage(ctx, http.DefaultClient, cfg, "555")

		// --- Then ---
		assert.NoError(t, err)
		req := srv.Request(0)
		assert.Equal(t, http.MethodDelete, req.Method)
		assert.Equal(t, "/wiki/api/v2/pages/555", req.URL.Path)
	})

	t.Run("error - non-2xx status", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusInternalServerError, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		err := deletePage(ctx, http.DefaultClient, cfg, "555")

		// --- Then ---
		assert.ErrorContain(t, "delete page 555: HTTP 500", err)
	})
}

func Test_createFolder(t *testing.T) {
	t.Run("posts the folder and returns its id", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := createFolder(
			ctx, http.DefaultClient, cfg, "9", "100", "Alpha")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "F1", have)

		req := srv.Request(0)
		assert.Equal(t, http.MethodPost, req.Method)
		assert.Equal(t, "/wiki/api/v2/folders", req.URL.Path)
		body := string(must.Value(io.ReadAll(req.Body)))
		assert.Contain(t, `"spaceId":"9"`, body)
		assert.Contain(t, `"parentId":"100"`, body)
		assert.Contain(t, `"title":"Alpha"`, body)
	})

	t.Run("error - non-2xx status", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusBadRequest, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, err := createFolder(ctx, http.DefaultClient, cfg, "9", "100", "Alpha")

		// --- Then ---
		assert.ErrorContain(t, `create folder "Alpha": HTTP 400`, err)
	})

	t.Run("error - response has no id", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, err := createFolder(ctx, http.DefaultClient, cfg, "9", "100", "Alpha")

		// --- Then ---
		assert.ErrorContain(t, "response has no id", err)
	})

	t.Run("error - duplicate title wraps the sentinel", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		taken := []byte(
			`{"errors":[{"title":"A folder exists with the same title in this space"}]}`)
		srv := httpkit.NewServer(t).Rsp(http.StatusBadRequest, taken)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		_, err := createFolder(ctx, http.DefaultClient, cfg, "9", "100", "Alpha")

		// --- Then ---
		assert.ErrorIs(t, errFolderTitleTaken, err)
	})
}

func Test_deleteFolder(t *testing.T) {
	t.Run("deletes the folder by id", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusNoContent, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		err := deleteFolder(ctx, http.DefaultClient, cfg, "F1")

		// --- Then ---
		assert.NoError(t, err)
		req := srv.Request(0)
		assert.Equal(t, http.MethodDelete, req.Method)
		assert.Equal(t, "/wiki/api/v2/folders/F1", req.URL.Path)
	})

	t.Run("tolerates an already-missing folder", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusNotFound, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		err := deleteFolder(ctx, http.DefaultClient, cfg, "F1")

		// --- Then ---
		assert.NoError(t, err)
	})

	t.Run("error - non-2xx status", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).Rsp(http.StatusInternalServerError, nil)
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		err := deleteFolder(ctx, http.DefaultClient, cfg, "F1")

		// --- Then ---
		assert.ErrorContain(t, "delete folder F1: HTTP 500", err)
	})
}

func Test_pushCreate(t *testing.T) {
	// folderPageMD is a title-only new page whose placement comes from the plan,
	// not its frontmatter.
	const folderPageMD = "---\ntitle: \"Page\"\n---\n\n# H\n\nbody\n"

	t.Run("creates ancestor folders then the page under the deepest", func(t *testing.T) {
		// --- Given --- a page two new directories deep, with its folder chain.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha", "beta")
		dest := oskit.Create(t, folderPageMD, dir, "team", "alpha", "beta", "p.md")
		in := createInput{
			Dest: dest, Title: "Page", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{
				{Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha"},
				{Dir: filepath.Join(dir, "team", "alpha", "beta"), Title: "Beta"},
			},
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		folderIDs := map[string]string{}

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`)).                         // Alpha POST
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F1 restrict
			Rsp(http.StatusOK, []byte(`{"id":"F2"}`)).                         // Beta POST
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F2 restrict
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)). // page
			Rsp(http.StatusOK, []byte(`{}`))                                   // page restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		ver, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1", folderIDs)

		// --- Then --- folders POST top-down with the parent chaining right.
		assert.NoError(t, err)
		assert.Equal(t, 1, ver)

		fa := srv.Request(0)
		assert.Equal(t, http.MethodPost, fa.Method)
		assert.Equal(t, "/wiki/api/v2/folders", fa.URL.Path)
		bodyA := string(must.Value(io.ReadAll(fa.Body)))
		assert.Contain(t, `"title":"Alpha"`, bodyA)
		assert.Contain(t, `"parentId":"100"`, bodyA)

		assert.Equal(t,
			"/wiki/rest/api/content/F1/restriction", srv.Request(1).URL.Path)

		bodyB := string(must.Value(io.ReadAll(srv.Request(2).Body)))
		assert.Contain(t, `"title":"Beta"`, bodyB)
		assert.Contain(t, `"parentId":"F1"`, bodyB)

		assert.Equal(t,
			"/wiki/rest/api/content/F2/restriction", srv.Request(3).URL.Path)

		post := srv.Request(4)
		assert.Equal(t, "/wiki/api/v2/pages", post.URL.Path)
		body := string(must.Value(io.ReadAll(post.Body)))
		assert.Contain(t, `"parentId":"F2"`, body)

		assert.Equal(t,
			"/wiki/rest/api/content/555/restriction", srv.Request(5).URL.Path)

		// The run now knows both folders for a later page under them.
		assert.Equal(t, "F1", folderIDs[filepath.Join(dir, "team", "alpha")])
		assert.Equal(t,
			"F2", folderIDs[filepath.Join(dir, "team", "alpha", "beta")])
	})

	t.Run("reuses a folder that already exists under the parent", func(t *testing.T) {
		// --- Given --- the folder create collides with one already in the space
		// that sits under the intended parent.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha")
		dest := oskit.Create(t, folderPageMD, dir, "team", "alpha", "p.md")
		in := createInput{
			Dest: dest, Title: "Page", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{
				{Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha"},
			},
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		folderIDs := map[string]string{}

		taken := []byte(
			`{"errors":[{"title":"A folder exists with the same title in this space"}]}`)
		found := []byte(
			`{"results":[{"id":"FX","type":"folder","title":"Alpha","status":"current"}]}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusBadRequest, taken).                                 // Alpha POST collides
			Rsp(http.StatusOK, found).                                         // lookup under parent
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)). // page
			Rsp(http.StatusOK, []byte(`{}`))                                   // page restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		ver, reused, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1", folderIDs)

		// --- Then --- the existing folder is reused, reported as reused, never
		// restricted, and the page is created under it.
		assert.NoError(t, err)
		assert.Equal(t, 1, ver)
		assert.Equal(t, []string{"Alpha"}, reused)
		assert.Equal(t, 4, srv.ReqCount())

		assert.Equal(t, "/wiki/api/v2/folders", srv.Request(0).URL.Path)
		assert.Equal(t,
			"/wiki/api/v2/folders/100/direct-children", srv.Request(1).URL.Path)

		post := srv.Request(2)
		assert.Equal(t, "/wiki/api/v2/pages", post.URL.Path)
		body := string(must.Value(io.ReadAll(post.Body)))
		assert.Contain(t, `"parentId":"FX"`, body)

		assert.Equal(t,
			"/wiki/rest/api/content/555/restriction", srv.Request(3).URL.Path)
		assert.Equal(t, "FX", folderIDs[filepath.Join(dir, "team", "alpha")])
	})

	t.Run("reuses a folder under a page parent via endpoint fallback", func(t *testing.T) {
		// --- Given --- the parent is a page, so the folder direct-children
		// lookup 404s and the page endpoint is tried next.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha")
		dest := oskit.Create(t, folderPageMD, dir, "team", "alpha", "p.md")
		in := createInput{
			Dest: dest, Title: "Page", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{
				{Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha"},
			},
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		folderIDs := map[string]string{}

		taken := []byte(
			`{"errors":[{"title":"A folder exists with the same title in this space"}]}`)
		found := []byte(
			`{"results":[{"id":"FX","type":"folder","title":"Alpha","status":"current"}]}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusBadRequest, taken).                                 // Alpha POST collides
			Rsp(http.StatusNotFound, nil).                                     // folder lookup: not a folder
			Rsp(http.StatusOK, found).                                         // page lookup: found
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)). // page
			Rsp(http.StatusOK, []byte(`{}`))                                   // page restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		ver, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1", folderIDs)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, 1, ver)
		assert.Equal(t, 5, srv.ReqCount())
		assert.Equal(t,
			"/wiki/api/v2/folders/100/direct-children", srv.Request(1).URL.Path)
		assert.Equal(t,
			"/wiki/api/v2/pages/100/direct-children", srv.Request(2).URL.Path)
		body := string(must.Value(io.ReadAll(srv.Request(3).Body)))
		assert.Contain(t, `"parentId":"FX"`, body)
	})

	t.Run("refuses a cross-parent folder title collision", func(t *testing.T) {
		// --- Given --- Alpha is created, then Beta collides with a folder that
		// lives elsewhere in the space, not under Alpha.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha", "beta")
		dest := oskit.Create(t, folderPageMD, dir, "team", "alpha", "beta", "p.md")
		in := createInput{
			Dest: dest, Title: "Page", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{
				{Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha"},
				{Dir: filepath.Join(dir, "team", "alpha", "beta"), Title: "Beta"},
			},
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		folderIDs := map[string]string{}

		taken := []byte(
			`{"errors":[{"title":"A folder exists with the same title in this space"}]}`)
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`)).    // Alpha POST
			Rsp(http.StatusOK, []byte(`{}`)).             // F1 restrict
			Rsp(http.StatusBadRequest, taken).            // Beta POST collides
			Rsp(http.StatusOK, []byte(`{"results":[]}`)). // lookup under F1: absent
			Rsp(http.StatusNoContent, nil)                // rollback DELETE F1
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		_, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1", folderIDs)

		// --- Then --- a clear per-page error names the folder, and the folder
		// created first is rolled back.
		assert.ErrorContain(t, `folder "Beta" already exists elsewhere`, err)
		assert.Equal(t, 5, srv.ReqCount())
		del := srv.Request(4)
		assert.Equal(t, http.MethodDelete, del.Method)
		assert.Equal(t, "/wiki/api/v2/folders/F1", del.URL.Path)
		assert.Equal(t, "", folderIDs[filepath.Join(dir, "team", "alpha")])
	})

	t.Run("reuses a folder created earlier in the run", func(t *testing.T) {
		// --- Given --- two pages sharing one new directory.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha")
		one := oskit.Create(t, folderPageMD, dir, "team", "alpha", "one.md")
		two := oskit.Create(t, folderPageMD, dir, "team", "alpha", "two.md")
		folder := folderPlan{Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha"}
		in1 := createInput{
			Dest: one, Title: "One", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{folder},
		}
		in2 := createInput{
			Dest: two, Title: "Two", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{folder},
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		folderIDs := map[string]string{}

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`)).                         // folder once
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F1 restrict
			Rsp(http.StatusOK, []byte(`{"id":"501","version":{"number":1}}`)). // one
			Rsp(http.StatusOK, []byte(`{}`)).                                  // one restrict
			Rsp(http.StatusOK, []byte(`{"id":"502","version":{"number":1}}`)). // two
			Rsp(http.StatusOK, []byte(`{}`))                                   // two restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		_, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in1, "acc-1", folderIDs)
		assert.NoError(t, err)
		_, _, err = pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in2, "acc-1", folderIDs)

		// --- Then --- the folder was created once; the second page reuses it.
		assert.NoError(t, err)
		assert.Equal(t, 6, srv.ReqCount())
		post := srv.Request(4)
		assert.Equal(t, "/wiki/api/v2/pages", post.URL.Path)
		body := string(must.Value(io.ReadAll(post.Body)))
		assert.Contain(t, `"parentId":"F1"`, body)
	})

	t.Run("recreates a folder after a failed page rolled it back", func(t *testing.T) {
		// --- Given --- two pages sharing one new folder; page one's own create
		// fails after the folder is made, so the rollback deletes it and clears
		// the dedupe map before page two runs in the same map.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha")
		one := oskit.Create(t, folderPageMD, dir, "team", "alpha", "one.md")
		two := oskit.Create(t, folderPageMD, dir, "team", "alpha", "two.md")
		folder := folderPlan{
			Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha",
		}
		in1 := createInput{
			Dest: one, Title: "One", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{folder},
		}
		in2 := createInput{
			Dest: two, Title: "Two", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{folder},
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		folderIDs := map[string]string{}

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`)).                         // Alpha POST (one)
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F1 restrict
			Rsp(http.StatusInternalServerError, nil).                          // one page POST fails
			Rsp(http.StatusNoContent, nil).                                    // rollback DELETE F1
			Rsp(http.StatusOK, []byte(`{"id":"F2"}`)).                         // Alpha POST again (two)
			Rsp(http.StatusOK, []byte(`{}`)).                                  // F2 restrict
			Rsp(http.StatusOK, []byte(`{"id":"502","version":{"number":1}}`)). // two page
			Rsp(http.StatusOK, []byte(`{}`))                                   // two restrict
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When --- page one fails and rolls back; page two runs in the map.
		_, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in1, "acc-1", folderIDs)
		assert.Error(t, err)
		_, _, err = pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in2, "acc-1", folderIDs)

		// --- Then --- the folder is recreated for page two, not reused.
		assert.NoError(t, err)
		assert.Equal(t, 8, srv.ReqCount())

		del := srv.Request(3)
		assert.Equal(t, http.MethodDelete, del.Method)
		assert.Equal(t, "/wiki/api/v2/folders/F1", del.URL.Path)

		assert.Equal(t, "/wiki/api/v2/folders", srv.Request(4).URL.Path)
		assert.Equal(t, "F2", folderIDs[folder.Dir])
	})

	t.Run("rolls back created folders when a later folder fails", func(t *testing.T) {
		// --- Given --- Alpha created, Beta's create then fails.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team", "alpha", "beta")
		dest := oskit.Create(t, folderPageMD, dir, "team", "alpha", "beta", "p.md")
		in := createInput{
			Dest: dest, Title: "Page", SpaceID: "9", ParentID: "100",
			Folders: []folderPlan{
				{Dir: filepath.Join(dir, "team", "alpha"), Title: "Alpha"},
				{Dir: filepath.Join(dir, "team", "alpha", "beta"), Title: "Beta"},
			},
		}
		cacheDir := filepath.Join(dir, adfCacheDir)
		folderIDs := map[string]string{}

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"F1"}`)). // Alpha POST
			Rsp(http.StatusOK, []byte(`{}`)).          // F1 restrict
			Rsp(http.StatusInternalServerError, nil).  // Beta POST fails
			Rsp(http.StatusNoContent, nil)             // rollback DELETE F1
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		_, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1", folderIDs)

		// --- Then --- Alpha is deleted, no page is created, the run is clean.
		assert.ErrorContain(t, "create folder", err)
		del := srv.Request(3)
		assert.Equal(t, http.MethodDelete, del.Method)
		assert.Equal(t, "/wiki/api/v2/folders/F1", del.URL.Path)
		assert.Equal(t, 4, srv.ReqCount())
		assert.Len(t, 0, folderIDs)
	})

	t.Run("creates the page, restricts it, and refreshes locally", func(t *testing.T) {
		// --- Given --- a new-page Markdown file under a space root.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team")
		dest := oskit.Create(t, newPageMD, dir, "team", "new.md")
		in := createInput{
			Dest: dest, Title: "New Page", SpaceID: "9", ParentID: "77",
		}
		cacheDir := filepath.Join(dir, adfCacheDir)

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)).
			Rsp(http.StatusOK, []byte(`{}`)) // restriction PUT
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		ver, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1",
			map[string]string{})

		// --- Then --- the page is created at v1 and restricted to the author.
		assert.NoError(t, err)
		assert.Equal(t, 1, ver)

		post := srv.Request(0)
		assert.Equal(t, "/wiki/api/v2/pages", post.URL.Path)
		body := string(must.Value(io.ReadAll(post.Body)))
		assert.Contain(t, "Heading", body)
		assert.Contain(t, "A paragraph.", body)

		put := srv.Request(1)
		assert.Equal(t, "/wiki/rest/api/content/555/restriction", put.URL.Path)

		// The frontmatter now tracks the page, so a later push is an update.
		refreshed := oskit.ReadFileStr(t, dest)
		assert.Contain(t, "page_id: \"555\"", refreshed)
		assert.Contain(t, "page_version: 1", refreshed)

		cached := filepath.Join(cacheDir, "team", "new.v1.json")
		assert.FileExist(t, cached)
	})

	t.Run("deletes the page when the restriction fails", func(t *testing.T) {
		// --- Given --- the create succeeds but the restriction is rejected.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team")
		dest := oskit.Create(t, newPageMD, dir, "team", "new.md")
		in := createInput{
			Dest: dest, Title: "New Page", SpaceID: "9", ParentID: "77",
		}
		cacheDir := filepath.Join(dir, adfCacheDir)

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)).
			Rsp(http.StatusInternalServerError, nil). // restriction PUT fails
			Rsp(http.StatusNoContent, nil)            // rollback DELETE
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		_, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1",
			map[string]string{})

		// --- Then --- the run fails and the unrestricted page is deleted.
		assert.ErrorContain(t, "restrict page 555: HTTP 500", err)

		del := srv.Request(2)
		assert.Equal(t, http.MethodDelete, del.Method)
		assert.Equal(t, "/wiki/api/v2/pages/555", del.URL.Path)

		// The local file is left untouched, so no half-created page is tracked.
		assert.NotContain(t, "page_id", oskit.ReadFileStr(t, dest))
	})

	t.Run("stamps page id when the local refresh fails", func(t *testing.T) {
		// --- Given --- create and restrict succeed; the cache dir is a file so
		// refreshAfterPush cannot write the baseline.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team")
		dest := oskit.Create(t, newPageMD, dir, "team", "new.md")
		in := createInput{
			Dest: dest, Title: "New Page", SpaceID: "9", ParentID: "77",
		}
		// A file at the cache path makes every cache write fail.
		cacheDir := oskit.Create(t, "not-a-dir", dir, "cache-file")

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)).
			Rsp(http.StatusOK, []byte(`{}`))
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		_, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1",
			map[string]string{})

		// --- Then --- the run fails but the file tracks the remote page.
		assert.Error(t, err)
		refreshed := oskit.ReadFileStr(t, dest)
		assert.Contain(t, "page_id: \"555\"", refreshed)
		assert.Contain(t, "page_version: 1", refreshed)
		// No longer a create candidate.
		cands, _ := classifyCreates([]string{dest}, nil)
		assert.Nil(t, cands)
	})

	t.Run("joins delete error when restriction and rollback fail", func(t *testing.T) {
		// --- Given --- create succeeds; restriction and delete both fail.
		ctx := t.Context()
		dir := t.TempDir()
		oskit.MkdirAll(t, dir, "team")
		dest := oskit.Create(t, newPageMD, dir, "team", "new.md")
		in := createInput{
			Dest: dest, Title: "New Page", SpaceID: "9", ParentID: "77",
		}
		cacheDir := filepath.Join(dir, adfCacheDir)

		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"id":"555","version":{"number":1}}`)).
			Rsp(http.StatusInternalServerError, nil). // restriction PUT
			Rsp(http.StatusInternalServerError, nil)  // rollback DELETE
		cfg := &config{
			Host: srv.URL(), Account: "a@ex.com", Token: "secret", WorkDir: dir,
		}

		// --- When ---
		_, _, err := pushCreate(
			ctx, http.DefaultClient, cfg, cacheDir, in, "acc-1",
			map[string]string{})

		// --- Then --- both failures are reported so the page is not silent.
		assert.ErrorContain(t, "restrict page 555: HTTP 500", err)
		assert.ErrorContain(t, "delete page 555: HTTP 500", err)
	})
}

func Test_currentAccountID(t *testing.T) {
	t.Run("returns the authenticated account id", func(t *testing.T) {
		// --- Given ---
		ctx := t.Context()
		srv := httpkit.NewServer(t).
			Rsp(http.StatusOK, []byte(`{"accountId":"acc-1"}`))
		cfg := &config{Host: srv.URL(), Account: "a@ex.com", Token: "secret"}

		// --- When ---
		have, err := currentAccountID(ctx, http.DefaultClient, cfg)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "acc-1", have)
		assert.Equal(t, userEndpoint, srv.Request(0).URL.Path)
	})
}
