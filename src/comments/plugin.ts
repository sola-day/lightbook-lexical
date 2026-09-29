import type { LexicalEditor, LexicalNode } from "lexical";
import { $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { $wrapSelectionInMarkNode, $unwrapMarkNode, $isMarkNode, MarkNode } from "@lexical/mark";
import {
  SKIP_UNDO_TAG,
  commentMarkId,
  isCommentMarkId,
  isSuggestionInsertMarkId,
  suggestionIdFromMarkId,
  threadIdFromMarkId,
} from "./ids";

export interface AddCommentOptions {
  threadId: string;
}

export interface ThreadRange {
  threadId: string;
  /** First ~120 chars of the anchored text, for a thread-list preview. */
  text: string;
}

function walk(node: LexicalNode, visit: (node: LexicalNode) => void) {
  visit(node);
  if ("getChildren" in node && typeof (node as any).getChildren === "function") {
    for (const child of (node as any).getChildren() as LexicalNode[]) {
      walk(child, visit);
    }
  }
}

/**
 * Wraps the current selection in a comment mark. Selection must be
 * non-collapsed. `{discrete: true}` forces this update (and its
 * reconciliation) to commit synchronously — without it, `editor.update()`
 * schedules its reconciliation as a microtask, so a caller that (correctly)
 * expects `listThreads(editor)` to already reflect a comment it just added
 * would read stale state until the next microtask tick.
 */
export function addComment(editor: LexicalEditor, { threadId }: AddCommentOptions): boolean {
  let applied = false;
  editor.update(
    () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
      $wrapSelectionInMarkNode(selection, selection.isBackward(), commentMarkId(threadId));
      applied = true;
    },
    { discrete: true, tag: SKIP_UNDO_TAG }
  );
  return applied;
}

/** Removes a comment thread's mark id from every span it covers, unwrapping empty MarkNodes. */
export function removeComment(editor: LexicalEditor, threadId: string): boolean {
  let removed = false;
  const id = commentMarkId(threadId);
  editor.update(
    () => {
      walk($getRoot(), (node) => {
        if (!$isMarkNode(node)) return;
        if (!node.hasID(id)) return;
        removed = true;
        const next = node.deleteID(id);
        if ((next as MarkNode).getIDs().length === 0) {
          $unwrapMarkNode(next as MarkNode);
        }
      });
    },
    { discrete: true, tag: SKIP_UNDO_TAG }
  );
  return removed;
}

/** Lists every distinct comment thread currently anchored in the document, with a text preview. */
export function listThreads(editor: LexicalEditor): Map<string, ThreadRange> {
  const threads = new Map<string, ThreadRange>();
  editor.getEditorState().read(() => {
    walk($getRoot(), (node) => {
      if (!$isMarkNode(node)) return;
      for (const id of node.getIDs()) {
        if (!isCommentMarkId(id)) continue;
        const threadId = threadIdFromMarkId(id)!;
        const text = node.getTextContent();
        const existing = threads.get(threadId);
        threads.set(threadId, { threadId, text: existing ? existing.text + text : text });
      }
    });
  });
  return threads;
}

/**
 * Toggles the `lb-comment-range--active` class on every DOM element backing
 * a MarkNode that carries `threadId`'s mark id (a thread's anchor can be
 * split across several MarkNode instances, e.g. across paragraphs).
 */
export function setActiveThread(editor: LexicalEditor, threadId: string | null): void {
  editor.getEditorState().read(() => {
    walk($getRoot(), (node) => {
      if (!$isMarkNode(node)) return;
      const el = editor.getElementByKey(node.getKey());
      if (!el) return;
      const active = threadId != null && node.hasID(commentMarkId(threadId));
      el.classList.toggle("lb-comment-range--active", active);
    });
  });
}

export interface SuggestionRange {
  suggestionId: string;
  /** Text proposed for insertion (empty for a pure deletion). */
  inserted: string;
  /** Text proposed for deletion (empty for a pure insertion). */
  deleted: string;
}

/** Lists every pending suggestion in the document, in document order. */
export function listSuggestions(editor: LexicalEditor): Map<string, SuggestionRange> {
  const suggestions = new Map<string, SuggestionRange>();
  editor.getEditorState().read(() => {
    walk($getRoot(), (node) => {
      if (!$isMarkNode(node)) return;
      for (const id of node.getIDs()) {
        const suggestionId = suggestionIdFromMarkId(id);
        if (!suggestionId) continue;
        const entry = suggestions.get(suggestionId) ?? { suggestionId, inserted: "", deleted: "" };
        if (isSuggestionInsertMarkId(id)) entry.inserted += node.getTextContent();
        else entry.deleted += node.getTextContent();
        suggestions.set(suggestionId, entry);
      }
    });
  });
  return suggestions;
}
