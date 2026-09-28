import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  CODE,
  ELEMENT_TRANSFORMERS,
  HIGHLIGHT,
  INLINE_CODE,
  LINK,
  STRIKETHROUGH,
  BOLD_STAR,
  ITALIC_STAR,
  type ElementTransformer,
  type TextFormatTransformer,
  type Transformer,
} from "@lexical/markdown";
import { $createParagraphNode, $createTextNode, type ElementNode, type LexicalNode } from "lexical";
import {
  $isTableNode,
  $isTableRowNode,
  $isTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableCellNode,
  TableCellHeaderStates,
  TableNode,
  TableRowNode,
  TableCellNode,
} from "@lexical/table";
import { $createImageNode, $isImageNode, ImageNode } from "./nodes/ImageNode";
import { $createVideoNode, $isVideoNode, VideoNode } from "./nodes/VideoNode";
import { $createNoticeNode, $isNoticeNode, NoticeNode, type NoticeKind } from "./nodes/NoticeNode";

/**
 * Underline/subscript/superscript have no CommonMark syntax; these three
 * (Pandoc-style) delimiters give them real, symmetric, round-trippable
 * markdown instead of the HTML-tag/import-lossy approach
 * lightbook-prosemirror used — Lexical's `TextFormatTransformer` only
 * supports one symmetric delimiter per format, which happens to make this
 * the *simpler* correct choice here, not just a nicer one.
 */
const UNDERLINE: TextFormatTransformer = { format: ["underline"], tag: "++", type: "text-format" };
const SUBSCRIPT: TextFormatTransformer = { format: ["subscript"], tag: "~", type: "text-format" };
const SUPERSCRIPT: TextFormatTransformer = { format: ["superscript"], tag: "^", type: "text-format" };

/** Outline-style callout, encoded as a GFM-alert-flavored blockquote: `> [!info] text`. */
const NOTICE: ElementTransformer = {
  dependencies: [NoticeNode],
  export: (node, traverseChildren) => {
    if (!$isNoticeNode(node)) return null;
    const kind = node.getKind();
    const lines = traverseChildren(node).split("\n");
    return lines.map((line, i) => (i === 0 ? `> [!${kind}] ${line}` : `> ${line}`)).join("\n");
  },
  regExp: /^>\s\[!(info|warning|tip)\]\s?/,
  replace: (parentNode, children) => {
    const match = /^>\s\[!(info|warning|tip)\]\s?/.exec(parentNode.getTextContent());
    const kind = (match?.[1] as NoticeKind) ?? "info";
    const notice = $createNoticeNode(kind);
    const paragraph = $createParagraphNode();
    paragraph.append(...children);
    notice.append(paragraph);
    parentNode.replace(notice);
    notice.selectEnd();
  },
  type: "element",
};

