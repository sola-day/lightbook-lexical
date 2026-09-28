import { useEffect, useRef, type ReactNode } from "react";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { EditorState, LexicalEditor } from "lexical";
import { $getRoot } from "lexical";
import { LIGHTBOOK_NODES } from "./nodes";
import { lightbookTheme } from "./theme";
import { markdownToNodes } from "./markdown";
import { SelectionToolbarPlugin } from "./menus/SelectionToolbarPlugin";
import { BlockMenuPlugin } from "./menus/BlockMenuPlugin";
import { registerMarkStyling } from "./comments/styling";
import { createSuggestionController, type SuggestionController } from "./comments/suggestion";

export interface LightbookEditorProps {
  namespace: string;
  editable?: boolean;
  initialMarkdown?: string;
  onChange?: (editorState: EditorState, editor: LexicalEditor) => void;
  onComment?: (threadId: string, previewText: string) => void;
  /** Fired once, after mount, with the editor and its (per-instance) suggestion controller. */
  onReady?: (editor: LexicalEditor, suggestion: SuggestionController) => void;
  /** Extra plugins to render inside the composer — used for the Loro collab plugin. */
  collabPlugins?: ReactNode;
  /** When true (collab mode), the initial doc comes from elsewhere (the CRDT), not `initialMarkdown`. */
  skipDefaultContent?: boolean;
}

function ReadyPlugin({
  onReady,
  onComment,
}: {
  onReady?: (editor: LexicalEditor, suggestion: SuggestionController) => void;
  onComment?: (threadId: string, previewText: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const controllerRef = useRef<SuggestionController | null>(null);

  useEffect(() => {
    const unregisterStyling = registerMarkStyling(editor);
    const controller = createSuggestionController(editor);
    controllerRef.current = controller;
    onReady?.(editor, controller);
    return () => {
      unregisterStyling();
      controller.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  void onComment;
  return null;
}

/**
 * Assembles a full lightbook-lexical editor: base rich-text nodes, tables,
 * lists/checklists, links, images/video/notices, Markdown initial content,
 * the floating selection toolbar, the "+"/slash block-insert menu, comment
 * threads + suggestion mode (both via `MarkNode`, see `src/comments/`), and
 * (optionally) Loro CRDT realtime collaboration via `collabPlugins`. This is
 * the single entry point apps are meant to use.
 */
export function LightbookEditor({
  namespace,
  editable = true,
  initialMarkdown,
  onChange,
  onComment,
  onReady,
  collabPlugins,
  skipDefaultContent = false,
}: LightbookEditorProps) {
  const initialConfig: InitialConfigType = {
    namespace,
    nodes: LIGHTBOOK_NODES,
    theme: lightbookTheme,
    editable,
    onError(error) {
      throw error;
    },
    editorState:
      skipDefaultContent || collabPlugins
        ? null
        : initialMarkdown
          ? (editor: LexicalEditor) => {
              editor.update(() => {
                markdownToNodes($getRoot(), initialMarkdown);
              });
            }
          : undefined,
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="lb-editor">
        <RichTextPlugin
          contentEditable={<ContentEditable className="lb-content-editable" />}
          ErrorBoundary={LexicalErrorBoundary}
        />
        {!collabPlugins && <HistoryPlugin />}
        <ListPlugin />
        <CheckListPlugin />
        <TablePlugin />
        <LinkPlugin />
        <SelectionToolbarPlugin onComment={onComment} />
        <BlockMenuPlugin />
        <ReadyPlugin onReady={onReady} onComment={onComment} />
        {onChange && <OnChangePlugin onChange={onChange} />}
        {collabPlugins}
      </div>
    </LexicalComposer>
  );
}
