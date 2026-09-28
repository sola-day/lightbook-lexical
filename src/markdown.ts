import {
  $convertToMarkdownString,
  $generateNodesFromMarkdownString,
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
  type TextMatchTransformer,
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
  replace: (parentNode, children, match) => {
    // `parentNode`'s text no longer carries the matched "> [!kind] " prefix
    // by the time `replace` runs (the block-matching machinery already
    // consumed it) — the kind has to come from `match`, not by re-deriving
    // it from `parentNode.getTextContent()` a second time.
    const kind = (match[1] as NoticeKind) ?? "info";
    const notice = $createNoticeNode(kind);
    const paragraph = $createParagraphNode();
    paragraph.append(...children);
    notice.append(paragraph);
    parentNode.replace(notice);
    notice.selectEnd();
  },
  type: "element",
};

/**
 * `ImageNode.isInline()` is true — it lives *inside* a paragraph like a
 * link, not in place of one — so this has to be a `TextMatchTransformer`
 * (matched while walking a paragraph's inline children), not an
 * `ElementTransformer` (matched against a whole line/block). Using the
 * wrong kind was a real bug caught by the smoke tests: import "worked" (the
 * image node was created, just left oddly nested), but export silently
 * produced nothing, since `$convertToMarkdownString` only ever hands a
 * top-level node to `ElementTransformer.export`, never an inline child.
 */
const IMAGE: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) => {
    if (!$isImageNode(node)) return null;
    return `![${node.__alt ?? ""}](${node.getSrc()})`;
  },
  importRegExp: /!\[([^[\]]*)\]\(([^()\s]+)\)/,
  regExp: /!\[([^[\]]*)\]\(([^()\s]+)\)$/,
  replace: (textNode, match) => {
    const [, alt, src] = match;
    textNode.replace($createImageNode({ src, alt }));
  },
  trigger: ")",
  type: "text-match",
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
 * text *before* `$generateNodesFromMarkdownString` sees it, built directly with
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

/**
 * Import: parse markdown into `root` (cleared first), tables handled by
 * `splitOutTables`. Each non-table chunk is parsed with
 * `$generateNodesFromMarkdownString`, which — unlike
 * `$convertFromMarkdownString` — returns nodes without touching any tree,
 * so appending several chunks' results in a row (around each table) doesn't
 * have each call clear out what the previous one just appended.
 */
export function markdownToNodes(root: ElementNode, markdown: string): void {
  root.clear();
  for (const part of splitOutTables(markdown)) {
    if (part.kind === "table") {
      root.append(buildTableNode(part.rows));
    } else if (part.text.length > 0) {
      const nodes = $generateNodesFromMarkdownString(part.text, TRANSFORMERS, true);
      for (const node of nodes) root.append(node);
    }
  }
  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode());
  }
}

/**
 * Table export, unlike import, needs none of `splitOutTables`' line-based
 * pre-processing: `$convertToMarkdownString` walks the already-structured
 * node tree and hands each top-level node to its matching transformer, so a
 * table's `export()` can just return its GFM markdown directly — the
 * library's own inline-formatting serialization (bold/italic/links/etc
 * inside surrounding paragraphs) keeps working normally alongside it. Only
 * `replace` (import) is a no-op here; table import goes through
 * `splitOutTables` in `markdownToNodes` instead.
 */
const TABLE_EXPORT: ElementTransformer = {
  dependencies: [TableNode, TableRowNode, TableCellNode],
  export: (node) => ($isTableNode(node) ? tableToMarkdown(node) : null),
  regExp: /^(?!)$/, // never matches on import; see docstring above
  replace: () => false,
  type: "element",
};

/** Export: serialize `root` to markdown, tables included via `TABLE_EXPORT`. */
export function nodesToMarkdown(root: ElementNode): string {
  return $convertToMarkdownString(TRANSFORMERS, root, true);
}

export const TRANSFORMERS: Transformer[] = [
  NOTICE,
  IMAGE,
  VIDEO,
  TABLE_EXPORT,
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
