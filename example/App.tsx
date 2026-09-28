import { useCallback, useMemo, useRef, useState } from "react";
import type { LexicalEditor } from "lexical";
import { $getRoot } from "lexical";
import { createHeadlessEditor } from "@lexical/headless";
import { LoroDoc } from "loro-crdt";
import {
  LightbookEditor,
  listThreads,
  removeComment,
  setActiveThread,
  nodesToMarkdown,
  markdownToNodes,
  LIGHTBOOK_NODES,
  LoroCollabPlugin,
  createLoroBinding,
  bridgeLoroDocs,
  createPresenceStore,
  bridgePresenceStores,
  type SuggestionController,
  type ThreadRange,
} from "../src/index";

const STARTER_MARKDOWN = [
  "# Welcome to lightbook-lexical",
  "",
  "This editor supports **bold**, *italic*, ~~strikethrough~~, `code`, tables, and lists.",
  "",
  "| Feature | Status |",
  "| --- | --- |",
  "| Tables | done |",
  "| Markdown | done |",
  "| Comments | done |",
  "| Suggesting | done |",
  "| Loro collab | done |",
  "",
  "- Try selecting a sentence and using the floating toolbar's comment button",
  "- Try toggling **Suggesting** below and typing a change",
  "- Type `/` at the start of a line for the block-insert menu",
].join("\n");

const COLLAB_STARTER = [
  "# Live collaboration demo",
  "",
  "Type in either pane — both share one Loro document (bridged in-memory).",
  "Open two browser tabs pointed at a real network transport instead of this",
  "in-memory bridge, and this becomes real multi-device collaboration.",
].join("\n");

