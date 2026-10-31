// Which anchor a freshly opened docx surface should land on (Task 25) — pure.
//
// Two answers compete, as on the Lexical surface: where the student left off
// (editor-scroll-store), and the block a link brought them to. A deep link is
// an explicit destination, so for that entry it REPLACES the saved position.
//
// The text a restore searches for comes from the block model (the DTO) whenever
// it names the same paragraph: the DTO's text is the paragraph's logical text,
// which is what the engine's findMatches compares against. The text the DOM read
// off painted pieces is the fallback, and an anchor the Lexical surface saved
// has none at all.

import type { DocBlockDTO } from "@/lib/api";
import type { ScrollAnchor } from "@/stores/editor-scroll-store";
import type { DocxScrollAnchor } from "../features/scroll-anchor";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The searchable text for `index`: the block's own if it is a paragraph with
 *  words, else the nearest such paragraph ABOVE it (a table or figure has no
 *  text to find; landing just above it is the right place to look). */
export function anchorTextFor(blocks: readonly DocBlockDTO[] | undefined, index: number): { index: number; text: string } | null {
  if (!blocks) return null;
  for (let i = Math.min(index, blocks.length - 1); i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === "paragraph" && b.text.trim()) return { index: i, text: b.text };
  }
  return null;
}

/** A saved anchor (or a deep link) made ready for the docx surface, or null. */
export function restoreAnchor(o: {
  saved: ScrollAnchor | null | undefined;
  deepLinkBlock: number | null | undefined;
  blocks: readonly DocBlockDTO[] | undefined;
}): DocxScrollAnchor | null {
  if (o.deepLinkBlock != null && o.deepLinkBlock >= 0) {
    const t = anchorTextFor(o.blocks, o.deepLinkBlock);
    return t ? { index: t.index, text: norm(t.text).slice(0, 80), delta: 0, y: 0 } : null;
  }
  const s = o.saved;
  if (!s || s.index < 0) return null;
  if (s.text) return { index: s.index, text: s.text.slice(0, 80), delta: s.delta, y: s.y };
  // Saved by the Lexical surface: an index and a delta into ITS layout. Only the
  // block survives the switch; its offset and raw y mean nothing here.
  const t = anchorTextFor(o.blocks, s.index);
  return t ? { index: t.index, text: norm(t.text).slice(0, 80), delta: 0, y: 0 } : null;
}

/** Whether the DTO's block and the painted one are the same paragraph: the
 *  first few painted words all occur early in the DTO's text. Word-level on
 *  purpose — painted RTL pieces may come out of the DOM in visual order, but a
 *  word is never split. An index the DTO has not caught up with (a local
 *  structural edit before its save) names a different paragraph and fails. */
export function textsAgree(dto: string, painted: string): boolean {
  const words = norm(painted).split(" ").filter((w) => w.length >= 2).slice(0, 4);
  if (!words.length) return true;
  const head = norm(dto).slice(0, 240);
  return words.every((w) => head.includes(w));
}

/** What the store keeps for a report: the DTO's text for the index when it is the
 *  same paragraph (see above), else what the DOM read. */
export function anchorToSave(a: DocxScrollAnchor, blocks: readonly DocBlockDTO[] | undefined): ScrollAnchor {
  const own = blocks?.[a.index];
  const dto = own && own.kind === "paragraph" ? norm(own.text) : "";
  const text = dto && textsAgree(dto, a.text) ? dto : a.text;
  return { index: a.index, delta: a.delta, y: a.y, text: text.slice(0, 80) };
}
