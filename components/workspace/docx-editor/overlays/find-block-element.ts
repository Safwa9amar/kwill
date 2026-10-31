// Block index → the engine's PAINTED elements for that block, and the rect they
// cover. The one place the overlay layer (and anything else that has to sit on a
// block — W4's select-mode checkboxes) learns where a block is on screen.
//
// What the engine paints (2.21.1, read from its dist — not part of the typed API):
//
//   div.docx-page[data-page-index]
//     div.docx-paragraph-fragment[data-paragraph-id][data-fragment-index]   ← one per page a paragraph lands on
//       span[data-paragraph-id][data-start][data-end]                        ← its lines/runs, SAME id
//     div.docx-table-fragment[data-table-id][data-fragment-index]           ← one per page a table lands on
//       … cell paragraphs, with DEEPER ids (/word/document.xml#0.1.43.r.c.p)
//
// The ids are the structural node ids lib/docx-block-id.ts parses: a block-level
// one has exactly three segments and its third is the DTO block index (as of the
// load — spec D7).
//
// ⚠️ `data-paragraph-id` is ALSO stamped on every run/line span inside the
// fragment, with the very same block-level id. Matching on the id alone finds a
// span (one line of the paragraph), not the paragraph — `data-fragment-index` is
// what only the fragment CONTAINERS carry, so it is part of the selector.
//
// ⚠️ A page the engine has virtualised out has no elements at all. "Not found" is
// therefore an ordinary answer, and every consumer must treat it as "hide", never
// as "the block is gone".
//
// Pure enough for node: nothing touches `document`/`window` at import time, and the
// DOM-walking helpers take their root as an argument, so find-block-element.test.ts
// drives them with plain objects.

import { FRAGMENT_SELECTOR, blockIndexOfFragmentId, fragmentIdOf } from "../bridge/dom-selectors";

// The fragment primitives (the selector — see the ⚠️ above for why
// `data-fragment-index` is in it — the id a fragment carries, and the body index it
// names) live in bridge/dom-selectors.ts: the Bridge's selection report resolves
// blocks with the very same selector, and bridge/ importing overlays/ would close a
// require cycle. Re-exported here for the overlays.
export { FRAGMENT_SELECTOR, blockIndexOfFragmentId, fragmentIdOf };

/** The minimum an element has to offer for the walk below (a real Element qualifies). */
export type FragmentLike = {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): RectLike;
};
export type FragmentRoot = { querySelectorAll(selector: string): ArrayLike<FragmentLike> };

/** A viewport rect without the DOMRect class, so the arithmetic stays testable. */
export type RectLike = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** Every index from `start` to `end` inclusive (either order); empty for nonsense. */
export function rangeIndices(start: number, end: number): number[] {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.max(start, end);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/**
 * The painted fragment containers of each wanted block, in DOM order. ONE query for
 * all of them — a consumer with fifty blocks (select mode) must not cost fifty.
 * Blocks with nothing painted are simply absent from the map.
 */
export function collectBlockFragments<E extends FragmentLike>(
  root: { querySelectorAll(selector: string): ArrayLike<E> },
  wanted: ReadonlySet<number>,
): Map<number, E[]> {
  const out = new Map<number, E[]>();
  if (wanted.size === 0) return out;
  const all = root.querySelectorAll(FRAGMENT_SELECTOR);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const index = blockIndexOfFragmentId(fragmentIdOf(el));
    if (index == null || !wanted.has(index)) continue;
    const list = out.get(index);
    if (list) list.push(el);
    else out.set(index, [el]);
  }
  return out;
}

/**
 * The smallest rect holding every given rect, ignoring empty ones (a fragment
 * being laid out reports 0×0). null when nothing is left.
 */
export function unionRects(rects: readonly RectLike[]): RectLike | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rects) {
    if (!(r.width > 0) || !(r.height > 0)) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (!Number.isFinite(left)) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** The viewport rect each wanted block's painted fragments cover (absent = not painted). */
export function measureBlocks(root: FragmentRoot, wanted: ReadonlySet<number>): Map<number, RectLike> {
  const out = new Map<number, RectLike>();
  for (const [index, els] of collectBlockFragments(root, wanted)) {
    const r = unionRects(els.map((el) => el.getBoundingClientRect()));
    if (r) out.set(index, r);
  }
  return out;
}

/** Equal to the half pixel — the threshold below which a re-render buys nothing. */
export function sameRect(a: RectLike | null | undefined, b: RectLike | null | undefined): boolean {
  if (!a || !b) return a == b; // eslint-disable-line eqeqeq
  return (
    Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
  );
}
