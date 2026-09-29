import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $parseSerializedNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";
import { $createLinkNode, type LinkNode } from "@lexical/link";
import { $createMarkNode, type MarkNode } from "@lexical/mark";
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
  // Consecutive runs sharing a link share one LinkNode, and within it,
  // consecutive runs sharing the same mark ids share one MarkNode.
  let link = null as { url: string; node: LinkNode } | null;
  let mark = null as { key: string; node: MarkNode; parent: ElementNode } | null;

  for (const run of runs) {
    if (!run.text) continue;
    const leaf = run.br ? $createLineBreakNode() : run.image ? $createImageNode(run.image) : $createTextNode(run.text);
    if (!run.br && !run.image) for (const format of run.formats) (leaf as ReturnType<typeof $createTextNode>).toggleFormat(format);

    if (run.link !== link?.url) {
      link = run.link ? { url: run.link, node: $createLinkNode(run.link) } : null;
      if (link) element.append(link.node);
      mark = null;
    }
    const container: ElementNode = link?.node ?? element;

    const markKey = run.marks?.length ? run.marks.join("\u0000") : "";
    if (!markKey) {
      mark = null;
      container.append(leaf);
      continue;
    }
    if (mark?.key !== markKey || mark.parent !== container) {
      mark = { key: markKey, node: $createMarkNode(run.marks!), parent: container };
      container.append(mark.node);
    }
    mark.node.append(leaf);
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
    case "image": {
      // Legacy top-level image block: images are inline, so it lives in a
      // paragraph (which the next local edit writes back in the new shape).
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createImageNode({
          src: attrs.src as string,
          alt: attrs.alt as string | undefined,
          title: attrs.title as string | null | undefined,
          width: attrs.width as number | null | undefined,
        })
      );
      return paragraph;
    }
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
