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

export interface VideoPayload {
  src: string;
  title?: string | null;
  key?: NodeKey;
}

export type SerializedVideoNode = Spread<{ src: string; title: string | null }, SerializedLexicalNode>;

function convertVideoElement(domNode: Node): DOMConversionOutput | null {
  if (!(domNode instanceof HTMLVideoElement)) return null;
  return { node: $createVideoNode({ src: domNode.src, title: domNode.title || null }) };
}

/** Block-level embedded video, mirroring lightbook-prosemirror's `video` node. */
export class VideoNode extends DecoratorNode<ReactNode> {
  __src: string;
  __title: string | null;

  static getType(): string {
    return "video";
  }

  static clone(node: VideoNode): VideoNode {
    return new VideoNode(node.__src, node.__title, node.__key);
  }

  constructor(src: string, title: string | null = null, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__title = title;
  }

  static importJSON(serializedNode: SerializedVideoNode): VideoNode {
    return $createVideoNode(serializedNode);
  }

  exportJSON(): SerializedVideoNode {
    return { type: "video", version: 1, src: this.__src, title: this.__title };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      video: () => ({ conversion: convertVideoElement, priority: 0 }),
    };
  }

  exportDOM(): DOMExportOutput {
    const el = document.createElement("video");
    el.setAttribute("src", this.__src);
    el.setAttribute("controls", "true");
    if (this.__title) el.setAttribute("title", this.__title);
    return { element: el };
  }

  createDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "lb-video-wrapper";
    return div;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): false {
    return false;
  }

  decorate(): ReactNode {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video src={this.__src} title={this.__title ?? undefined} controls className="lb-video" />
    );
  }
}

export function $createVideoNode({ src, title = null, key }: VideoPayload): VideoNode {
  return new VideoNode(src, title, key);
}

export function $isVideoNode(node: LexicalNode | null | undefined): node is VideoNode {
  return node instanceof VideoNode;
}
