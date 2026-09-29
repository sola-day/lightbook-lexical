import { createHeadlessEditor } from "@lexical/headless";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  $createTextNode,
  $createRangeSelection,
  $setSelection,
} from "lexical";
import { $isMarkNode } from "@lexical/mark";
import { LIGHTBOOK_NODES } from "../src/nodes";
import { markdownToNodes, nodesToMarkdown } from "../src/markdown";
import { addComment, listSuggestions, listThreads, removeComment } from "../src/comments/plugin";
import { HISTORIC_TAG, DELETE_CHARACTER_COMMAND, CUT_COMMAND } from "lexical";
import { registerRichText } from "@lexical/rich-text";
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

  const pending = [...listSuggestions(editor).values()];
  ok(pending.some((p) => p.inserted === "XY"), `listSuggestions reports the pending insertion (got ${JSON.stringify(pending)})`);
  ok(pending.some((p) => p.deleted === "de"), "listSuggestions reports the pending deletion");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  ok(pending.every((p) => uuid.test(p.suggestionId)), "suggestion ids are UUIDs (they double as server primary keys)");
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

// A "historic" update (undo/redo restoring an old EditorState onto
// brand-new node keys) must not be misread as a fresh insertion by the
// suggestion transform — see the $hasUpdateTag(HISTORIC_TAG) guard.
{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("abc"));
      root.append(p);
    },
    { discrete: true }
  );
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");

  // Simulate what undo/redo actually does: swap in a whole new text node
  // (a fresh, never-cached key) inside a `{ tag: HISTORIC_TAG }` update,
  // the same way Lexical's own history restoration is tagged.
  editor.update(
    () => {
      const root = $getRoot();
      const p = root.getFirstChild() as any;
      p.clear();
      p.append($createTextNode("xyz"));
    },
    { discrete: true, tag: HISTORIC_TAG }
  );

  ok(textOf(editor) === "xyz", `historic update applies normally (got ${JSON.stringify(textOf(editor))})`);
  ok(
    markIdsOf(editor).every((ids) => !ids.some(isSuggestionInsertMarkId) && !ids.some(isSuggestionDeleteMarkId)),
    "a historic (undo/redo) update is not tagged as a suggestion insert"
  );
}

// Overlapping ranges: a comment placed on text that's still a pending
// (unresolved) suggestion insertion. Further edits to that text should
// pass through as real edits (not get wrapped in a second, nested
// suggestion span) even though the immediate parent is now the comment's
// MarkNode, not the suggestion's — see the ancestor-walk in suggestion.ts.
{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("x"));
      root.append(p);
    },
    { discrete: true }
  );
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");

  editor.update(
    () => {
      const textNode = ($getRoot().getFirstChild() as any).getFirstChild() as import("lexical").TextNode;
      textNode.spliceText(0, 1, "hello", true);
    },
    { discrete: true }
  );
  // The replaced "x" stays visually present as a struck-through pending
  // suggestion_delete (see the earlier "deleted text ... is still present"
  // test) — suggestion mode never actually removes text until resolved.
  ok(textOf(editor) === "hellox", `typed text present before commenting (got ${JSON.stringify(textOf(editor))})`);
  ok(
    markIdsOf(editor).some((ids) => ids.some(isSuggestionInsertMarkId)),
    "typed text is wrapped in a suggestion_insert mark before commenting"
  );

  // Comment the whole (still-pending) suggestion span.
  editor.update(
    () => {
      const root = $getRoot();
      const textNode = (() => {
        let found: any = null;
        const walk = (node: any) => {
          if (node.getType?.() === "text" && node.getTextContent() === "hello") found = node;
          if (typeof node.getChildren === "function") for (const c of node.getChildren()) walk(c);
        };
        walk(root);
        return found;
      })();
      const selection = $createRangeSelection();
      selection.anchor.set(textNode.getKey(), 0, "text");
      selection.focus.set(textNode.getKey(), textNode.getTextContentSize(), "text");
      $setSelection(selection);
    },
    { discrete: true }
  );
  addComment(editor, { threadId: "t1" });

  const nestedBefore = markIdsOf(editor).filter(
    (ids) => ids.some(isSuggestionInsertMarkId)
  ).length;
  ok(nestedBefore === 1, `exactly one suggestion_insert mark exists after nesting a comment on it (got ${nestedBefore})`);

  // Now edit that same (comment-wrapped, still-pending-suggestion) text again.
  editor.update(
    () => {
      const walk = (node: any): any => {
        if (node.getType?.() === "text" && node.getTextContent() === "hello") return node;
        if (typeof node.getChildren === "function") {
          for (const c of node.getChildren()) {
            const found = walk(c);
            if (found) return found;
          }
        }
        return null;
      };
      const textNode = walk($getRoot());
      textNode.spliceText(textNode.getTextContentSize(), 0, " world", true);
    },
    { discrete: true }
  );

  ok(textOf(editor) === "hello worldx", `edit inside comment+suggestion nesting applies (got ${JSON.stringify(textOf(editor))})`);
  const insertMarkCount = markIdsOf(editor).filter((ids) => ids.some(isSuggestionInsertMarkId)).length;
  ok(
    insertMarkCount === 1,
    `editing text already inside a pending suggestion (nested under a comment) does not create a second, double-nested suggestion_insert mark (found ${insertMarkCount})`
  );
}

