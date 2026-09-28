import {
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type TextFormatType,
} from "lexical";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { $isCodeNode } from "@lexical/code";
import { $isTableNode } from "@lexical/table";
import { $isImageNode } from "../nodes/ImageNode";
import { $isVideoNode } from "../nodes/VideoNode";
import { $isNoticeNode } from "../nodes/NoticeNode";

/** One inline formatted run, used to reconstruct a text-bearing block's formatting from a snapshot. */
export interface TextRun {
  text: string;
  formats: TextFormatType[];
}

/**
 * A block's content, decomposed into the three things the Loro binding
 * syncs separately (see `src/collab/binding.ts`'s module docstring for why):
 * `text` (the plain string, synced character-by-character via `LoroText`),
 * `runs` (a redundant formatting snapshot, synced as a plain non-merging
 * value — concurrent formatting edits on the same block can overwrite each
 * other, by design), and `children` (nested blocks, for container types).
 */
export interface BlockSpec {
  type: string;
  attrs: Record<string, unknown>;
  text?: string;
  runs?: TextRun[];
  children?: LexicalNode[];
}

const TRACKED_FORMATS: TextFormatType[] = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "subscript",
  "superscript",
  "highlight",
];

function textRunsOf(element: ElementNode): { text: string; runs: TextRun[] } {
  const runs: TextRun[] = [];
  let text = "";
  for (const child of element.getChildren()) {
    if ($isTextNode(child)) {
      const formats = TRACKED_FORMATS.filter((f) => child.hasFormat(f));
      runs.push({ text: child.getTextContent(), formats });
      text += child.getTextContent();
    }
  }
  return { text, runs };
}

/**
 * Decomposes one Lexical node into the shape the Loro binding writes.
 * Returns `null` for node types the binding doesn't sync (falls back to
 * "leave it out of the synced doc" rather than crashing on an unknown
 * type) — currently only `LineBreakNode`/other pure-inline nodes reach a
 * top-level block position, which shouldn't normally happen.
 */
export function lexicalNodeToBlockSpec(node: LexicalNode): BlockSpec | null {
  if ($isParagraphNode(node)) {
    const { text, runs } = textRunsOf(node);
    return { type: "paragraph", attrs: {}, text, runs };
  }
  if ($isHeadingNode(node)) {
    const { text, runs } = textRunsOf(node);
    return { type: "heading", attrs: { tag: node.getTag() }, text, runs };
  }
  if ($isQuoteNode(node)) {
    // Flattened: a multi-paragraph blockquote collapses to one text block
    // under sync (matches this package's documented "simple tier" scope).
    const { text, runs } = textRunsOf(node);
    return { type: "quote", attrs: {}, text, runs };
  }
  if ($isCodeNode(node)) {
    return { type: "code", attrs: { language: node.getLanguage() ?? "" }, text: node.getTextContent() };
  }
  if ($isListNode(node)) {
    return {
      type: "list",
      attrs: { listType: node.getListType(), start: node.getStart() },
      children: node.getChildren(),
    };
  }
  if ($isListItemNode(node)) {
    const nestedList = node.getChildren().find((c) => $isListNode(c));
    const inlineChildren = node.getChildren().filter((c) => !$isListNode(c));
    let text = "";
    const runs: TextRun[] = [];
    for (const child of inlineChildren) {
      if ($isTextNode(child)) {
        const formats = TRACKED_FORMATS.filter((f) => child.hasFormat(f));
        runs.push({ text: child.getTextContent(), formats });
        text += child.getTextContent();
      }
    }
    return {
      type: "listitem",
      attrs: { checked: node.getChecked() ?? null },
      text,
      runs,
      children: nestedList ? [nestedList] : undefined,
    };
  }
  if ($isImageNode(node)) {
    return { type: "image", attrs: { src: node.__src, alt: node.__alt, title: node.__title, width: node.__width } };
  }
  if ($isVideoNode(node)) {
    return { type: "video", attrs: { src: node.__src, title: node.__title } };
  }
  if ($isNoticeNode(node)) {
    return { type: "notice", attrs: { kind: node.getKind() }, children: node.getChildren() };
  }
  if ($isTableNode(node)) {
    // Opaque: synced as a whole-node JSON snapshot, not merged cell-by-cell
    // (same "simple tier" trade as blockquote flattening above).
    return { type: "table", attrs: { snapshot: node.exportJSON() } };
  }
  if (node.getType() === "horizontalrule") {
    return { type: "hr", attrs: {} };
  }
  if ($isElementNode(node)) {
    // Unknown element type: sync it as an opaque flattened text block so
    // content is never silently dropped, rather than crashing.
    return { type: "paragraph", attrs: {}, text: node.getTextContent(), runs: [{ text: node.getTextContent(), formats: [] }] };
  }
  return null;
}
