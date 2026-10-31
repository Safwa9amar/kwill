// The reading position as a BLOCK anchor on the docx surface (Task 25) — the pure
// half: which painted block is the anchor, and how to search for it again.
// ScrollAnchor.tsx does the measuring and the scrolling.
//
// A block anchor, not a pixel offset: fonts, pictures and the auto-fit zoom all
// re-lay the pages out after a fresh open, so a stored scrollTop lands somewhere
// else. "This block, this far past the top" survives that. The block is named by
// index AND text because indices shift (spec D7): restore searches the text and
// prefers the match whose node id still parses to the index (bridge/find-block).

import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";

export type DocxScrollAnchor = {
  index: number;
  /** First ≤80 chars of the block's text — what restore searches for. */
  text: string;
  /** Document px (unscaled by zoom) the block's top sits ABOVE the viewport top;
   *  negative when the anchor starts below it. */
  delta: number;
  /** Raw scrollTop: the fallback when no block can be re-found. */
  y: number;
};

/** One painted element carrying a paragraph id, in viewport coordinates. */
export type PaintedPiece = { id: string; top: number; bottom: number; text: string };

export const normText = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The anchor for a viewport whose top is at `vpTop`: the topmost BODY block still
 * (partly) on screen that has text — an empty paragraph or a picture cannot be
 * searched for, so the next block with words is the better handle even though
 * it starts lower. Pieces of one paragraph (its lines, its runs) are merged;
 * header/footer stories are never anchors (their ids are not block indices).
 */
export function pickAnchor(pieces: readonly PaintedPiece[], vpTop: number, zoom: number, y: number): DocxScrollAnchor | null {
  const byId = new Map<string, { index: number; top: number; bottom: number; text: string }>();
  for (const p of pieces) {
    if (!isBodyId(p.id)) continue;
    const index = blockIndexFromId(p.id);
    if (index == null) continue;
    const cur = byId.get(p.id);
    if (!cur) byId.set(p.id, { index, top: p.top, bottom: p.bottom, text: normText(p.text) });
    else {
      cur.top = Math.min(cur.top, p.top);
      cur.bottom = Math.max(cur.bottom, p.bottom);
      if (!cur.text) cur.text = normText(p.text);
    }
  }
  const visible = [...byId.values()].filter((b) => b.bottom > vpTop + 1).sort((a, b) => a.top - b.top);
  const pick = visible.find((b) => b.text) ?? null;
  if (!pick) return null;
  const z = zoom > 0 ? zoom : 1;
  return { index: pick.index, text: pick.text.slice(0, 80), delta: Math.round((vpTop - pick.top) / z), y: Math.max(0, Math.round(y)) };
}

/** Queries to try, in order: the anchor's own opening, then a slice from its
 *  middle — a painted list label or field result can make the opening
 *  unsearchable while the middle of the sentence still matches. */
export function anchorQueries(text: string | undefined): string[] {
  const t = normText(text ?? "");
  if (!t) return [];
  const out = [t.slice(0, 80)];
  if (t.length > 36) {
    const from = Math.floor(t.length / 3);
    const mid = t.slice(from, from + 30).trim();
    if (mid && !out.includes(mid)) out.push(mid);
  }
  return out;
}

/** Dedupe key for reporting: a reader sitting still must not re-send. */
export const anchorKey = (a: DocxScrollAnchor) => `${a.index}:${a.delta}:${a.text.slice(0, 24)}`;

/** The scrollTop correction that puts a block whose top is at `blockTop` (viewport
 *  coordinates) `delta` document-px above the viewport top. */
export function correction(blockTop: number, vpTop: number, delta: number, zoom: number): number {
  return blockTop - vpTop + delta * (zoom > 0 ? zoom : 1);
}

/** Dispatched on window by the Bridge right BEFORE it hands the engine new bytes
 *  (a reload, a D7 re-parse). The old pages are still painted at that moment, so
 *  the reading position can be read off them — and restored once the new layout
 *  grows back into it, with the same machinery as the open-time restore. Without
 *  it every load() started the student at the cover page (simulator, 10-31). */
export const WILL_LOAD_EVENT = "kw:docx-will-load";
