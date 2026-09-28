import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  TextNode,
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
  return `sg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
export function createSuggestionController(editor: LexicalEditor): SuggestionController {
  let active: SuggestingActive | null = null;
  let isResolving = false; // true while accept/reject's own editor.update runs
  const prevTextCache = new Map<NodeKey, string>();

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

    const parent = node.getParent();
    if (
      $isMarkNode(parent) &&
      parent.getIDs().some((id) => isSuggestionInsertMarkId(id) || isSuggestionDeleteMarkId(id))
    ) {
      // Already inside a pending suggestion span: let edits here pass
      // through for real (see docstring above) — just keep the cache
      // current so a later edit elsewhere doesn't see a stale diff base.
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
    if (insertPart) {
      insertMarkNode = $createMarkNode([suggestionInsertMarkId(suggestionId)]);
      insertPart.replace(insertMarkNode);
      insertMarkNode.append(insertPart);
    }

    if (deletedText) {
      const deleteMark = $createMarkNode([suggestionDeleteMarkId(suggestionId)]);
      const deleteTextNode = $createTextNode(deletedText);
      deleteMark.append(deleteTextNode);
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
        walkNode($getRoot(), (node) => {
          if (!$isMarkNode(node)) return;
          if (node.hasID(insertId)) {
            (action === "accept" ? toUnwrap : toRemove).push(node);
          } else if (node.hasID(deleteId)) {
            (action === "accept" ? toRemove : toUnwrap).push(node);
          }
        });
        for (const node of toRemove) node.remove();
        for (const node of toUnwrap) $unwrapMarkNode(node);
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
