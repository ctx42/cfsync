// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"path/filepath"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_canonicalizeImages(t *testing.T) {
	// --- Given --- an uploaded image the user wrote with a ".jpeg" extension. A
	// pull names a JPEG ".jpg" from its media type, so the canonical push name
	// must too, or the next pull re-downloads it and orphans this copy.
	work := t.TempDir()
	oskit.MkdirAll(t, work, "docs")
	dest := filepath.Join(work, "docs", "page.md")
	src := oskit.Write(t, "JPEG", work, "docs", "photo.jpeg")

	assets := map[string]string{"L1": "photo.jpeg"}
	ups := []uploadedImage{{fileID: "F1", localID: "L1", src: src}}

	// --- When ---
	err := canonicalizeImages(ups, dest, work, assets)

	// --- Then --- the file is moved into the shared assets dir under a ".jpg"
	// name and its assets entry is repointed at the canonical relative path.
	assert.NoError(t, err)
	assert.FileExist(t, filepath.Join(work, assetsDir, "F1-L1.jpg"))
	assert.Equal(t, "../_assets/F1-L1.jpg", assets["L1"])
}

func Test_detectNewImages(t *testing.T) {
	// --- Given --- a page directory with one local image on disk, and a body
	// mixing a new local image, a URL image, an already-tracked image, an
	// inline (non-block) image, and one whose file is missing.
	dir := t.TempDir()
	dest := filepath.Join(dir, "page.md")
	oskit.Write(t, "PNG", dir, "new.png")
	oskit.Write(t, "PNG", dir, "old.png")

	assets := map[string]string{"L1": "old.png"} // already tracked
	body := "intro\n\n" +
		"![fresh](new.png)\n\n" + // new local image → detected
		"![web](https://ex.com/x.png)\n\n" + // URL → skipped
		"![kept](old.png)\n\n" + // tracked → skipped
		"see ![inline](new.png) here\n\n" + // not a lone block → skipped
		"![gone](missing.png)" // no file on disk → skipped

	// --- When ---
	have, err := detectNewImages(body, assets, dest)

	// --- Then --- only the lone, local, untracked, existing image is returned.
	assert.NoError(t, err)
	assert.Equal(t, 1, len(have))
	assert.Equal(t, "new.png", have[0].path)
	assert.Equal(t, "fresh", have[0].alt)
	assert.Equal(t, filepath.Join(dir, "new.png"), have[0].abs)
}

func Test_detectInlineNewImages(t *testing.T) {
	// --- Given --- a page dir with one local image, and a body mixing a lone
	// block image (a valid upload candidate, not inline), an inline local image,
	// an inline URL image, an inline tracked image, and an inline missing file.
	dir := t.TempDir()
	dest := filepath.Join(dir, "page.md")
	oskit.Write(t, "PNG", dir, "pic.png")

	assets := map[string]string{"L1": "old.png"} // already tracked
	body := "![lone](pic.png)\n\n" +             // lone block → not inline, skipped
		"see ![in](pic.png) here\n\n" + // inline local new → reported
		"web ![u](https://ex.com/x.png) end\n\n" + // inline URL → skipped
		"kept ![k](old.png) x\n\n" + // inline tracked → skipped
		"gone ![g](missing.png) y" // inline missing file → skipped

	// --- When ---
	have, err := detectInlineNewImages(body, assets, dest)

	// --- Then --- only the inline, local, untracked, existing image is flagged.
	assert.NoError(t, err)
	assert.Equal(t, []string{"pic.png"}, have)
}
