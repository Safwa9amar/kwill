import { describe, it, expect } from "vitest";
import { anchorKey, anchorQueries, correction, pickAnchor, type PaintedPiece } from "./scroll-anchor";

const P = (block: number, top: number, bottom: number, text: string, part = "document"): PaintedPiece =>
  ({ id: `/word/${part}.xml#0.1.${block}`, top, bottom, text });

describe("pickAnchor", () => {
  it("anchors on the topmost body block still on screen, merging its pieces", () => {
    const a = pickAnchor([
      P(3, -300, -120, "gone above"),
      P(4, -40, -10, "first line of 4"),
      P(4, -10, 20, "second line of 4"),
      P(5, 20, 60, "five"),
    ], 0, 1, 900);
    expect(a).toEqual({ index: 4, text: "first line of 4", delta: 40, y: 900 });
  });
  it("skips a block with no text — it cannot be searched for — even if it starts lower", () => {
    const a = pickAnchor([P(7, -5, 15, "  "), P(8, 30, 60, "words here")], 0, 1, 10);
    expect(a?.index).toBe(8);
    expect(a?.delta).toBe(-30);
  });
  it("never anchors on a header/footer story or an unparseable id", () => {
    const a = pickAnchor([
      { id: "/word/header1.xml#0.0.1", top: 0, bottom: 20, text: "Running head" },
      { id: "garbage", top: 0, bottom: 20, text: "x" },
      P(12, 25, 50, "body"),
    ], 0, 1, 0);
    expect(a?.index).toBe(12);
  });
  it("stores the offset in DOCUMENT px, so a different fit zoom lands the same place", () => {
    expect(pickAnchor([P(2, -50, 50, "t")], 0, 0.5, 0)?.delta).toBe(100);
  });
  it("is relative to the viewport's own top, not the window's", () => {
    expect(pickAnchor([P(2, 90, 150, "t")], 100, 1, 0)?.delta).toBe(10);
  });
  it("normalises and caps the text at 80 chars", () => {
    const a = pickAnchor([P(1, 0, 10, `  a\n\n${"b".repeat(200)}`)], 0, 1, 0);
    expect(a?.text).toBe(`a ${"b".repeat(78)}`);
  });
  it("nothing painted → null", () => {
    expect(pickAnchor([], 0, 1, 0)).toBeNull();
  });
});

describe("anchorQueries", () => {
  it("opening first, then a slice from the middle", () => {
    const t = "1. Introduction générale au sujet de la recherche et ses objectifs";
    const q = anchorQueries(t);
    expect(q[0]).toBe(t);
    expect(q[1].length).toBeLessThanOrEqual(30);
    expect(t.includes(q[1])).toBe(true);
  });
  it("short or empty text", () => {
    expect(anchorQueries("قصير")).toEqual(["قصير"]);
    expect(anchorQueries("   ")).toEqual([]);
    expect(anchorQueries(undefined)).toEqual([]);
  });
});

describe("correction / anchorKey", () => {
  it("puts the block `delta` document-px above the viewport top", () => {
    // block top at 300 in a viewport whose top is at 100, wanted 40px above → scroll 240 more
    expect(correction(300, 100, 40, 1)).toBe(240);
    expect(correction(300, 100, 40, 0.5)).toBe(220);
    expect(correction(100, 100, 0, 1)).toBe(0);
  });
  it("a reader sitting still keeps the same key", () => {
    const a = { index: 3, text: "abc", delta: 10, y: 99 };
    expect(anchorKey(a)).toBe(anchorKey({ ...a, y: 100 }));
    expect(anchorKey(a)).not.toBe(anchorKey({ ...a, delta: 11 }));
  });
});
