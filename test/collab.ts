import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $createParagraphNode, $createTextNode, $getNodeByKey, $createLineBreakNode, $isLineBreakNode, $getSelection, $isRangeSelection, UNDO_COMMAND, REDO_COMMAND } from "lexical";
import { $createLinkNode, $isLinkNode } from "@lexical/link";
import { $createMarkNode, $isMarkNode } from "@lexical/mark";
import { $createListNode, $createListItemNode } from "@lexical/list";
import { $createTableNodeWithDimensions } from "@lexical/table";
import { $createImageNode } from "../src/nodes/ImageNode";
import { LoroDoc } from "loro-crdt";
import { LIGHTBOOK_NODES } from "../src/nodes";
import { createLoroBinding } from "../src/collab/binding";
import { bridgeLoroDocs } from "../src/collab/bridge";
import { createSuggestionController } from "../src/comments/suggestion";
import { listSuggestions } from "../src/comments/plugin";
import { createPresenceStore, setPresence, resolveLocalCursorPoint, resolveRemoteCursors } from "../src/collab/presence";

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

function tableTextOf(editor: ReturnType<typeof newEditor>) {
  let text = "";
  editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find((n) => n.getType() === "table");
    text = table ? table.getTextContent().trim() : "";
  });
  return text;
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

// --- Opening a page before its content arrives adds nothing to the shared doc ---
//
// The web app binds the editor to a still-empty doc while the server's
// copy is in flight. The placeholder paragraph the editor shows meanwhile
// must stay local, or every device's first open adds an empty paragraph.

{
  const editorA = newEditor();
  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("server content"));
      root.append(p);
    },
    { discrete: true }
  );
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  const editorB = newEditor();
  const docB = new LoroDoc();
  const bindingB = createLoroBinding(editorB, { doc: docB });
  ok(textOf(editorB) === "", "a late peer shows an empty placeholder while its doc is still empty");
  ok(((docB.getMap("lb").get("rootOrder") as any)?.length ?? 0) === 0, "the placeholder is not written into the doc");

  docB.import(docA.export({ mode: "snapshot" }));
  let blocks = 0;
  editorB.getEditorState().read(() => (blocks = $getRoot().getChildrenSize()));
  ok(textOf(editorB) === "server content" && blocks === 1, `the arriving content replaces the placeholder (got ${JSON.stringify(textOf(editorB))}, ${blocks} blocks)`);
  ok(docB.export({ mode: "update", from: docA.oplogVersion() }).length === 0 || (() => {
    const probe = new LoroDoc();
    probe.import(docA.export({ mode: "snapshot" }));
    probe.import(docB.export({ mode: "update", from: docA.oplogVersion() }));
    return JSON.stringify(probe.toJSON()) === JSON.stringify(docA.toJSON());
  })(), "the late peer has nothing of its own to send back");

  // Same when the editor already holds an empty paragraph (as a browser editor does).
  const editorE = newEditor();
  editorE.update(() => $getRoot().append($createParagraphNode()), { discrete: true });
  const docE = new LoroDoc();
  const bindingE = createLoroBinding(editorE, { doc: docE });
  ok(((docE.getMap("lb").get("rootOrder") as any)?.length ?? 0) === 0, "an editor's own empty paragraph isn't written into an empty doc either");
  bindingE.destroy();

  // Typing into an empty page does reach the doc.
  const editorC = newEditor();
  const docC = new LoroDoc();
  const bindingC = createLoroBinding(editorC, { doc: docC });
  editorC.update(() => ($getRoot().getFirstChild() as any).append($createTextNode("first words")), { discrete: true });
  const docD = new LoroDoc();
  docD.import(docC.export({ mode: "snapshot" }));
  const editorD = newEditor();
  const bindingD = createLoroBinding(editorD, { doc: docD });
  ok(textOf(editorD) === "first words", `the first edit on an empty page is written (got ${JSON.stringify(textOf(editorD))})`);

  bindingA.destroy();
  bindingB.destroy();
  bindingC.destroy();
  bindingD.destroy();
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

// --- Inline elements (links, comment/suggestion marks, line breaks) keep their text ---
// Regression: the binding used to read only a block's direct TextNode
// children, so wrapping text in a comment mark (or a link) synced the block
// as empty — wiping that text for every other peer.

