# textwrap

Package `textwrap` reflows a single paragraph of text so that no line is wider
than a given display width, without ever splitting a word or a hyphenated word.

```go
import "github.com/ctx42/cfsync/pkg/textwrap"

s := textwrap.Wrap("The state-of-the-art solution wraps text nicely.", 20)
// The state-of-the-art
// solution wraps text
// nicely.
```

Width is measured in terminal display columns (`runewidth`). Pass a width of
`0` or less for no limit. Use `WrapTokens` when a token must stay whole even if
it contains spaces (for example a Markdown link).

See the package examples for more.
