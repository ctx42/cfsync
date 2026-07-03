# Design note: create-and-restrict flow

Status: implemented (`pkg/cfsync/create.go`). Two deltas from the original
proposal, both noted inline below: created pages do not carry user-added images
yet, and a failed restriction deletes the page immediately rather than retrying
first.

## Problem

`push` today only *updates* pages. `loadPushInput` (`pkg/cfsync/push.go`)
fails unless the frontmatter carries both `page_id` and `page_version`, and
every downstream step (`pushDoc`, `putPage`) targets that id. There is no path
that creates a page in Confluence.

We want `push` to create a page when the local file has no remote counterpart,
and — per requirement — a created page must be **visible only to its author**
until someone deliberately opens it up.

## Confluence behavior we must work around

1. A page created via `POST /wiki/api/v2/pages` is born with **no page-level
   restrictions**. It is immediately visible to everyone with space view
   permission (minus any restrictions inherited from ancestors). "Author only"
   is never the default.
2. The v2 create endpoint does **not** accept restrictions in the request body.
   Restrictions are a separate call, and the restriction endpoints are still
   v1: `/wiki/rest/api/content/{id}/restriction`. So creation and restriction
   are two round-trips with a window in between.
3. "Nobody else" is not literally achievable. **Space and site admins always
   retain view/manage access** to restricted pages; the API cannot strip that.
   Ancestor view restrictions also still bind — the effective audience is the
   intersection of this page's restriction and every ancestor's. The note must
   state this plainly so no one expects hard secrecy.

## Trigger: when does push create?

A file is a create candidate when its frontmatter has **no `page_id`** (and no
`page_version`). To create, cfsync still needs a destination:

- `space_id` — required; which space the page lives in.
- `parent_id` — optional; the parent page. Absent → space root/homepage.
- `title` — required; from frontmatter (already in `mdMeta`).

`loadPushInput` currently rejects a missing `page_id` outright. It grows a
branch: missing `page_id` + present `space_id` + present `title` → create path;
missing all three → the existing "frontmatter lacks page_id" error.

Open question: is the create target better expressed in the config `pages:`
value (dest file → parent page URL) than in frontmatter? See Open questions.

## Confirmation

A missing `page_id` might be a typo, not intent to create, so a create is never
silent — every new page is confirmed before it is created.

- **Up-front summary first.** Before the first prompt, print the full list of
  pending creates (dest file → title → target space/parent) so the user sees
  the whole blast radius before answering anything. This is the default, not an
  option.
- **Then, per page, prompt Y / N / A / S** on the terminal:
  - `Y` — create this page.
  - `N` — skip it (leave the file untouched, continue the run).
  - `A` (All) — create this page and every remaining new page without further
    prompting.
  - `S` (Skip all) — skip this page and every remaining new page; create none.
- Bypass with the existing **`--yes`** flag (treated as `A` for the whole run),
  matching how `clean` skips its prompt. The up-front summary still prints, so a
  `--yes` run still reports what it is about to create.
- **Refuse to prompt without a terminal.** Reuse `onTerminal(rng)`
  (`pkg/cfsync/clean.go`); when stdin is not a terminal and `--yes` was not
  given, fail with "refusing to prompt without a terminal; re-run with --yes"
  rather than creating or silently skipping.
- Build the prompt with `huh` (a per-page `huh.NewSelect` with the four
  choices), wired to `rng.Stdin()`/`rng.Stderr()` exactly as `promptStale` is.

Confirmation happens *before* any remote work for that page (before image
upload and create), so a declined page costs no round-trips and orphans
nothing.

## The flow

`pushCreate` (new sibling of `pushOne`), for a create-candidate file that the
user confirmed:

1. **Resolve the author accountId.** Reuse the current-user call that backs
   `connectionTest` (`GET /wiki/rest/api/user/current`, `atlassianUser` in
   `pkg/cfsync/connection.go`). The credentialed account *is* the author, so no
   new config is needed. Cache it for the run if creating many pages.
2. **Render the body.** Build ADF from the Markdown body exactly as the update
   path does. There is no baseline to merge against, so this skips the
   three-way merge in `pushDoc` — a create is an unconditional render.
3. **Render the body from an empty baseline.** The lens (`ADF.PutLinks`) runs
   with an empty `doc` as the baseline, so every block is an insert. This limits
   a created page to what insertion allows — since the rich-block builders
   landed (`pkg/adf/build.go`) that covers paragraphs, headings, lists, tables,
   code fences, panels, expands, blockquotes, and the `[[TOC]]` marker; a block
   nesting another structured block is still rejected.
   *Delta from proposal:* user-added images are **not** supported on create yet.
   Uploading an attachment needs the page id, which does not exist until after
   the create, so images are a follow-up: create the page, then add images on a
   later push. `pushCreate` passes no images to the lens, so an image block in a
   new file is rejected rather than silently dropped.