{
  const editorA = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      const link = $createLinkNode("https://example.com/docs");
      link.append($createTextNode("docs"));
      const mark = $createMarkNode(["c:thread-1"]);
      const bold = $createTextNode("this part");
      bold.toggleFormat("bold");
      mark.append(bold);
      p.append($createTextNode("see "), link, $createTextNode(" and "), mark, $createLineBreakNode(), $createTextNode("end"));
      root.append(p);
    },
    { discrete: true }
  );

  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });
  const unbridge = bridgeLoroDocs(docA, docB);

  const inspect = (editor: ReturnType<typeof newEditor>) => {
    let out = { text: "", linkUrl: "", linkText: "", markIds: [] as string[], markText: "", markBold: false, breaks: 0 };
    editor.getEditorState().read(() => {
      const p = $getRoot().getFirstChild() as any;
      out.text = p.getTextContent();
      for (const child of p.getChildren()) {
        if ($isLinkNode(child)) {
          out.linkUrl = child.getURL();
          out.linkText = child.getTextContent();
        }
        if ($isMarkNode(child)) {
          out.markIds = child.getIDs();
          out.markText = child.getTextContent();
          out.markBold = (child.getFirstChild() as any)?.hasFormat?.("bold") ?? false;
        }
        if ($isLineBreakNode(child)) out.breaks++;
      }
    });
    return out;
  };

  const b = inspect(editorB);
  ok(b.text === "see docs and this part\nend", `text inside links/marks survives the round-trip (got ${JSON.stringify(b.text)})`);
  ok(b.linkUrl === "https://example.com/docs" && b.linkText === "docs", `links are rebuilt with their URL (got ${JSON.stringify(b)})`);
  ok(b.markIds.join() === "c:thread-1" && b.markText === "this part", "comment marks are rebuilt with their id and text");
  ok(b.markBold, "formatting inside a mark survives");
  ok(b.breaks === 1, "line breaks survive");

  // A mark added live (the "Comment" action) reaches the peer without losing text.
  editorA.update(
    () => {
      const p = $getRoot().getFirstChild() as any;
      const last = p.getLastChild();
      const mark = $createMarkNode(["c:thread-2"]);
      last.insertBefore(mark);
      mark.append(last);
    },
    { discrete: true }
  );
  const after = inspect(editorB);
  ok(after.text === "see docs and this part\nend", `adding a mark live keeps the peer's text (got ${JSON.stringify(after.text)})`);
  let ids: string[] = [];
  editorB.getEditorState().read(() => {
    for (const child of ($getRoot().getFirstChild() as any).getChildren()) if ($isMarkNode(child)) ids.push(...child.getIDs());
  });
  ok(ids.includes("c:thread-2"), `the live-added mark reaches the peer (got ${JSON.stringify(ids)})`);

  unbridge();
  bindingA.destroy();
  bindingB.destroy();
}

// --- Reordering blocks uses LoroMovableList.move(), preserving identity ---
// (not delete+reinsert) — a concurrent edit to the moved block's own text
// should still land on it correctly after the peer replays the reorder.

{
  const editorA = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const text of ["first", "second", "third"]) {
        const p = $createParagraphNode();
        p.append($createTextNode(text));
        root.append(p);
      }
    },
    { discrete: true }
  );

  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });
  const unbridge = bridgeLoroDocs(docA, docB);

  ok(
    textOf(editorB) === "first\n\nsecond\n\nthird",
    `editor B starts with the same three paragraphs in order (got ${JSON.stringify(textOf(editorB))})`
  );

  // Reorder on A: move the "third" paragraph to the front.
  editorA.update(
    () => {
      const root = $getRoot();
      const children = root.getChildren();
      const third = children.find((c) => c.getTextContent() === "third")!;
      third.remove();
      root.splice(0, 0, [third]);
    },
    { discrete: true }
  );

  ok(
    textOf(editorA) === "third\n\nfirst\n\nsecond",
    `editor A's own reorder applied (got ${JSON.stringify(textOf(editorA))})`
  );
  ok(
    textOf(editorB) === "third\n\nfirst\n\nsecond",
    `editor B receives the reorder via the bridge (got ${JSON.stringify(textOf(editorB))})`
  );

  // Now edit the moved paragraph's text on B — it should land on the SAME
  // logical block (now first), not create a duplicate or land on the
  // wrong paragraph, proving the move preserved the block's identity.
  editorB.update(
    () => {
      const root = $getRoot();
      const moved = root.getChildren()[0] as any;
      const textNode = moved.getFirstChild();
      textNode.spliceText(textNode.getTextContentSize(), 0, "-edited", true);
    },
    { discrete: true }
  );

  ok(
    textOf(editorA) === "third-edited\n\nfirst\n\nsecond",
    `an edit to the moved block on B lands on the same block on A, not a duplicate (got ${JSON.stringify(textOf(editorA))})`
  );

  unbridge();
  bindingA.destroy();
  bindingB.destroy();
}