// Accepting/rejecting a suggestion should merge the neighbors exposed by
// unwrapping/removing its MarkNode back into one TextNode, instead of
// leaving the tree permanently fragmented by the earlier splitText() calls
// — see coalesceAdjacentTextNodes in suggestion.ts.
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
      textNode.spliceText(2, 2, "", true); // delete "cd" from the middle -> pending suggestion_delete
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

  suggestion.acceptSuggestion(suggestionId);
  ok(textOf(editor) === "abef", `accepting the deletion applies it (got ${JSON.stringify(textOf(editor))})`);

  const childCount = editor.getEditorState().read(() => {
    const p = $getRoot().getFirstChild() as any;
    return p.getChildrenSize();
  });
  ok(
    childCount === 1,
    `accepting a suggestion coalesces the exposed neighbors back into a single text node instead of leaving them fragmented (paragraph has ${childCount} children)`
  );
}

// resolve() must not silently no-op (or throw) on a suggestionId whose
// marks were already resolved once — the id-index is deleted after the
// first resolve, so a duplicate call has nothing to look up.
{
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode("abc"));
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
      textNode.spliceText(3, 0, "XYZ", true);
    },
    { discrete: true }
  );
  editor.getEditorState().read(() => {
    const walk = (node: any) => {
      if ($isMarkNode(node)) {
        const id = node.getIDs().find(isSuggestionInsertMarkId);
        if (id) suggestionId = id.slice("si:".length);
      }
      if (typeof node.getChildren === "function") for (const c of node.getChildren()) walk(c);
    };
    walk($getRoot());
  });

  suggestion.acceptSuggestion(suggestionId);
  ok(textOf(editor) === "abcXYZ", `first accept applies (got ${JSON.stringify(textOf(editor))})`);
  suggestion.acceptSuggestion(suggestionId); // duplicate resolve of an already-resolved id
  ok(textOf(editor) === "abcXYZ", `duplicate accept of an already-resolved id is a harmless no-op (got ${JSON.stringify(textOf(editor))})`);
}

