import { $createParagraphNode, $createTextNode, $parseSerializedNode, type ElementNode, type LexicalNode } from "lexical";
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import { $createListNode, $createListItemNode, type ListType } from "@lexical/list";
import { $createHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $createImageNode } from "../nodes/ImageNode";
import { $createVideoNode } from "../nodes/VideoNode";
import { $createNoticeNode, type NoticeKind } from "../nodes/NoticeNode";
import type { TextRun } from "./blockSpec";

/**
 * Rebuilds an element's inline children from `text` + `runs`. If the runs'
 * combined length doesn't match `text` (meaning a concurrent plain-text
 * edit changed the merged `LoroText` content since this `runs` snapshot was
 * taken — see `blockSpec.ts`'s docstring), falls back to one plain
 * unformatted text node rather than misaligning formatting onto the wrong
 * characters. Safe degradation, not a crash; formatting recovers on the
 * next edit that re-syncs consistent runs.
 */
export function applyTextRuns(element: ElementNode, text: string, runs: TextRun[] | undefined): void {
  element.clear();
  if (!runs || runs.reduce((sum, r) => sum + r.text.length, 0) !== text.length) {
    if (text) element.append($createTextNode(text));
    return;
  }
  for (const run of runs) {
    if (!run.text) continue;
    const textNode = $createTextNode(run.text);
    for (const format of run.formats) textNode.toggleFormat(format);
    element.append(textNode);
  }
}

/** Creates a fresh Lexical node of `type` (content/formatting filled in by the caller afterward). */
export function createLexicalNodeForType(type: string, attrs: Record<string, unknown>): LexicalNode {
  switch (type) {
    case "paragraph":
      return $createParagraphNode();
    case "heading":
      return $createHeadingNode((attrs.tag as HeadingTagType) ?? "h1");
    case "quote":
      return $createQuoteNode();
    case "code":
      return $createCodeNode((attrs.language as string) || undefined);
    case "list":
      return $createListNode((attrs.listType as ListType) ?? "bullet", (attrs.start as number) ?? 1);
    case "listitem":
      return $createListItemNode((attrs.checked as boolean | null) ?? undefined);
    case "image":
      return $createImageNode({
        src: attrs.src as string,
        alt: attrs.alt as string | undefined,
        title: attrs.title as string | null | undefined,
        width: attrs.width as number | null | undefined,
      });
    case "video":
      return $createVideoNode({ src: attrs.src as string, title: attrs.title as string | null | undefined });
    case "notice":
      return $createNoticeNode((attrs.kind as NoticeKind) ?? "info");
    case "hr":
      return $createHorizontalRuleNode();
    case "table": {
      // Opaque whole-node snapshot (see blockSpec.ts) — `$parseSerializedNode`
      // dispatches to TableNode's own `importJSON` via the node registry,
      // so this doesn't need any table-specific rebuild logic here.
      const node = $parseSerializedNode(attrs.snapshot as Parameters<typeof $parseSerializedNode>[0]);
      return node;
    }
    default:
      // Unknown type: represented as an empty paragraph placeholder so the
      // document stays structurally valid rather than crashing.
      return $createParagraphNode();
  }
}
