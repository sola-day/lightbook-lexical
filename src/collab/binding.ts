import {
  LoroMap,
  LoroMovableList,
  LoroText,
  UndoManager,
  type Cursor,
  type LoroDoc,
  type LoroEventBatch,
} from "loro-crdt";
import {
  $addUpdateTag,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_EDITOR,
  REDO_COMMAND,
  UNDO_COMMAND,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type PointType,
} from "lexical";
import { $isListItemNode, $isListNode } from "@lexical/list";
import { lexicalNodeToBlockSpec, type BlockSpec, type TextRun } from "./blockSpec";
import { $flattenPoint, $locateFlatOffset } from "./caret";
import { canonicalRuns, configureTextStyles, hasMarks, readRunMarks, writeRunMarks } from "./richText";
import { applyTextRuns, createLexicalNodeForType } from "./buildLexicalNode";
import { BlockIdRegistry } from "./blockIdRegistry";

const LORO_REMOTE_TAG = "lb-loro-remote-apply";
const ROOT_ORDER_KEY = "rootOrder";
const BLOCKS_KEY = "blocks";

/**
 * `JSON.stringify` compares object key ORDER, not just content — and Loro
 * does not preserve a plain object value's original key order when it
 * round-trips through map storage (observed: `{text, formats}` written
 * locally comes back as `{formats, text}`). A raw `JSON.stringify`
 * equality check between a freshly-computed spec and a Loro-stored one is
 * therefore unreliable — it can report "changed" for content that's
 * actually identical. This recursively sorts object keys (arrays keep
 * their order) before stringifying so the comparison is by content, not by
 * incidental key order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Loro CRDT binding for lightbook-lexical — the "simple tier" from the
 * README's status table, not a full node-level binding like
 * lightbook-prosemirror's (which reuses the official `loro-prosemirror`
 * package; no `loro-lexical` equivalent exists).
 *
 * Document shape in the `LoroDoc`, under `doc.getMap("lb")`:
 *   - `rootOrder`: a mergeable `LoroMovableList<string>` of root-level block ids,
 *     in order.
 *   - `blocks`: a mergeable `LoroMap<string, LoroMap>` from block id to
 *     that block's own container map, with:
 *       - `type` / `attrs`: plain (non-CRDT) values, overwritten wholesale
 *         on every change that touches them.
 *       - `text` (text-bearing types only): a mergeable `LoroText` whose
 *         characters merge via Loro's Fugue algorithm, and whose marks
 *         carry the block's inline structure (formatting, links,
 *         comment/suggestion marks, inline images; see `richText.ts`), so
 *         two peers typing concurrently in the same formatted, commented
 *         paragraph converge without losing either.
 *       - `runs` (legacy, read only): the whole-block formatting value
 *         older documents used; dropped on the block's next local edit.
 *       - `childOrder` (container types only): a mergeable
 *         `LoroMovableList<string>` of this block's own children's ids, same
 *         shape as `rootOrder` one level down — recursion, not a flat
 *         per-type table.
 *
 *   The two top-level containers are `ensureMergeable*` so every peer's
 *   copy converges on one; they are created when a binding starts, outside
 *   undo history. Per-block containers are plain `setContainer` children:
 *   block ids are random per creator, so there is nothing to converge,
 *   and Loro's redo of a mergeable container's creation duplicates its
 *   contents (undo + redo of a new paragraph doubled its text).
 *
 * Known v1 scope cuts (all documented in the README too):
 *   - Blockquotes flatten to one text block (no nested multi-paragraph
 *     merge); tables sync as an opaque whole-node JSON snapshot
 *     (last-write-wins, no per-cell merge).
 *
 * Undo/redo goes through Loro's `UndoManager` rather than Lexical's
 * `HistoryPlugin` (which would restore whole old EditorStates and so revert
 * remote peers' concurrent edits too): only this peer's own commits are
 * undone, and the result flows back into Lexical like a remote update.
 *
 * Remote cursor / presence (who's editing where) is a separate optional
 * layer on top of this binding — see `presence.ts` and `LoroCollabPlugin`'s
 * `presence` prop, addressed with the same `{blockId, offset}` ids/text
 * flattening this file uses for content.
 */
