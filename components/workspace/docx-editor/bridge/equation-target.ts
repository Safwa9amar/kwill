// A tapped equation → which block, and which of that block's equations.
//
// Pinned against the engine's painted markup at 2.21.1: every Office Math run is
// painted as `<span class="layout-run docx-equation" data-docx-equation="<oMath
// node id>" data-paragraph-id="<paragraph id>" data-start=… data-end=…
// contenteditable="false" role="math">` (core's equation painter, `xt`). The engine
// handles the press itself (it selects the equation and opens its own popover,
// which the host switches off with `popups={{ equation: false }}`); we only read
// where it was.
//
// Pure so it runs under node; the DOM reads live in features/use-equation-tap.ts.

import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";
import { isBlockLevelId } from "./dom-selectors";

/** The painted equation element. One place, so an engine upgrade that renames it
 *  breaks one constant and one test. */
export const EQUATION_SELECTOR = "[data-docx-equation]";

export type EquationFacts = {
  /** `data-docx-equation`: the oMath node's own id. */
  sourceNodeId: string | null;
  /** `data-paragraph-id`: the paragraph that holds it. */
  paragraphId: string | null;
  /** `data-start`: its offset in that paragraph. */
  start: number | null;
  /** `data-start` of every painted equation in the same paragraph (its siblings and itself). */
  siblingStarts: readonly number[];
};

/**
 * `{ index, ordinal }`: the DTO block and which of its `math[]` entries was tapped
 * (a paragraph can hold several inline equations; the DTO lists them in order).
 * null for an equation outside the body (a header) or inside a table cell — the
 * DTO carries no math for a table, so there is nothing for the sheet to open.
 */
export function equationTarget(f: EquationFacts): { index: number; ordinal: number } | null {
  let index: number | null = null;
  if (isBodyId(f.paragraphId)) {
    // A paragraph deeper than a body child is a table cell's (or a text box's).
    if (!isBlockLevelId(f.paragraphId)) return null;
    index = blockIndexFromId(f.paragraphId);
  } else if (!f.paragraphId && isBodyId(f.sourceNodeId)) {
    index = blockIndexFromId(f.sourceNodeId);
  }
  if (index == null) return null;
  const starts = Array.from(new Set(f.siblingStarts)).sort((a, b) => a - b);
  const ordinal = f.start == null ? 0 : Math.max(0, starts.indexOf(f.start));
  return { index, ordinal };
}
