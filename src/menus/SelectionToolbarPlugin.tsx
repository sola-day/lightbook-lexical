import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_LOW,
  type TextFormatType,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list";
import { TOGGLE_LINK_COMMAND } from "@lexical/link";
import { addComment } from "../comments/plugin";

export interface SelectionToolbarPluginProps {
  /** Called after a comment thread is created via the toolbar's comment button. */
  onComment?: (threadId: string, previewText: string) => void;
}

const FORMAT_BUTTONS: Array<{ label: string; title: string; format: TextFormatType }> = [
  { label: "B", title: "Bold (⌘B)", format: "bold" },
  { label: "I", title: "Italic (⌘I)", format: "italic" },
  { label: "S", title: "Strikethrough", format: "strikethrough" },
  { label: "✎", title: "Highlight", format: "highlight" },
  { label: "</>", title: "Code", format: "code" },
];

/**
 * Outline/Google-Docs-style floating toolbar: appears above a non-empty
 * selection. Positioned with the native DOM Selection API's
 * `getBoundingClientRect()` (`position: fixed`) — Lexical keeps the
 * browser's real selection in sync with its own, so there's no ProseMirror
 * `coordsAtPos`-style lookup needed.
 */
export function SelectionToolbarPlugin({ onComment }: SelectionToolbarPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const domSelection = window.getSelection();
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (
          !$isRangeSelection(selection) ||
          selection.isCollapsed() ||
          !domSelection ||
          domSelection.rangeCount === 0 ||
          !editor.isEditable()
        ) {
          setRect(null);
          return;
        }
        const domRange = domSelection.getRangeAt(0);
        setRect(domRange.getBoundingClientRect());
      });
    };

    const unregisterCommand = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        update();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
    const unregisterUpdate = editor.registerUpdateListener(update);
    document.addEventListener("selectionchange", update);
    return () => {
      unregisterCommand();
      unregisterUpdate();
      document.removeEventListener("selectionchange", update);
    };
  }, [editor]);

  if (!rect) return null;

  const heading = (tag: HeadingTagType) => () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $setBlocksType(selection, () => $createHeadingNode(tag));
    });
  };

  const blockquote = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $setBlocksType(selection, () => $createQuoteNode());
    });
  };

  const clearFormatting = () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const formats: TextFormatType[] = ["bold", "italic", "strikethrough", "underline", "highlight", "code", "subscript", "superscript"];
      for (const format of formats) {
        if (selection.hasFormat(format)) selection.toggleFormat(format);
      }
    });
  };

  const comment = () => {
    let previewText = "";
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) previewText = selection.getTextContent();
    });
    if (!previewText) return;
    const threadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (addComment(editor, { threadId })) onComment?.(threadId, previewText);
  };

  const link = () => {
    const href = window.prompt("Link URL");
    if (!href) return;
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, href);
  };

  return (
    <div
      ref={toolbarRef}
      className="lb-toolbar-float"
      style={{ position: "fixed", top: rect.top - 46, left: rect.left + rect.width / 2 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="lb-toolbar-btn" title="Heading 1" onClick={heading("h1")}>H1</button>
      <button type="button" className="lb-toolbar-btn" title="Heading 2" onClick={heading("h2")}>H2</button>
      <button type="button" className="lb-toolbar-btn" title="Heading 3" onClick={heading("h3")}>H3</button>
      <button type="button" className="lb-toolbar-btn" title="Blockquote" onClick={blockquote}>&#8221;</button>
      <button type="button" className="lb-toolbar-btn lb-toolbar-group-start" title="Clear formatting" onClick={clearFormatting}>&#10005;</button>
      <button
        type="button"
        className="lb-toolbar-btn lb-toolbar-group-start"
        title="Todo list"
        onClick={() => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)}
      >
        &#9745;
      </button>
      <button
        type="button"
        className="lb-toolbar-btn"
        title="Bulleted list"
        onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
      >
        &#8226;
      </button>
      <button
        type="button"
        className="lb-toolbar-btn"
        title="Ordered list"
        onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
      >
        1.
      </button>
      {FORMAT_BUTTONS.map((btn) => (
        <button
          key={btn.format}
          type="button"
          className={`lb-toolbar-btn${btn.format === "bold" ? " lb-toolbar-group-start" : ""}`}
          title={btn.title}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, btn.format)}
        >
          {btn.label}
        </button>
      ))}
      <button type="button" className="lb-toolbar-btn" title="Link" onClick={link}>&#128279;</button>
      <button type="button" className="lb-toolbar-btn lb-toolbar-group-start" title="Comment on selection" onClick={comment}>&#128172;</button>
    </div>
  );
}