// --- Presence: local cursor resolves to {blockId, offset}, remote resolves back to a live node ---

{
  const editorA = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p1 = $createParagraphNode();
      p1.append($createTextNode("hello"));
      const p2 = $createParagraphNode();
      p2.append($createTextNode("world"));
      root.append(p1, p2);
    },
    { discrete: true }
  );

  let point: ReturnType<typeof resolveLocalCursorPoint> = null;
  editorA.getEditorState().read(() => {
    const secondParagraphText = ($getRoot().getChildren()[1] as any).getFirstChild();
    point = resolveLocalCursorPoint(bindingA, secondParagraphText, 3); // "wor|ld"
  });
  ok(point !== null, "resolveLocalCursorPoint resolves a point inside the second paragraph");
  ok((point as any)?.offset === 3, `offset within the block is 3, not accumulated across blocks (got ${(point as any)?.offset})`);

  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });

  const store = createPresenceStore();
  const peerA = "peer-a";
  setPresence(store, peerA, { user: { name: "Alice", color: "#4285f4" }, blockId: (point as any).blockId, offset: (point as any).offset });

  const resolved = resolveRemoteCursors(editorB, bindingB, store, "peer-b");
  ok(resolved.length === 1, `editor B resolves exactly one remote cursor (got ${resolved.length})`);
  ok(resolved[0]?.offset === 3, `resolved remote offset matches what was broadcast (got ${resolved[0]?.offset})`);
  editorB.getEditorState().read(() => {
    const node = resolved[0] && $getNodeByKey(resolved[0].nodeKey);
    ok(node?.getTextContent() === "world", `resolved remote node is editor B's own "world" paragraph (got ${JSON.stringify(node?.getTextContent())})`);
  });

  // Offset clamping: broadcast an offset past a block's current length (block shrank since the broadcast).
  setPresence(store, peerA, { user: { name: "Alice", color: "#4285f4" }, blockId: (point as any).blockId, offset: 999 });
  const clamped = resolveRemoteCursors(editorB, bindingB, store, "peer-b");
  ok(clamped[0]?.offset === "world".length, `an out-of-range offset is clamped to the block's current length, not left dangling (got ${clamped[0]?.offset})`);

  // A cursor on a block id that no longer exists anywhere is dropped, not crashed on.
  setPresence(store, peerA, { user: { name: "Alice", color: "#4285f4" }, blockId: "b-does-not-exist", offset: 0 });
  const dangling = resolveRemoteCursors(editorB, bindingB, store, "peer-b");
  ok(dangling.length === 0, "a cursor on a deleted/unknown block id is dropped rather than crashing");

  bindingA.destroy();
  bindingB.destroy();
}

// --- Presence offsets count through comment marks, links and inline images ---

