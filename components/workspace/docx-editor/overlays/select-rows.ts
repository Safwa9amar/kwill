// Checkbox select mode's geometry (Task 24) — pure, so select-rows.test.ts runs it
// under node with plain objects. SelectCheckboxes.tsx is the React/DOM half.
//
// A "row" is one painted BODY block: its fragment boxes (a paragraph that spans a
// page has two), the box its checkbox sits beside, and the side that box is on.
//
// Why not useBlockRects: that hook wants the indices up front and hands back rects
// only. Select mode wants EVERY painted block — which ones are painted is exactly
// what the pass discovers — and each one's direction, from the same single pass.

import { getTextDirection, firstStrongDirection } from "@/lib/text-direction";
import { FRAGMENT_SELECTOR, blockIndexOfFragmentId, fragmentIdOf, paintedText, type PaintedEl } from "../bridge/dom-selectors";
import { sameRect, type RectLike } from "./find-block-element";

/** Checkbox edge, and the gap between it and the block's text column. */
export const BOX = 20;
const GAP = 6;
/** Extra reach around the box for a fingertip: the box itself is small. */
const REACH = 10;

export type SelectRow = {
  index: number;
  /** Every painted fragment of the block that is not empty. */
  boxes: RectLike[];
  /** The fragment the checkbox sits beside: the first one still on screen. */
  anchor: RectLike;
  rtl: boolean;
};

type SelectFragment = Pick<PaintedEl, "getAttribute" | "textContent"> & { getBoundingClientRect(): RectLike };

// The direction a text OPENS with, or null when it has no strong letter at all (an
// empty paragraph, a figure's carrier, "(1)"). Two fallbacks that disagree only
// when the fallback was used.
function strongDir(text: string): "rtl" | "ltr" | null {
  const a = firstStrongDirection(text, "ltr");
  return a === firstStrongDirection(text, "rtl") ? a : null;
}

/**
 * Every painted body block with any part on screen (0..viewportH), in document
 * order — ONE querySelectorAll, one rect read per fragment.
 *
 * The side follows the block's CONTENT (the codebase rule: a thesis's language
 * field is unreliable, the text is not): an Arabic paragraph's box goes on the
 * right, a French one's on the left. A block with no letter of its own takes its
 * neighbour's side, so an empty line between two Arabic paragraphs does not throw
 * its box across the page; with no letter anywhere, the column falls back to the
 * whole screen's majority, then LTR.
 */
export function readSelectRows(root: { querySelectorAll(selector: string): ArrayLike<SelectFragment> }, viewportH: number): SelectRow[] {
  const groups = new Map<number, SelectFragment[]>();
  const all = root.querySelectorAll(FRAGMENT_SELECTOR);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const index = blockIndexOfFragmentId(fragmentIdOf(el));
    if (index == null) continue;
    const list = groups.get(index);
    if (list) list.push(el);
    else groups.set(index, [el]);
  }
  const rows: SelectRow[] = [];
  const dirs: ("rtl" | "ltr" | null)[] = [];
  const texts: string[] = [];
  for (const [index, els] of groups) {
    const boxes = els.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (!boxes.some((r) => r.bottom > 0 && r.top < viewportH)) continue;
    const anchor = boxes.find((r) => r.bottom > 0) ?? boxes[0];
    // Raw textContent is enough here: gluing two wrapped lines cannot change which
    // strong letter comes FIRST (paintedText, the careful reading, is for the tap).
    const text = els.map((el) => el.textContent ?? "").join(" ");
    rows.push({ index, boxes, anchor, rtl: false });
    dirs.push(strongDir(text));
    texts.push(text);
  }
  const whole = getTextDirection(texts.join(" "), "ltr");
  for (let i = 0; i < rows.length; i++) {
    let d = dirs[i];
    for (let k = i - 1; d == null && k >= 0; k--) d = dirs[k];
    for (let k = i + 1; d == null && k < rows.length; k++) d = dirs[k];
    rows[i].rtl = (d ?? whole) === "rtl";
  }
  return rows;
}

/** Same rows, same sides, every box within half a pixel — nothing to re-render. */
export function sameRows(a: readonly SelectRow[], b: readonly SelectRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.index !== y.index || x.rtl !== y.rtl || x.boxes.length !== y.boxes.length) return false;
    if (!sameRect(x.anchor, y.anchor)) return false;
    for (let k = 0; k < x.boxes.length; k++) if (!sameRect(x.boxes[k], y.boxes[k])) return false;
  }
  return true;
}

/**
 * Where a row's checkbox goes (viewport coordinates): in the page margin at the
 * START of the block's text column — left for LTR, right for RTL — level with its
 * first line. A one- or two-line block centres it; a taller one pins it to the top.
 * Clamped on screen, so a page fitted edge to edge still shows it (over the text).
 */
export function checkboxAt(row: SelectRow, viewportW: number): { left: number; top: number } {
  const a = row.anchor;
  const left = row.rtl ? Math.min(a.right + GAP, viewportW - BOX - 2) : Math.max(2, a.left - GAP - BOX);
  const top = a.height <= BOX * 2 ? a.top + (a.height - BOX) / 2 : a.top;
  return { left, top };
}

/**
 * The row a tap at (x, y) means, when the tap did not land on a block's own text:
 * its checkbox (with a fingertip's reach), else any of its painted boxes — a chart
 * drawn over its carrier paragraph, a figure.
 */
export function rowAt(rows: readonly SelectRow[], x: number, y: number, viewportW: number): number | null {
  for (const r of rows) {
    const c = checkboxAt(r, viewportW);
    if (x >= c.left - REACH && x <= c.left + BOX + REACH && y >= c.top - REACH && y <= c.top + BOX + REACH) return r.index;
  }
  for (const r of rows) {
    if (r.boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) return r.index;
  }
  return null;
}

/** Block `index`'s whole painted text — what the host stores beside the pick. */
export function blockTextAt(root: { querySelectorAll(selector: string): ArrayLike<PaintedEl> }, index: number): string {
  const all = root.querySelectorAll(FRAGMENT_SELECTOR);
  const mine: PaintedEl[] = [];
  for (let i = 0; i < all.length; i++) if (blockIndexOfFragmentId(fragmentIdOf(all[i])) === index) mine.push(all[i]);
  return paintedText(mine);
}

/**
 * Visual first: a tapped box flips at once (`flips`), before the host's selection
 * comes back across the bridge. Each flip is dropped as soon as the host AGREES
 * with it, so the host stays the source of truth — and a double tap in flight
 * (flip on, flip off) resolves to whatever the host settles on.
 */
export function reconcileFlips(flips: ReadonlyMap<number, boolean>, host: ReadonlySet<number>): ReadonlyMap<number, boolean> {
  if (flips.size === 0) return flips;
  let next: Map<number, boolean> | null = null;
  for (const [i, on] of flips) {
    if (host.has(i) !== on) continue;
    next ??= new Map(flips);
    next.delete(i);
  }
  return next ?? flips;
}
