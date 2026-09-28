# lightbook-lexical

Shared, standalone [Lexical](https://lexical.dev)-based editor core for the
Lightbook ecosystem — a second implementation of the same product surface
as `lightbook-prosemirror`, built fresh on Lexical instead of ProseMirror,
to compare the two before committing either as the long-term dependency of
the new Lightbook web app.

## Status

| Area | Status |
| --- | --- |
| Rich block schema (headings, lists/checklists, tables, code, quote, links, HR) | done — built on Lexical's official node packages |
| Custom nodes: image, video, notice/callout | done |
| Markdown import/export (GFM tables, task lists, notices, video) | done |
| Comments (`@lexical/mark`'s `MarkNode`) | done |
| Suggestion / track-changes mode | done |
| Floating selection toolbar + `/` slash block-insert menu | done |
| Realtime collaboration via Loro CRDT | done — a from-scratch "simple tier" binding (see below); no official `loro-lexical` package exists (unlike `loro-prosemirror` for the ProseMirror package) |

## Why Lexical here, ProseMirror there

Both packages implement the same feature set so they can be compared
head-to-head. Notable differences this package's implementation surfaced:

- Lexical ships official packages for most of the schema (`@lexical/list`,
  `@lexical/table`, `@lexical/code`, `@lexical/link`, `@lexical/rich-text`)
  and for comment-style annotations (`@lexical/mark`'s `MarkNode`, reused
  here for both comments and suggestion mode via an id-prefix convention —
  see `src/comments/ids.ts`), so the schema/comments layer needed
  meaningfully less custom code than the ProseMirror version.
- Lexical has no ProseMirror-style step/transaction pipeline to intercept
  edits before they land. Suggestion mode is instead built on a `TextNode`
  node transform (Lexical's mechanism for "rewrite a just-applied change
  before it's user-visible, synchronously, within the same update") that
  diffs each dirty node's text against its own last-seen baseline — see the
  docstring in `src/comments/suggestion.ts`.
- Positioning the floating toolbar/slash menu is simpler in Lexical: the
  browser's native DOM Selection stays in sync with Lexical's own, so
  `getBoundingClientRect()` on the real selection range is enough — no
  ProseMirror `coordsAtPos`-style lookup needed.
- `$convertFromMarkdownString`/`$convertToMarkdownString` clear their
  target node on every call, which broke naive "call it once per chunk
  around a table" splicing; `$generateNodesFromMarkdownString` (which
  returns nodes without touching any tree) is the correct primitive for
  that — see `src/markdown.ts`.

## Loro collaboration binding

No official `loro-lexical` package exists, so `src/collab/binding.ts` is a
from-scratch binding — deliberately a simpler "two-layer" design rather than
a full node-level one (contrast with `loro-prosemirror`, which maps every
ProseMirror node to its own Loro container and handles cursor position
algebra across all of them):

- The document is a recursive tree of blocks, each a mergeable `LoroMap`
  keyed by a stable block id (`ensureMergeableMap`, so two peers creating
  "the same" block concurrently converge instead of forking).
- Only a block's **plain text** gets real CRDT merging, via a mergeable
  `LoroText` + `LoroText.update()` (Loro computes the minimal diff with
  Myers' algorithm). This is deliberate: two people typing concurrently in
  the same paragraph is the scenario "feels like Google Docs" is actually
  judged on, so that's where the real merge effort goes.
- Inline **formatting** (bold/italic/etc, as a run-length snapshot) is
  synced as a plain value, overwritten wholesale on change — not merged
  character-by-character. Concurrent formatting edits to the same
  paragraph can overwrite each other.
- Block **order** is a mergeable `LoroMovableList` of block ids, one per
  nesting level (`rootOrder`, and each container block's own
  `childOrder`), reconciled with real `LoroMovableList.move()` ops for
  anything that only changed position rather than a delete+reinsert — see
  `reconcileOrder` in `binding.ts`. This matters under concurrency: a
  delete+insert looks to Loro like "destroyed and recreated" for that op,
  so a concurrent edit to that block's own text racing a reorder is more
  likely to collide; a real move preserves the block's identity through
  the reorder, so the two merge cleanly instead — `test/collab.ts` has a
  test that moves a paragraph and edits it (from the other peer) in the
  same pass to confirm the edit lands on the right block, not a
  duplicate.
- Blockquotes flatten to one text block (no per-paragraph merge inside a
  quote); tables sync as an opaque whole-node JSON snapshot (no per-cell
  merge).
- No collaborative undo/redo yet — the `HistoryPlugin` is simply disabled
  while collab is active for now.

### Remote cursor / presence layer

`src/collab/presence.ts` + `LoroCollabPlugin`'s optional `presence` prop
render a colored caret + name label for where every other peer's cursor
currently is, over Loro's `EphemeralStore` (a peer-keyed,
per-entry-timeout-expiring key/value channel — not part of the CRDT
document, nothing persisted — the Loro analogue of Yjs Awareness).

Cursors are addressed the same way content is: `{blockId, offset}`, using
the exact same block ids and text-flattening `binding.ts` uses for sync
(`resolveLocalCursorPoint`/`readLocalCursorPayload` walk up to the nearest
text-bearing block and flatten to one character offset, mirroring
`blockSpec.ts`'s `textRunsOf`). Rendering resolves a remote `{blockId,
offset}` back to a live DOM point via a `TreeWalker` over the target
block's rendered text nodes; an offset past the block's current length
(the block shrank since the broadcast) is clamped rather than left
dangling, and a cursor on a block id that's since been deleted is dropped
rather than crashing — see `test/collab.ts`'s presence tests.

Scoped to a collapsed-caret position for v1, not a full remote-selection
range highlight (unlike the ProseMirror package's decoration-based one) —
the caret already gives strong "I can see where you are" feedback, and a
correct multi-line range-highlight renderer was a large enough chunk of
DOM work on its own to defer.

See `src/collab/binding.ts`'s module docstring for the exact Loro document
shape, and `test/collab.ts` for the tests that back these claims — including
a concurrent-same-paragraph-typing test that verifies both peers' edits
survive and converge identically after reconnecting.

## Structure

```
src/
  nodes/          custom Image/Video/Notice nodes + the LIGHTBOOK_NODES registry
  theme.ts        EditorThemeClasses mapping onto the shared lb-* CSS classes
  markdown.ts      Markdown <-> Lexical node tree conversion
  comments/        MarkNode-based comment threads + suggestion-mode controller
  menus/           floating selection toolbar + "+"/slash block-insert menu (React)
  collab/          Loro CRDT binding (block tree sync) + bridging/demo helpers
  LightbookEditor.tsx   the single entry point apps are meant to use
example/           a runnable React demo page (live collab, comments/suggesting UI, markdown import/export)
```

## Getting started

```sh
corepack pnpm install
corepack pnpm dev        # example app at http://localhost:5184
corepack pnpm typecheck
corepack pnpm test        # headless smoke tests via @lexical/headless
corepack pnpm build
```

## Known scope limits (documented, not accidental)

- Suggestion mode only rewrites edits that touch a single `TextNode`
  (typing, backspace/delete, short in-place replacement) — matching
  `lightbook-prosemirror`'s documented scope. Structurally larger edits
  (multi-block, paste, list/table restructuring) apply normally,
  untracked.
- Table cells are treated as single-paragraph plain text on markdown
  import/export, same as the ProseMirror package.
- Underline/subscript/superscript round-trip through Pandoc-style
  `++text++`/`~text~`/`^text^` delimiters rather than CommonMark syntax
  (which doesn't define any) — see `src/markdown.ts`.