export interface LoroBindingOptions {
  doc: LoroDoc;
}

export interface LoroBinding {
  destroy(): void;
  /** The block id a given Lexical node currently maps to, if any — for the presence layer (`presence.ts`). */
  blockIdForNode(node: LexicalNode): string;
  /** The current `NodeKey` a given block id maps to, if the doc still has it. */
  nodeKeyForBlockId(id: string): NodeKey | undefined;
}


function rootMap(doc: LoroDoc): LoroMap {
  return doc.getMap("lb");
}

// --- Lexical -> Loro ---------------------------------------------------

function childMap(parent: LoroMap, key: string): LoroMap {
  const existing = parent.get(key);
  return existing instanceof LoroMap ? existing : parent.setContainer(key, new LoroMap());
}

function childText(parent: LoroMap, key: string): LoroText {
  const existing = parent.get(key);
  return existing instanceof LoroText ? existing : parent.setContainer(key, new LoroText());
}

function childList(parent: LoroMap, key: string): LoroMovableList {
  const existing = parent.get(key);
  return existing instanceof LoroMovableList ? existing : parent.setContainer(key, new LoroMovableList());
}

/**
 * What each block's text and marks were last written as, so a keystroke in
 * one block doesn't re-read every other block's marks. Only a shortcut: a
 * miss just reconciles against the doc.
 */
type WrittenCache = Map<string, string>;

function writeAttrsAndText(id: string, block: LoroMap, spec: BlockSpec, written: WrittenCache) {
  if (block.get("type") !== spec.type) block.set("type", spec.type);
  const prevAttrsJSON = stableStringify(block.get("attrs") ?? null);
  const nextAttrsJSON = stableStringify(spec.attrs ?? null);
  if (prevAttrsJSON !== nextAttrsJSON) block.set("attrs", spec.attrs as never);

  if (spec.text !== undefined) {
    const textContainer = childText(block, "text");
    const runs = spec.runs ? canonicalRuns(spec.runs) : undefined;
    const key = stableStringify([spec.text, runs ?? null]);
    if (written.get(id) === key && block.get("runs") === undefined) return;
    if (textContainer.toString() !== spec.text) textContainer.update(spec.text);
    if (runs) writeRunMarks(textContainer, runs);
    // Legacy: formatting used to be a whole-block `runs` value.
    if (block.get("runs") !== undefined) block.delete("runs");
    written.set(id, key);
  }
}

/**
 * Reconciles `list` to `targetIds` using `LoroMovableList`'s real `move()`
 * op for anything that's just changed position, instead of deleting and
 * re-inserting everything. That distinction matters under concurrency: a
 * delete+insert looks to Loro like "this block was destroyed and a new one
 * was created at the same id" for that op, so a concurrent edit to that
 * block's own text racing against someone else reordering it is more
 * likely to collide; a real `move()` preserves the block's identity
 * through the reorder, so the concurrent text edit and the move merge
 * cleanly instead.
 */
function reconcileOrder(list: LoroMovableList, targetIds: string[]) {
  let current = list.toArray() as string[];
  if (current.length === targetIds.length && current.every((v, i) => v === targetIds[i])) return;

  const targetSet = new Set(targetIds);
  for (let i = current.length - 1; i >= 0; i--) {
    if (!targetSet.has(current[i])) list.delete(i, 1);
  }
  current = list.toArray() as string[];

  const currentSet = new Set(current);
  for (let i = 0; i < targetIds.length; i++) {
    if (!currentSet.has(targetIds[i])) {
      list.insert(i, targetIds[i]);
      currentSet.add(targetIds[i]);
      current = list.toArray() as string[];
    }
  }

  // Same set now, possibly different order — fix it with real moves.
  for (let i = 0; i < targetIds.length; i++) {
    if (current[i] === targetIds[i]) continue;
    const from = current.indexOf(targetIds[i], i);
    list.move(from, i);
    current = list.toArray() as string[];
  }
}