{
  const editorA = newEditor();
  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      const mark = $createMarkNode(["c:x"]);
      mark.append($createTextNode("abc"));
      const link = $createLinkNode("https://example.com");
      link.append($createTextNode("lnk"));
      p.append(mark, $createTextNode("def"), $createImageNode({ src: "https://example.com/i.png" }), link, $createTextNode("gh"));
      root.append(p);
    },
    { discrete: true }
  );
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });
  const offsets: Record<string, number | undefined> = {};
  editorA.getEditorState().read(() => {
    const p = $getRoot().getFirstChild() as any;
    const [mark, def, , link, gh] = p.getChildren();
    offsets.inMark = resolveLocalCursorPoint(bindingA, mark.getFirstChild(), 2)?.offset; // ab|c
    offsets.afterMark = resolveLocalCursorPoint(bindingA, def, 2)?.offset; // abcde|f
    offsets.inLinkAfterImage = resolveLocalCursorPoint(bindingA, link.getFirstChild(), 1)?.offset; // abcdef + image + l|nk
    offsets.end = resolveLocalCursorPoint(bindingA, gh, 2)?.offset;
  });
  ok(offsets.inMark === 2, `a caret inside a comment mark flattens to its offset in the block (got ${offsets.inMark})`);
  ok(offsets.afterMark === 5, `a caret after a comment mark counts the marked text (got ${offsets.afterMark})`);
  ok(offsets.inLinkAfterImage === 8, `a caret inside a link after an image counts the image as one character (got ${offsets.inLinkAfterImage})`);
  ok(offsets.end === 12, `the end of the block is its full length (got ${offsets.end})`);

  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });
  const store = createPresenceStore();
  let blockId = "";
  editorA.getEditorState().read(() => (blockId = bindingA.blockIdForNode($getRoot().getFirstChild()!)));
  setPresence(store, "peer-a", { user: { name: "Alice", color: "#4285f4" }, blockId, offset: 8 });
  const [remote] = resolveRemoteCursors(editorB, bindingB, store, "peer-b");
  let landed = "";
  editorB.getEditorState().read(() => {
    const node = remote?.textNodeKey ? $getNodeByKey(remote.textNodeKey) : null;
    landed = `${node?.getTextContent()}@${remote?.textOffset}`;
  });
  ok(landed === "lnk@1", `the remote cursor resolves to the same spot in the other editor (got ${landed})`);

  bindingA.destroy();
  bindingB.destroy();
}

// --- A remote edit to one block must not rebuild unrelated blocks ---------
// (readChildrenInto used to unconditionally clear()+rebuild EVERY
// text-bearing block's children on every remote update, which would reset
// a local selection/cursor sitting in a completely untouched paragraph
// every time anyone typed anywhere else. Verified here by checking that an
// untouched paragraph's TextNode keeps the same NodeKey across a remote
// update to a DIFFERENT paragraph — a stable key is what lets Lexical keep
// a local selection anchored there intact.)

{
  const editorA = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });

  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p1 = $createParagraphNode();
      p1.append($createTextNode("untouched"));
      const p2 = $createParagraphNode();
      p2.append($createTextNode("will change"));
      root.append(p1, p2);
    },
    { discrete: true }
  );

  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });
  const unbridge = bridgeLoroDocs(docA, docB);

  let keyBefore = "";
  editorB.getEditorState().read(() => {
    keyBefore = ($getRoot().getChildren()[0] as any).getFirstChild().getKey();
  });

  editorA.update(
    () => {
      const textNode = ($getRoot().getChildren()[1] as any).getFirstChild();
      textNode.spliceText(0, 0, "it ", true);
    },
    { discrete: true }
  );

  ok(
    textOf(editorB) === "untouched\n\nit will change",
    `editor B received the edit to the second paragraph (got ${JSON.stringify(textOf(editorB))})`
  );

  let keyAfter = "";
  editorB.getEditorState().read(() => {
    keyAfter = ($getRoot().getChildren()[0] as any).getFirstChild().getKey();
  });
  ok(
    keyAfter === keyBefore,
    `the untouched first paragraph's TextNode keeps the same key across a remote edit to the second paragraph (before=${keyBefore}, after=${keyAfter})`
  );

  unbridge();
  bindingA.destroy();
  bindingB.destroy();
}

// --- Attribute-only changes to an existing block reach the other peer ---
//
// A peer that already has a block reuses its Lexical node on remote
// updates; that reuse must not ignore a changed type/attrs (a checked todo,
// a resized image, an edited table).

