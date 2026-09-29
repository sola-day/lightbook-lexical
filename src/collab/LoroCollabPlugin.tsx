import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, SELECTION_CHANGE_COMMAND, COMMAND_PRIORITY_LOW } from "lexical";
import type { LoroDoc } from "loro-crdt";
import { createLoroBinding, type LoroBinding } from "./binding";
import {
  setPresence,
  readLocalCursorPayload,
  resolveRemoteCursors,
  type PresenceState,
  type PresenceUser,
} from "./presence";
import type { EphemeralStore } from "loro-crdt";

export interface LoroCollabPluginProps {
  doc: LoroDoc;
  /**
   * Remote cursor / presence layer (optional — the editor works fine
   * without it, just without the "who's editing where" carets). `store`
   * is shared across peers the same way `doc` is (see
   * `createPresenceStore`/`bridgePresenceStores`); `peerId` should be
   * unique per peer (`doc.peerIdStr` is a reasonable default) and `user`
   * is the local peer's displayed name/color.
   */
  presence?: {
    store: EphemeralStore<PresenceState>;
    peerId: string;
    user: PresenceUser;
  };
}

/** Drop this in `LightbookEditor`'s `collabPlugins` slot to wire the editor to a `LoroDoc` (and, optionally, remote cursors). */
export function LoroCollabPlugin({ doc, presence }: LoroCollabPluginProps) {
  const [editor] = useLexicalComposerContext();
  const bindingRef = useRef<LoroBinding | null>(null);

  useEffect(() => {
    const binding = createLoroBinding(editor, { doc });
    bindingRef.current = binding;
    return () => {
      binding.destroy();
      bindingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, doc]);

  useEffect(() => {
    if (!presence) return;
    const { store, peerId, user } = presence;
    const binding = bindingRef.current;
    if (!binding) return;

    const host = editor.getRootElement()?.parentElement;
    if (host) {
      const computed = window.getComputedStyle(host);
      if (computed.position === "static") host.style.position = "relative";
    }

    const cursorEls = new Map<string, { caret: HTMLElement; label: HTMLElement }>();

    // Only a real change of this peer's cursor is broadcast: every remote
    // edit also runs the update listener below, and rebroadcasting an
    // unchanged cursor for each one made presence traffic grow with the
    // square of the number of collaborators. A periodic refresh keeps an
    // idle cursor from expiring out of everyone's store.
    let lastSent: string | undefined;
    let lastPayload: ReturnType<typeof readLocalCursorPayload> = null;
    function broadcastLocal() {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        const payload = selection ? readLocalCursorPayload(binding!, user) : null;
        const key = JSON.stringify(payload);
        if (key === lastSent) return;
        lastSent = key;
        lastPayload = payload;
        setPresence(store, peerId, payload);
      });
    }
    const refresh = setInterval(() => {
      if (lastPayload) setPresence(store, peerId, lastPayload);
    }, 10_000);

    // Drawing measures layout, so it runs at most once per frame, and not
    // at all while nobody else is here.
    let frame = 0;
    function scheduleRender() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        renderRemote();
      });
    }

    function renderRemote() {
      if (cursorEls.size === 0 && Object.keys(store.getAllStates()).every((id) => id === peerId)) return;
      const rootEl = editor.getRootElement();
      const hostEl = rootEl?.parentElement;
      if (!rootEl || !hostEl) return;
      const remotes = resolveRemoteCursors(editor, binding!, store, peerId);
      const seen = new Set<string>();

      for (const remote of remotes) {
        seen.add(remote.peerId);
        // Lexical resolved the cursor to a text node (see presence.ts), so
        // only that node's DOM text needs indexing; a block without text
        // gets the caret at its start.
        const textEl = remote.textNodeKey ? editor.getElementByKey(remote.textNodeKey) : null;
        const blockEl = editor.getElementByKey(remote.nodeKey);
        let point: { node: Node; offset: number } | null = null;
        const textNode = textEl ? document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT).nextNode() : null;
        if (textNode) {
          point = { node: textNode, offset: Math.min(remote.textOffset ?? 0, (textNode as Text).length) };
        } else if (blockEl) {
          point = { node: blockEl, offset: 0 };
        }
        if (!point) continue;

        const range = document.createRange();
        range.setStart(point.node, point.offset);
        range.collapse(true);
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0)) continue;
        const hostRect = hostEl.getBoundingClientRect();

        let entry = cursorEls.get(remote.peerId);
        if (!entry) {
          const caret = document.createElement("span");
          caret.className = "lb-remote-cursor";
          const label = document.createElement("div");
          label.className = "lb-remote-cursor-label";
          caret.appendChild(label);
          hostEl.appendChild(caret);
          entry = { caret, label };
          cursorEls.set(remote.peerId, entry);
        }
        entry.caret.style.position = "absolute";
        entry.caret.style.top = `${rect.top - hostRect.top}px`;
        entry.caret.style.left = `${rect.left - hostRect.left}px`;
        entry.caret.style.height = `${rect.height || 18}px`;
        entry.caret.style.borderColor = remote.user.color;
        entry.label.style.backgroundColor = remote.user.color;
        entry.label.textContent = remote.user.name;
      }

      for (const [peerId, entry] of cursorEls) {
        if (!seen.has(peerId)) {
          entry.caret.remove();
          cursorEls.delete(peerId);
        }
      }
    }

    const unregisterSelectionCmd = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        broadcastLocal();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
    const unregisterUpdate = editor.registerUpdateListener(() => {
      broadcastLocal();
      scheduleRender();
    });
    const unsubscribeStore = store.subscribe(() => scheduleRender());

    broadcastLocal();
    renderRemote();

    return () => {
      clearInterval(refresh);
      cancelAnimationFrame(frame);
      unregisterSelectionCmd();
      unregisterUpdate();
      unsubscribeStore();
      setPresence(store, peerId, null);
      for (const entry of cursorEls.values()) entry.caret.remove();
      cursorEls.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, presence?.store, presence?.peerId]);

  return null;
}
