// Document search on the docx surface: the panel keeps its own matcher (over the
// DTO, with Arabic folding — see lib/search-match.ts), and each hit is carried to
// the engine as a SearchTarget (the literal text it covers + where). These are the
// pure halves of both ends:
//   native:  targetFor()                 — DTO hit → SearchTarget
//            liveEdits() / engineStart() — the replace ledger (below)
//   DOM:     pickMatch()                 — engine matches of the literal → the one meant
//            replaceOrder()              — the order a batch must replace in
// Kept here (no DOM, no React Native) so both sides share them and node tests them.
//
// The replace ledger. After a local replace the panel's remaining hits keep their
// DTO offsets until the DTO refreshes — deliberately not shifted in the panel,
// because the literal is read from the (stale) DTO text at those offsets. The engine
// HAS moved, though: the replace shifted every later hit of its paragraph by the
// length difference. So the native side keeps those shifts and sends the start the
// engine should see; an edit leaves the ledger once the DTO shows it.

import { isBlockLevelId } from "./dom-selectors";
import type { SearchTarget } from "./surface-types";

/** How many non-overlapping copies of `literal` start before `start` in `text`. */
export function ordinalOf(text: string, literal: string, start: number): number {
  if (!literal) return 0;
  let n = 0;
  for (let at = text.indexOf(literal); at !== -1 && at < start; at = text.indexOf(literal, at + literal.length)) n++;
  return n;
}

/** A panel hit ({blockIndex, start, end} into the block's searchable text) as a target. */
export function targetFor(blockIndex: number, text: string, start: number, end: number): SearchTarget | null {
  const literal = text.slice(start, end);
  if (!literal.trim()) return null;
  return { blockIndex, literal, start, ordinal: ordinalOf(text, literal, start) };
}

/** One local replace the DTO may not show yet, in DTO coordinates. */
export type ReplaceEdit = { blockIndex: number; at: number; literal: string; replacement: string };

/** The edits a batch of targets replaced with `text` makes. */
export function editsFor(items: readonly SearchTarget[], text: string): ReplaceEdit[] {
  return items.map((t) => ({ blockIndex: t.blockIndex, at: t.start, literal: t.literal, replacement: text }));
}

/**
 * The ledger minus every edit the DTO now shows: still pending while the DTO text
 * at `at` is the literal and not (yet) the replacement. The second test is what lets
 * a replacement that BEGINS with the literal ("ab" → "abc") leave the ledger.
 */
export function liveEdits(edits: readonly ReplaceEdit[], textOf: (blockIndex: number) => string | undefined): ReplaceEdit[] {
  return edits.filter((e) => {
    const text = textOf(e.blockIndex);
    if (text == null) return false;
    return text.slice(e.at, e.at + e.literal.length) === e.literal && text.slice(e.at, e.at + e.replacement.length) !== e.replacement;
  });
}

/** Where the engine should find a target, given the replaces it has not seen in the DTO. */
export function engineStart(t: SearchTarget, edits: readonly ReplaceEdit[]): number {
  let start = t.start;
  for (const e of edits) {
    if (e.blockIndex === t.blockIndex && e.at < t.start) start += e.replacement.length - e.literal.length;
  }
  return start;
}

type EngineHit = { readonly blockId: string; readonly start: number };

/**
 * The engine match a target means, among the matches of its literal that sit in its
 * block (already filtered by block index). `t.start` is where the ENGINE should have
 * it (see engineStart).
 *
 * In a body paragraph the DTO's offsets and the engine's agree (both count the
 * paragraph's run text), so the NEAREST start wins — which also survives the small
 * drift of a few characters typed since the DTO was taken. In a table the DTO
 * searched a flattened grid while the engine reports per-cell offsets, so there only
 * the ORDINAL (document order) can say which.
 */
export function pickMatch<M extends EngineHit>(inBlock: readonly M[], t: SearchTarget): M | null {
  if (!inBlock.length) return null;
  if (inBlock.every((m) => isBlockLevelId(m.blockId))) {
    let best = inBlock[0];
    for (const m of inBlock) if (Math.abs(m.start - t.start) < Math.abs(best.start - t.start)) best = m;
    return best;
  }
  return inBlock[t.ordinal] ?? null;
}

/**
 * Deduplicated, and back-to-front within each paragraph: replacing a match shifts
 * the offsets of every match AFTER it in the same paragraph, so those go first and
 * the ones before stay valid. Paragraphs are independent of each other.
 */
export function replaceOrder<M extends EngineHit>(ms: readonly M[]): M[] {
  const seen = new Set<string>();
  const out: M[] = [];
  for (const m of ms) {
    const k = `${m.blockId}@${m.start}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.sort((a, b) => (a.blockId === b.blockId ? b.start - a.start : a.blockId < b.blockId ? -1 : 1));
}
