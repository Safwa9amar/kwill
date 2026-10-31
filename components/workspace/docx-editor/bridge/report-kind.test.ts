import { describe, expect, it } from "vitest";
import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { classifyReport, NO_FACTS, sectionStartIndex, structuralReport } from "./report-kind";

const BASE: LexicalState = {
  bold: true, italic: false, underline: false,
  blockType: "paragraph", isRTL: true, alignment: "right",
  index: 40, text: "نص الفقرة", blocks: [{ index: 40, text: "نص الفقرة" }],
  y: 120, canUndo: true, canRedo: false, userDriven: true,
};
const STARTS = [0, 12, 57];

describe("classifyReport", () => {
  it("leaves an ordinary paragraph report alone", () => {
    expect(classifyReport(BASE, NO_FACTS, { sectionStarts: STARTS })).toBe(BASE);
  });

  it("reports a header story as chrome:top at the SECTION's first block", () => {
    const r = classifyReport(BASE, { ...NO_FACTS, headerFooter: { editing: "header", sectionIndex: 1 } }, { sectionStarts: STARTS });
    expect(r.blockType).toBe("chrome:top");
    expect(r.index).toBe(12);
    expect(r.blocks).toEqual([{ index: 12, text: "" }]);
    // Chrome carries no marks (read-state.ts's ChromeNode report), but keeps the
    // history availability and the anchor the host needs.
    expect(r.bold).toBe(false);
    expect(r.canUndo).toBe(true);
    expect(r.y).toBe(120);
    expect(r.isRTL).toBe(true);
  });

  it("reports a footer story as chrome:bottom", () => {
    const r = classifyReport(BASE, { ...NO_FACTS, headerFooter: { editing: "footer", sectionIndex: 2 } }, { sectionStarts: STARTS });
    expect(r.blockType).toBe("chrome:bottom");
    expect(r.index).toBe(57);
  });

  it("the header wins over a picture or table inside it", () => {
    const r = classifyReport(
      BASE,
      { headerFooter: { editing: "header", sectionIndex: 0 }, image: { id: "/word/header1.xml#0.0.1.0", top: 5 }, table: null },
      { sectionStarts: STARTS },
    );
    expect(r.blockType).toBe("chrome:top");
    expect(r.index).toBe(0);
  });

  it("reports a selected picture as image at its carrier paragraph, anchored on the picture", () => {
    const r = classifyReport(BASE, { ...NO_FACTS, image: { id: "/word/document.xml#0.1.220.1.0", top: 300 } }, { sectionStarts: STARTS });
    expect(r).toMatchObject({ blockType: "image", index: 220, text: "", blocks: [{ index: 220, text: "" }], y: 300, bold: false });
  });

  it("falls back to the focused block when the picture id is not a body id", () => {
    const r = classifyReport(BASE, { ...NO_FACTS, image: { id: "opaque-id", top: null } }, { sectionStarts: STARTS });
    expect(r).toMatchObject({ blockType: "image", index: 40, y: 120 });
  });

  it("reports a caret in a table as the table block", () => {
    const r = classifyReport(BASE, { ...NO_FACTS, table: { blockId: "/word/document.xml#0.1.88" } }, { sectionStarts: STARTS });
    expect(r).toMatchObject({ blockType: "table", index: 88, text: "", blocks: [{ index: 88, text: "" }] });
  });

  // The DOM reports what is selected; which toolbar shows is still the native
  // side's call from the DTO block at that index (a table here).
  it("a selected picture outranks the table around it", () => {
    const r = classifyReport(
      BASE,
      { headerFooter: null, image: { id: "/word/document.xml#0.1.3.0.0.0.1.0", top: 10 }, table: { blockId: "/word/document.xml#0.1.3" } },
      { sectionStarts: STARTS },
    );
    expect(r.blockType).toBe("image");
    expect(r.index).toBe(3);
  });

  it("drops nothing when no index can be found", () => {
    const noFocus = { ...BASE, index: -1 };
    expect(classifyReport(noFocus, { ...NO_FACTS, table: { blockId: "x" } }, { sectionStarts: STARTS })).toBe(noFocus);
  });
});

describe("sectionStartIndex", () => {
  it("maps the engine's section index onto the DTO's start block", () => {
    expect(sectionStartIndex(STARTS, 2)).toBe(57);
  });
  it("falls back to the first section rather than -1 (which the host would drop)", () => {
    expect(sectionStartIndex(STARTS, 9)).toBe(0);
    expect(sectionStartIndex([], 0)).toBe(0);
  });
});

describe("structuralReport", () => {
  it("keeps y when none is given", () => {
    expect(structuralReport(BASE, "image", 7).y).toBe(120);
    expect(structuralReport(BASE, "image", 7, 9).y).toBe(9);
  });
});
