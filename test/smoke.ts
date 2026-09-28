import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $getSelection, $isRangeSelection, $createParagraphNode, $createTextNode } from "lexical";
import { $isMarkNode } from "@lexical/mark";
import { LIGHTBOOK_NODES } from "../src/nodes";
import { markdownToNodes, nodesToMarkdown } from "../src/markdown";
import { addComment, listThreads, removeComment } from "../src/comments/plugin";
import { createSuggestionController } from "../src/comments/suggestion";
import { isSuggestionInsertMarkId, isSuggestionDeleteMarkId } from "../src/comments/ids";

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
    namespace: "smoke-test",
    nodes: LIGHTBOOK_NODES,
    onError(error) {
      throw error;
    },
  });
}

// --- Markdown round-trips ---------------------------------------------------

{
  const editor = newEditor();
  editor.update(
    () => {
      markdownToNodes(
        $getRoot(),
        [
          "# Title",
          "",
          "Some **bold** and *italic* and ~~strike~~ and `code` text.",
          "",
          "| a | b |",
          "| --- | --- |",
          "| 1 | 2 |",
          "",
          "- [ ] todo one",
          "- [x] todo two",
          "",
          "![alt text](https://example.com/img.png)",
        ].join("\n")
      );
    },
    { discrete: true }
  );

  editor.getEditorState().read(() => {
    const root = $getRoot();
    const text = root.getTextContent();
    ok(text.includes("Title"), "heading text imported");
    ok(text.includes("bold") && text.includes("italic") && text.includes("strike") && text.includes("code"), "inline-format text imported");
    ok(text.includes("todo one") && text.includes("todo two"), "checklist items imported");
  });

  editor.getEditorState().read(() => {
    const md = nodesToMarkdown($getRoot());
    ok(md.includes("**bold**"), "bold survives markdown export");
    ok(md.includes("*italic*"), "italic survives markdown export");
    ok(md.includes("~~strike~~"), "strikethrough survives markdown export");
    ok(md.includes("`code`"), "inline code survives markdown export");
    ok(/\|\s*a\s*\|\s*b\s*\|/.test(md), "table header exports as GFM table");
    ok(md.includes("- [ ] todo one") || md.includes("-   [ ] todo one"), "unchecked task list round-trips");
    ok(md.includes("- [x] todo two") || md.includes("-   [x] todo two"), "checked task list round-trips");
    ok(md.includes("![alt text]"), "image round-trips through markdown");
  });
}

// underline/subscript/superscript round-trip
{
  const editor = newEditor();
  editor.update(() => markdownToNodes($getRoot(), "++under++ and ~sub~ and ^sup^"), { discrete: true });
  editor.getEditorState().read(() => {
    const md = nodesToMarkdown($getRoot());
    ok(md.includes("++under++"), "underline round-trips via ++text++");
    ok(md.includes("~sub~"), "subscript round-trips via ~text~");
    ok(md.includes("^sup^"), "superscript round-trips via ^text^");
  });
}

// notice / callout
{
  const editor = newEditor();
  editor.update(() => markdownToNodes($getRoot(), "> [!warning] Careful now"), { discrete: true });
  editor.getEditorState().read(() => {
    const md = nodesToMarkdown($getRoot());
    ok(md.includes("[!warning]"), "notice/callout round-trips");
    ok($getRoot().getTextContent().includes("Careful now"), "notice content imported");
  });
}

// video
{
  const editor = newEditor();
  editor.update(() => markdownToNodes($getRoot(), "[video](https://example.com/clip.mp4)"), { discrete: true });
  editor.getEditorState().read(() => {
    const md = nodesToMarkdown($getRoot());
    ok(md.includes("[video](https://example.com/clip.mp4)"), "video node round-trips through markdown");
  });
}

// --- Comments -----------------------------------------------------------

{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("Hello world"));
      root.append(p);
    },
    { discrete: true }
  );
  editor.update(
    () => {
      const root = $getRoot();
      const textNode = (root.getFirstChild() as any).getFirstChild()!;
      const sel = textNode.select(0, 5); // "Hello"
      void sel;
    },
    { discrete: true }
  );
  const applied = addComment(editor, { threadId: "t1" });
  ok(applied, "comment applies to a non-collapsed selection");

  const threads = listThreads(editor);
  ok(threads.has("t1") && threads.get("t1")!.text === "Hello", `comment thread anchors to selected text (got ${JSON.stringify(threads.get("t1")?.text)})`);

  const removed = removeComment(editor, "t1");
  ok(removed, "comment removal reports success");
  ok(listThreads(editor).size === 0, "comment thread removal clears the anchor");
}

// --- Suggestion mode ------------------------------------------------------

