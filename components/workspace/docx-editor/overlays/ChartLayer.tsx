// Chart RENDER layer for the docx surface — ported from kwill-dashboard
// (bubble/ChartLayer.tsx), where it was proven on real theses.
//
// The engine draws native Word charts as blank placeholders (it treats a chart as a
// non-editable graphic). The server already rebuilds every chart as an SVG (the
// DTO's image block `svg`), so that SVG is painted on top of the placeholder — the
// editor shows real charts without touching the engine.
//
// Identity is EXACT: the placeholder carries `data-drawing-node-id`
// (`/word/document.xml#<doc>.<body>.<blockIndex>.…`) and its third segment is the
// DTO block index (lib/docx-block-id.ts). So each placeholder resolves to its chart
// directly, immune to page virtualisation and to other unsupported graphics in the
// flow. The label is only a secondary EXCLUSION filter (chart-placeholder.ts).
//
// Visual first: a chart edit is a SERVER patch (ChartToolbar → updateThesisChart),
// whose echoed document carries the new SVG; the host hands it straight down, so the
// overlay swaps at once — before the bytes reload behind it.
//
// A tap on a chart is reported as a whole-block selection (`blockType: "image"` at
// the chart's index, like read-state.ts did for Lexical's chart node), so the native
// ChartToolbar opens on it.

import { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { brand } from "@/constants/colors";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";
import type { ChartOverlayInput } from "../bridge/surface-types";
import { isChartPlaceholderLabel } from "./chart-placeholder";
import { sameBoxes, useAnchored, type Box } from "./use-anchored";

type Hit = Box & { key: string; index: number; svg: string };

export function ChartLayer({
  charts,
  selectedIndex,
  onSelect,
}: {
  charts: readonly ChartOverlayInput[];
  /** The chart the native selection is on (ring), or -1. */
  selectedIndex: number;
  onSelect: (index: number, rect: Box) => void;
}) {
  // The props cross the bridge as fresh JSON every host render; key the measure on
  // CONTENT so a re-sent identical list does not re-place every overlay.
  const sig = useMemo(() => charts.map((c) => `${c.index}:${c.svg.length}:${c.svg.slice(-64)}`).join("|"), [charts]);
  const bySvg = useMemo(() => new Map(charts.map((c) => [c.index, c.svg])), [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const measure = useCallback((): Hit[] => {
    const out: Hit[] = [];
    const claimed = new Set<number>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".docx-drawing-placeholder"))) {
      if (!isChartPlaceholderLabel(el.textContent ?? "")) continue;
      const id = el.getAttribute("data-drawing-node-id");
      const index = isBodyId(id) ? blockIndexFromId(id) : null;
      if (index == null || claimed.has(index)) continue;
      const svg = bySvg.get(index);
      if (svg == null) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue; // not painted / zero-size
      claimed.add(index);
      out.push({ key: `${index}:${svg.length}`, index, svg, left: r.left, top: r.top, width: r.width, height: r.height });
    }
    return out.sort((a, b) => a.index - b.index);
  }, [bySvg]);

  const hits = useAnchored(measure, sameBoxes, charts.length > 0);
  if (typeof document === "undefined" || !hits.length) return null;

  return createPortal(
    <>
      {hits.map((h) => (
        <div
          key={h.index}
          role="button"
          tabIndex={-1}
          aria-label="Chart"
          // Keep the engine's caret where it is: the tap selects the CHART, natively.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(h.index, { left: h.left, top: h.top, width: h.width, height: h.height })}
          style={{
            position: "fixed", left: h.left, top: h.top, width: h.width, height: h.height, zIndex: 45,
            overflow: "hidden", borderRadius: 2, background: "#fff", cursor: "pointer",
            boxShadow: selectedIndex === h.index ? `0 0 0 2px ${brand.primary}` : "none",
          }}
          // Server-generated SVG (our chartToSvg) — not user HTML.
          dangerouslySetInnerHTML={{ __html: fitSvg(h.svg) }}
        />
      ))}
    </>,
    document.body,
  );
}

/** Make the server SVG fill its overlay box: force width/height 100% on the root. */
function fitSvg(svg: string): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\s(width|height)="[^"]*"/gi, "");
    return `<svg${cleaned} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="display:block">`;
  });
}
