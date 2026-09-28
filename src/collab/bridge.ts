import type { LoroDoc, LoroEventBatch } from "loro-crdt";

/**
 * Wires two independent `LoroDoc` peers together in-memory by forwarding
 * each side's locally-generated update bytes to the other — the same
 * demo/testing helper as lightbook-prosemirror's `bridgeLoroDocs`. A real
 * deployment replaces this with a network transport carrying the same
 * `doc.export({ mode: "update" })` bytes.
 */
export function bridgeLoroDocs(a: LoroDoc, b: LoroDoc): () => void {
  const forward = (from: LoroDoc, to: LoroDoc) => (event: LoroEventBatch) => {
    if (event.by !== "local") return;
    to.import(from.export({ mode: "update" }));
  };
  const unsubA = a.subscribe(forward(a, b));
  const unsubB = b.subscribe(forward(b, a));
  return () => {
    unsubA();
    unsubB();
  };
}