// Typing character by character, and backspacing repeatedly, each extend one
// suggestion rather than creating one per keystroke.
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
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");

  for (const ch of " again") {
    editor.update(
      () => {
        const p = $getRoot().getFirstChild() as any;
        const last = p.getLastDescendant() as import("lexical").TextNode;
        // Lexical places the caret after the mark, so each keystroke becomes a sibling text node.
        const next = $createTextNode(ch);
        const topLevel = (last.getParent() === p ? last : last.getParent())!;
        topLevel.insertAfter(next);
      },
      { discrete: true }
    );
  }
  const typed = [...listSuggestions(editor).values()];
  ok(typed.length === 1 && typed[0].inserted === " again", `keystrokes extend one insertion suggestion (got ${JSON.stringify(typed)})`);

  suggestion.setSuggesting(null);
  suggestion.acceptSuggestion(typed[0].suggestionId);
  suggestion.setSuggesting("alice");

  for (let i = 0; i < 3; i++) {
    editor.update(
      () => {
        const p = $getRoot().getFirstChild() as any;
        // the untouched plain text node that precedes any pending deletion
        const plain = p.getChildren().find((c: any) => c.getType?.() === "text" && c.getTextContent().length > 0);
        plain.spliceText(plain.getTextContentSize() - 1, 1, "", true);
      },
      { discrete: true }
    );
  }
  const deleted = [...listSuggestions(editor).values()];
  ok(deleted.length === 1 && deleted[0].deleted === "ain", `repeated backspace extends one deletion suggestion (got ${JSON.stringify(deleted)})`);
}

// Backspace/Delete in suggesting mode go through DELETE_CHARACTER_COMMAND.
// Deleting the last remaining character of a text node used to lose it for
// real (Lexical removes the emptied node before any transform sees it) and
// leave the caret inside the struck-through span.
function pressDelete(editor: ReturnType<typeof newEditor>, isBackward: boolean, times: number) {
  for (let i = 0; i < times; i++) {
    editor.update(() => void editor.dispatchCommand(DELETE_CHARACTER_COMMAND, isBackward), { discrete: true });
  }
}

function deletedSuggestionTexts(editor: ReturnType<typeof newEditor>) {
  return [...listSuggestions(editor).values()].map((s) => s.deleted).filter(Boolean);
}

function typeAtCaret(editor: ReturnType<typeof newEditor>, text: string) {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertText(text);
  }, { discrete: true });
}

for (const [initial, isBackward, caret, presses, expectDeleted] of [
  ["jiang", true, 5, 5, "jiang"],
  ["hi jiang", true, 8, 5, "jiang"],
  ["jiang", false, 0, 5, "jiang"],
  ["jiang yo", false, 0, 6, "jiang "],
] as const) {
  const label = `${isBackward ? "Backspace" : "Delete"} x${presses} on ${JSON.stringify(initial)}`;
  const editor = newEditor();
  editor.update(() => {
    const p = $createParagraphNode();
    const t = $createTextNode(initial);
    p.append(t);
    $getRoot().clear().append(p);
    t.select(caret, caret);
  }, { discrete: true });
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");
  pressDelete(editor, isBackward, presses);

  ok(textOf(editor) === initial, `${label}: no character is really removed (got ${JSON.stringify(textOf(editor))})`);
  const deleted = deletedSuggestionTexts(editor);
  ok(deleted.length === 1 && deleted[0] === expectDeleted, `${label}: one deletion suggestion covering ${JSON.stringify(expectDeleted)} (got ${JSON.stringify(deleted)})`);

  typeAtCaret(editor, "X");
  const after = [...listSuggestions(editor).values()];
  ok(
    after.some((s) => s.inserted === "X") && after.some((s) => s.deleted === expectDeleted),
    `${label}: typing afterwards lands outside the struck span as its own insertion (got ${JSON.stringify(after)})`
  );

  const deletionId = after.find((s) => s.deleted)!.suggestionId;
  suggestion.rejectSuggestion(deletionId);
  ok(textOf(editor).replace("X", "") === initial, `${label}: rejecting restores the full text (got ${JSON.stringify(textOf(editor))})`);
}

