import type { ReactNode } from "react";
import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";

export interface ImagePayload {
  src: string;
  alt?: string;
  title?: string | null;
  width?: number | null;
  key?: NodeKey;
}

export type SerializedImageNode = Spread<
  { src: string; alt: string; title: string | null; width: number | null },
  SerializedLexicalNode
>;

function convertImageElement(domNode: Node): DOMConversionOutput | null {
  if (!(domNode instanceof HTMLImageElement)) return null;
  const { src, alt, title } = domNode;
  const width = domNode.getAttribute("width");
  return { node: $createImageNode({ src, alt, title, width: width ? +width : null }) };
}

/**
 * Inline image, mirroring lightbook-prosemirror's `image` node. A leaf
 * `DecoratorNode` (Lexical's equivalent of a ProseMirror leaf node):
 * `createDOM` only builds the empty wrapper Lexical's reconciler puts in
 * the content-editable DOM tree, and `decorate()` returns the actual
 * visible React content that `@lexical/react` portals into that wrapper —
 * splitting these two is required for the React decorator-rendering path
 * (`LexicalContentEditable`'s `useDecorators`) to work, not optional
 * styling; a non-React embedder that never calls `decorate()` would just
 * see the empty wrapper.
 */
export class ImageNode extends DecoratorNode<ReactNode> {
  __src: string;
  __alt: string;
  __title: string | null;
  __width: number | null;

  static getType(): string {
    return "image";
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__alt, node.__title, node.__width, node.__key);
  }

  constructor(src: string, alt = "", title: string | null = null, width: number | null = null, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
    this.__title = title;
    this.__width = width;
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    return $createImageNode(serializedNode);
  }

  exportJSON(): SerializedImageNode {
    return {
      type: "image",
      version: 1,
      src: this.__src,
      alt: this.__alt,
      title: this.__title,
      width: this.__width,
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      img: () => ({ conversion: convertImageElement, priority: 0 }),
    };
  }

  exportDOM(): DOMExportOutput {
    const el = document.createElement("img");
    el.setAttribute("src", this.__src);
    if (this.__alt) el.setAttribute("alt", this.__alt);
    if (this.__title) el.setAttribute("title", this.__title);
    if (this.__width) el.setAttribute("width", String(this.__width));
    return { element: el };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "lb-image-wrapper";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): true {
    return true;
  }

  getSrc(): string {
    return this.__src;
  }

  decorate(): ReactNode {
    return (
      <img
        src={this.__src}
        alt={this.__alt}
        title={this.__title ?? undefined}
        width={this.__width ?? undefined}
        className="lb-image"
      />
    );
  }
}

export function $createImageNode({ src, alt = "", title = null, width = null, key }: ImagePayload): ImageNode {
  return new ImageNode(src, alt, title, width, key);
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
