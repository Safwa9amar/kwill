// Keep a list of viewport rects in step with the painted pages under them.
//
// The engine paints ASYNC (wasm, fonts, its own layout pass) and virtualises pages,
// so what an overlay sits on can appear, move or vanish at any moment: re-measure on
// scroll (capture — the scroller is the engine's, not the window), on resize, and on
// any DOM mutation. rAF-coalesced, and `same` keeps the previous array when nothing
// moved so observe → measure → setState cannot feed itself.
//
// ⚠️ Observe <body>, not the pages container: it almost never exists yet when an
// overlay mounts (learned in the web ChartLayer — overlays stayed at zero forever).
//
// Shared by ChartLayer and PendingLayer only. The suggestion/range/table cards have
// their own anchoring (OverlayLayer + use-block-rect).

import { useEffect, useRef, useState } from "react";

export function useAnchored<T>(
  measure: () => T[],
  same: (a: T[], b: T[]) => boolean,
  /** Skip observing entirely while there is nothing to place. */
  active: boolean,
): T[] {
  const [items, setItems] = useState<T[]>([]);
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const sameRef = useRef(same);
  sameRef.current = same;
  const raf = useRef(0);

  // Inputs changed (new charts, new pending set) → place them now, not on the next scroll.
  useEffect(() => {
    if (!active) { setItems((prev) => (prev.length ? [] : prev)); return; }
    const next = measureRef.current();
    setItems((prev) => (sameRef.current(prev, next) ? prev : next));
  }, [measure, active]);

  useEffect(() => {
    if (!active) return;
    const run = () => {
      raf.current = 0;
      const next = measureRef.current();
      setItems((prev) => (sameRef.current(prev, next) ? prev : next));
    };
    const schedule = () => { if (!raf.current) raf.current = requestAnimationFrame(run); };
    schedule();
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
    ro?.observe(document.body);
    mo?.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [active]);

  return items;
}

export type Box = { left: number; top: number; width: number; height: number };

export function sameBoxes<B extends Box & { key: string }>(a: B[], b: B[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.key !== y.key || x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) return false;
  }
  return true;
}
