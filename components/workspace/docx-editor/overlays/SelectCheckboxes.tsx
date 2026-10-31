// Task 24 — checkbox select mode on the docx surface: build a multi-block
// selection by TAPPING blocks (the ✦ dock's "Select" chip), the Lexical SelectPlugin's
// behaviour on the engine's painted pages.
//
// Mounted only while the mode is on (DocxEditorDom), and while it is mounted the
// host has put the engine in `mode="view"` — read-only, so a tap places no caret,
// opens no keyboard and starts no OS selection. Here:
//   • one checkbox per painted body block, in the page margin at the START of the
//     block's text (right for an Arabic block, left for a Latin one — select-rows.ts),
//     plus a tint over the checked ones;
//   • a tap ANYWHERE on a block toggles it — the whole block is the target, not the
//     20px box; the box itself and the margin around it count too;
//   • the checked marks come from the host (`selected`, the workspace store's pick),
//     so the store stays the single source of truth; a tapped box flips at once
//     locally and the store's echo confirms it (reconcileFlips).
//
// Everything painted here is pointer-events: none — a checkbox that took touches
// would be a dead spot for scrolling (it sits outside the engine's scroller). Taps
// are read by ONE click listener on `window`, capture phase: it runs before the
// document-level ones (the equation tap would otherwise open its sheet), and
// stopping it there keeps the click from the engine and the chart layer.
//
// ⚠️ `cursor: pointer` on the pages is load-bearing on iOS, not decoration: WebKit
// only dispatches a click for a tap on an element it considers clickable, and a
// listener on window does not make anything clickable (the Lexical plugin's CSS
// carries the same note).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom"; // typed by ./react-dom.d.ts (no @types/react-dom)
import { brand, rgbTriplet } from "@/constants/colors";
import { blockIndexOfFragmentId, bodyFragmentOf, fragmentIdOf, type PaintedEl } from "../bridge/dom-selectors";
import { BOX, blockTextAt, checkboxAt, drawnBoxes, readSelectRows, reconcileFlips, rowAt, sameRows, type SelectRow } from "./select-rows";
import { OVERLAY_ATTR, subscribeLayout } from "./use-block-rect";

const CHECK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='%23fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' d='M3.2 8.4l3.1 3.1 6.5-6.5'/%3E%3C/svg%3E";

const CSS = (() => {
  const rgb = rgbTriplet(brand.primary);
  return [
    // The engine's pages: no OS selection, no callout, and clickable (see ⚠️ above).
    "[data-page-index],[data-page-index] *{-webkit-user-select:none;user-select:none;",
    // touch-action: WebKit otherwise holds every click ~350ms to see whether the tap
    // becomes a double-tap zoom; select mode has no use for one, and the box must
    // flip under the finger.
    "-webkit-touch-callout:none;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}",
    "html,body{touch-action:manipulation}",
    // will-change: every fixed overlay root gets its own compositing layer, so a
    // style-only change (a box flipping, a card resizing) is a cheap composite over
    // the engine's pages rather than a repaint of them. Measured on the simulator
    // with timestamps: click → flip on screen ≤170ms. (⚠️ Maestro returns ~3s
    // BEFORE the simulator delivers the touch — time a tap from the DOM's own
    // click timestamp, never from when the driver returned.)
    `.kws-box{position:fixed;z-index:47;width:${BOX}px;height:${BOX}px;box-sizing:border-box;`,
    "border:2px solid #b9bcc8;border-radius:6px;background:#fff center/14px 14px no-repeat;",
    "pointer-events:none;transition:background-color .12s ease,border-color .12s ease;will-change:transform;transform:translateZ(0)}",
    `.kws-box.on{border-color:${brand.primary};background-color:${brand.primary};background-image:url("${CHECK}")}`,
    // Above the chart layer (45): a checked chart block is tinted like any other.
    `.kws-tint{position:fixed;z-index:46;pointer-events:none;border-radius:4px;background:rgba(${rgb},.11);will-change:transform;transform:translateZ(0)}`,
  ].join("");
})();

const NO_FLIPS: ReadonlyMap<number, boolean> = new Map();

export function SelectCheckboxes({ selected, onToggle }: {
  /** Block indices the host has picked (the workspace store's selectedBlocks). */
  selected: readonly number[];
  onToggle: (index: number, text: string) => void;
}) {
  // Our own container: mutations under OVERLAY_ATTR never trigger a re-measure, or
  // every flipped box would re-measure the whole document (use-block-rect.ts).
  const host = useMemo(() => {
    const el = document.createElement("div");
    el.setAttribute(OVERLAY_ATTR, "");
    return el;
  }, []);
  useLayoutEffect(() => {
    document.body.appendChild(host);
    return () => host.remove();
  }, [host]);

  // ── where every painted block is: one pass per layout tick ──
  const [rows, setRows] = useState<SelectRow[]>([]);
  const latest = useRef<SelectRow[]>([]);
  useEffect(() => subscribeLayout(() => {
    const next = readSelectRows(document, window.innerHeight);
    latest.current = next;
    setRows((prev) => (sameRows(prev, next) ? prev : next));
  }), []);

  // ── what is checked: the host's pick, plus taps it has not echoed yet ──
  const hostKey = selected.join(",");
  const hostSet = useMemo(() => new Set(selected), [hostKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [flips, setFlips] = useState(NO_FLIPS);
  useEffect(() => { setFlips((prev) => reconcileFlips(prev, hostSet)); }, [hostSet]);
  // Read by the tap, which must see a flip made earlier in the same frame.
  const live = useRef({ hostSet, flips });
  live.current = { hostSet, flips };
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;

  const toggle = useCallback((index: number) => {
    const { hostSet: h, flips: f } = live.current;
    const next = new Map(f);
    next.set(index, !(f.get(index) ?? h.has(index)));
    live.current = { hostSet: h, flips: next };
    setFlips(next);
    // The host toggles too (the store's toggleBlock), so the two agree as long as
    // every tap arrives — which the bridge guarantees, in order.
    onToggleRef.current(index, blockTextAt(document, index));
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      // An AI card or preview owns its own taps.
      if (target?.closest(`[${OVERLAY_ATTR}]`)) return;
      const frag = bodyFragmentOf(target as PaintedEl | null);
      const index = (frag ? blockIndexOfFragmentId(fragmentIdOf(frag)) : null)
        ?? rowAt(latest.current, e.clientX, e.clientY, window.innerWidth);
      if (index == null) return;
      e.preventDefault();
      e.stopPropagation();
      toggle(index);
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [toggle]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const drawn = drawnBoxes(rows, vw);
  return createPortal(
    <>
      <style>{CSS}</style>
      {rows.map((r) => {
        const on = flips.get(r.index) ?? hostSet.has(r.index);
        const c = checkboxAt(r, vw);
        return (
          <div key={r.index}>
            {on ? r.boxes.map((b, k) => (
              <div key={k} className="kws-tint" style={{ left: b.left - 3, top: b.top - 2, width: b.width + 6, height: b.height + 4 }} />
            )) : null}
            {drawn.has(r.index) ? <div className={on ? "kws-box on" : "kws-box"} style={{ left: c.left, top: c.top }} /> : null}
          </div>
        );
      })}
    </>,
    host,
  );
}
