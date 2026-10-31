import { describe, expect, it } from "vitest";
import { EQUATION_SELECTOR, equationTarget } from "./equation-target";

describe("equationTarget", () => {
  it("pins the painted selector (core 2.21.1 paints data-docx-equation)", () => {
    expect(EQUATION_SELECTOR).toBe("[data-docx-equation]");
  });

  it("resolves a body paragraph's equation to its block and position", () => {
    expect(
      equationTarget({
        sourceNodeId: "/word/document.xml#0.1.42.2",
        paragraphId: "/word/document.xml#0.1.42",
        start: 17,
        siblingStarts: [3, 17],
      }),
    ).toEqual({ index: 42, ordinal: 1 });
  });

  it("counts siblings by offset, not by paint order, and dedupes split fragments", () => {
    expect(
      equationTarget({ sourceNodeId: null, paragraphId: "/word/document.xml#0.1.5", start: 9, siblingStarts: [30, 9, 9, 2] }),
    ).toEqual({ index: 5, ordinal: 1 });
  });

  it("refuses an equation in a header or a table cell", () => {
    expect(equationTarget({ sourceNodeId: null, paragraphId: "/word/header1.xml#0.0.1", start: 0, siblingStarts: [0] })).toBeNull();
    expect(equationTarget({ sourceNodeId: null, paragraphId: "/word/document.xml#0.1.7.0.1.0", start: 0, siblingStarts: [0] })).toBeNull();
  });

  it("falls back to the equation's own id when the paragraph id is missing", () => {
    expect(equationTarget({ sourceNodeId: "/word/document.xml#0.1.12.1", paragraphId: null, start: null, siblingStarts: [] })).toEqual({ index: 12, ordinal: 0 });
  });
});
