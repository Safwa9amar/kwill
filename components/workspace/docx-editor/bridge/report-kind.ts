// What KIND of thing the selection is on, in the vocabulary the native chrome
// already speaks (Lexical's read-state.ts):
//
//   chrome:top / chrome:bottom  the caret is in a running header / footer story
//                               — `index` is that section's FIRST block, so
//                               sectionAt() on the native side finds the section
//   image                       a picture is selected — `index` is its carrier
//                               paragraph, i.e. the DTO image block (a chart is an
//                               image-kind DTO block too; the toolbar tells them
//                               apart by the block's `svg`)
//   table                       the caret is in a table — `index` is the table
//
// Everything else keeps what the base report says (paragraph / h1..h6 / quote /
// bullet / number).
//
// The decision is PURE (`classifyReport`) so it is tested under node; reading the
// facts off the live engine and the painted DOM is `readSelectionFacts`, which
// touches `document` only when called.

import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";

export type SelectionFacts = {
  /** Non-null while a header/footer story is open for editing. */
  headerFooter: { editing: "header" | "footer"; sectionIndex: number } | null;
  /** The selected picture: its drawing node id, and the painted top (viewport px) when known. */
  image: { id: string; top: number | null } | null;
  /** The table holding the caret, by the table's own node id. */
  table: { blockId: string } | null;
};

export const NO_FACTS: SelectionFacts = { headerFooter: null, image: null, table: null };

/** Body index of a node id, or null for any other story (a header picture, a note). */
function bodyIndex(id: string | null | undefined): number | null {
  return isBodyId(id) ? blockIndexFromId(id) : null;
}

/** The section's first block — what Lexical's chrome bands reported as `index`. */
export function sectionStartIndex(sectionStarts: readonly number[], sectionIndex: number): number {
  const at = sectionStarts[sectionIndex];
  if (typeof at === "number" && at >= 0) return at;
  // Unknown section (no DTO sections yet): the first one is the honest fallback —
  // a single-section thesis is the common case, and -1 would drop the report.
  return sectionStarts.length ? Math.max(0, sectionStarts[0]) : 0;
}

/** A single structural block selected as a whole — the shape read-state.ts used
 *  for a NodeSelection on a BlockDataNode (no marks, empty text). */
export function structuralReport(base: LexicalState, kind: string, index: number, y?: number | null): LexicalState {
  return {
    ...base,
    bold: false, italic: false, underline: false,
    blockType: kind,
    alignment: null,
    index,
    text: "",
    blocks: [{ index, text: "" }],
    y: typeof y === "number" ? y : base.y,
  };
}

export function classifyReport(
  base: LexicalState,
  facts: SelectionFacts,
  ctx: { sectionStarts: readonly number[] },
): LexicalState {
  // The header/footer scope wins over everything: a picture or table inside a
  // header is still the header as far as the native chrome is concerned.
  if (facts.headerFooter) {
    const index = sectionStartIndex(ctx.sectionStarts, facts.headerFooter.sectionIndex);
    return {
      ...base,
      bold: false, italic: false, underline: false,
      blockType: facts.headerFooter.editing === "header" ? "chrome:top" : "chrome:bottom",
      alignment: null,
      index,
      // The native side enriches the text from doc.sections (sectionAt), exactly as
      // it did for Lexical's bands; the DOM's own story text is not the source.
      text: "",
      blocks: [{ index, text: "" }],
    };
  }
  if (facts.image) {
    const index = bodyIndex(facts.image.id) ?? (base.index >= 0 ? base.index : null);
    if (index != null) return structuralReport(base, "image", index, facts.image.top);
  }
  if (facts.table) {
    const index = bodyIndex(facts.table.blockId) ?? (base.index >= 0 ? base.index : null);
    if (index != null) return structuralReport(base, "table", index);
  }
  return base;
}
