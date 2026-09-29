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
import { inlineSize } from "./blockSpec";
import { $flattenPoint, $inlineLeaves, $locateFlatOffset } from "./caret";

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

/**
 * Flattens a selection point to `{blockId, offset}` in the units of the
 * block's synced text (see `caret.ts`), so a broadcast position addresses
 * the same character a remote peer's copy of the block has, whatever marks,
 * links or images sit before it.
 */
export function resolveLocalCursorPoint(
  binding: LoroBinding,
  anchorNode: LexicalNode,
  anchorOffset: number
): { blockId: string; offset: number } | null {
  const flat = $flattenPoint(anchorNode, anchorOffset);
  return flat ? { blockId: binding.blockIdForNode(flat.block), offset: flat.offset } : null;
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
  /** The block the cursor is in. */
  nodeKey: string;
  /** Offset within the block, clamped to its current text length (the block may have shrunk since this was broadcast). */
  offset: number;
  /** The text node the cursor falls in and the offset inside it, when the block has text (for drawing it). */
  textNodeKey?: string;
  textOffset?: number;
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
      const size = $inlineLeaves(node).reduce((sum, leaf) => sum + inlineSize(leaf), 0);
      const offset = Math.max(0, Math.min(payload.offset, size));
      const at = $locateFlatOffset(node, offset);
      out.push({ peerId, user: payload.user, nodeKey, offset, textNodeKey: at?.node.getKey(), textOffset: at?.offset });
    }
  });
  return out;
}
