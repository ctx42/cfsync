// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Package textwrap reflows a single paragraph of text so that no line is wider
// than a given display width, without ever splitting a word or a hyphenated
// word.
package textwrap

import (
	"strings"

	"github.com/mattn/go-runewidth"
)

// Wrap reflows s into lines no wider than width display columns and returns the
// result with lines joined by "\n" and without a trailing newline.
//
// Every run of whitespace in s collapses to a single space, so any line breaks
// already present are treated as soft and the paragraph is re-wrapped from
// scratch. Words are whitespace-delimited and atomic: a word, including a
// hyphenated one such as "state-of-the-art", is never split, not even at a
// hyphen. A word wider than width on its own occupies a line that exceeds the
// limit rather than being broken.
//
// Width is measured in terminal display columns with [runewidth.StringWidth],
// so double-width runes count as two columns and zero-width runes as none. A
// width less than or equal to zero means "no limit": s is returned collapsed to
// a single line. Input that is empty or all whitespace yields an empty string.
func Wrap(s string, width int) string {
	return WrapTokens(strings.Fields(s), width)
}

// WrapTokens greedily packs words onto lines no wider than width display
// columns, joining words with a single space, and returns the result with lines
// joined by "\n" and without a trailing newline.
//
// Each element of words is atomic and is never split, so a caller can keep a
// unit that contains spaces (such as a Markdown link) whole by passing it as a
// single word. Width is measured as in [Wrap]; a width less than or equal to
// zero means "no limit". An empty words slice yields an empty string.
func WrapTokens(words []string, width int) string {
	if len(words) == 0 {
		return ""
	}
	if width <= 0 {
		return strings.Join(words, " ")
	}

	var b strings.Builder
	line := words[0]
	lineWidth := runewidth.StringWidth(line)
	for _, word := range words[1:] {
		wordWidth := runewidth.StringWidth(word)
		// The +1 accounts for the single space joining the word to the line.
		if lineWidth+1+wordWidth <= width {
			line += " " + word
			lineWidth += 1 + wordWidth
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')
		line = word
		lineWidth = wordWidth
	}
	b.WriteString(line)
	return b.String()
}
