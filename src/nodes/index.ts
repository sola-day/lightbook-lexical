import type { Klass, LexicalNode } from "lexical";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import { TableNode, TableCellNode, TableRowNode } from "@lexical/table";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { MarkNode } from "@lexical/mark";
import { ImageNode } from "./ImageNode";
import { VideoNode } from "./VideoNode";
import { NoticeNode } from "./NoticeNode";

export { ImageNode, $createImageNode, $isImageNode } from "./ImageNode";
export { VideoNode, $createVideoNode, $isVideoNode } from "./VideoNode";
export { NoticeNode, $createNoticeNode, $isNoticeNode } from "./NoticeNode";
export type { NoticeKind } from "./NoticeNode";

/**
 * Node registry mirroring lightbook-prosemirror's schema: headings, lists
 * (bullet/ordered/checkbox — `@lexical/list`'s `ListNode` handles all three
 * via its `listType`), tables, code blocks, blockquotes, links, images,
 * video, notices, and `MarkNode` (comments + suggestion mode both reuse
 * this single node — see `src/comments/`).
 */
export const LIGHTBOOK_NODES: Array<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  AutoLinkNode,
  TableNode,
  TableCellNode,
  TableRowNode,
  HorizontalRuleNode,
  MarkNode,
  ImageNode,
  VideoNode,
  NoticeNode,
];