4. **Create the page.** `POST /wiki/api/v2/pages` with
   `{spaceId, status:"current", title, parentId?, body:{representation:
   "atlas_doc_format", value: docJSON}}`. Response yields the new `id` and
   `version.number` (1).
5. **Restrict to author — immediately.** `PUT /wiki/rest/api/content/{id}/
   restriction` with a `read` operation restricting to the single author user:

   ```json
   [
     {
       "operation": "read",
       "restrictions": { "user": [ { "type": "known", "accountId": "<author>" } ] }
     }
   ]
   ```

   Add an `update` operation with the same user if edit-locking is also wanted
   (recommended — otherwise anyone with space edit rights can edit a page they
   cannot read). The author always keeps read+update on their own page, so this
   yields the author-only view.
6. **Write frontmatter back.** Fold the returned `page_id`, `page_version` (1),
   and `space_id` into the file via the existing `refreshAfterPush` mechanism,
   so the *next* push takes the normal update path. From here on the file is
   indistinguishable from a pulled one.

## Atomicity and the restriction window

Between step 4 and step 5 the page is space-visible. This is unavoidable with
the two-call API, but the window is one request wide. Handling:

- If **create succeeds but restrict fails**, the page exists and is
  *unrestricted* — the exact state we must not leave. `pushCreate` **deletes the
  just-created page** (`DELETE /wiki/api/v2/pages/{id}`) and returns the
  restriction error, mirroring the orphan-attachment rollback used for images.
  *Delta from proposal:* the bounded-retry step is not implemented — a single
  restriction attempt, then delete on failure. Retry can be added later without
  changing the contract. Leaving an unrestricted page on a hard failure is worse
  than leaving nothing.
- `page_id` is written to frontmatter only after the page is both created *and*
  restricted (`refreshAfterPush` runs last), so a failed run leaves no
  half-adopted local state.

## Failure matrix

| Stage failed        | Remote state           | Cleanup                                  |
|---------------------|------------------------|------------------------------------------|
| Body render (lens)  | nothing                | none; fail before any request            |
| Create page         | nothing                | none; return the create error            |
| Restrict page       | page exists, open      | delete the page, return restrict error   |
| Frontmatter refresh | page live + restricted | keep remote; report local-only mismatch  |

The last row matches `refreshAfterPush` today: once the page is live and
correct, a local refresh error is a local divergence, not cause to undo remote
work.

## Caveats to document for users

- Author-only means **author + space/site admins**. Not hard secrecy.
- Creating under a restricted parent narrows the audience further (intersection
  of restrictions), never widens it.
- `read`-only restriction without a matching `update` restriction leaves the
  page editable by space members who cannot see it. Restrict both.

## Open questions

1. ~~Create target in config vs frontmatter.~~ **Resolved:** the trigger is a
   bare on-disk file under a managed root with `title` and no `page_id`; its
   `space_id` and `parent_id` are derived disk-only (explicit frontmatter, else
   the directory's `_index.md`, else agreeing sibling pages). Config `pages:`
   entries get no derivation; one becomes a create candidate only when its
   frontmatter carries `title` and `space_id` explicitly and no `page_id`.
   `classifyCreates` implements this.
2. ~~Restrict scope default.~~ **Resolved:** `read` **and** `update`, both to
   the author (`restrictToAuthor`), since read-only alone is a footgun.
3. ~~Is create opt-in?~~ **Resolved:** an up-front summary of all pending
   creates prints first, then each page is confirmed Y/N/A/S on the terminal,
   bypassable with `--yes`; see [Confirmation](#confirmation).
4. **Bulk create ordering.** When a folder/space sync creates many pages,
   parents must exist before children. Needs a create order derived from the
   parent tree — out of scope for the single-page flow, flagged for later.
5. **Reuse of the v2 vs v1 split.** Create is v2, restrict is v1. Confirm the
   v1 restriction endpoint is still the supported path at implementation time;
   prefer a v2 equivalent if one has shipped.

## Out of scope

- **Creating whole spaces.** cfsync never creates a space. Confluence folders,
  by contrast, are created on push as dependencies of a confirmed page: when a
  new local sub-directory has no remote counterpart, the missing folder(s) are
  created and restricted first, then the page attaches under the deepest one. A
  created page's parent may therefore be a folder cfsync just made, an existing
  page, or the space root.
- User-added images on a created page (create the page, add images on a later
  push; see the body-render step).
- Bounded retry of a failed restriction before the delete rollback.
- Deleting or un-restricting existing pages.
- Restricting to groups or to users other than the author.
