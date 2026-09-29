export { LightbookEditor } from "./LightbookEditor";
export type { LightbookEditorProps } from "./LightbookEditor";
export { lightbookTheme } from "./theme";
export { LIGHTBOOK_NODES } from "./nodes";
export { markdownToNodes, nodesToMarkdown, TRANSFORMERS } from "./markdown";
export * from "./comments";
export * from "./menus";
export * from "./collab";
// Consumers type against the editor instance this package creates, not a
// separately installed `lexical` (two copies' types never unify).
export type { LexicalEditor, EditorState } from "lexical";
