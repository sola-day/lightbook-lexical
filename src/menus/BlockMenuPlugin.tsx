import { useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  $isRootOrShadowRoot,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { $createHeadingNode, type HeadingTagType } from "@lexical/rich-text";
import { INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list";
import { $createImageNode } from "../nodes/ImageNode";
import { $createVideoNode } from "../nodes/VideoNode";

interface MenuItem {
  label: string;
  icon: string;
  shortcut?: string;
  groupStart?: boolean;
  keywords?: string[];
  run: (editor: LexicalEditor) => void;
}

function headingItem(tag: HeadingTagType, label: string): MenuItem {
  return {
    label,
    icon: tag.toUpperCase(),
    keywords: [tag, "heading"],
    run(editor) {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) $setBlocksType(selection, () => $createHeadingNode(tag));
      });
    },
  };
}

function useItems(): MenuItem[] {
  return useMemo(
    () => [
      headingItem("h1", "Big heading"),
      headingItem("h2", "Medium heading"),
      headingItem("h3", "Small heading"),
      headingItem("h4", "Extra small heading"),
      {
        label: "Todo list",
        icon: "☑",
        groupStart: true,
        keywords: ["todo", "checkbox", "task"],
        run: (editor) => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined),
      },
      {
        label: "Bulleted list",
        icon: "•",
        keywords: ["bullet", "ul"],
        run: (editor) => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
      },
      {
        label: "Ordered list",
        icon: "1.",
        keywords: ["numbered", "ol"],
        run: (editor) => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
      },
      {
        label: "Image",
        icon: "🖼",
        groupStart: true,
        keywords: ["picture", "photo"],
        run: (editor) => {
          const src = window.prompt("Image URL");
          if (!src) return;
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.insertNodes([$createImageNode({ src })]);
          });
        },
      },
      {
        label: "Video",
        icon: "▶",
        keywords: ["embed"],
        run: (editor) => {
          const src = window.prompt("Video URL");
          if (!src) return;
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.insertNodes([$createVideoNode({ src })]);
          });
        },
      },
    ],
    []
  );
}

function matches(item: MenuItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.label.toLowerCase().includes(q) || !!item.keywords?.some((k) => k.startsWith(q));
}

interface SlashMatch {
  nodeKey: string;
  /** Offset of the "/" character itself within the text node. */
  slashOffset: number;
  query: string;
}

/** Cursor at end of a text node, preceded by "/" + word chars, with a word boundary (or block start) before the "/". */
function detectSlash(selection: RangeSelection): SlashMatch | null {
  if (!selection.isCollapsed()) return null;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node)) return null;
  const offset = selection.anchor.offset;
  const textBefore = node.getTextContent().slice(0, offset);
  const match = /(?:^|\s)\/(\w*)$/.exec(textBefore);
  if (!match) return null;
  const query = match[1];
  const slashOffset = offset - query.length - 1;
  return { nodeKey: node.getKey(), slashOffset, query };
}

/**
 * Outline/Notion-style block-insert menu: a "+" handle in the left margin
 * (click to open), and typing "/" at the cursor (filters as you type,
 * Up/Down to navigate, Enter/click to run, Escape or a space to cancel).
 */
