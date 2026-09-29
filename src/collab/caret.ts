import { $isElementNode, $isTextNode, type ElementNode, type LexicalNode, type TextNode } from "lexical";
import { inlineSize } from "./blockSpec";

/**
 * Positions inside a text-bearing block as one flattened character offset,
 * in the units of the block's synced text (`blockSpec.ts`): text and line
 * breaks count their characters, an inline image counts one, and marks and
 * links are looked through. Shared by undo/redo caret restore and presence.
 */

const TEXT_BEARING_TYPES = new Set(["paragraph", "heading", "quote", "code", "listitem"]);

/** The nearest text-bearing block at or above `node`. */
export function $textBlockOf(node: LexicalNode): ElementNode | null {
  let current: LexicalNode | null = node;
  while (current && !($isElementNode(current) && TEXT_BEARING_TYPES.has(current.getType()))) current = current.getParent();
  return current as ElementNode | null;
}

/** The block's inline leaves (text, line breaks, images...) in order, looking through marks and links but not nested blocks. */
export function $inlineLeaves(block: ElementNode): LexicalNode[] {
  const out: LexicalNode[] = [];
  const walk = (parent: ElementNode) => {
    for (const child of parent.getChildren()) {
      if ($isElementNode(child)) {
        if (child.isInline()) walk(child);
      } else {
        out.push(child);
      }
    }
  };
  walk(block);
  return out;
}

/** Flattens a Lexical point (`node` + `offset`, as in a selection point) to its block and flat offset. */
export function $flattenPoint(node: LexicalNode, offset: number): { block: ElementNode; offset: number } | null {
  let leafNode = node;
  let leafOffset = offset;
  if ($isElementNode(node)) {
    const child = node.getChildAtIndex(offset) ?? node.getLastChild();
    const atEnd = offset >= node.getChildrenSize();
    if (!child) {
      const block = $textBlockOf(node);
      return block ? { block, offset: 0 } : null;
    }
    const leaf: LexicalNode | null = $isElementNode(child) ? (atEnd ? child.getLastDescendant() : child.getFirstDescendant()) : child;
    if (!leaf) return null;
    leafNode = leaf;
    leafOffset = atEnd ? inlineSize(leaf) : 0;
  }
  const block = $textBlockOf(leafNode);
  if (!block) return null;
  let flat = 0;
  for (const leaf of $inlineLeaves(block)) {
    if (leaf.is(leafNode)) return { block, offset: flat + leafOffset };
    flat += inlineSize(leaf);
  }
  return { block, offset: flat };
}

/** The text node and offset in it where flat `offset` falls (clamped); null when the block has no text node. */
export function $locateFlatOffset(block: ElementNode, offset: number): { node: TextNode; offset: number } | null {
  let remaining = Math.max(0, offset);
  let lastText: TextNode | null = null;
  for (const leaf of $inlineLeaves(block)) {
    const size = inlineSize(leaf);
    if ($isTextNode(leaf)) {
      if (remaining <= size) return { node: leaf, offset: remaining };
      lastText = leaf;
    }
    remaining -= size;
  }
  return lastText ? { node: lastText, offset: lastText.getTextContentSize() } : null;
}