const IMAGE: ElementTransformer = {
  dependencies: [ImageNode],
  export: (node) => {
    if (!$isImageNode(node)) return null;
    return `![${node.__alt ?? ""}](${node.getSrc()})`;
  },
  regExp: /!\[([^[]*)\]\(([^()\s]+)\)\s?$/,
  replace: (parentNode, _children, match) => {
    const [, alt, src] = match;
    parentNode.replace($createImageNode({ src, alt }));
  },
  type: "element",
};

const VIDEO: ElementTransformer = {
  dependencies: [VideoNode],
  export: (node) => {
    if (!$isVideoNode(node)) return null;
    return `[video](${node.__src})`;
  },
  regExp: /^\[video\]\(([^()\s]+)\)\s?$/,
  replace: (parentNode, _children, match) => {
    const [, src] = match;
    parentNode.replace($createVideoNode({ src }));
  },
  type: "element",
};

const TABLE_ROW_REGEXP = /^\|.*\|\s*$/;
const TABLE_DIVIDER_REGEXP = /^\|(?:\s*:?-+:?\s*\|)+\s*$/;

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * GFM table support, hand-written like lightbook-prosemirror's: no built-in
 * table transformer ships in `@lexical/markdown`. A table spans multiple
 * lines (header + divider + rows), which `ElementTransformer`'s one-line
 * `regExp` can't parse on its own, so tables are pulled out of the markdown
 * text *before* `$convertFromMarkdownString` sees it, built directly with
 * `@lexical/table`'s node constructors, and spliced back in as siblings —
 * see `markdownToNodes`/`nodesToMarkdown` below. Cells are treated as
 * single-paragraph plain text (same scope as the ProseMirror package).
 */
function splitOutTables(markdown: string): Array<{ kind: "table"; rows: string[][] } | { kind: "text"; text: string }> {
  const lines = markdown.split("\n");
  const out: Array<{ kind: "table"; rows: string[][] } | { kind: "text"; text: string }> = [];
  let i = 0;
  let textBuf: string[] = [];
  const flushText = () => {
    if (textBuf.length) out.push({ kind: "text", text: textBuf.join("\n") });
    textBuf = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const nextIsDivider = i + 1 < lines.length && TABLE_DIVIDER_REGEXP.test(lines[i + 1].trim());
    if (TABLE_ROW_REGEXP.test(line.trim()) && nextIsDivider) {
      flushText();
      const rows = [parseTableRow(line)];
      i += 2; // header + divider
      while (i < lines.length && TABLE_ROW_REGEXP.test(lines[i].trim())) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      out.push({ kind: "table", rows });
      continue;
    }
    textBuf.push(line);
    i++;
  }
  flushText();
  return out;
}

function buildTableNode(rows: string[][]): TableNode {
  const table = $createTableNode();
  rows.forEach((row, rowIndex) => {
    const tableRow = $createTableRowNode();
    for (const cellText of row) {
      const cell = $createTableCellNode(rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS);
      const paragraph = $createParagraphNode();
      if (cellText) paragraph.append($createTextNode(cellText));
      cell.append(paragraph);
      tableRow.append(cell);
    }
    table.append(tableRow);
  });
  return table;
}

function tableToMarkdown(table: TableNode): string {
  const rows: string[][] = [];
  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row)) continue;
    const cells: string[] = [];
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell)) continue;
      cells.push(cell.getTextContent().replace(/\|/g, "\\|").replace(/\n/g, " ") || " ");
    }
    rows.push(cells);
  }
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** Import: parse markdown into `root` (cleared first), tables handled by `splitOutTables`. */
export function markdownToNodes(root: ElementNode, markdown: string): void {
  root.clear();
  for (const part of splitOutTables(markdown)) {
    if (part.kind === "table") {
      root.append(buildTableNode(part.rows));
    } else {
      $convertFromMarkdownString(part.text, TRANSFORMERS, root, true);
    }
  }
  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode());
  }
}

/** Export: serialize `root` to markdown, re-inlining any table nodes at their position. */
export function nodesToMarkdown(root: ElementNode): string {
  const children = root.getChildren();
  if (!children.some((child) => $isTableNode(child))) {
    return $convertToMarkdownString(TRANSFORMERS, root, true);
  }

  const chunks: string[] = [];
  let run: LexicalNode[] = [];
  const flushRun = () => {
    for (const node of run) chunks.push(exportBlockToMarkdown(node));
    run = [];
  };

  for (const child of children) {
    if ($isTableNode(child)) {
      flushRun();
      const md = tableToMarkdown(child);
      if (md) chunks.push(md);
    } else {
      run.push(child);
    }
  }
  flushRun();
  return chunks.filter((c) => c.length > 0).join("\n\n");
}

function exportBlockToMarkdown(node: LexicalNode): string {
  for (const transformer of TRANSFORMERS) {
    if (transformer.type !== "element") continue;
    const result = transformer.export(node, (n) => n.getTextContent());
    if (result != null) return result;
  }
  return node.getTextContent();
}

export const TRANSFORMERS: Transformer[] = [
  NOTICE,
  IMAGE,
  VIDEO,
  CHECK_LIST,
  ...ELEMENT_TRANSFORMERS,
  CODE,
  UNDERLINE,
  SUBSCRIPT,
  SUPERSCRIPT,
  HIGHLIGHT,
  INLINE_CODE,
  BOLD_STAR,
  ITALIC_STAR,
  STRIKETHROUGH,
  LINK,
];