{
  const editorA = newEditor();
  const docA = new LoroDoc();
  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const list = $createListNode("check");
      const item = $createListItemNode(false);
      item.append($createTextNode("task"));
      list.append(item);
      const table = $createTableNodeWithDimensions(2, 2, false);
      (table.getFirstDescendant()!.getParent() as ReturnType<typeof $createParagraphNode>).append($createTextNode("cell"));
      const withImage = $createParagraphNode();
      withImage.append($createTextNode("see "), $createImageNode({ src: "https://example.com/a.png", width: 100 }), $createTextNode(" here"));
      root.append(list, withImage, table, $createParagraphNode());
    },
    { discrete: true }
  );
  const bindingA = createLoroBinding(editorA, { doc: docA });
  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });
  const unbridge = bridgeLoroDocs(docA, docB);

  ok(tableTextOf(editorB) === "cell", `a table's cell content syncs to the other peer (got ${JSON.stringify(tableTextOf(editorB))})`);
  let imageB: { src?: string; width?: unknown; around?: string } = {};
  editorB.getEditorState().read(() => {
    const p = $getRoot().getChildAtIndex(1) as any;
    const img = p.getChildAtIndex(1);
    imageB = { src: img?.__src, width: img?.__width, around: p.getTextContent() };
  });
  ok(
    imageB.src === "https://example.com/a.png" && imageB.width === 100 && imageB.around === "see  here",
    `an inline image syncs to the other peer in place (got ${JSON.stringify(imageB)})`
  );

  editorA.update(() => ($getRoot().getFirstChild() as any).getFirstChild().setChecked(true), { discrete: true });
  let checked: boolean | undefined;
  editorB.getEditorState().read(() => (checked = ($getRoot().getFirstChild() as any).getFirstChild().getChecked()));
  ok(checked === true, `checking a todo on one peer checks it on the other (got ${checked})`);

  editorA.update(() => (($getRoot().getChildAtIndex(1) as any).getChildAtIndex(1).getWritable().__width = 300), { discrete: true });
  let width: unknown;
  editorB.getEditorState().read(() => (width = ($getRoot().getChildAtIndex(1) as any).getChildAtIndex(1)?.__width));
  ok(width === 300, `resizing an image on one peer resizes it on the other (got ${width})`);

  editorA.update(
    () => {
      const cell = ($getRoot().getChildAtIndex(2) as any).getFirstDescendant();
      cell.setTextContent("edited cell");
    },
    { discrete: true }
  );
  ok(tableTextOf(editorB) === "edited cell", `editing a table cell on one peer updates the other (got ${JSON.stringify(tableTextOf(editorB))})`);

  // Nothing changed on B's side: a further unrelated remote edit must not rebuild B's unchanged blocks.
  let keysBefore: string[] = [];
  editorB.getEditorState().read(() => (keysBefore = $getRoot().getChildren().map((n) => n.getKey())));
  editorA.update(() => ($getRoot().getLastChild() as any).append($createTextNode("typing")), { discrete: true });
  let keysAfter: string[] = [];
  editorB.getEditorState().read(() => (keysAfter = $getRoot().getChildren().map((n) => n.getKey())));
  ok(JSON.stringify(keysBefore) === JSON.stringify(keysAfter), `unchanged blocks keep their nodes across an unrelated remote edit (${JSON.stringify(keysBefore)} -> ${JSON.stringify(keysAfter)})`);

  unbridge();
  bindingA.destroy();
  bindingB.destroy();
}

// --- Concurrent typing in one block keeps its formatting, links and comment/suggestion marks ---
//
// Inline structure is stored as marks on the block's LoroText, so it merges
// character by character along with the text (a whole-block formatting
// value would be last-writer-wins, and a length mismatch used to strip it).

