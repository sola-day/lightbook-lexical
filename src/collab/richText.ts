import type { Delta, LoroDoc, LoroText } from "loro-crdt";
import { IMAGE_CHAR, type InlineImage, type TextRun } from "./blockSpec";

/**
 * A text block's inline structure lives on its `LoroText` as character-level
 * marks, so it merges character by character like the text itself (two
 * peers typing into the same bold/commented sentence keep the formatting).
 * Keys:
 *   - a format name (`bold`, `italic`, ...): `true`
 *   - `link`: the URL
 *   - `mark:<id>`: `true`, one key per comment/suggestion MarkNode id, so
 *     overlapping ranges don't overwrite each other
 *   - `image`: the image's attrs, on its one `IMAGE_CHAR` character
 * Line breaks are the "\n" characters of the text.
 *
 * This file must stay in lockstep with apps/node's `collab/richText.ts`
 * (the server reads and writes the same shape).
 */

const FORMAT_KEYS = ["bold", "italic", "underline", "strikethrough", "code", "subscript", "superscript", "highlight"];
const MARK_PREFIX = "mark:";

type Attrs = Record<string, unknown>;

/** Must run on every doc before it writes marks (the expand rule is recorded in each mark op, so readers need nothing). */
export function configureTextStyles(doc: LoroDoc): void {
  // Formats grow as you type at their end; links, comments, suggestions and
  // images don't.
  doc.configTextStyle(Object.fromEntries(FORMAT_KEYS.map((key) => [key, { expand: key === "code" ? "none" : "after" }])));
  doc.configDefaultTextStyle({ expand: "none" });
}

function attrsOfRun(run: TextRun): Attrs {
  const attrs: Attrs = {};
  if (!run.br && !run.image) for (const format of run.formats) attrs[format] = true;
  if (run.link && !run.br) attrs.link = run.link;
  for (const id of run.marks ?? []) attrs[MARK_PREFIX + id] = true;
  if (run.image) attrs.image = run.image;
  return attrs;
}

/** Key-order-independent equality for mark values (images are objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  const sorted = (v: object) => JSON.stringify(v, Object.keys(v).sort());
  return sorted(a) === sorted(b);
}

interface Span {
  start: number;
  end: number;
  attrs: Attrs;
}

function spansOf(pieces: Array<{ length: number; attrs: Attrs }>): Span[] {
  const spans: Span[] = [];
  let at = 0;
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    spans.push({ start: at, end: at + piece.length, attrs: piece.attrs });
    at += piece.length;
  }
  return spans;
}

/**
 * Brings `text`'s marks in line with `runs` (whose concatenated text must
 * already equal the text's content), touching only the ranges that differ.
 */
export function writeRunMarks(text: LoroText, runs: TextRun[]): void {
  const want = spansOf(runs.map((run) => ({ length: run.text.length, attrs: attrsOfRun(run) })));
  const have = spansOf(
    (text.toDelta() as Delta<string>[]).flatMap((d) =>
      d.insert !== undefined ? [{ length: d.insert.length, attrs: (d.attributes ?? {}) as Attrs }] : []
    )
  );

  // Pending op per key, extended while consecutive intervals need the same value.
  const ops: Array<{ key: string; value: unknown; start: number; end: number }> = [];
  const open = new Map<string, { key: string; value: unknown; start: number; end: number }>();
  let i = 0;
  let j = 0;
  let at = 0;
  while (i < want.length && j < have.length) {
    const end = Math.min(want[i].end, have[j].end);
    const w = want[i].attrs;
    const h = have[j].attrs;
    const touched = new Set<string>();
    for (const key of new Set([...Object.keys(w), ...Object.keys(h)])) {
      if (sameValue(w[key], h[key])) continue;
      touched.add(key);
      const pending = open.get(key);
      if (pending && pending.end === at && sameValue(pending.value, w[key])) {
        pending.end = end;
      } else {
        const op = { key, value: w[key], start: at, end };
        ops.push(op);
        open.set(key, op);
      }
    }
    for (const key of open.keys()) if (!touched.has(key)) open.delete(key);
    at = end;
    if (want[i].end === end) i++;
    if (have[j].end === end) j++;
  }

  for (const op of ops) {
    if (op.value === undefined) text.unmark({ start: op.start, end: op.end }, op.key);
    else text.mark({ start: op.start, end: op.end }, op.key, op.value);
  }
}

/** Whether any character carries a mark (a block written in the current shape, not legacy `runs`). */
export function hasMarks(text: LoroText): boolean {
  return (text.toDelta() as Delta<string>[]).some((d) => d.attributes && Object.keys(d.attributes).length > 0);
}

/** The block's runs as stored in its text's marks, in `canonicalRuns` form. */
export function readRunMarks(text: LoroText): TextRun[] {
  const runs: TextRun[] = [];
  for (const d of text.toDelta() as Delta<string>[]) {
    if (d.insert === undefined || d.insert.length === 0) continue;
    const attrs = (d.attributes ?? {}) as Attrs;
    const formats = FORMAT_KEYS.filter((key) => attrs[key] === true) as TextRun["formats"];
    const marks = Object.keys(attrs)
      .filter((key) => key.startsWith(MARK_PREFIX) && attrs[key] === true)
      .map((key) => key.slice(MARK_PREFIX.length))
      .sort();
    const link = typeof attrs.link === "string" ? attrs.link : undefined;
    const image = attrs.image && typeof attrs.image === "object" ? (attrs.image as InlineImage) : undefined;

    // One run per image character and per line break; text between them
    // keeps the segment's formatting.
    let pending = "";
    const flush = () => {
      if (!pending) return;
      runs.push(withContext({ text: pending, formats: [...formats] }, marks, link));
      pending = "";
    };
    for (const ch of d.insert) {
      if (ch === "\n") {
        flush();
        runs.push(withContext({ text: "\n", formats: [], br: true }, marks, undefined));
      } else if (ch === IMAGE_CHAR && image) {
        flush();
        runs.push(withContext({ text: IMAGE_CHAR, formats: [], image }, marks, link));
      } else {
        pending += ch;
      }
    }
    flush();
  }
  return canonicalRuns(runs);
}

function withContext(run: TextRun, marks: string[], link: string | undefined): TextRun {
  if (marks.length) run.marks = [...marks];
  if (link) run.link = link;
  return run;
}

/**
 * Normalizes runs so two descriptions of the same content compare equal:
 * sorted formats and mark ids, adjacent plain-text runs with identical
 * attributes merged, empty runs dropped.
 */
export function canonicalRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const next: TextRun = { text: run.text, formats: [...run.formats].sort() };
    if (run.marks?.length) next.marks = [...run.marks].sort();
    if (run.link && !run.br) next.link = run.link;
    if (run.br) next.br = true;
    if (run.image) next.image = run.image;
    const prev = out[out.length - 1];
    if (
      prev &&
      !prev.br &&
      !prev.image &&
      !next.br &&
      !next.image &&
      prev.link === next.link &&
      prev.formats.join() === next.formats.join() &&
      (prev.marks ?? []).join() === (next.marks ?? []).join()
    ) {
      prev.text += next.text;
    } else {
      out.push(next);
    }
  }
  return out;
}
