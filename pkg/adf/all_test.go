// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

import (
	"strings"

	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testing/pkg/tester"
)

// renderBody renders adf and returns its Markdown body without the frontmatter
// and without the trailing newline.
func renderBody(t tester.T, adf *ADF, assets map[string]string) string {
	t.Helper()
	md, sm, err := adf.MarshallMarkdownMapped(assets)
	must.Nil(err)
	return strings.TrimSuffix(string(md[sm.BodyStart:]), "\n")
}

// blocksOf builds a block slice from raw texts, for diff tests.
func blocksOf(texts ...string) []mdBlock {
	out := make([]mdBlock, len(texts))
	for i, t := range texts {
		out[i] = newBlock(t)
	}
	return out
}