function writeChildren(
  blocksMap: LoroMap,
  orderList: LoroMovableList,
  nodes: LexicalNode[],
  ids: BlockIdRegistry,
  written: WrittenCache
) {
  const currentIds: string[] = [];
  for (const node of nodes) {
    const spec = lexicalNodeToBlockSpec(node);
    if (!spec) continue;
    const id = ids.idFor(node);
    currentIds.push(id);
    const block = childMap(blocksMap, id);
    writeAttrsAndText(id, block, spec, written);
    if (spec.children !== undefined) {
      const childOrder = childList(block, "childOrder");
      writeChildren(blocksMap, childOrder, spec.children, ids, written);
    }
  }
  reconcileOrder(orderList, currentIds);
}

function writeLexicalToLoro(doc: LoroDoc, root: ElementNode, ids: BlockIdRegistry, written: WrittenCache) {
  const lb = rootMap(doc);
  const orderList = lb.ensureMergeableMovableList(ROOT_ORDER_KEY);
  const blocksMap = lb.ensureMergeableMap(BLOCKS_KEY);
  writeChildren(blocksMap, orderList, root.getChildren(), ids, written);
  doc.commit({ origin: "lb-local-edit" });
}

// --- Loro -> Lexical ---------------------------------------------------

/** Attrs as compared across peers: key order and null-vs-missing don't count as differences. */
function attrsKey(attrs: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(attrs ?? {})), (_key, val) => (val === null ? undefined : val));
}

/**
 * Which stored `type`+`attrs` each node was last built or updated from. A
 * node rebuilt from the doc doesn't always re-export byte-identical attrs
 * (a table's import fills in defaults like `height: 0`), so "the doc still
 * says what this node was built from" counts as a match too.
 */
type BuiltFrom = Map<NodeKey, string>;

/** Whether a live node still is what the doc says this block is (same type and attrs). */
function $matchesBlock(node: LexicalNode, type: string, attrs: Record<string, unknown>, built: BuiltFrom): boolean {
  const stored = `${type}:${attrsKey(attrs)}`;
  if (built.get(node.getKey()) === stored) return true;
  const spec = lexicalNodeToBlockSpec(node);
  return !!spec && `${spec.type}:${attrsKey(spec.attrs)}` === stored;
}

/** Applies an attrs-only change to a live node where that's a plain setter, keeping its key (and any caret in it). */
function $updateAttrsInPlace(node: LexicalNode, type: string, attrs: Record<string, unknown>, built: BuiltFrom): boolean {
  if (type === "listitem" && $isListItemNode(node)) {
    node.setChecked((attrs.checked as boolean | null) ?? undefined);
    return $matchesBlock(node, type, attrs, built);
  }
  return false;
}

/** The editor holds nothing but one empty paragraph. */
function $isPlaceholderOnly(): boolean {
  const root = $getRoot();
  const only = root.getFirstChild();
  return root.getChildrenSize() === 1 && $isParagraphNode(only) && only.getChildrenSize() === 0;
}

/** True when every `blocksMap`/`orderList` entry referenced actually resolves — used to detect "empty doc". */
function isLoroDocEmpty(doc: LoroDoc): boolean {
  const lb = rootMap(doc);
  const orderList = lb.get(ROOT_ORDER_KEY) as LoroMovableList | undefined;
  return !orderList || orderList.length === 0;
}

