import type { RescueScreen } from "@/lib/rescue-v2-screen";

/** Top of the sheet as % of the screen, measured off the mocks. */
export const SHEET_TOP_PCT: Record<Exclude<RescueScreen, "failure">, number> = {
  start: 42, parts: 24, reading: 49, rules_choice: 24, notes: 15, understood: 49,
  diagnosis: 49, preview: 49, payment: 23, rules: 24, question: 49, cover: 49,
  repairing: 49, result: 49, changed: 22, revisions: 42,
  timeline: 29, version: 33, compare: 55, edit_rerun: 21,
};
export type StageLayout =
  | { kind: "three"; mid: [number, number]; side: [number, number] }
  | { kind: "pair"; each: [number, number] }
  | { kind: "big"; page: [number, number] }
  | { kind: "none" };
/** Mock sizes, before scaling. */
export const STAGE_LAYOUT: Record<Exclude<RescueScreen, "failure">, StageLayout> = {
  start: { kind: "three", mid: [122, 170], side: [84, 120] },
  parts: { kind: "none" },
  reading: { kind: "three", mid: [122, 170], side: [84, 120] },
  rules_choice: { kind: "three", mid: [80, 112], side: [56, 80] },
  notes: { kind: "three", mid: [42, 58], side: [42, 58] },
  understood: { kind: "three", mid: [122, 170], side: [84, 120] },
  diagnosis: { kind: "three", mid: [122, 170], side: [84, 120] },
  preview: { kind: "three", mid: [122, 170], side: [84, 120] },
  payment: { kind: "three", mid: [70, 98], side: [70, 98] },
  rules: { kind: "big", page: [86, 120] },
  question: { kind: "big", page: [150, 200] },
  cover: { kind: "pair", each: [96, 136] },
  repairing: { kind: "three", mid: [122, 170], side: [84, 120] },
  result: { kind: "three", mid: [122, 170], side: [84, 120] },
  changed: { kind: "big", page: [56, 80] },
  revisions: { kind: "three", mid: [122, 170], side: [84, 120] },
  timeline: { kind: "three", mid: [66, 92], side: [52, 72] },
  version: { kind: "three", mid: [76, 106], side: [60, 84] },
  compare: { kind: "big", page: [150, 200] },
  edit_rerun: { kind: "three", mid: [52, 72], side: [52, 72] },
};
export const scaleFor = (screenWidth: number) => screenWidth / 222;

/** A layout's tallest page, in mock units. */
export function tallestMock(layout: StageLayout): number {
  return layout.kind === "three" ? Math.max(layout.mid[1], layout.side[1])
    : layout.kind === "pair" ? layout.each[1] : layout.kind === "big" ? layout.page[1] : 0;
}

/**
 * The scale a stage's pages are drawn at when they must fit `room` points of height: the width's scale, shrunk (never grown) so the tallest
 * page fits, aspect ratio kept. Everything drawn over a page (diagnosis dots) uses the same number, so it stays on the page.
 */
export function roomScale(screenWidth: number, layout: StageLayout, room: number): number {
  const s = scaleFor(screenWidth);
  const tallest = tallestMock(layout) * s;
  return tallest > 0 ? s * Math.max(0, Math.min(1, room / tallest)) : s;
}

/**
 * A measured slot height worth re-rendering for: the first one, or one that moved by at least `step` points. The stage's height follows the
 * sheet frame by frame while it springs; a re-render per frame would be for nothing.
 */
export function nextRoom(prev: number | null, measured: number, step = 4): number | null {
  const next = Math.max(0, Math.floor(measured));
  return prev === null || Math.abs(next - prev) >= step ? next : null;
}

/**
 * The mocks have no status bar: scaled by the width alone, a short stage's pages (screens 4, 5, 9, H5) run up under the status bar and the
 * notch. When the centred pages would reach above the safe area, they shrink to the room between it and the sheet's corner (`SHEET_RADIUS`
 * overlaps the stage) and move down to the middle of that room. A stage where they already fit is left exactly as it was.
 * `stageH` is the stage's height (the sheet's top plus the corner), `tallest` the tallest page at the width's scale.
 */
/**
 * The height a stage's pages may take when the stage stacks other things with them (H2 and H3: a badge above, a page label below) and
 * pads itself under the status bar: the room between the safe area and the sheet's corner, less `reserve` for the stacked rows.
 */
export function stageRoom(stageH: number, topInset: number, reserve: number): number {
  return Math.max(0, stageH - (topInset + 4) - (SHEET_RADIUS + 4) - reserve);
}

export function stageFit(stageH: number, tallest: number, topInset: number): { factor: number; shift: number } {
  const top = topInset + 4;
  const bottom = stageH - SHEET_RADIUS - 4;
  if ((stageH - tallest) / 2 >= top || bottom <= top) return { factor: 1, shift: 0 };
  const factor = Math.min(1, (bottom - top) / tallest);
  return { factor, shift: (top + bottom) / 2 - stageH / 2 };
}
export const SHEET_RADIUS = 22;
