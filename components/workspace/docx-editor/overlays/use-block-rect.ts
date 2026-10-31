// Live viewport rects for body blocks, for anything that has to sit ON a block in
// the docx surface: the AI cards here, and (Phase 4) select mode's checkboxes.
//
//   useBlockRect(index)         one block                 → DOMRect | null
//   useRangeRect(start, end)    union of start..end       → DOMRect | null
//   useBlockRects(indices)      many blocks, ONE DOM pass → Map<index, DOMRect>
//
// null / absent means "not painted right now" — the engine only paints pages near
// the viewport — and the consumer HIDES; it must not keep a stale position.
// Rects are VIEWPORT coordinates (getBoundingClientRect), i.e. for `position: fixed`.
//
// They stay live through scroll, zoom, repaint and reload by re-measuring on ONE
// shared, rAF-coalesced tick (the web ChartLayer's technique, lifted out so N
// consumers cost one listener set, not N):
//   - `scroll` in the CAPTURE phase on document — the engine's scroller is not the
//     window, and scroll does not bubble;
//   - window + visualViewport resize (rotation, the iOS keyboard);
//   - a ResizeObserver and a MutationObserver on <body>.
// ⚠️ Observe <body>, not `.docx-pages`: the engine paints ASYNC (wasm, fonts, its
// own layout pass), so the pages container usually does not exist yet when a
// consumer mounts — the first web version observed nothing and never moved again.
// ⚠️ Mutations INSIDE the overlay layer are ignored: a streaming card re-renders
// every few ms and would otherwise re-measure the document on every token.
//
// Re-measuring is a single querySelectorAll over the painted pages plus one
// getBoundingClientRect per matching fragment, and a consumer only re-renders when
// its rect moved by half a pixel or more (sameRect).

import { useEffect, useMemo, useState } from "react";
import { measureBlocks, rangeIndices, sameRect, unionRects, type RectLike } from "./find-block-element";

/** Set on the overlay layer's container; mutations under it never re-measure. */
export const OVERLAY_ATTR = "data-kw-overlay";

const listeners = new Set<() => void>();
let raf = 0;
let teardown: (() => void) | null = null;

function flush() {
  raf = 0;
  for (const l of Array.from(listeners)) l();
}

/** Ask every consumer to re-measure on the next frame (coalesced). */
export function requestLayoutTick(): void {
  if (!raf && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(flush);
}

function insideOverlay(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest(`[${OVERLAY_ATTR}]`);
}

function install(): () => void {
  const schedule = requestLayoutTick;
  const vv = window.visualViewport;
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
  ro?.observe(document.body);
  const mo = typeof MutationObserver !== "undefined"
    ? new MutationObserver((records) => {
        for (const r of records) if (!insideOverlay(r.target)) { schedule(); return; }
      })
    : null;
  // style/class: zoom and repaint move fragments by rewriting their inline boxes;
  // childList: a page painted in or recycled out, a re-parse after a reload.
  mo?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  return () => {
    document.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    ro?.disconnect();
    mo?.disconnect();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  };
}

/**
 * Run `fn` on every layout tick (and once on the next frame). The listener set is
 * installed with the first subscriber and torn down with the last.
 */
export function subscribeLayout(fn: () => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1) teardown = install();
  requestLayoutTick();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && teardown) { teardown(); teardown = null; }
  };
}

function toDomRect(r: RectLike): DOMRect {
  return new DOMRect(r.left, r.top, r.width, r.height);
}

/**
 * Live rects for several blocks from ONE DOM pass per frame. The map only changes
 * identity when some rect actually moved, so it is safe as an effect dependency.
 */
export function useBlockRects(indices: readonly number[]): ReadonlyMap<number, DOMRect> {
  // A fresh array every render must not resubscribe: key on the values.
  const key = indices.join(",");
  const wanted = useMemo(() => new Set(indices), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rects, setRects] = useState<ReadonlyMap<number, DOMRect>>(() => new Map());

  useEffect(() => {
    if (wanted.size === 0) { setRects((prev) => (prev.size ? new Map() : prev)); return; }
    const measure = () => {
      const next = measureBlocks(document, wanted);
      setRects((prev) => {
        let same = prev.size === next.size;
        if (same) for (const [i, r] of next) if (!sameRect(prev.get(i), r)) { same = false; break; }
        if (same) return prev;
        const out = new Map<number, DOMRect>();
        for (const [i, r] of next) out.set(i, toDomRect(r));
        return out;
      });
    };
    return subscribeLayout(measure);
  }, [wanted]);

  return rects;
}

/** The live rect of block `index`, or null while it is not painted. Pass null for "none". */
export function useBlockRect(index: number | null | undefined): DOMRect | null {
  const rects = useBlockRects(index == null || index < 0 ? [] : [index]);
  return index == null ? null : rects.get(index) ?? null;
}

/**
 * The union of the painted parts of blocks start..end (inclusive), or null when none
 * of them is painted. A range whose head is scrolled out still anchors on its tail.
 */
export function useRangeRect(start: number | null | undefined, end: number | null | undefined): DOMRect | null {
  const indices = useMemo(
    () => (start == null || end == null ? [] : rangeIndices(start, end)),
    [start, end],
  );
  const rects = useBlockRects(indices);
  return useMemo(() => {
    const u = unionRects(Array.from(rects.values()));
    return u ? toDomRect(u) : null;
  }, [rects]);
}
