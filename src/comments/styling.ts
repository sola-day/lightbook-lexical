import { $getNodeByKey, type LexicalEditor } from "lexical";
import { $isMarkNode, MarkNode } from "@lexical/mark";
import { isCommentMarkId, isSuggestionInsertMarkId, isSuggestionDeleteMarkId } from "./ids";

/**
 * `MarkNode.createDOM` only ever applies `theme.mark`/`theme.markOverlap` —
 * it has no idea some of its ids mean "comment" and others mean "suggested
 * insert/delete" (see `ids.ts`). A mutation listener is the standard
 * Lexical pattern for driving extra DOM state off node data without a
 * custom node subclass (this is the same approach Lexical's own playground
 * comments plugin uses): every time a MarkNode's DOM is created or
 * updated, re-derive its semantic classes from its current id list.
 */
export function registerMarkStyling(editor: LexicalEditor): () => void {
  const applyToKey = (key: string) => {
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(key);
      if (!node || !$isMarkNode(node)) return;
      const el = editor.getElementByKey(key);
      if (!el) return;
      applyClasses(el, (node as MarkNode).getIDs());
    });
  };

  return editor.registerMutationListener(MarkNode, (mutations) => {
    for (const [key, mutation] of mutations) {
      if (mutation === "destroyed") continue;
      applyToKey(key);
    }
  });
}

function applyClasses(el: HTMLElement, ids: readonly string[]) {
  const hasComment = ids.some(isCommentMarkId);
  const hasInsert = ids.some(isSuggestionInsertMarkId);
  const hasDelete = ids.some(isSuggestionDeleteMarkId);
  el.classList.toggle("lb-comment-range", hasComment);
  el.classList.toggle("lb-suggestion-insert", hasInsert);
  el.classList.toggle("lb-suggestion-delete-visual", hasDelete);
}
