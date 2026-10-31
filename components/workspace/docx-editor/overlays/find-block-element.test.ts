import { describe, it, expect } from "vitest";
import {
  FRAGMENT_SELECTOR,
  blockIndexOfFragmentId,
  collectBlockFragments,
  fragmentIdOf,
  measureBlocks,
  rangeIndices,
  sameRect,
  unionRects,
  type RectLike,
} from "./find-block-element";

const rect = (left: number, top: number, width: number, height: number): RectLike =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

/** A painted element as the walk sees it: attributes + a rect. */
function el(attrs: Record<string, string>, r: RectLike = rect(0, 0, 10, 10)) {
  return { getAttribute: (n: string) => attrs[n] ?? null, getBoundingClientRect: () => r };
}

/** A root that answers the fragment selector with exactly the elements that carry
 *  `data-fragment-index` — what the real selector does, so a span sharing its
 *  paragraph's id is filtered by the SELECTOR, as in the WebView. */
function root(all: ReturnType<typeof el>[]) {
  return {
    querySelectorAll(selector: string) {
      expect(selector).toBe(FRAGMENT_SELECTOR);
      return all.filter((e) => e.getAttribute("data-fragment-index") != null);
    },
  };
}

describe("blockIndexOfFragmentId", () => {
  it("parses a body paragraph/table id to its block index", () => {
    expect(blockIndexOfFragmentId("/word/document.xml#0.1.42")).toBe(42);
    expect(blockIndexOfFragmentId("/word/document.xml#0.1.0")).toBe(0);
  });
  it("refuses a cell paragraph, a run, another story, and nothing", () => {
    expect(blockIndexOfFragmentId("/word/document.xml#0.1.43.0.0.0")).toBeNull();
    expect(blockIndexOfFragmentId("/word/document.xml#0.1.42.1")).toBeNull();
    expect(blockIndexOfFragmentId("/word/header1.xml#0.0.2")).toBeNull();
    expect(blockIndexOfFragmentId(null)).toBeNull();
    expect(blockIndexOfFragmentId("")).toBeNull();
  });
});

describe("fragmentIdOf", () => {
  it("reads a paragraph's id, else a table's", () => {
    expect(fragmentIdOf(el({ "data-paragraph-id": "/word/document.xml#0.1.4" }))).toBe("/word/document.xml#0.1.4");
    expect(fragmentIdOf(el({ "data-table-id": "/word/document.xml#0.1.5" }))).toBe("/word/document.xml#0.1.5");
    expect(fragmentIdOf(el({}))).toBeNull();
  });
});

describe("rangeIndices", () => {
  it("is inclusive and order-agnostic", () => {
    expect(rangeIndices(3, 5)).toEqual([3, 4, 5]);
    expect(rangeIndices(5, 3)).toEqual([3, 4, 5]);
    expect(rangeIndices(2, 2)).toEqual([2]);
  });
  it("is empty for non-integers", () => {
    expect(rangeIndices(NaN, 3)).toEqual([]);
    expect(rangeIndices(1.5, 3)).toEqual([]);
  });
});

describe("collectBlockFragments", () => {
  it("keeps only fragment containers of the wanted body blocks, grouped per block", () => {
    const pA1 = el({ "data-paragraph-id": "/word/document.xml#0.1.7", "data-fragment-index": "0" });
    const pA2 = el({ "data-paragraph-id": "/word/document.xml#0.1.7", "data-fragment-index": "1" });
    const spanA = el({ "data-paragraph-id": "/word/document.xml#0.1.7", "data-start": "0", "data-end": "9" });
    const table = el({ "data-table-id": "/word/document.xml#0.1.8", "data-fragment-index": "0" });
    const cellPara = el({ "data-paragraph-id": "/word/document.xml#0.1.8.0.0.0", "data-fragment-index": "0" });
    const other = el({ "data-paragraph-id": "/word/document.xml#0.1.9", "data-fragment-index": "0" });
    const header = el({ "data-paragraph-id": "/word/header1.xml#0.0.7", "data-fragment-index": "0" });
    const got = collectBlockFragments(root([pA1, spanA, pA2, table, cellPara, other, header]), new Set([7, 8]));
    expect(got.get(7)).toEqual([pA1, pA2]);
    expect(got.get(8)).toEqual([table]);
    expect(got.has(9)).toBe(false);
  });
  it("does no query at all when nothing is wanted", () => {
    const noQuery = { querySelectorAll: () => { throw new Error("queried"); } };
    expect(collectBlockFragments(noQuery, new Set()).size).toBe(0);
  });
});

describe("unionRects", () => {
  it("covers every non-empty rect", () => {
    expect(unionRects([rect(10, 100, 200, 40), rect(10, 900, 200, 20)])).toEqual(rect(10, 100, 200, 820));
  });
  it("ignores zero-size rects and answers null when nothing is left", () => {
    expect(unionRects([rect(0, 0, 0, 0), rect(5, 5, 10, 0)])).toBeNull();
    expect(unionRects([])).toBeNull();
    expect(unionRects([rect(0, 0, 0, 0), rect(1, 2, 3, 4)])).toEqual(rect(1, 2, 3, 4));
  });
});

describe("measureBlocks", () => {
  it("unions a split paragraph's fragments and omits what is not painted", () => {
    const a1 = el({ "data-paragraph-id": "/word/document.xml#0.1.1", "data-fragment-index": "0" }, rect(20, 700, 300, 60));
    const a2 = el({ "data-paragraph-id": "/word/document.xml#0.1.1", "data-fragment-index": "1" }, rect(20, 820, 300, 30));
    const got = measureBlocks(root([a1, a2]), new Set([1, 2]));
    expect(got.get(1)).toEqual(rect(20, 700, 300, 150));
    expect(got.has(2)).toBe(false);
  });
});

describe("sameRect", () => {
  it("treats sub-half-pixel drift as equal", () => {
    expect(sameRect(rect(0, 0, 10, 10), rect(0.2, 0.3, 10.1, 9.9))).toBe(true);
    expect(sameRect(rect(0, 0, 10, 10), rect(0, 1, 10, 10))).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(null, rect(0, 0, 1, 1))).toBe(false);
  });
});