function readChildrenInto(
  parent: ElementNode,
  blocksMap: LoroMap,
  orderList: LoroMovableList,
  ids: BlockIdRegistry,
  reuse: Map<string, LexicalNode>,
  built: BuiltFrom
) {
  const targetIds = orderList.toArray() as string[];
  const nextChildren: LexicalNode[] = [];

  for (const id of targetIds) {
    const block = blocksMap.get(id) as LoroMap | undefined;
    if (!block) continue;
    const type = (block.get("type") as string) ?? "paragraph";
    const attrs = (block.get("attrs") as Record<string, unknown>) ?? {};

    // A reused node may be stale: a peer changed this block's type or attrs
    // (checked a todo, resized an image, edited a table...). Update it in
    // place when that's a simple setter, otherwise rebuild it.
    let node = reuse.get(id);
    if (node && !$matchesBlock(node, type, attrs, built) && !$updateAttrsInPlace(node, type, attrs, built)) node = undefined;
    if (!node) {
      node = createLexicalNodeForType(type, attrs);
      ids.bind(node, id);
      built.set(node.getKey(), `${type}:${attrsKey(attrs)}`);
    }
    nextChildren.push(node);

    const textContainer = block.get("text") as LoroText | undefined;
    if (textContainer != null && $isElementNode(node)) {
      const text = textContainer.toString();
      // Code blocks are plain text; everything else carries its inline
      // structure as marks (or, written before that, a legacy `runs` value).
      const legacyRuns = block.get("runs") as TextRun[] | undefined;
      const runs = type === "code" ? undefined : legacyRuns && !hasMarks(textContainer) ? legacyRuns : readRunMarks(textContainer);
      // `applyTextRuns` destructively `clear()`s and rebuilds the block's
      // text children, which resets any local selection anchored inside
      // it. `readChildrenInto` walks and re-applies EVERY block on every
      // remote update (not just the one that actually changed), so
      // without this guard, typing in paragraph 5 would reset a local
      // cursor sitting in paragraph 1 too, every keystroke. Skip the
      // rebuild when this block's own current content already matches.
      const currentSpec = lexicalNodeToBlockSpec(node);
      const textChanged = currentSpec?.text !== text;
      const runsChanged =
        stableStringify(canonicalRuns(currentSpec?.runs ?? [])) !== stableStringify(canonicalRuns(runs ?? []));
      if (textChanged || runsChanged) {
        applyTextRuns(node, text, runs);
      }
    }

    const childOrder = block.get("childOrder") as LoroMovableList | undefined;
    if (childOrder && $isElementNode(node)) {
      readChildrenInto(node, blocksMap, childOrder, ids, reuse, built);
    }
  }

  const nextKeys = new Set(nextChildren.map((c) => c.getKey()));
  for (const child of parent.getChildren()) {
    if (!nextKeys.has(child.getKey())) child.remove();
  }
  // `append()` on an already-attached child moves it, so replaying
  // `nextChildren` in order both inserts new nodes and fixes ordering for
  // reused ones in a single pass.
  for (const child of nextChildren) {
    parent.append(child);
  }
}

function $applyLoroToLexical(doc: LoroDoc, ids: BlockIdRegistry, reuse: Map<string, LexicalNode>, built: BuiltFrom) {
  const lb = rootMap(doc);
  const orderList = lb.get(ROOT_ORDER_KEY) as LoroMovableList | undefined;
  const blocksMap = lb.get(BLOCKS_KEY) as LoroMap | undefined;
  const root = $getRoot();
  if (orderList && blocksMap) {
    readChildrenInto(root, blocksMap, orderList, ids, reuse, built);
  } else {
    // No containers at all (e.g. undoing a page's very first edit removed
    // them): an empty page.
    root.clear();
  }
  if (root.getChildrenSize() === 0) {
    root.append(createLexicalNodeForType("paragraph", {}));
  }
}

// `COLLABORATION_TAG` lets other transforms (the suggestion controller)
// tell content arriving from the CRDT apart from local typing.
const REMOTE_APPLY_TAGS = [LORO_REMOTE_TAG, COLLABORATION_TAG];

function readLoroToLexical(
  editor: LexicalEditor,
  doc: LoroDoc,
  ids: BlockIdRegistry,
  reuse: Map<string, LexicalNode>,
  built: BuiltFrom
) {
  editor.update(() => $applyLoroToLexical(doc, ids, reuse, built), { tag: REMOTE_APPLY_TAGS, discrete: true });
}

// --- Caret <-> {blockId, offset} (for undo/redo) -------------------------