{
  const editorA = newEditor();
  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      const comment = $createMarkNode(["c:t1"]);
      comment.append($createTextNode("hello"));
      const bold = $createTextNode(" bold");
      bold.toggleFormat("bold");
      const link = $createLinkNode("https://example.com");
      link.append($createTextNode(" link"));
      const suggestion = $createMarkNode(["si:s1"]);
      suggestion.append($createTextNode(" new"));
      p.append(comment, bold, link, suggestion, $createTextNode(" end"));
      root.append(p);
    },
    { discrete: true }
  );
  const docA = new LoroDoc();
  docA.setPeerId(1n);
  const bindingA = createLoroBinding(editorA, { doc: docA });
  const docB = new LoroDoc();
  docB.setPeerId(2n);
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });

  // Both type at the same time, not yet connected: A inside the bold word, B at the end.
  editorA.update(
    () => {
      const bold = ($getRoot().getFirstChild() as any).getChildAtIndex(1);
      bold.setTextContent(" bo!ld");
    },
    { discrete: true }
  );
  editorB.update(
    () => {
      const last = ($getRoot().getFirstChild() as any).getLastChild();
      last.setTextContent(" end?");
    },
    { discrete: true }
  );
  const fromA = docA.export({ mode: "update", from: docB.oplogVersion() });
  const fromB = docB.export({ mode: "update", from: docA.oplogVersion() });
  docB.import(fromA);
  docA.import(fromB);

  for (const [name, editor] of [["A", editorA], ["B", editorB]] as const) {
    let summary: Record<string, unknown> = {};
    editor.getEditorState().read(() => {
      const p = $getRoot().getFirstChild() as any;
      const bold = p.getAllTextNodes().find((t: any) => t.hasFormat("bold"));
      const link = p.getChildren().find((c: any) => $isLinkNode(c));
      const marks = p.getChildren().filter((c: any) => $isMarkNode(c)).map((m: any) => `${m.getIDs().join()}=${m.getTextContent()}`);
      summary = { text: p.getTextContent(), bold: bold?.getTextContent(), link: link?.getTextContent(), marks };
    });
    ok(
      summary.text === "hello bo!ld link new end?" &&
        summary.bold === " bo!ld" &&
        summary.link === " link" &&
        JSON.stringify(summary.marks) === JSON.stringify(["c:t1=hello", "si:s1= new"]),
      `peer ${name} keeps bold, link, comment and suggestion marks after concurrent typing (got ${JSON.stringify(summary)})`
    );
  }
  let listed: string[] = [];
  editorB.getEditorState().read(() => (listed = [...listSuggestions(editorB).values()].map((s) => s.inserted)));
  ok(JSON.stringify(listed) === JSON.stringify([" new"]), `the suggestion is still pending on the other peer (got ${JSON.stringify(listed)})`);

  bindingA.destroy();
  bindingB.destroy();
}

// --- A block written in the legacy `runs` shape still renders its formatting, and is migrated on the next edit ---

{
  const doc = new LoroDoc();
  const lb = doc.getMap("lb");
  const block = lb.ensureMergeableMap("blocks").ensureMergeableMap("old-1");
  block.set("type", "paragraph");
  block.set("attrs", {} as never);
  block.ensureMergeableText("text").update("plain bold");
  block.set("runs", [{ text: "plain ", formats: [] }, { text: "bold", formats: ["bold"] }] as never);
  lb.ensureMergeableMovableList("rootOrder").push("old-1");
  doc.commit();

  const editor = newEditor();
  const binding = createLoroBinding(editor, { doc });
  let bold: string | undefined;
  editor.getEditorState().read(() => (bold = ($getRoot().getFirstChild() as any).getAllTextNodes().find((t: any) => t.hasFormat("bold"))?.getTextContent()));
  ok(bold === "bold", `a legacy runs block renders its formatting (got ${bold})`);

  editor.update(() => ($getRoot().getFirstChild() as any).append($createTextNode("!")), { discrete: true });
  const text = block.get("text") as any;
  ok(
    block.get("runs") === undefined && JSON.stringify(text.toDelta()) === JSON.stringify([{ insert: "plain " }, { insert: "bold", attributes: { bold: true } }, { insert: "!" }]),
    `the next local edit migrates it to marks (got runs=${JSON.stringify(block.get("runs"))}, delta=${JSON.stringify(text.toDelta())})`
  );
  binding.destroy();
}

// --- A legacy top-level "image" block (written before images were inline) still renders ---

