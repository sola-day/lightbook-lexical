import {
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type SerializedLexicalNode,
  type TextFormatType,
} from "lexical";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { $isLinkNode } from "@lexical/link";
import { $isMarkNode } from "@lexical/mark";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { $isCodeNode } from "@lexical/code";
import { $isTableNode } from "@lexical/table";
import { $isImageNode } from "../nodes/ImageNode";
import { $isVideoNode } from "../nodes/VideoNode";
import { $isNoticeNode } from "../nodes/NoticeNode";

/**
 * One inline formatted run, used to reconstruct a text-bearing block's
 * inline structure from a snapshot. Inline element wrappers are flattened
 * onto the runs they contain: `marks` are the enclosing `MarkNode` ids
 * (comment threads and suggestions, see `src/comments/ids.ts`), `link` the
 * enclosing link's URL, and `br` marks a `LineBreakNode` (its text is "\n").
 */
export interface TextRun {
  text: string;
  formats: TextFormatType[];
  marks?: string[];
  link?: string;
  br?: true;
  /** An inline image; its `text` is the single character `IMAGE_CHAR`. */
  image?: InlineImage;
}

export interface InlineImage {
  src: string;
  alt?: string;
  title?: string | null;
  width?: number | null;
}

/** U+FFFC OBJECT REPLACEMENT CHARACTER: an inline image's one character in a block's synced text. */
export const IMAGE_CHAR = "\uFFFC";

/** A leaf's length in the synced text: text and line breaks count their characters, an inline image counts as `IMAGE_CHAR`. */
export function inlineSize(node: LexicalNode): number {
  return $isImageNode(node) ? 1 : node.getTextContentSize();
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

interface InlineContext {
  marks: string[];
  link?: string;
}

function collectRuns(children: LexicalNode[], ctx: InlineContext, runs: TextRun[]): void {
  for (const child of children) {
    if ($isTextNode(child)) {
      const run: TextRun = { text: child.getTextContent(), formats: TRACKED_FORMATS.filter((f) => child.hasFormat(f)) };
      if (ctx.marks.length) run.marks = [...ctx.marks];
      if (ctx.link) run.link = ctx.link;
      runs.push(run);
    } else if ($isLineBreakNode(child)) {
      const run: TextRun = { text: "\n", formats: [], br: true };
      if (ctx.marks.length) run.marks = [...ctx.marks];
      runs.push(run);
    } else if ($isImageNode(child)) {
      const run: TextRun = {
        text: IMAGE_CHAR,
        formats: [],
        image: { src: child.__src, alt: child.__alt, title: child.__title, width: child.__width },
      };
      if (ctx.marks.length) run.marks = [...ctx.marks];
      if (ctx.link) run.link = ctx.link;
      runs.push(run);
    } else if ($isMarkNode(child)) {
      collectRuns(child.getChildren(), { ...ctx, marks: [...ctx.marks, ...child.getIDs()] }, runs);
    } else if ($isLinkNode(child)) {
      collectRuns(child.getChildren(), { ...ctx, link: child.getURL() }, runs);
    } else if ($isElementNode(child) && child.isInline()) {
      collectRuns(child.getChildren(), ctx, runs);
    }
  }
}

/** Flattens a block's inline content (text, line breaks, and text inside marks/links) into `text` + `runs`. */
function inlineRunsOf(children: LexicalNode[]): { text: string; runs: TextRun[] } {
  const runs: TextRun[] = [];
  collectRuns(children, { marks: [] }, runs);
  return { text: runs.map((r) => r.text).join(""), runs };
}

function textRunsOf(element: ElementNode): { text: string; runs: TextRun[] } {
  return inlineRunsOf(element.getChildren());
}

/** `exportJSON()` leaves `children` empty (the editor-state serializer fills them in); this fills them in too. */
function exportDeep(node: LexicalNode): SerializedLexicalNode {
  const json = node.exportJSON() as SerializedLexicalNode & { children?: SerializedLexicalNode[] };
  if ($isElementNode(node)) json.children = node.getChildren().map(exportDeep);
  return json;
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
    const { text, runs } = inlineRunsOf(node.getChildren().filter((c) => !$isListNode(c)));
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
    return { type: "table", attrs: { snapshot: exportDeep(node) } };
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