interface BlockCaret {
  blockId: string;
  /** Flattened character offset within the block's text (same units as `blockSpec.ts`'s `text`). */
  offset: number;
}

function $caretOfPoint(point: PointType, ids: BlockIdRegistry): BlockCaret | null {
  const flat = $flattenPoint(point.getNode(), point.offset);
  return flat ? { blockId: ids.idFor(flat.block), offset: flat.offset } : null;
}

function $readCaret(ids: BlockIdRegistry): BlockCaret | null {
  const selection = $getSelection();
  return $isRangeSelection(selection) ? $caretOfPoint(selection.anchor, ids) : null;
}

function $restoreCaret(caret: BlockCaret, ids: BlockIdRegistry) {
  const key = ids.keyForId(caret.blockId);
  const block = key ? $getNodeByKey(key) : null;
  if (!$isElementNode(block)) return;
  const at = $locateFlatOffset(block, caret.offset);
  if (at) at.node.select(at.offset, at.offset);
  else block.selectEnd();
}

function readCaretIn(state: EditorState, ids: BlockIdRegistry): BlockCaret | null {
  return state.read(() => $readCaret(ids));
}

/** Rebuilds `reuse` (id -> current Lexical node) by walking the live tree, so the next Loro->Lexical pass can update nodes in place instead of recreating them (which would lose local cursor/DOM state). */
function rebuildReuseMap(editor: LexicalEditor, ids: BlockIdRegistry): Map<string, LexicalNode> {
  const reuse = new Map<string, LexicalNode>();
  editor.getEditorState().read(() => {
    const walk = (node: LexicalNode) => {
      // Only nodes the binding created/bound carry a known id; harmless to
      // skip ones that don't (e.g. before the first sync pass).
      reuse.set(ids.idFor(node), node);
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) walk(child);
      }
    };
    for (const child of $getRoot().getChildren()) walk(child);
  });
  return reuse;
}

/**
 * Wires a `LexicalEditor` to a `LoroDoc` bidirectionally. Call once per
 * editor instance. If the doc already has content, the editor adopts it
 * (any initial Lexical content is discarded); otherwise the editor's
 * current content seeds the doc.
 */
