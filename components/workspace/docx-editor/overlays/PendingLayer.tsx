// "Working on it" on the very element a SERVER edit is about to change.
//
// Everything the engine can do itself happens in the engine, instantly. What it
// cannot — a chart patch, a background removal, a crop, an equation/caption/header
// sheet's apply, an AI turn's edit — goes to the server and comes back as a reload
// of the bytes (spec D3). Without a mark, the page would sit there unchanged for the
// whole round trip and the tap would look like it did nothing. The native host
// decides WHAT is pending (stores/docx-surface-store); this paints a shimmer on the
// painted element(s) of each pending block — a picture, a paragraph's fragments on
// every page it spans, a table — and on the running header/footer bands.
//
// Positioned like ChartLayer (fixed, from live rects); pointer-events none, so it
// never eats a tap.

import { useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { brand, rgbTriplet } from "@/constants/colors";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";
import { isBlockLevelId } from "../bridge/dom-selectors";
import { deferToPreview, usePreviewCover } from "./preview-cover";
import { sameBoxes, useAnchored, type Box } from "./use-anchored";

type Mark = Box & { key: string };

// Painted elements that stand for a whole body block. A paragraph is painted as one
// fragment per page it spans; a picture or chart as its drawing; a table as one
// fragment per page.
const BLOCK_SELECTOR = ".docx-paragraph-fragment[data-paragraph-id],.docx-table-fragment[data-table-id],[data-drawing-node-id]";

function blockIdOf(el: Element): string | null {
  return el.getAttribute("data-drawing-node-id") ?? el.getAttribute("data-table-id") ?? el.getAttribute("data-paragraph-id");
}

const CSS = (() => {
  const rgb = rgbTriplet(brand.primary);
  return [
    "@keyframes docx-pending-sweep{0%{background-position:-160% 0}100%{background-position:260% 0}}",
    ".docx-pending{position:fixed;pointer-events:none;z-index:46;border-radius:3px;",
    `background:linear-gradient(100deg,rgba(${rgb},.06) 30%,rgba(${rgb},.22) 50%,rgba(${rgb},.06) 70%);`,
    "background-size:200% 100%;animation:docx-pending-sweep 1.3s linear infinite;",
    `box-shadow:inset 0 0 0 1px rgba(${rgb},.35)}`,
  ].join("");
})();

export function PendingLayer({ pending: marked, pendingChrome }: { pending: readonly number[]; pendingChrome: readonly string[] }) {
  // A block the "applying" preview is painted over already shows the result; a
  // shimmer on top would be a second overlay on it (preview-cover.ts).
  const cover = usePreviewCover();
  const absorbed = useRef<ReadonlySet<number>>(new Set());
  const pending = useMemo(() => {
    const r = deferToPreview(marked, cover, absorbed.current);
    absorbed.current = r.absorbed;
    return r.shown;
  }, [marked.join(","), cover]); // eslint-disable-line react-hooks/exhaustive-deps
  const sig = `${pending.join(",")}|${pendingChrome.join(",")}`;
  const wanted = useMemo(() => new Set(pending), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const sides = useMemo(() => new Set(pendingChrome), [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const measure = useCallback((): Mark[] => {
    const out: Mark[] = [];
    const vh = window.innerHeight;
    const push = (key: string, el: Element) => {
      const r = el.getBoundingClientRect();
      // Off screen or unpainted: nothing to show, and nothing to observe for.
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > vh) return;
      out.push({ key, left: r.left, top: r.top, width: r.width, height: r.height });
    };
    if (wanted.size) {
      // A figure's block is its carrier paragraph AND the drawing in it: mark the
      // drawing alone, or the two shimmers stack.
      const drawings = new Map<number, Element[]>();
      const others = new Map<number, Element[]>();
      for (const el of Array.from(document.querySelectorAll(BLOCK_SELECTOR))) {
        const id = blockIdOf(el);
        if (!isBodyId(id)) continue;
        const isDrawing = el.hasAttribute("data-drawing-node-id");
        // A picture's id runs deeper than its block; a paragraph's must BE the block
        // (a table cell's paragraph lies inside the table's own mark).
        if (!isDrawing && !isBlockLevelId(id)) continue;
        const index = blockIndexFromId(id);
        if (index == null || !wanted.has(index)) continue;
        const into = isDrawing ? drawings : others;
        into.set(index, [...(into.get(index) ?? []), el]);
      }
      for (const index of wanted) {
        for (const el of drawings.get(index) ?? others.get(index) ?? []) push(`b${index}:${out.length}`, el);
      }
    }
    for (const side of sides) {
      for (const el of Array.from(document.querySelectorAll(`.docx-hf[data-docx-hf="${side}"]:not(.docx-hf--placeholder)`))) {
        push(`${side}:${out.length}`, el);
      }
    }
    return out;
  }, [wanted, sides]);

  const marks = useAnchored(measure, sameBoxes, wanted.size > 0 || sides.size > 0);
  if (typeof document === "undefined" || !marks.length) return null;

  return createPortal(
    <>
      <style>{CSS}</style>
      {marks.map((m) => (
        <div key={m.key} className="docx-pending" style={{ left: m.left, top: m.top, width: m.width, height: m.height }} />
      ))}
    </>,
    document.body,
  );
}