{
  const doc = new LoroDoc();
  const lb = doc.getMap("lb");
  const block = lb.ensureMergeableMap("blocks").ensureMergeableMap("img-1");
  block.set("type", "image");
  block.set("attrs", { src: "https://example.com/old.png", alt: "old" } as never);
  lb.ensureMergeableMovableList("rootOrder").push("img-1");
  doc.commit();

  const editor = newEditor();
  const binding = createLoroBinding(editor, { doc });
  let src: string | undefined;
  editor.getEditorState().read(() => (src = ($getRoot().getFirstChild() as any)?.getFirstChild()?.__src));
  ok(src === "https://example.com/old.png", `a legacy image block renders as an image inside a paragraph (got ${src})`);

  editor.update(() => ($getRoot().getFirstChild() as any).append($createTextNode(" caption")), { discrete: true });
  const stored = (lb.get("blocks") as any).get("img-1");
  ok(
    stored.get("type") === "paragraph" && stored.get("text").toDelta()[0]?.attributes?.image?.src === "https://example.com/old.png",
    `the next local edit rewrites it in the inline shape (got ${JSON.stringify(stored.toJSON())})`
  );
  binding.destroy();
}

// --- Work scales with what changed, not with the document ----------------

{
  const BLOCKS = 300;
  const editorA = newEditor();
  editorA.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (let i = 0; i < BLOCKS; i++) {
        const p = $createParagraphNode();
        const t = $createTextNode(`paragraph ${i} `);
        if (i % 3 === 0) t.toggleFormat("bold");
        p.append(t, $createTextNode("tail"));
        root.append(p);
      }
    },
    { discrete: true }
  );
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });
  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const editorB = newEditor();
  const bindingB = createLoroBinding(editorB, { doc: docB });
  const unbridge = bridgeLoroDocs(docA, docB);

  let dirtyOnB: string[] = [];
  const off = editorB.registerUpdateListener(({ dirtyElements }) => {
    dirtyOnB = [...dirtyElements.keys()];
  });
  const typeInto = (editor: ReturnType<typeof newEditor>, index: number, text: string) =>
    editor.update(
      () => {
        const last = ($getRoot().getChildAtIndex(index) as any).getLastChild();
        last.setTextContent(last.getTextContent() + text);
      },
      { discrete: true }
    );
  typeInto(editorA, 150, "!");
  let expected: string[] = [];
  editorB.getEditorState().read(() => (expected = ["root", $getRoot().getChildAtIndex(150)!.getKey()]));
  ok(
    dirtyOnB.length <= 2 && dirtyOnB.every((k) => expected.includes(k)),
    `a remote keystroke only dirties its own block on the other peer (dirtied ${dirtyOnB.length} elements)`
  );
  off();

  const start = performance.now();
  for (let i = 0; i < 100; i++) typeInto(editorA, i % BLOCKS, "x");
  const perKeystroke = (performance.now() - start) / 100;
  console.log(`      (${BLOCKS}-block doc, local keystroke + remote apply: ${perKeystroke.toFixed(2)} ms each)`);

  ok(
    bindingA.registeredIds() <= BLOCKS + 5 && bindingB.registeredIds() <= BLOCKS + 5,
    `block ids are only kept for blocks (A ${bindingA.registeredIds()}, B ${bindingB.registeredIds()}, blocks ${BLOCKS})`
  );

  unbridge();
  bindingA.destroy();
  bindingB.destroy();
}

// --- Undo/redo go through Loro's UndoManager ---------------------------
// With a collab binding there's no HistoryPlugin (it would restore whole old
// EditorStates, reverting remote peers' edits too), so Cmd+Z used to do
// nothing at all.

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function typeAtEnd(editor: ReturnType<typeof newEditor>, text: string) {
  editor.update(
    () => {
      const p = $getRoot().getLastChild() as any;
      const last = p.getLastDescendant?.() ?? null;
      if (last && last.getType() === "text") {
        last.select(last.getTextContentSize(), last.getTextContentSize());
      } else {
        p.selectEnd();
      }
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    },
    { discrete: true }
  );
}

function caretOffset(editor: ReturnType<typeof newEditor>) {
  let offset = -1;
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) offset = selection.anchor.offset;
  });
  return offset;
}

function press(editor: ReturnType<typeof newEditor>, command: typeof UNDO_COMMAND) {
  editor.update(() => void editor.dispatchCommand(command, undefined), { discrete: true });
}