// A non-collapsed selection is struck through as one suggestion, not removed.
{
  const editor = newEditor();
  editor.update(() => {
    const p = $createParagraphNode();
    const t = $createTextNode("hello world");
    p.append(t);
    $getRoot().clear().append(p);
    t.select(0, 5);
  }, { discrete: true });
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");
  pressDelete(editor, true, 1);
  ok(textOf(editor) === "hello world", `deleting a selection keeps the text (got ${JSON.stringify(textOf(editor))})`);
  ok(JSON.stringify(deletedSuggestionTexts(editor)) === '["hello"]', `the selection becomes one deletion suggestion (got ${JSON.stringify(deletedSuggestionTexts(editor))})`);
}

// A multi-character insertion while suggesting (paste, an IME-composed word)
// leaves the caret after the inserted text, not at its start.
{
  const editor = newEditor();
  editor.update(() => {
    const p = $createParagraphNode();
    const t = $createTextNode("abc");
    p.append(t);
    $getRoot().clear().append(p);
    t.select(3, 3);
  }, { discrete: true });
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");
  for (const [label, text] of [["at the end", "XYZ"], ["continuing it", "12"]] as const) {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    }, { discrete: true });
    let caret = "";
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const node = selection.anchor.getNode();
        caret = `${selection.anchor.type}:${node.getTextContent()}@${selection.anchor.offset}`;
      }
    });
    const inserted = [...listSuggestions(editor).values()].map((s) => s.inserted).join();
    ok(caret === `text:${inserted}@${inserted.length}`, `multi-character insertion ${label}: caret ends after it (got ${caret}, inserted ${JSON.stringify(inserted)})`);
  }
  suggestion.destroy();
}

// Cmd+X while suggesting strikes the selection through instead of cutting it,
// including a whole text node (Lexical removes an emptied node outright, so
// the transform never sees it).
{
  // Lexical's cut path checks `event instanceof ClipboardEvent`; Node has none.
  // Stubbed so the cut goes through its real path; headless there is no DOM
  // selection, so the copy step copies nothing.
  class ClipboardEvent {
    clipboardData = null;
    preventDefault() {}
  }
  (globalThis as any).ClipboardEvent ??= ClipboardEvent;
  const cutEvent = () => new (globalThis as any).ClipboardEvent();
  const editor = newEditor();
  const unregisterRichText = registerRichText(editor);
  editor.update(() => {
    const p = $createParagraphNode();
    const bold = $createTextNode("gone").toggleFormat("bold");
    p.append($createTextNode("keep "), bold, $createTextNode(" tail"));
    $getRoot().clear().append(p);
    bold.select(0, 4);
  }, { discrete: true });
  const suggestion = createSuggestionController(editor);
  suggestion.setSuggesting("alice");
  editor.dispatchCommand(CUT_COMMAND, cutEvent());
  await new Promise((resolve) => setTimeout(resolve, 20));
  ok(textOf(editor) === "keep gone tail", `cutting while suggesting keeps the text (got ${JSON.stringify(textOf(editor))})`);
  ok(JSON.stringify(deletedSuggestionTexts(editor)) === '["gone"]', `the cut becomes one deletion suggestion (got ${JSON.stringify(deletedSuggestionTexts(editor))})`);

  // Not suggesting: a cut really removes the text.
  suggestion.setSuggesting(null);
  editor.update(() => {
    const p = $getRoot().getFirstChildOrThrow() as import("lexical").ElementNode;
    const first = p.getFirstDescendant() as import("lexical").TextNode;
    first.select(0, 4);
  }, { discrete: true });
  editor.dispatchCommand(CUT_COMMAND, cutEvent());
  await new Promise((resolve) => setTimeout(resolve, 20));
  ok(!textOf(editor).startsWith("keep"), `outside suggesting, cut still removes text (got ${JSON.stringify(textOf(editor))})`);
  suggestion.destroy();
  unregisterRichText();
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All smoke tests passed.");
}
