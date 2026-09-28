import { EphemeralStore, type Value } from "loro-crdt";
import {
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import type { LoroBinding } from "./binding";

export interface PresenceUser {
  name: string;
  color: string;
}

/** One peer's broadcast cursor position, addressed the same way the binding addresses content: `{blockId, offset}`. */
export interface PresencePayload {
  user: PresenceUser;
  blockId: string;
  /** Flattened character offset within the block's text, same units as `blockSpec.ts`'s `text`/`runs`. */
  offset: number;
}

/**
 * Loro's `EphemeralStore` requires its value type to structurally satisfy
 * `Value` (a plain-index-signature JSON type), which a named `interface`
 * like `PresencePayload` doesn't automatically do — so the store itself is
 * typed loosely (`Record<string, Value>`) and every read/write of a peer's
 * entry goes through `setPresence`/`getPresence` below, which own the cast
 * to/from `PresencePayload` in one place.
 */
export type PresenceState = Record<string, Value>;

/**
 * Creates the presence/awareness channel: Loro's `EphemeralStore` — a
 * peer-keyed, per-entry-timeout-expiring key/value store that is NOT part
 * of the CRDT document (no merge history, nothing persisted) — the Loro
 * analogue of Yjs Awareness. One store is shared per collaboration
 * session, same as the `LoroDoc` itself.
 */
export function createPresenceStore(timeoutMs = 30_000): EphemeralStore<PresenceState> {
  return new EphemeralStore<PresenceState>(timeoutMs);
}

export function setPresence(store: EphemeralStore<PresenceState>, peerId: string, payload: PresencePayload | null): void {
  if (payload == null) {
    store.delete(peerId);
  } else {
    store.set(peerId, payload as unknown as Value);
  }
}

export function getPresence(store: EphemeralStore<PresenceState>, peerId: string): PresencePayload | null {
  return (store.get(peerId) as unknown as PresencePayload | undefined) ?? null;
}

function getAllPresence(store: EphemeralStore<PresenceState>): Record<string, PresencePayload> {
  return store.getAllStates() as unknown as Record<string, PresencePayload>;
}

/**
 * Wires two independent `EphemeralStore`s together in-memory, same idea as
 * `bridgeLoroDocs` but for the presence channel: forwards each side's
 * local updates to the other via `subscribeLocalUpdates`/`apply`.
 */
export function bridgePresenceStores(a: EphemeralStore<PresenceState>, b: EphemeralStore<PresenceState>): () => void {
  const unsubA = a.subscribeLocalUpdates((bytes) => b.apply(bytes));
  const unsubB = b.subscribeLocalUpdates((bytes) => a.apply(bytes));
  return () => {
    unsubA();
    unsubB();
  };
}

const TEXT_BEARING_TYPES = new Set(["paragraph", "heading", "quote", "code", "listitem"]);

/** True for the Lexical node types `blockSpec.ts` gives a flattened `text` string to (see its `lexicalNodeToBlockSpec`). */
function isTextBearingBlock(node: LexicalNode): node is ElementNode {
  return $isElementNode(node) && TEXT_BEARING_TYPES.has(node.getType());
}

/**
 * Walks up from a text-selection point to its nearest text-bearing block
 * ancestor, and flattens the position to a single character offset within
 * that block — the same flattening `blockSpec.ts`'s `textRunsOf` does for
 * sync, so a broadcast `{blockId, offset}` addresses the same position a
 * remote peer's synced text will actually have.
 */
export function resolveLocalCursorPoint(
  binding: LoroBinding,
  anchorNode: LexicalNode,
  anchorOffset: number
): { blockId: string; offset: number } | null {
  let block: LexicalNode | null = anchorNode;
  while (block && !isTextBearingBlock(block)) block = block.getParent();
  if (!block) return null;

  let offset = anchorOffset;
  for (const child of (block as ElementNode).getChildren()) {
    if (child.getKey() === anchorNode.getKey()) break;
    if ($isTextNode(child)) offset += child.getTextContentSize();
  }
  return { blockId: binding.blockIdForNode(block), offset };
}

/** Reads the current selection's focus point (for the local peer's own broadcast) inside an `editor.getEditorState().read()`/`editor.update()` callback. */
export function readLocalCursorPayload(binding: LoroBinding, user: PresenceUser): PresencePayload | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const focus = selection.focus;
  const node = focus.getNode();
  const point = resolveLocalCursorPoint(binding, node, focus.offset);
  if (!point) return null;
  return { user, blockId: point.blockId, offset: point.offset };
}

export interface ResolvedRemoteCursor {
  peerId: string;
  user: PresenceUser;
  nodeKey: string;
  /** Offset within the block, clamped to its current text length (the block may have shrunk since this was broadcast). */
  offset: number;
}

/**
 * Resolves every OTHER peer's broadcast cursor to a still-live Lexical
 * `NodeKey` + clamped offset, for the DOM-rendering layer
 * (`LoroPresencePlugin.tsx`) to turn into an actual screen position. Peers
 * whose block no longer exists (block was deleted) are dropped, not
 * crashed on.
 */
export function resolveRemoteCursors(
  editor: LexicalEditor,
  binding: LoroBinding,
  store: EphemeralStore<PresenceState>,
  selfPeerId: string
): ResolvedRemoteCursor[] {
  const out: ResolvedRemoteCursor[] = [];
  const all = getAllPresence(store);
  editor.getEditorState().read(() => {
    for (const [peerId, payload] of Object.entries(all)) {
      if (peerId === selfPeerId || !payload) continue;
      const nodeKey = binding.nodeKeyForBlockId(payload.blockId);
      if (!nodeKey) continue;
      const node = $getNodeByKey(nodeKey);
      if (!$isElementNode(node)) continue;
      const offset = Math.max(0, Math.min(payload.offset, node.getTextContentSize()));
      out.push({ peerId, user: payload.user, nodeKey, offset });
    }
  });
  return out;
}
