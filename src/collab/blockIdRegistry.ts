import type { LexicalNode, NodeKey } from "lexical";

/**
 * Maps Lexical `NodeKey`s to the stable block ids used in the Loro doc
 * (see `binding.ts`'s module docstring), in both directions. Shared
 * between the sync binding and the presence layer (`presence.ts`) so
 * remote-cursor addressing (`{blockId, offset}`) uses the exact same ids
 * the doc itself is keyed by.
 */
export class BlockIdRegistry {
  private keyToId = new Map<NodeKey, string>();
  private idToKey = new Map<string, NodeKey>();

  idFor(node: LexicalNode): string {
    const key = node.getKey();
    let id = this.keyToId.get(key);
    if (!id) {
      id = `b-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      this.bind(node, id);
    }
    return id;
  }

  /** Called when rebuilding FROM Loro, so a reused (not freshly-created) Lexical node keeps its known id. */
  bind(node: LexicalNode, id: string): void {
    const key = node.getKey();
    this.keyToId.set(key, id);
    this.idToKey.set(id, key);
  }

  keyForId(id: string): NodeKey | undefined {
    return this.idToKey.get(id);
  }

  /** The node's id if it already has one (never allocates). */
  knownId(node: LexicalNode): string | undefined {
    return this.keyToId.get(node.getKey());
  }

  get size(): number {
    return this.keyToId.size;
  }

  /** Forgets every node key not in `live` (nodes the editor has since destroyed). */
  prune(live: Set<NodeKey>): void {
    for (const [key, id] of this.keyToId) {
      if (live.has(key)) continue;
      this.keyToId.delete(key);
      if (this.idToKey.get(id) === key) this.idToKey.delete(id);
    }
  }
}
