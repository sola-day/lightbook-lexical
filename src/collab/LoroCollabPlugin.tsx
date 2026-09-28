import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { LoroDoc } from "loro-crdt";
import { createLoroBinding } from "./binding";

export interface LoroCollabPluginProps {
  doc: LoroDoc;
}

/** Drop this in `LightbookEditor`'s `collabPlugins` slot to wire the editor to a `LoroDoc`. */
export function LoroCollabPlugin({ doc }: LoroCollabPluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const binding = createLoroBinding(editor, { doc });
    return () => binding.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, doc]);

  return null;
}
