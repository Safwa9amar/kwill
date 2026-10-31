// Which blocks (and which running header/footer edges) a SERVER change touched —
// so the docx surface can put a "working on it" shimmer on exactly those while it
// reloads the bytes (spec D3), instead of leaving the page looking unchanged.
//
// Pure: runs on the native side over two DocumentDTOs, tested under node.
//
// Deliberately cheap and conservative. Equal lengths → compare position by position
// (a restyle, a rewrite, a chart patch). Different lengths → the span between the
// longest common prefix and suffix (an insert or delete shifts everything after it,
// and a per-index compare would light up the rest of the thesis). Past `cap` blocks
// it is an AI rewrite of a whole chapter: mark the first `cap` and stop — the point
// is that the page visibly responds, not an exhaustive census.

import type { DocBlockDTO, DocSectionDTO } from "@/lib/api";

export type DocChanges = { blocks: number[]; sides: ("header" | "footer")[] };

// Content, not position: after an insert every later block carries a new `index`,
// and comparing that would turn one inserted equation into "the rest of the thesis".
function sameBlock(a: DocBlockDTO, b: DocBlockDTO): boolean {
  return a === b || JSON.stringify({ ...a, index: 0 }) === JSON.stringify({ ...b, index: 0 });
}

export function changedBlocks(prev: readonly DocBlockDTO[], next: readonly DocBlockDTO[], cap = 12): number[] {
  const out: number[] = [];
  if (prev.length === next.length) {
    for (let i = 0; i < next.length && out.length < cap; i++) {
      if (!sameBlock(prev[i], next[i])) out.push(next[i].index);
    }
    return out;
  }
  let head = 0;
  const min = Math.min(prev.length, next.length);
  while (head < min && sameBlock(prev[head], next[head])) head++;
  let tail = 0;
  while (
    tail < min - head &&
    sameBlock(prev[prev.length - 1 - tail], next[next.length - 1 - tail])
  ) tail++;
  // The blocks of `next` between the shared prefix and suffix are the new/changed
  // ones. A pure deletion leaves none: mark the block that closed the gap instead.
  const from = head;
  const to = next.length - tail; // exclusive
  if (to <= from) {
    const closer = next[Math.min(from, next.length - 1)];
    return closer ? [closer.index] : [];
  }
  for (let i = from; i < to && out.length < cap; i++) out.push(next[i].index);
  return out;
}

function partKey(s: DocSectionDTO, side: "header" | "footer"): string {
  return JSON.stringify(side === "header" ? s.header : s.footer);
}

export function changedSides(prev: readonly DocSectionDTO[] | undefined, next: readonly DocSectionDTO[] | undefined): ("header" | "footer")[] {
  const a = prev ?? [];
  const b = next ?? [];
  const out: ("header" | "footer")[] = [];
  for (const side of ["header", "footer"] as const) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (!a[i] || !b[i] || partKey(a[i], side) !== partKey(b[i], side)) { out.push(side); break; }
    }
  }
  return out;
}

export function docChanges(
  prev: { blocks: readonly DocBlockDTO[]; sections?: readonly DocSectionDTO[] },
  next: { blocks: readonly DocBlockDTO[]; sections?: readonly DocSectionDTO[] },
): DocChanges {
  return { blocks: changedBlocks(prev.blocks, next.blocks), sides: changedSides(prev.sections, next.sections) };
}