{
  const editor = newEditor();
  const doc = new LoroDoc();
  const binding = createLoroBinding(editor, { doc });
  typeAtEnd(editor, "hello");
  await pause(600); // past the undo merge interval: a separate step
  typeAtEnd(editor, " world");
  ok(textOf(editor) === "hello world", `typed two steps (got ${JSON.stringify(textOf(editor))})`);

  press(editor, UNDO_COMMAND);
  ok(textOf(editor) === "hello", `undo reverts the last step only (got ${JSON.stringify(textOf(editor))})`);
  ok(caretOffset(editor) === 5, `undo puts the caret back where the edit started (got ${caretOffset(editor)})`);
  press(editor, UNDO_COMMAND);
  ok(textOf(editor) === "", `a second undo reverts the first step (got ${JSON.stringify(textOf(editor))})`);
  press(editor, REDO_COMMAND);
  press(editor, REDO_COMMAND);
  ok(textOf(editor) === "hello world", `redo re-applies both steps (got ${JSON.stringify(textOf(editor))})`);
  ok(caretOffset(editor) === 11, `redo puts the caret after the redone text (got ${caretOffset(editor)})`);

  await pause(600);
  typeAtEnd(editor, "!");
  press(editor, UNDO_COMMAND);
  ok(textOf(editor) === "hello world", `an edit after redo is its own undo step (got ${JSON.stringify(textOf(editor))})`);

  // A whole new block, undone and redone twice, comes back exactly once.
  await pause(600);
  editor.update(
    () => {
      const p = $createParagraphNode();
      p.append($createTextNode("second"));
      $getRoot().append(p);
    },
    { discrete: true }
  );
  press(editor, UNDO_COMMAND);
  press(editor, REDO_COMMAND);
  press(editor, UNDO_COMMAND);
  press(editor, REDO_COMMAND);
  ok(textOf(editor) === "hello world\n\nsecond", `undo/redo of a new block doesn't duplicate its text (got ${JSON.stringify(textOf(editor))})`);
  binding.destroy();
}

// Undo only reverts this peer's own edits, never a collaborator's.
{
  const editorA = newEditor();
  const docA = new LoroDoc();
  const bindingA = createLoroBinding(editorA, { doc: docA });
  typeAtEnd(editorA, "base");
  const editorB = newEditor();
  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const bindingB = createLoroBinding(editorB, { doc: docB });
  const unbridge = bridgeLoroDocs(docA, docB);

  await pause(600);
  typeAtEnd(editorA, " fromA");
  typeAtEnd(editorB, " fromB");
  ok(textOf(editorA) === "base fromA fromB", `both edits synced (got ${JSON.stringify(textOf(editorA))})`);

  press(editorA, UNDO_COMMAND);
  ok(textOf(editorA) === "base fromB", `A's undo removes only A's edit (got ${JSON.stringify(textOf(editorA))})`);
  ok(textOf(editorB) === "base fromB", `B sees A's undo and keeps its own edit (got ${JSON.stringify(textOf(editorB))})`);

  unbridge();
  bindingA.destroy();
  bindingB.destroy();
}

// Undo while suggesting reverts the suggestion instead of suggesting the undo.
{
  const editor = newEditor();
  const doc = new LoroDoc();
  const binding = createLoroBinding(editor, { doc });
  typeAtEnd(editor, "draft");
  await pause(600);
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");
  typeAtEnd(editor, " more");
  ok([...listSuggestions(editor).values()].some((s) => s.inserted === " more"), "suggesting: typed text is a pending insertion");

  press(editor, UNDO_COMMAND);
  ok(textOf(editor) === "draft", `undo while suggesting removes the suggested text (got ${JSON.stringify(textOf(editor))})`);
  ok(listSuggestions(editor).size === 0, `undo leaves no stray suggestion behind (got ${JSON.stringify([...listSuggestions(editor).values()])})`);

  press(editor, REDO_COMMAND);
  const redone = [...listSuggestions(editor).values()];
  ok(redone.length === 1 && redone[0].inserted === " more", `redo brings the suggestion back (got ${JSON.stringify(redone)})`);
  suggestion.acceptSuggestion(redone[0].suggestionId);
  ok(textOf(editor) === "draft more" && listSuggestions(editor).size === 0, `a suggestion rebuilt by redo can still be accepted (got ${JSON.stringify(textOf(editor))})`);

  suggestion.destroy();
  binding.destroy();
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All collab smoke tests passed.");
}