export default function App() {
  // Two peers, bridged in-memory. Both editors ADOPT already-seeded docs —
  // neither is "the empty-doc initializer" at mount time — because two
  // peers that each independently seed their OWN separately-empty LoroDoc
  // before bridging end up with two divergent initial blocks bridging (only
  // forwards updates from that point forward) never reconciles; see the
  // same note in test/collab.ts.
  const [collabDocA, collabDocB] = useMemo(() => {
    const seedEditor = createHeadlessEditor({
      namespace: "lightbook-lexical-collab-seed",
      nodes: LIGHTBOOK_NODES,
      onError(error) {
        throw error;
      },
    });
    seedEditor.update(
      () => {
        markdownToNodes($getRoot(), COLLAB_STARTER);
      },
      { discrete: true }
    );
    const docA = new LoroDoc();
    createLoroBinding(seedEditor, { doc: docA });
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    bridgeLoroDocs(docA, docB);
    return [docA, docB];
  }, []);

  const [presenceStoreA, presenceStoreB] = useMemo(() => {
    const storeA = createPresenceStore();
    const storeB = createPresenceStore();
    bridgePresenceStores(storeA, storeB);
    return [storeA, storeB];
  }, []);

  const editorARef = useRef<LexicalEditor | null>(null);
  const suggestionRef = useRef<SuggestionController | null>(null);
  const [threads, setThreads] = useState<Map<string, ThreadRange>>(new Map());
  const [suggesting, setSuggestingUi] = useState(false);
  const [mdOutput, setMdOutput] = useState("");
  const [mdInput, setMdInput] = useState(
    "# Paste markdown here\n\n- with lists\n- and tables\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"
  );
  const [importedKey, setImportedKey] = useState(0);
  const [importedMarkdown, setImportedMarkdown] = useState<string | null>(null);

  const refreshThreads = useCallback(() => {
    const editor = editorARef.current;
    if (!editor) return;
    setThreads(listThreads(editor));
  }, []);

  const handleReady = useCallback(
    (editor: LexicalEditor, suggestion: SuggestionController) => {
      editorARef.current = editor;
      suggestionRef.current = suggestion;
      refreshThreads();
    },
    [refreshThreads]
  );

  const toggleSuggesting = () => {
    const suggestion = suggestionRef.current;
    if (!suggestion) return;
    const next = !suggestion.isSuggesting();
    suggestion.setSuggesting(next ? "alice" : null);
    setSuggestingUi(next);
  };

  const handleExport = () => {
    const editor = editorARef.current;
    if (!editor) return;
    editor.getEditorState().read(() => {
      setMdOutput(nodesToMarkdown($getRoot()));
    });
  };

  const handleImport = () => {
    setImportedMarkdown(mdInput || "# Empty document");
    setImportedKey((k) => k + 1);
  };

  return (
    <>
      <header className="lb-page-header">
        <h1>lightbook-lexical</h1>
        <p>
          Shared Lexical editor core for Lightbook — Outline-style rich blocks and tables, Markdown
          import/export, Google-Docs-style comments &amp; suggesting (both built on{" "}
          <code>@lexical/mark</code>'s <code>MarkNode</code>), and Loro CRDT realtime collaboration
          (a from-scratch binding — see the README for what it does and doesn't merge losslessly).
        </p>
      </header>

      <section className="lb-panel">
        <h2>Realtime collaboration (two editors, two Loro peers)</h2>
        <p className="lb-hint">
          Type in either pane — each has its own <code>LoroDoc</code> peer, bridged in-memory via{" "}
          <code>createLoroBinding</code>. Text edits merge character-by-character even when made
          concurrently in the same paragraph; click into one pane and you'll see the other peer's
          colored cursor label follow along. See the README for what this "simple tier" binding
          does and doesn't merge losslessly.
        </p>
        <div className="lb-collab-grid">
          <div>
            <div className="lb-user-badge" style={{ background: "#4285f4" }}>
              Alice
            </div>
            <div className="lb-editor lb-editor-bordered">
              <LightbookEditor
                key="collab-a"
                namespace="lightbook-lexical-collab-a"
                skipDefaultContent
                collabPlugins={
                  <LoroCollabPlugin
                    doc={collabDocA}
                    presence={{ store: presenceStoreA, peerId: "alice", user: { name: "Alice", color: "#4285f4" } }}
                  />
                }
              />
            </div>
          </div>
          <div>
            <div className="lb-user-badge" style={{ background: "#ea4335" }}>
              Bob
            </div>
            <div className="lb-editor lb-editor-bordered">
              <LightbookEditor
                key="collab-b"
                namespace="lightbook-lexical-collab-b"
                skipDefaultContent
                collabPlugins={
                  <LoroCollabPlugin
                    doc={collabDocB}
                    presence={{ store: presenceStoreB, peerId: "bob", user: { name: "Bob", color: "#ea4335" } }}
                  />
                }
              />
            </div>
          </div>
        </div>
      </section>

      <section className="lb-panel">
        <h2>Comments &amp; suggestion mode</h2>
        <p className="lb-hint">
          Select text to open the floating toolbar (comment button included), or toggle
          "Suggesting" and type a change — deletions show struck-through, insertions underlined,
          until accepted/rejected.
        </p>
        <div className="lb-toolbar">
          <button type="button" className={suggesting ? "active" : ""} onClick={toggleSuggesting}>
            &#9998; Toggle suggesting
          </button>
          {suggesting && <span className="lb-status">Suggesting as Alice — edits are tracked</span>}
        </div>
        <div className="lb-comments-layout">
          <div>
            <div id="editor-a" className="lb-editor lb-editor-bordered">
              <LightbookEditor
                key="editor-a"
                namespace="lightbook-lexical-demo-a"
                initialMarkdown={STARTER_MARKDOWN}
                onReady={handleReady}
                onChange={refreshThreads}
                onComment={refreshThreads}
              />
            </div>
          </div>
          <aside className="lb-threads">
            <h3>Threads</h3>
            <ul>
              {threads.size === 0 && (
                <li style={{ cursor: "default", color: "#999" }}>
                  No comments yet — select text above and use the toolbar's comment button.
                </li>
              )}
              {[...threads.values()].map((thread) => (
                <li
                  key={thread.threadId}
                  onMouseEnter={() => editorARef.current && setActiveThread(editorARef.current, thread.threadId)}
                  onMouseLeave={() => editorARef.current && setActiveThread(editorARef.current, null)}
                  onClick={() => {
                    if (!editorARef.current) return;
                    removeComment(editorARef.current, thread.threadId);
                    refreshThreads();
                  }}
                  title="Click to remove"
                >
                  &ldquo;{thread.text.slice(0, 40)}
                  {thread.text.length > 40 ? "…" : ""}&rdquo;
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>

      <section className="lb-panel">
        <h2>Markdown import / export</h2>
        <p className="lb-hint">
          Export serializes the editor above to Markdown (tables included); paste Markdown below and
          import to load it into a standalone editor.
        </p>
        <div className="lb-md-grid">
          <div>
            <button type="button" onClick={handleExport}>
              Export editor → Markdown
            </button>
            <textarea rows={14} readOnly value={mdOutput} placeholder="Markdown output appears here" />
          </div>
          <div>
            <textarea rows={14} value={mdInput} onChange={(e) => setMdInput(e.target.value)} />
            <button type="button" onClick={handleImport}>
              Import Markdown → editor below
            </button>
            <div className="lb-editor lb-editor-bordered">
              {importedMarkdown != null && (
                <LightbookEditor key={importedKey} namespace={`lightbook-lexical-import-${importedKey}`} initialMarkdown={importedMarkdown} />
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
