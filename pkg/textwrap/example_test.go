// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package textwrap_test

import (
	"fmt"

	"github.com/ctx42/cfsync/pkg/textwrap"
)

func ExampleWrap() {
	s := "The state-of-the-art solution wraps text nicely."
	fmt.Println(textwrap.Wrap(s, 20))
	// Output:
	// The state-of-the-art
	// solution wraps text
	// nicely.
}

func ExampleWrapTokens() {
	// A token that contains spaces, such as a Markdown link, stays whole: it is
	// never split at its internal space even when it lands on its own line.
	words := []string{"click", "[Asset Data](url)", "here"}
	fmt.Println(textwrap.WrapTokens(words, 18))
	// Output:
	// click
	// [Asset Data](url)
	// here
}