function textOf(editor: ReturnType<typeof newEditor>) {
  let text = "";
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

function markIdsOf(editor: ReturnType<typeof newEditor>) {
  const all: string[][] = [];
  editor.getEditorState().read(() => {
    const walk = (node: import("lexical").LexicalNode) => {
      if ($isMarkNode(node)) all.push([...node.getIDs()]);
      if ("getChildren" in node && typeof (node as any).getChildren === "function") {
        for (const child of (node as any).getChildren()) walk(child);
      }
    };
    walk($getRoot());
  });
  return all;
}

{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("abcdef"));
      root.append(p);
    },
    { discrete: true }
  );

  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");
  ok(suggestion.isSuggesting(), "suggesting mode toggles on");

  // Insert "XY" between "abc" and "def" -> "abcXYdef"
  editor.update(
    () => {
      const textNode = ($getRoot().getFirstChild() as any).getFirstChild() as import("lexical").TextNode;
      textNode.spliceText(3, 0, "XY", true);
    },
    { discrete: true }
  );

  ok(textOf(editor) === "abcXYdef", `typed insertion is visible in document text (got ${JSON.stringify(textOf(editor))})`);
  const idsAfterInsert = markIdsOf(editor);
  ok(idsAfterInsert.some((ids) => ids.some(isSuggestionInsertMarkId)), "inserted text is wrapped in a suggestion_insert mark");

  // Now select and delete 2 real chars ("cd" is now "cXYd" region; delete "de" from the untouched tail)
  editor.update(
    () => {
      const root = $getRoot();
      const paragraph = root.getFirstChild() as any;
      // Find the plain-text node holding the tail "def" (after XY's mark).
      let tail: import("lexical").TextNode | null = null;
      paragraph.getChildren().forEach((child: any) => {
        if (child.getType?.() === "text" && child.getTextContent().startsWith("def")) tail = child;
      });
      ok(tail !== null, "found the untouched tail text node after insertion");
      if (tail) {
        (tail as import("lexical").TextNode).spliceText(0, 2, "", true); // delete "de" -> "f" remains in this node
      }
    },
    { discrete: true }
  );

  ok(textOf(editor).includes("de"), `deleted text "de" is still present (struck through), not actually removed (got ${JSON.stringify(textOf(editor))})`);
  const idsAfterDelete = markIdsOf(editor);
  ok(idsAfterDelete.some((ids) => ids.some(isSuggestionDeleteMarkId)), "deleted text is wrapped in a suggestion_delete mark");
  ok(
    !idsAfterDelete.some((ids) => ids.some(isSuggestionInsertMarkId) && ids.some(isSuggestionDeleteMarkId)),
    "no MarkNode is tagged both suggestion_insert and suggestion_delete"
  );
}

// Backspacing your own still-pending suggestion_insert should really delete it, not double-tag it.
{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      // Note: NOT an empty TextNode — Lexical's own node normalization
      // removes a stray empty TextNode between updates (a paragraph is
      // allowed to have zero children), so `getFirstChild()` on the
      // paragraph would come back null in the next update.
      root.append(p);
    },
    { discrete: true }
  );
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");

  editor.update(
    () => {
      const paragraph = $getRoot().getFirstChild() as any;
      paragraph.append($createTextNode("Suggesting"));
    },
    { discrete: true }
  );
  ok(textOf(editor) === "Suggesting", `typed text is present (got ${JSON.stringify(textOf(editor))})`);

  editor.update(
    () => {
      const root = $getRoot();
      let insertText: import("lexical").TextNode | null = null;
      const walk = (node: any) => {
        if (node.getType?.() === "text" && node.getTextContent() === "Suggesting") insertText = node;
        if (typeof node.getChildren === "function") for (const c of node.getChildren()) walk(c);
      };
      walk(root);
      if (insertText) (insertText as import("lexical").TextNode).spliceText(9, 1, "", true); // backspace the trailing "g"
    },
    { discrete: true }
  );

  ok(textOf(editor) === "Suggestin", `backspacing your own pending insertion actually removes it (got ${JSON.stringify(textOf(editor))})`);
  const idsAfterSelfBackspace = markIdsOf(editor);
  ok(
    !idsAfterSelfBackspace.some((ids) => ids.some(isSuggestionInsertMarkId) && ids.some(isSuggestionDeleteMarkId)),
    "no MarkNode ends up tagged both suggestion_insert and suggestion_delete after self-backspace"
  );
}

// Accept / reject
{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("abcdef"));
      root.append(p);
    },
    { discrete: true }
  );
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");

  let suggestionId = "";
  editor.update(
    () => {
      const textNode = ($getRoot().getFirstChild() as any).getFirstChild() as import("lexical").TextNode;
      textNode.spliceText(3, 3, "", true); // delete "def" entirely
    },
    { discrete: true }
  );
  editor.getEditorState().read(() => {
    const walk = (node: any) => {
      if ($isMarkNode(node)) {
        const id = node.getIDs().find(isSuggestionDeleteMarkId);
        if (id) suggestionId = id.slice("sd:".length);
      }
      if (typeof node.getChildren === "function") for (const c of node.getChildren()) walk(c);
    };
    walk($getRoot());
  });
  ok(suggestionId !== "", "captured the suggestion id of the tracked deletion");

  suggestion.acceptSuggestion(suggestionId);
  ok(textOf(editor) === "abc", `accepting a deletion suggestion actually removes the text (got ${JSON.stringify(textOf(editor))})`);
}

{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("abcdef"));
      root.append(p);
    },
    { discrete: true }
  );
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");

  let suggestionId = "";
  editor.update(
    () => {
      const textNode = ($getRoot().getFirstChild() as any).getFirstChild() as import("lexical").TextNode;
      textNode.spliceText(3, 3, "", true);
    },
    { discrete: true }
  );
  editor.getEditorState().read(() => {
    const walk = (node: any) => {
      if ($isMarkNode(node)) {
        const id = node.getIDs().find(isSuggestionDeleteMarkId);
        if (id) suggestionId = id.slice("sd:".length);
      }
      if (typeof node.getChildren === "function") for (const c of node.getChildren()) walk(c);
    };
    walk($getRoot());
  });

  suggestion.rejectSuggestion(suggestionId);
  ok(textOf(editor) === "abcdef", `rejecting a deletion suggestion restores the text (got ${JSON.stringify(textOf(editor))})`);
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All smoke tests passed.");
}
