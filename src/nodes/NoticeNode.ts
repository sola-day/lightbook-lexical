import {
  ElementNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from "lexical";

export type NoticeKind = "info" | "warning" | "tip";

export type SerializedNoticeNode = Spread<{ kind: NoticeKind }, SerializedElementNode>;

function convertNoticeElement(domNode: HTMLElement): DOMConversionOutput | null {
  const kind = (domNode.getAttribute("data-notice") as NoticeKind | null) || "info";
  return { node: $createNoticeNode(kind) };
}

/**
 * Outline-style callout / notice box, mirroring lightbook-prosemirror's
 * `notice` node: a block container (like blockquote) that holds other
 * block nodes (usually paragraphs), tagged with a `kind`.
 */
export class NoticeNode extends ElementNode {
  __kind: NoticeKind;

  static getType(): string {
    return "notice";
  }

  static clone(node: NoticeNode): NoticeNode {
    return new NoticeNode(node.__kind, node.__key);
  }

  constructor(kind: NoticeKind = "info", key?: NodeKey) {
    super(key);
    this.__kind = kind;
  }

  static importJSON(serializedNode: SerializedNoticeNode): NoticeNode {
    return $createNoticeNode(serializedNode.kind);
  }

  exportJSON(): SerializedNoticeNode {
    return { ...super.exportJSON(), type: "notice", version: 1, kind: this.__kind };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode) =>
        domNode.hasAttribute("data-notice") ? { conversion: convertNoticeElement, priority: 1 } : null,
    };
  }

  exportDOM(): DOMExportOutput {
    const el = document.createElement("div");
    el.setAttribute("data-notice", this.__kind);
    el.className = `lb-notice lb-notice--${this.__kind}`;
    return { element: el };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement("div");
    el.setAttribute("data-notice", this.__kind);
    el.className = `lb-notice lb-notice--${this.__kind}`;
    return el;
  }

  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    if (prevNode.__kind !== this.__kind) {
      dom.setAttribute("data-notice", this.__kind);
      dom.className = `lb-notice lb-notice--${this.__kind}`;
    }
    return false;
  }

  getKind(): NoticeKind {
    return this.__kind;
  }

  setKind(kind: NoticeKind): void {
    this.getWritable().__kind = kind;
  }

  canBeEmpty(): boolean {
    return false;
  }

  isShadowRoot(): boolean {
    return false;
  }
}

export function $createNoticeNode(kind: NoticeKind = "info"): NoticeNode {
  return new NoticeNode(kind);
}

export function $isNoticeNode(node: LexicalNode | null | undefined): node is NoticeNode {
  return node instanceof NoticeNode;
}
