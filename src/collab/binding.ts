import type { LoroDoc, LoroEventBatch, LoroMovableList, LoroMap } from "loro-crdt";
import {
  $getRoot,
  $isElementNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import { $isListNode } from "@lexical/list";
import { lexicalNodeToBlockSpec, type BlockSpec } from "./blockSpec";
import { applyTextRuns, createLexicalNodeForType } from "./buildLexicalNode";

const LORO_REMOTE_TAG = "lb-loro-remote-apply";
const ROOT_ORDER_KEY = "rootOrder";
const BLOCKS_KEY = "blocks";

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
 *       - `text` (text-bearing types only): a mergeable `LoroText` — this
 *         is the ONLY thing that gets real character-level CRDT merging.
 *         Two peers typing concurrently in the same paragraph converge
 *         losslessly via Loro's Fugue algorithm, same as Yjs/ProseMirror
 *         collab. This is deliberately the one place real merge effort
 *         goes, because it's the scenario "feels like Google Docs" is
 *         actually judged on.
 *       - `runs` (text-bearing types only): a plain JSON formatting
 *         snapshot (see `blockSpec.ts`) — NOT merged; two peers changing
 *         formatting on the same block concurrently can overwrite each
 *         other. Accepted trade for this tier.
 *       - `childOrder` (container types only): a mergeable
 *         `LoroMovableList<string>` of this block's own children's ids, same
 *         shape as `rootOrder` one level down — recursion, not a flat
 *         per-type table.
 *
 *   `ensureMergeable*` (not `setContainer`) is used throughout so two
 *   peers independently creating "the same" block under the same parent
 *   key at the same moment deterministically converge on one container
 *   instead of forking into two hidden branches — see loro-crdt's own
 *   docs on `LoroMap.ensureMergeable*`.
 *
 * Known v1 scope cuts (all documented in the README too):
 *   - Blockquotes flatten to one text block (no nested multi-paragraph
 *     merge); tables sync as an opaque whole-node JSON snapshot
 *     (last-write-wins, no per-cell merge).
 *   - No remote cursor / presence layer yet (unlike the ProseMirror
 *     package's `CursorEphemeralStore`-based one).
 */
export interface LoroBindingOptions {
  doc: LoroDoc;
}

export interface LoroBinding {
  destroy(): void;
}

class BlockIdRegistry {
  private keyToId = new Map<NodeKey, string>();

  idFor(node: LexicalNode): string {
    const key = node.getKey();
    let id = this.keyToId.get(key);
    if (!id) {
      id = `b-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      this.keyToId.set(key, id);
    }
    return id;
  }

  /** Called when rebuilding FROM Loro, so a reused (not freshly-created) Lexical node keeps its known id. */
  bind(node: LexicalNode, id: string): void {
    this.keyToId.set(node.getKey(), id);
  }
}

function rootMap(doc: LoroDoc): LoroMap {
  return doc.getMap("lb");
}

// --- Lexical -> Loro ---------------------------------------------------

function writeAttrsAndText(block: LoroMap, spec: BlockSpec) {
  if (block.get("type") !== spec.type) block.set("type", spec.type);
  const prevAttrsJSON = JSON.stringify(block.get("attrs") ?? null);
  const nextAttrsJSON = JSON.stringify(spec.attrs ?? null);
  if (prevAttrsJSON !== nextAttrsJSON) block.set("attrs", spec.attrs as never);

  if (spec.text !== undefined) {
    const textContainer = block.ensureMergeableText("text");
    if (textContainer.toString() !== spec.text) textContainer.update(spec.text);
    const prevRunsJSON = JSON.stringify(block.get("runs") ?? []);
    const nextRunsJSON = JSON.stringify(spec.runs ?? []);
    if (prevRunsJSON !== nextRunsJSON) block.set("runs", (spec.runs ?? []) as never);
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

function writeChildren(blocksMap: LoroMap, orderList: LoroMovableList, nodes: LexicalNode[], ids: BlockIdRegistry) {
  const currentIds: string[] = [];
  for (const node of nodes) {
    const spec = lexicalNodeToBlockSpec(node);
    if (!spec) continue;
    const id = ids.idFor(node);
    currentIds.push(id);
    const block = blocksMap.ensureMergeableMap(id);
    writeAttrsAndText(block, spec);
    if (spec.children !== undefined) {
      const childOrder = block.ensureMergeableMovableList("childOrder");
      writeChildren(blocksMap, childOrder, spec.children, ids);
    }
  }
  reconcileOrder(orderList, currentIds);
}

function writeLexicalToLoro(doc: LoroDoc, root: ElementNode, ids: BlockIdRegistry) {
  const lb = rootMap(doc);
  const orderList = lb.ensureMergeableMovableList(ROOT_ORDER_KEY);
  const blocksMap = lb.ensureMergeableMap(BLOCKS_KEY);
  writeChildren(blocksMap, orderList, root.getChildren(), ids);
  doc.commit({ origin: "lb-local-edit" });
}

// --- Loro -> Lexical ---------------------------------------------------

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
  reuse: Map<string, LexicalNode>
) {
  const targetIds = orderList.toArray() as string[];
  const nextChildren: LexicalNode[] = [];

  for (const id of targetIds) {
    const block = blocksMap.get(id) as LoroMap | undefined;
    if (!block) continue;
    const type = (block.get("type") as string) ?? "paragraph";
    const attrs = (block.get("attrs") as Record<string, unknown>) ?? {};

    let node = reuse.get(id);
    if (!node) {
      node = createLexicalNodeForType(type, attrs);
      ids.bind(node, id);
    }
    nextChildren.push(node);

    const textContainer = block.get("text") as { toString(): string } | undefined;
    if (textContainer != null && $isElementNode(node)) {
      const text = textContainer.toString();
      const runs = block.get("runs") as { text: string; formats: string[] }[] | undefined;
      applyTextRuns(node, text, runs as never);
    }

    const childOrder = block.get("childOrder") as LoroMovableList | undefined;
    if (childOrder && $isElementNode(node)) {
      readChildrenInto(node, blocksMap, childOrder, ids, reuse);
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

function readLoroToLexical(editor: LexicalEditor, doc: LoroDoc, ids: BlockIdRegistry, reuse: Map<string, LexicalNode>) {
  editor.update(
    () => {
      const lb = rootMap(doc);
      const orderList = lb.get(ROOT_ORDER_KEY) as LoroMovableList | undefined;
      const blocksMap = lb.get(BLOCKS_KEY) as LoroMap | undefined;
      const root = $getRoot();
      if (!orderList || !blocksMap) return;
      readChildrenInto(root, blocksMap, orderList, ids, reuse);
      if (root.getChildrenSize() === 0) {
        root.append(createLexicalNodeForType("paragraph", {}));
      }
    },
    { tag: LORO_REMOTE_TAG, discrete: true }
  );
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

  if (isLoroDocEmpty(doc)) {
    editor.update(
      () => {
        const root = $getRoot();
        // `LightbookEditor` passes `editorState: null` when it's given a
        // `collabPlugins` slot (per Lexical's own convention for pairing
        // with a collab binding), which leaves root with zero children —
        // give it one so the doc this seeds isn't degenerately empty.
        if (root.getChildrenSize() === 0) {
          root.append(createLexicalNodeForType("paragraph", {}));
        }
        writeLexicalToLoro(doc, root, ids);
      },
      { discrete: true }
    );
    reuse = rebuildReuseMap(editor, ids);
  } else {
    readLoroToLexical(editor, doc, ids, reuse);
    reuse = rebuildReuseMap(editor, ids);
  }

  const unregisterUpdateListener = editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves }) => {
    if (tags.has(LORO_REMOTE_TAG)) return;
    if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
    editor.getEditorState().read(() => {
      writeLexicalToLoro(doc, $getRoot(), ids);
    });
    reuse = rebuildReuseMap(editor, ids);
  });

  const unsubscribeDoc = doc.subscribe((event: LoroEventBatch) => {
    if (event.by === "local") return;
    readLoroToLexical(editor, doc, ids, reuse);
    reuse = rebuildReuseMap(editor, ids);
  });

  return {
    destroy() {
      unregisterUpdateListener();
      unsubscribeDoc();
    },
  };
}

// Re-exported for callers that need to check list-node-ness while working
// with block specs elsewhere (kept here to avoid a redundant import list).
export { $isListNode };