export function BlockMenuPlugin() {
  const [editor] = useLexicalComposerContext();
  const items = useItems();
  const [handleTop, setHandleTop] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [slash, setSlash] = useState<SlashMatch | null>(null);
  const [openViaHandle, setOpenViaHandle] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const query = slash?.query ?? "";
  const visibleItems = useMemo(() => items.filter((item) => matches(item, query)), [items, query]);

  useEffect(() => setSelectedIndex(0), [query, openViaHandle]);

  useEffect(() => {
    const update = () => {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setHandleTop(null);
          setSlash(null);
          return;
        }
        const detected = detectSlash(selection);
        setSlash(detected);

        // Only element/decorator nodes get their own keyed DOM element in
        // Lexical's reconciler, so look up the nearest top-level block. The
        // anchor can be the root itself (an element point on the root, e.g.
        // while the document is still empty), which has no top-level block
        // of its own: use the child at that point instead.
        const anchorNode = selection.anchor.getNode();
        const block = $isRootOrShadowRoot(anchorNode)
          ? (anchorNode.getChildAtIndex(selection.anchor.offset) ?? anchorNode.getLastChild())
          : anchorNode.getTopLevelElement();
        const el = block ? editor.getElementByKey(block.getKey()) : null;
        const rootEl = editor.getRootElement();
        if (!el) setHandleTop(null);
        if (el && rootEl) {
          const rect = el.getBoundingClientRect();
          const rootRect = rootEl.getBoundingClientRect();
          setHandleTop(rect.top - rootRect.top);
        }

        if (detected) {
          const domSelection = window.getSelection();
          if (domSelection && domSelection.rangeCount > 0) {
            const domRect = domSelection.getRangeAt(0).getBoundingClientRect();
            setMenuAnchor({ top: domRect.bottom + 4, left: domRect.left });
          }
        }
      });
    };
    const unregister = editor.registerUpdateListener(update);
    update();
    return unregister;
  }, [editor]);

  const runItem = (item: MenuItem) => {
    if (slash) {
      const { nodeKey, slashOffset, query: q } = slash;
      // Delete the "/query" text first, in its own update so selection lands correctly.
      editor.update(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) {
          const anchorNode = sel.anchor.getNode();
          if ($isTextNode(anchorNode) && anchorNode.getKey() === nodeKey) {
            anchorNode.spliceText(slashOffset, 1 + q.length, "", true);
          }
        }
      });
    }
    item.run(editor);
    setSlash(null);
    setOpenViaHandle(false);
    editor.focus();
  };

  useEffect(() => {
    const isOpen = () => slash != null || openViaHandle;
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (!isOpen() || visibleItems.length === 0) return false;
        event?.preventDefault();
        setSelectedIndex((i) => (i + 1) % visibleItems.length);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (!isOpen() || visibleItems.length === 0) return false;
        event?.preventDefault();
        setSelectedIndex((i) => (i - 1 + visibleItems.length) % visibleItems.length);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!isOpen() || visibleItems.length === 0) return false;
        event?.preventDefault();
        runItem(visibleItems[selectedIndex]);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!isOpen() || visibleItems.length === 0) return false;
        event?.preventDefault();
        runItem(visibleItems[selectedIndex]);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        if (!isOpen()) return false;
        setSlash(null);
        setOpenViaHandle(false);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, visibleItems, selectedIndex, slash, openViaHandle]);

  useEffect(() => {
    if (!openViaHandle) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpenViaHandle(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [openViaHandle]);

  const isMenuOpen = slash != null || openViaHandle;

  return (
    <div ref={containerRef}>
      {handleTop != null && !slash && (
        <button
          type="button"
          className="lb-block-handle"
          style={{ position: "absolute", top: handleTop, left: 4 }}
          title="Insert block (or type / )"
          onMouseDown={(event) => {
            event.preventDefault();
            setOpenViaHandle((open) => {
              if (!open) {
                const rootEl = editor.getRootElement();
                if (rootEl) {
                  const rect = rootEl.getBoundingClientRect();
                  setMenuAnchor({ top: rect.top + (handleTop ?? 0) + 26, left: rect.left + 4 });
                }
              }
              return !open;
            });
          }}
        >
          +
        </button>
      )}
      {isMenuOpen && menuAnchor && (
        <div className="lb-block-menu" style={{ position: "fixed", top: menuAnchor.top, left: menuAnchor.left }}>
          {visibleItems.length === 0 && <div className="lb-block-menu-empty">No matching blocks</div>}
          {visibleItems.map((item, index) => (
            <button
              key={item.label}
              type="button"
              className={`lb-block-menu-item${item.groupStart ? " lb-block-menu-group-start" : ""}${index === selectedIndex ? " active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                runItem(item);
              }}
            >
              <span className="lb-block-menu-icon">{item.icon}</span>
              <span className="lb-block-menu-label">{item.label}</span>
              {item.shortcut && <span className="lb-block-menu-shortcut">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
