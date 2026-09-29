import {
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $hasUpdateTag,
  $isTextNode,
  $setSelection,
  HISTORIC_TAG,
  TextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import { $createMarkNode, $isMarkNode, $unwrapMarkNode, MarkNode } from "@lexical/mark";
import {
  isSuggestionDeleteMarkId,
  isSuggestionInsertMarkId,
  suggestionDeleteMarkId,
  suggestionInsertMarkId,
  newMarkId,
} from "./ids";

export interface SuggestingActive {
  authorId: string;
}

export interface SuggestionController {
  isSuggesting(): boolean;
  setSuggesting(authorId: string | null): void;
  acceptSuggestion(suggestionId: string): void;
  rejectSuggestion(suggestionId: string): void;
  destroy(): void;
}

function newSuggestionId(): string {
  return newMarkId();
}

function walkNode(node: LexicalNode, visit: (node: LexicalNode) => void) {
  visit(node);
  if ("getChildren" in node && typeof (node as any).getChildren === "function") {
    for (const child of (node as any).getChildren() as LexicalNode[]) {
      walkNode(child, visit);
    }
  }
}

/**
 * Merges consecutive plain-text sibling children of `parent` that share the
 * same format/style/mode/detail back into one TextNode. Called on the
 * parent(s) touched by `resolve()` (unwrapping/removing a suggestion mark
 * exposes its former neighbors as new adjacent siblings) so an editing
 * session with many accepted/rejected suggestions doesn't permanently leave
 * the tree fragmented into ever-smaller TextNodes from `splitText` — with
 * no merge step, every resolved suggestion would be a net-additive split
 * that never gets undone, and both this controller's own diffing and
 * generic tree walks (markdown export, `listThreads`, etc.) get slower as
 * fragment count grows with document age rather than document size.
 */
function coalesceAdjacentTextNodes(parent: ElementNode) {
  let child = parent.getFirstChild();
  while (child) {
    const next: LexicalNode | null = child.getNextSibling();
    if (
      $isTextNode(child) &&
      $isTextNode(next) &&
      child.getFormat() === next.getFormat() &&
      child.getStyle() === next.getStyle() &&
      child.getMode() === next.getMode() &&
      child.getDetail() === next.getDetail()
    ) {
      child.setTextContent(child.getTextContent() + next.getTextContent());
      next.remove();
      continue; // re-check the grown node against its new next sibling
    }
    child = next;
  }
}

/**
 * Google-Docs-style "Suggesting" mode.
 *
 * Lexical has no ProseMirror-style step/transaction pipeline to intercept
 * before an edit lands, so this uses Lexical's own equivalent for
 * "rewrite a just-applied change before it's user-visible": a node
 * transform on `TextNode`, which Lexical re-runs synchronously (within the
 * same update) for every dirty text node until the tree stabilizes — the
 * same role `appendTransaction` played in lightbook-prosemirror's
 * suggestion.ts, just triggered per-node instead of per-transaction.
 *
 * Each dirty TextNode's current text is diffed against the text this
 * controller last recorded for that node key (`prevTextCache` — Lexical
 * transforms don't receive a "before" snapshot the way `appendTransaction`
 * gets `oldState`, so the controller keeps its own). The common
 * prefix/suffix is left untouched; the inserted middle span is wrapped in a
 * `suggestion_insert`-tagged `MarkNode`, and the deleted middle span —
 * already gone from the node's text, since the transform runs *after*
 * Lexical applied the edit — is recreated as its own text node and spliced
 * back in, tagged `suggestion_delete`, exactly like the ProseMirror
 * version's "re-insert the deleted slice" approach.
 *
 * Scope, matching lightbook-prosemirror's documented limits: only edits
 * that touch a single TextNode are rewritten (typing, backspace/delete,
 * short in-place replacement). Edits already inside a *pending* (not yet
 * accepted) suggestion span pass through untouched — see the parent check
 * below — so backspacing your own unaccepted insertion really deletes it
 * instead of double-tagging it.
 */
/** A pending single-id suggestion mark directly next to `node`, if any. */
function adjacentSuggestionMark(
  node: LexicalNode,
  isKind: (id: string) => boolean,
): { mark: MarkNode; side: "before" | "after" } | null {
  const matches = (n: LexicalNode | null): n is MarkNode =>
    $isMarkNode(n) && n.getIDs().length === 1 && isKind(n.getIDs()[0]);
  const before = node.getPreviousSibling();
  if (matches(before)) return { mark: before, side: "before" };
  const after = node.getNextSibling();
  if (matches(after)) return { mark: after, side: "after" };
  return null;
}

export function createSuggestionController(editor: LexicalEditor): SuggestionController {
  let active: SuggestingActive | null = null;
  let isResolving = false; // true while accept/reject's own editor.update runs
  const prevTextCache = new Map<NodeKey, string>();
  // suggestion mark id (e.g. "si:sg-...") -> the MarkNode key(s) carrying
  // it. Every suggestion MarkNode is created in exactly one place (the
  // transform below) and destroyed in exactly one place (`resolve`, which
  // fully resolves — and so fully clears — a given suggestionId at once),
  // so this can be kept in sync at those two call sites directly instead of
  // deriving it from a mutation listener. That makes `resolve()` an O(marks
  // for this id) lookup instead of an O(document size) tree walk, which
  // matters once a long editing session has accumulated many resolved and
  // pending suggestions. (This index only knows about marks created by
  // *this* controller instance — fine today since suggestion/comment marks
  // aren't yet synced over the Loro collab layer; would need to become
  // mutation-listener-driven if/when they are.)
  const idIndex = new Map<string, Set<NodeKey>>();
  function indexAdd(id: string, key: NodeKey) {
    let set = idIndex.get(id);
    if (!set) {
      set = new Set();
      idIndex.set(id, set);
    }
    set.add(key);
  }

  const unregisterTransform = editor.registerNodeTransform(TextNode, (node) => {
    if (!active || isResolving) return;
    if (!$isTextNode(node)) return;
    // IME composition (Chinese/Japanese/Korean input, etc.) fires many
    // intermediate DOM/text changes while the browser's own composition
    // UI still owns the caret — splitting the node and wrapping a partial,
    // not-yet-committed fragment in a MarkNode mid-composition (as this
    // transform otherwise would, on every intermediate change) confuses
    // the browser about which DOM text node it's still composing into,
    // which is what caused the cursor to land in the wrong place after
    // every commit. Skip entirely while composing; the transform still
    // runs once composition ends, by which point `node`'s text is the
    // final committed string and the whole composed word is diffed and
    // tagged as one atomic insertion, same as a paste.
    if (editor.isComposing()) return;

    // Undo/redo (and any other "historic" update, e.g. the history plugin's
    // own coalesced restores) swaps in an old EditorState wholesale rather
    // than applying an incremental edit. The reconciler then marks the
    // restored TextNodes dirty — often under brand-new node keys the
    // `prevTextCache` has never seen — so without this guard the diff below
    // would read `prevText` as `""` and misread the entire restored text as
    // a fresh insertion, wrapping it in a spurious new suggestion span
    // every time the user hits Cmd+Z. Treat a historic update as "resync
    // the baseline, don't diff it" instead: whatever the document looks
    // like after undo/redo, accept it as the new starting point for future
    // real edits (which is also what ProseMirror-style history/plugin-state
    // coupling gets for free, and this doesn't).
    if ($hasUpdateTag(HISTORIC_TAG)) {
      prevTextCache.set(node.getKey(), node.getTextContent());
      return;
    }

    // Already inside a pending suggestion span — possibly nested several
    // MarkNodes deep, e.g. a comment placed on top of (or inside) an
    // unresolved suggestion insert/delete — let edits here pass through for
    // real (see docstring above) instead of double-wrapping them in another
    // suggestion span. Walking through the whole contiguous MarkNode
    // ancestor chain (not just the immediate parent) matters because
    // comments and suggestions freely nest in either order: a comment can
    // be added on selected text that's still a pending suggestion, and a
    // suggestion-mode edit can land inside already-commented text (see
    // `$wrapSelectionInMarkNode`'s nesting behavior in `plugin.ts`).
    let ancestor: LexicalNode | null = node.getParent();
    let insidePendingSuggestion = false;
    while ($isMarkNode(ancestor)) {
      if (ancestor.getIDs().some((id) => isSuggestionInsertMarkId(id) || isSuggestionDeleteMarkId(id))) {
        insidePendingSuggestion = true;
        break;
      }
      ancestor = ancestor.getParent();
    }
    if (insidePendingSuggestion) {
      prevTextCache.set(node.getKey(), node.getTextContent());
      return;
    }

    const key = node.getKey();
    // A key with no cache entry is a text node this controller has never
    // diffed before. That's either a brand-new node (baseline "" — its
    // whole content is an insertion, correctly) or a pre-existing node from
    // before suggesting mode was turned on; `setSuggesting` pre-populates
    // the cache for every node current at that moment specifically so the
    // second case doesn't fall into this branch and get misread as the
    // first — see its own comment.
    const prevText = prevTextCache.get(key) ?? "";
    const newText = node.getTextContent();
    if (prevText === newText) return;

    let prefixLen = 0;
    const minLen = Math.min(prevText.length, newText.length);
    while (prefixLen < minLen && prevText[prefixLen] === newText[prefixLen]) prefixLen++;
    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      prevText[prevText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }
    const deletedText = prevText.slice(prefixLen, prevText.length - suffixLen);
    const insertedText = newText.slice(prefixLen, newText.length - suffixLen);
    if (!deletedText && !insertedText) {
      prevTextCache.set(key, newText);
      return;
    }

    const isBackward = insertedText.length === 0; // pure deletion

    const suggestionId = newSuggestionId();
    const boundary = newText.length - suffixLen;
    const offsets = Array.from(new Set([prefixLen, boundary]))
      .filter((o) => o > 0 && o < newText.length)
      .sort((a, b) => a - b);
    const parts = offsets.length ? node.splitText(...offsets) : [node];

    let cursor = 0;
    let prefixPart: TextNode | null = null;
    let insertPart: TextNode | null = null;
    let suffixPart: TextNode | null = null;
    for (const part of parts) {
      const len = part.getTextContentSize();
      if (cursor === 0 && prefixLen > 0) {
        prefixPart = part;
      } else if (cursor === prefixLen && insertedText.length > 0) {
        insertPart = part;
      } else {
        suffixPart = part;
      }
      cursor += len;
    }
    for (const part of parts) prevTextCache.set(part.getKey(), part.getTextContent());

    let insertMarkNode: MarkNode | null = null;
    // Typing continues a pending insertion: a keystroke landing right after
    // (or before) an insert-suggestion joins it instead of starting its own.
    const adjacentInsert = insertPart && !deletedText ? adjacentSuggestionMark(insertPart, isSuggestionInsertMarkId) : null;
    if (insertPart && adjacentInsert) {
      if (adjacentInsert.side === "before") adjacentInsert.mark.append(insertPart);
      else adjacentInsert.mark.splice(0, 0, [insertPart]);
      insertMarkNode = adjacentInsert.mark;
    } else if (insertPart) {
      const insertId = suggestionInsertMarkId(suggestionId);
      insertMarkNode = $createMarkNode([insertId]);
      insertPart.replace(insertMarkNode);
      insertMarkNode.append(insertPart);
      indexAdd(insertId, insertMarkNode.getKey());
    }

    // Repeated Backspace (or Delete) continues a pending deletion the same way.
    const deleteNeighbor =
      deletedText && isBackward && !suffixPart && prefixPart
        ? prefixPart.getNextSibling()
        : deletedText && isBackward && !prefixPart && suffixPart
          ? suffixPart.getPreviousSibling()
          : null;
    const continuedDelete =
      $isMarkNode(deleteNeighbor) && deleteNeighbor.getIDs().length === 1 && isSuggestionDeleteMarkId(deleteNeighbor.getIDs()[0])
        ? deleteNeighbor
        : null;

    if (deletedText && continuedDelete) {
      const deleteTextNode = $createTextNode(deletedText);
      if (prefixPart) continuedDelete.splice(0, 0, [deleteTextNode]);
      else continuedDelete.append(deleteTextNode);
      prevTextCache.set(deleteTextNode.getKey(), deletedText);
      if (prefixPart) {
        const selection = $createRangeSelection();
        selection.anchor.set(prefixPart.getKey(), prefixPart.getTextContentSize(), "text");
        selection.focus.set(prefixPart.getKey(), prefixPart.getTextContentSize(), "text");
        $setSelection(selection);
      }
    } else if (deletedText) {
      const deleteId = suggestionDeleteMarkId(suggestionId);
      const deleteMark = $createMarkNode([deleteId]);
      const deleteTextNode = $createTextNode(deletedText);
      deleteMark.append(deleteTextNode);
      indexAdd(deleteId, deleteMark.getKey());
      if (suffixPart) {
        suffixPart.insertBefore(deleteMark);
      } else if (insertMarkNode) {
        insertMarkNode.insertAfter(deleteMark);
      } else if (prefixPart) {
        prefixPart.insertAfter(deleteMark);
      } else {
        parts[0].insertAfter(deleteMark);
      }
      prevTextCache.set(deleteTextNode.getKey(), deletedText);

      if (isBackward) {
        // Backspace: put the caret back before the (visually struck-through,
        // but still-in-the-tree) deleted span, so the next Backspace keeps
        // walking left into real, untouched content instead of sitting still.
        const anchorNode = prefixPart ?? deleteTextNode;
        const anchorOffset = prefixPart ? prefixPart.getTextContentSize() : 0;
        const selection = $createRangeSelection();
        selection.anchor.set(anchorNode.getKey(), anchorOffset, "text");
        selection.focus.set(anchorNode.getKey(), anchorOffset, "text");
        $setSelection(selection);
      }
      // Forward Delete needs no override: Lexical's own post-edit selection
      // already sits after the insertion point, i.e. right where the caret
      // should land once the struck-through phantom is spliced in after it.
    }
  });

  function resolve(suggestionId: string, action: "accept" | "reject") {
    const insertId = suggestionInsertMarkId(suggestionId);
    const deleteId = suggestionDeleteMarkId(suggestionId);
    isResolving = true;
    editor.update(
      () => {
        const toUnwrap: MarkNode[] = [];
        const toRemove: MarkNode[] = [];
        const collect = (id: string, target: MarkNode[]) => {
          const keys = idIndex.get(id);
          if (!keys) return;
          for (const key of keys) {
            const node = $getNodeByKey(key);
            if ($isMarkNode(node)) target.push(node);
          }
        };
        collect(insertId, action === "accept" ? toUnwrap : toRemove);
        collect(deleteId, action === "accept" ? toRemove : toUnwrap);
        // A suggestionId is always resolved (accepted/rejected) as a whole,
        // atomically, right here — so once this update runs, no mark
        // carrying either id can exist anymore, whether or not it was
        // still in the index (e.g. never actually reached, see below).
        // Clearing eagerly also means a caller that mistakenly resolves an
        // already-resolved id a second time is a cheap no-op, not a stale
        // lookup.
        idIndex.delete(insertId);
        idIndex.delete(deleteId);

        const affectedParents = new Set<ElementNode>();
        for (const node of toRemove) {
          const parent = node.getParent();
          if (parent) affectedParents.add(parent);
          node.remove();
        }
        for (const node of toUnwrap) {
          const parent = node.getParent();
          if (parent) affectedParents.add(parent);
          $unwrapMarkNode(node);
        }
        for (const parent of affectedParents) coalesceAdjacentTextNodes(parent);
      },
      // `discrete: true` so a caller reading editor state right after
      // accept/reject returns (as the example UI and the smoke tests both
      // do) sees the resolved document, not a state still pending in a
      // microtask.
      { discrete: true, onUpdate: () => (isResolving = false) }
    );
  }

  return {
    isSuggesting() {
      return active != null;
    },
    setSuggesting(authorId) {
      const turningOn = authorId != null && active == null;
      active = authorId ? { authorId } : null;
      if (turningOn) {
        // Prime the diff baseline with every text node's *current* content
        // so the first real edit after turning suggesting on diffs against
        // "what's actually in the document now", not against "" (which
        // would misread all of it as one giant insertion the moment
        // anything in that node changes) — see the node-transform's
        // "unseen key" comment above for why this pairing matters.
        editor.getEditorState().read(() => {
          walkNode($getRoot(), (node) => {
            if ($isTextNode(node)) prevTextCache.set(node.getKey(), node.getTextContent());
          });
        });
      }
    },
    acceptSuggestion(suggestionId) {
      resolve(suggestionId, "accept");
    },
    rejectSuggestion(suggestionId) {
      resolve(suggestionId, "reject");
    },
    destroy() {
      unregisterTransform();
    },
  };
}
