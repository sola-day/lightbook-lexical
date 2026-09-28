import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { LoroDoc } from "loro-crdt";
import { LIGHTBOOK_NODES } from "../src/nodes";
import { createLoroBinding } from "../src/collab/binding";
import { bridgeLoroDocs } from "../src/collab/bridge";

let passed = 0;
let failed = 0;

function ok(condition: boolean, description: string) {
  if (condition) {
    passed++;
    console.log(`ok  - ${description}`);
  } else {
    failed++;
    console.error(`FAIL - ${description}`);
  }
}

function newEditor() {
  return createHeadlessEditor({
    namespace: "collab-smoke-test",
    nodes: LIGHTBOOK_NODES,
    onError(error) {
      throw error;
    },
  });
}

function textOf(editor: ReturnType<typeof newEditor>) {
  let text = "";
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

// --- Initial sync: non-empty Lexical content seeds an empty Loro doc -----

{
  const editorA = newEditor();
  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("hello from A"));
      root.append(p);
    },
    { discrete: true }
  );

  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  ok(textOf(editorA) === "hello from A", `editor A keeps its own seed content after binding (got ${JSON.stringify(textOf(editorA))})`);

  // A second peer starting from an empty editor but a doc PRE-LOADED with A's export should adopt A's content.
  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });

  ok(textOf(editorB) === "hello from A", `editor B adopts content from a pre-loaded LoroDoc (got ${JSON.stringify(textOf(editorB))})`);

  bindingA.destroy();
  bindingB.destroy();
}

// --- Two bridged peers converge on structural edits -----------------------
//
// Bootstrap order matters here: two peers that each independently seed
// their OWN separately-empty LoroDoc before bridging end up with two
// divergent "my own initial empty paragraph" blocks that bridging (which
// only forwards updates from that point forward) never reconciles into
// one. The fix, same as real usage: only one side starts from a truly
// empty doc; the other imports its snapshot first, THEN binds.

{
  const editorA = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  const editorB = newEditor();
  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const bindingB = createLoroBinding(editorB, { doc: docB });

  const unbridge = bridgeLoroDocs(docA, docB);

  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("shared paragraph"));
      root.append(p);
    },
    { discrete: true }
  );

  ok(textOf(editorB) === "shared paragraph", `editor B receives editor A's paragraph via the bridge (got ${JSON.stringify(textOf(editorB))})`);

  editorB.update(
    () => {
      const root = $getRoot();
      const p2 = $createParagraphNode();
      p2.append($createTextNode("second paragraph from B"));
      root.append(p2);
    },
    { discrete: true }
  );

  ok(
    textOf(editorA).includes("second paragraph from B"),
    `editor A receives editor B's new paragraph via the bridge (got ${JSON.stringify(textOf(editorA))})`
  );
  ok(textOf(editorA).includes("shared paragraph"), "editor A's own earlier content survives editor B's edit");

  unbridge();
  bindingA.destroy();
  bindingB.destroy();
}

// --- Concurrent typing in the same paragraph merges character-by-character (the core "feels real-time" property) ---

{
  const editorA = newEditor();
  const editorB = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("start"));
      root.append(p);
    },
    { discrete: true }
  );

  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const bindingB = createLoroBinding(editorB, { doc: docB });
  ok(textOf(editorB) === "start", "editor B starts from the same synced content before going concurrent");

  const unbridge = bridgeLoroDocs(docA, docB);
  // Temporarily unbridge to simulate two peers editing offline, then reconnect.
  unbridge();

  editorA.update(
    () => {
      const textNode = ($getRoot().getFirstChild() as any).getFirstChild();
      textNode.spliceText(5, 0, "-A-suffix", true); // "start-A-suffix"
    },
    { discrete: true }
  );
  editorB.update(
    () => {
      const textNode = ($getRoot().getFirstChild() as any).getFirstChild();
      textNode.spliceText(0, 0, "B-prefix-", true); // "B-prefix-start"
    },
    { discrete: true }
  );

  ok(textOf(editorA) === "start-A-suffix", `editor A sees its own concurrent edit before reconnecting (got ${JSON.stringify(textOf(editorA))})`);
  ok(textOf(editorB) === "B-prefix-start", `editor B sees its own concurrent edit before reconnecting (got ${JSON.stringify(textOf(editorB))})`);

  // Reconnect: exchange whatever accumulated on each side while offline.
  docB.import(docA.export({ mode: "update" }));
  docA.import(docB.export({ mode: "update" }));
  // Binding only re-reads Lexical on its own `doc.subscribe` firing with
  // `event.by !== "local"`; importing bytes directly (bypassing the bridge)
  // still fires that subscription the same way a real network import would.

  const finalA = textOf(editorA);
  const finalB = textOf(editorB);
  ok(finalA === finalB, `both peers converge to the same text after reconnecting (A=${JSON.stringify(finalA)}, B=${JSON.stringify(finalB)})`);
  ok(finalA.includes("B-prefix-") && finalA.includes("-A-suffix"), `the converged text contains BOTH peers' concurrent edits, neither was dropped (got ${JSON.stringify(finalA)})`);

  bindingA.destroy();
  bindingB.destroy();
}

// --- Formatting round-trips through the binding ---------------------------

{
  const editorA = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      const bold = $createTextNode("bold text");
      bold.toggleFormat("bold");
      p.append(bold);
      root.append(p);
    },
    { discrete: true }
  );

  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });

  let hasBold = false;
  editorB.getEditorState().read(() => {
    const textNode = ($getRoot().getFirstChild() as any).getFirstChild();
    hasBold = textNode?.hasFormat?.("bold") ?? false;
  });
  ok(hasBold, "bold formatting survives the Lexical -> Loro -> Lexical round-trip");

  bindingA.destroy();
  bindingB.destroy();
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All collab smoke tests passed.");
}