export function createLoroBinding(editor: LexicalEditor, options: LoroBindingOptions): LoroBinding {
  const { doc } = options;
  const ids = new BlockIdRegistry();
  let reuse = new Map<string, LexicalNode>();
  const built: BuiltFrom = new Map();
  const written: WrittenCache = new Map();
  configureTextStyles(doc);

  // The top-level containers exist from the start, outside undo history:
  // undoing a page's first edit must not delete them (Loro's redo of a
  // mergeable container's creation duplicates its contents). Empty
  // mergeable containers created by several peers converge, so this adds
  // nothing visible to anyone.
  if (!rootMap(doc).get(ROOT_ORDER_KEY) || !rootMap(doc).get(BLOCKS_KEY)) {
    rootMap(doc).ensureMergeableMovableList(ROOT_ORDER_KEY);
    rootMap(doc).ensureMergeableMap(BLOCKS_KEY);
    doc.commit({ origin: "lb-init" });
  }

  if (isLoroDocEmpty(doc)) {
    editor.update(
      () => {
        const root = $getRoot();
        // `LightbookEditor` passes `editorState: null` when it's given a
        // `collabPlugins` slot (per Lexical's own convention for pairing
        // with a collab binding), which leaves root with zero children.
        // Show an empty paragraph, but keep it out of the doc: the doc is
        // usually only empty because its real content hasn't arrived yet,
        // and a written placeholder would merge in as an extra paragraph
        // on every device that opens the page. It's written with the first
        // real edit instead.
        if (root.getChildrenSize() === 0) root.append(createLexicalNodeForType("paragraph", {}));
        // (The browser editor usually has that empty paragraph already.)
        if ($isPlaceholderOnly()) return;
        writeLexicalToLoro(doc, root, ids, written);
      },
      { discrete: true }
    );
    reuse = rebuildReuseMap(editor, ids);
  } else {
    readLoroToLexical(editor, doc, ids, reuse, built);
    reuse = rebuildReuseMap(editor, ids);
  }

  // Undo/redo (see the file docstring). Each undo step remembers where the
  // caret was before the edit, as a Loro cursor so concurrent remote edits
  // shift it along with the text; a redo step remembers where the caret was
  // when it was undone.
  let caretBeforeEdit: BlockCaret | null = null;
  let applyingHistory = false;
  let caretAfterHistory: BlockCaret | null = null;
  const blockText = (blockId: string) =>
    ((rootMap(doc).get(BLOCKS_KEY) as LoroMap | undefined)?.get(blockId) as LoroMap | undefined)?.get("text") as
      | LoroText
      | undefined;
  const undoManager = new UndoManager(doc, {
    mergeInterval: 500,
    maxUndoSteps: 200,
    onPush: (isUndo) => {
      const caret = applyingHistory || !isUndo ? $readCaret(ids) : caretBeforeEdit;
      if (!caret) return { value: null, cursors: [] };
      const cursor = blockText(caret.blockId)?.getCursor(caret.offset);
      return { value: caret as never, cursors: cursor ? [cursor] : [] };
    },
    onPop: (_isUndo, { value, cursors }) => {
      const caret = value as unknown as BlockCaret | null;
      if (!caret) return;
      let offset = caret.offset;
      try {
        if (cursors[0]) offset = doc.getCursorPos(cursors[0] as Cursor)?.offset ?? offset;
      } catch {
        // The cursor's text no longer exists; keep the recorded offset.
      }
      caretAfterHistory = { blockId: caret.blockId, offset };
    },
  });

  function $applyHistory(kind: "undo" | "redo"): boolean {
    if (!(kind === "undo" ? undoManager.canUndo() : undoManager.canRedo())) return true;
    caretAfterHistory = null;
    applyingHistory = true;
    try {
      if (kind === "undo") undoManager.undo();
      else undoManager.redo();
    } finally {
      applyingHistory = false;
    }
    for (const tag of REMOTE_APPLY_TAGS) $addUpdateTag(tag);
    $applyLoroToLexical(doc, ids, reuse, built);
    if (caretAfterHistory) $restoreCaret(caretAfterHistory, ids);
    return true;
  }

  const unregisterUndo = editor.registerCommand(UNDO_COMMAND, () => $applyHistory("undo"), COMMAND_PRIORITY_EDITOR);
  const unregisterRedo = editor.registerCommand(REDO_COMMAND, () => $applyHistory("redo"), COMMAND_PRIORITY_EDITOR);

  const unregisterUpdateListener = editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves, prevEditorState }) => {
    if (tags.has(LORO_REMOTE_TAG)) {
      reuse = rebuildReuseMap(editor, ids);
      return;
    }
    if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
    caretBeforeEdit = readCaretIn(prevEditorState, ids);
    editor.getEditorState().read(() => {
      // Until the doc has content, the editor's lone empty paragraph is a
      // placeholder (see the seeding above), whatever else touched it.
      if (isLoroDocEmpty(doc) && $isPlaceholderOnly()) return;
      writeLexicalToLoro(doc, $getRoot(), ids, written);
    });
    reuse = rebuildReuseMap(editor, ids);
  });

  const unsubscribeDoc = doc.subscribe((event: LoroEventBatch) => {
    if (event.by === "local") return;
    readLoroToLexical(editor, doc, ids, reuse, built);
    reuse = rebuildReuseMap(editor, ids);
  });

  return {
    destroy() {
      unregisterUpdateListener();
      unregisterUndo();
      unregisterRedo();
      unsubscribeDoc();
      undoManager.free();
    },
    blockIdForNode(node) {
      return ids.idFor(node);
    },
    nodeKeyForBlockId(id) {
      return ids.keyForId(id);
    },
  };
}

// Re-exported for callers that need to check list-node-ness while working
// with block specs elsewhere (kept here to avoid a redundant import list).
export { $isListNode };
