# cfsync Markdown flavor

`cfsync` pulls a Confluence page (Atlassian Document Format, ADF) to a local
Markdown file and pushes edits back. This document specifies the Markdown
dialect that pull emits and push reads, so an editor — human or tool — can
change a page and have `cfsync` rebuild the ADF faithfully.

The dialect is **GitHub-Flavored Markdown plus a small set of extensions** for
ADF constructs GFM cannot express (panels, mentions, statuses, dates, emojis,
Confluence macros, colored/underlined text). Everything below is what the
renderer in `pkg/adf` produces and the parser reads back.

## Design contract

- **Round-trippable.** An unedited block re-renders byte-identically; a block
  you edit re-renders to exactly what you wrote. `cfsync` verifies both laws
  before pushing and rejects (never corrupts) a page that fails.
- **Edit, don't restructure.** You edit prose in place. Constructs the Markdown
  cannot express losslessly are **read-only**: change one and the push is
  rejected with a reason. See [Editability](#editability-on-push).
- **Soft wrap is cosmetic.** Body text is soft-wrapped at 80 columns. Rewrapping
  or reflowing a paragraph is not seen as an edit — only the words matter.
- **Blocks are blank-line separated.** Top-level blocks are joined by one blank
  line. The renderer never puts a blank line inside a block, except inside a
  fenced code block or between the items of a multi-paragraph list.

## Frontmatter

Every file opens with a YAML frontmatter block. Do not edit these fields — they
identify the page and its assets to `cfsync`.

```yaml
---
title: "Page title"
page_path: "docs/page-title.md"
page_id: "123456"
page_version: 7
space_id: "98765"
space_key: "TEAM"
page_images:
  - local_id: 5f3a1c2b9e0d
    file: "_assets/diagram.png"
    alt: "Architecture diagram"
mentions:
  "Jane Doe": "557058:abc-...-id"
---
```

| Field          | Meaning                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `title`        | Confluence page title.                                                           |
| `page_path`    | Local Markdown path of the page; pass it to `cfsync push`.                       |
| `page_id`      | Numeric Confluence page id.                                                      |
| `page_version` | Page version the file was pulled at.                                             |
| `space_id`     | Numeric space id.                                                                |
| `space_key`    | Space key; written only for a page pulled through a `spaces:` entry.             |
| `page_images`  | One entry per downloaded image: its ADF `local_id`, local `file` path, `alt`.    |
| `mentions`     | Maps each `[[@name]]` display name in the body to its account id (see Mentions). |

`space_key`, `page_images`, and `mentions` appear only when the page has them:
`space_key` only for a page pulled through a `spaces:` entry. An ambiguous
mention name (one used with more than one account id) is omitted from `mentions`
and carries its id inline instead.

## Block elements

### Headings

ATX headings, level 1–6, from the ADF heading level:

```markdown
# H1
## H2
###### H6
```

### Paragraphs

Plain soft-wrapped text. A Confluence **indented** paragraph carries an `N>`
marker on its first line, where `N` is the indentation level; continuation lines
align under the text:

```markdown
2> This paragraph sits at indentation level 2, and its wrapped
   continuation lines are padded to line up under the first.
```

Editing the `N` re-indents the paragraph; removing the marker de-indents it. A
flush-left paragraph whose own text would begin with a digit-then-`>` (e.g.
`3> more`) is escaped with a leading backslash (`\3> more`) so it is not misread
as indented — the backslash is not part of the text.

### Hard line breaks

A hard break inside flowing text renders as a **trailing backslash** then a
newline:

```markdown
first line\
second line
```

In a one-line context (a heading or a table cell) a hard break renders as
`<br>` instead.

### Lists

Bullet items use `- `; ordered items use `N. ` numbered from the list's start
value. Continuation lines are indented to align under the item text; a
multi-paragraph item separates its paragraphs with a blank line.

```markdown
- first item
- second item, whose wrapped text
  aligns under the "s"

1. step one
2. step two
```

Ordered-list numbers are re-derived from ADF on render; you do not renumber them
by hand.

### Tables

Column-aligned GFM tables. A table whose entire first row is header cells uses
that row as the GFM header:

```markdown
| Name  | Role      |
|-------|-----------|
| Alice | Author    |
| Bob   | Reviewer  |
```

A key/value table (a header cell leading every row, no header row) has no GFM
equivalent: it renders under a **blank header row** with its header cells
**bolded** inline.

- A cell covered by a colspan/rowspan shows the span marker **`«`**; the origin
  cell keeps the value.
- A literal `|` or `\` inside a cell is backslash-escaped (`\|`, `\\`).
- A multi-paragraph cell, or a cell holding a block, joins its parts with
  `<br>`.

### Code blocks

Fenced, with the language on the opening fence. The body is literal (no escapes
applied):

````markdown
```go
func main() {}
```
````

### Panels, blockquotes, and expands

Rendered as GitHub-style alert blockquotes.

| Construct  | Rendering                                         |
|------------|---------------------------------------------------|
| Panel      | `> [!TYPE]` tag line, then the body (TYPE upper). |
| Blockquote | Plain `> ` lines, **no** `[!TYPE]` tag.           |
| Expand     | `> [!EXPAND] Title` tag line, then the body.      |

```markdown
> [!INFO]
> A Confluence info panel.

> [!EXPAND] Details
> Body of a collapsible expand section.
```

A panel's `[!TYPE]` tag is frozen (editing it is rejected). An expand's title is
editable prose; edit the text after `[!EXPAND]` to retitle it.

### Images and media

A resolved image (downloaded on pull, or an external URL) renders as standard
Markdown:

```markdown
![alt text](_assets/diagram.png)
![alt text](https://example.com/pic.png)
```

An uploaded file with no downloaded asset falls back to a read-only anchor
directive (see below). Media is read-only on push, except that a **new**
`![alt](path)` block pointing at a locally-added, uploaded image can be
inserted.

### Table of contents and other macros

The Confluence Table of Contents macro renders as the marker `[[TOC]]`. Every
other Confluence macro/extension renders as a read-only **anchor directive**
(next section) that carries its identity so `cfsync` copies it back verbatim.

## Inline elements

### Formatting marks

| ADF mark    | Markdown                              |
| ----------- | ------------------------------------- |
| strong      | `**bold**`                            |
| emphasis    | `*italic*`                            |
| strike      | `~~struck~~`                          |
| code        | `` `code` ``                          |
| underline   | `<u>underlined</u>`                   |
| text color  | `<span style="color:red">text</span>` |

When marks nest, they nest in a fixed order (outermost → innermost): strike,
text color, underline, emphasis, code, strong. Inside a code span no escaping is
applied — the content is literal.

### Links and smart links

- **Link:** `[label](href)`.
- **Smart link / inline card:** a bare autolink `<https://example.com>`. This is
  distinct from a normal link so it round-trips back to an ADF inline card
  rather than collapsing to a plain link.

A link to another pulled Confluence page is rewritten to its local Markdown path
when link resolution is enabled.

### Mentions

A user mention renders as `[[@Display Name]]`; the account id is recovered from
the `mentions` frontmatter map. When a display name is ambiguous on the page (it
maps to more than one account id), the id is carried inline:

```markdown
[[@Jane Doe]]
[[@Jane Doe|id=557058:abc-...-id]]
```

### Inline directives

ADF inline nodes with no plain-Markdown form render as `[[…]]` directives, so
they survive a pull → edit → push round-trip. The **first character after `[[`**
selects the kind; an optional `|` introduces a `;`-separated list of
`key=value` attributes. A `[[…]]` starting with neither a sigil nor `*` is
**inert** — ordinary text — so a wiki `[[link]]` and the `[[TOC]]` marker are
never captured.

```
directive = "[[" ( sugar / generic ) "]]"
sugar     = sigil content [ "|" attrs ]
generic   = "*" type ":" content [ "|" attrs ]
sigil     = "@" / "!" / "#" / ":"
type      = ALPHA *( ALPHA / DIGIT )      ; ADF node type, letter-led
content   = *( escaped / literal )        ; display text, may be empty
attrs     = attr *( ";" attr )
attr      = key "=" ( bare / quoted )
key       = 1*( ALPHA / DIGIT / "-" / "_" )
bare      = 1*( not ";" / not "]]" )
quoted    = '"' *( escaped / not-'"' ) '"'
```

| Kind    | Form                                 | Notes                                                        |
|---------|--------------------------------------|--------------------------------------------------------------|
| Status  | `[[!Label\|color=green;style=bold]]` | `color` defaults to `neutral`; `style` omitted when default. |
| Date    | `[[#2026-07-13\|ts=1768262400000]]`  | `ts` (epoch ms) is authoritative; the date text is cosmetic. |
| Emoji   | `[[:smile\|id=1f604]]`               | Content is the shortName without colons; `id` when present.  |
| Mention | `[[@Name]]` / `[[@Name\|id=…]]`      | See Mentions above.                                          |
| Generic | `[[*type:content\|key=value;…]]`     | Any other inline node type; attributes sorted by key.        |
| Anchor  | `[[*type:content\|…;localId=…]]`     | **Read-only**: carries `localId`; copied back verbatim.      |

Per-type contract:

- **Mention** — an inline `id=` wins; otherwise the name resolves through the
  frontmatter `mentions` map. An unresolved name degrades to plain text (the
  block stays read-only), never linking the wrong account.
- **Status** — `text` → content; `color` is always emitted (default `neutral`),
  `style` only when present and not `default`; canonical order `color`, `style`.
- **Date** — content is the UTC `YYYY-MM-DD` derived from `ts`; on push `ts`
  wins and the content is cosmetic.
- **Emoji** — the shortName drives the render, colons stripped (`":smile:"` →
  `[[:smile]]`); the glyph is not carried. `id` rides along when present.
- **Generic** — content is the `text` attr; other string attrs ride after `|`,
  keyed lexically. `localId` is dropped. A node with a non-string attribute
  cannot be flattened to `key=value` and keeps a read-only
  `<!-- adf:type -->` placeholder.
- **Anchor** — the read-only form: it keeps its `localId` (the merge anchor) and
  is never editable, unlike an editable inline directive, which carries none.

**Render is asymmetric with parse, by design.** Render emits exactly one
canonical spelling per node — sugar for the four sigil types, `*generic` for the
rest — which keeps the merge's rendered-vs-rendered reflow diff stable. Parse
accepts both spellings, so a hand-edited `[[*status:OK]]` still round-trips.

**Self-check.** After rendering, cfsync parses its own output back and confirms
the node signature matches. A run that cannot re-parse to the same node degrades
to a read-only placeholder rather than emit something that mis-parses — so
adding a new inline type is safe: the worst case is a faithful read-only
fallback, never silent corruption.

## Escaping

The renderer escapes exactly the characters that would otherwise start a
construct, so text re-parses literally; a leading backslash before an escapable
character is consumed on parse.

| Context              | Escaped                                                                                                                 |
|----------------------|-------------------------------------------------------------------------------------------------------------------------|
| Inline text          | `\`, `` ` ``, `*` always; `~` before `~~`; `[` before a link/directive; `<` before an autolink, `<u>`, or a color span. |
| Directive content    | `\`, `]`, `\|`.                                                                                                         |
| Directive attr value | Double-quoted when empty or containing space, tab, `"`, `;`, or `]`.                                                    |
| Table cell           | `\` and `\|`.                                                                                                           |

An `=` inside an attribute value is fine bare (a pair splits on its first `=`);
a value bearing the `;` separator, such as a URL query string, is quoted.
Ordinary punctuation (a lone `~`, a non-link `[`, a stray `<`) is left untouched
so the Markdown stays clean.

## Editability on push

`cfsync` back-ports your edits through a lens: it applies what the Markdown can
express and copies everything else from the cached ADF. What you may change:

| Change                                                | Allowed?                                       |
|-------------------------------------------------------|------------------------------------------------|
| Edit top-level paragraph / heading text               | Yes — including heading level and `N>` indent. |
| Edit list item text                                   | Yes — item structure (nesting) frozen.         |
| Edit panel / expand / blockquote body paragraph       | Yes — paragraph **count** frozen; tag frozen.  |
| Retitle an expand                                     | Yes — edit the text after `[!EXPAND]`.         |
| Edit table cell text                                  | Yes — table shape, spans, header flags frozen. |
| Insert / delete a plain paragraph or heading          | Yes.                                           |
| Insert a single-paragraph plain list item             | Yes.                                           |
| Insert a `![alt](path)` for a newly-added image       | Yes.                                           |
| Edit a code block, macro, media, or anchor            | No — read-only, rejected.                      |
| Change table rows/columns, list numbering, panel type | No — frozen structure, rejected.               |
| Edit any block whose inline cannot round-trip         | No — rejected rather than pushed lossily.      |

A rejected push names the offending block and why; nothing is pushed until every
block passes both round-trip laws.
