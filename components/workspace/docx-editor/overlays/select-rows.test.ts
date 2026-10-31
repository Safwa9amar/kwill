import { describe, it, expect } from "vitest";
import { FRAGMENT_SELECTOR, type RectLike } from "./find-block-element";
import { drawnBoxes, BOX, blockTextAt, checkboxAt, readSelectRows, reconcileFlips, rowAt, sameRows, type SelectRow } from "./select-rows";

const rect = (left: number, top: number, width: number, height: number): RectLike =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

const id = (i: number) => `/word/document.xml#0.1.${i}`;

/** A painted fragment container (or, without data-fragment-index, a run sharing its id). */
function frag(attrs: Record<string, string>, text: string, r: RectLike) {
  return {
    getAttribute: (n: string) => attrs[n] ?? null,
    getBoundingClientRect: () => r,
    textContent: text,
    // paintedText: no line elements → the fragment's own text.
    querySelectorAll: () => [],
    closest: () => null,
    parentElement: null,
  };
}
const para = (i: number, text: string, r: RectLike, fragmentIndex = 0) =>
  frag({ "data-paragraph-id": id(i), "data-fragment-index": String(fragmentIndex) }, text, r);

function root(all: ReturnType<typeof frag>[]) {
  return {
    querySelectorAll(selector: string) {
      expect(selector).toBe(FRAGMENT_SELECTOR);
      return all.filter((e) => e.getAttribute("data-fragment-index") != null);
    },
  };
}

describe("readSelectRows", () => {
  it("gives every painted body block one row, in document order, skipping off-screen blocks and other stories", () => {
    const rows = readSelectRows(root([
      para(0, "Above", rect(40, -80, 300, 20)), // scrolled out above
      para(1, "Intro", rect(40, 10, 300, 20)),
      frag({ "data-paragraph-id": id(1) }, "Intro", rect(40, 10, 50, 20)), // a run: not a fragment
      frag({ "data-paragraph-id": "/word/header1.xml#0.0.1", "data-fragment-index": "0" }, "Header", rect(40, 0, 300, 10)),
      para(2, "Body", rect(40, 40, 300, 60)),
      para(3, "Below", rect(40, 900, 300, 20)), // below the fold
    ]), 800);
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
  });

  it("anchors a paragraph that spans a page on its first part still on screen", () => {
    const rows = readSelectRows(root([
      para(5, "first half", rect(40, -60, 300, 40), 0),
      para(5, "second half", rect(40, 30, 300, 40), 1),
    ]), 800);
    expect(rows).toHaveLength(1);
    expect(rows[0].boxes).toHaveLength(2);
    expect(rows[0].anchor.top).toBe(30);
  });

  it("puts an Arabic block's box on the right and a Latin one's on the left; a block with no letters takes its neighbour's side", () => {
    const rows = readSelectRows(root([
      para(1, "مقدمة البحث", rect(40, 10, 300, 20)),
      para(2, "", rect(40, 40, 300, 20)), // empty line between two Arabic paragraphs
      para(3, "(1)", rect(40, 70, 300, 20)),
      para(4, "الفصل الأول", rect(40, 100, 300, 20)),
      para(5, "Introduction", rect(40, 130, 300, 20)),
    ]), 800);
    expect(rows.map((r) => [r.index, r.rtl])).toEqual([[1, true], [2, true], [3, true], [4, true], [5, false]]);
  });

  it("decides by the letter a block OPENS with, not by counting", () => {
    const rows = readSelectRows(root([para(1, "التنسيق: Word (.docx) format", rect(40, 10, 300, 20))]), 800);
    expect(rows[0].rtl).toBe(true);
  });
});

describe("checkboxAt", () => {
  const row = (rtl: boolean, a: RectLike): SelectRow => ({ index: 0, boxes: [a], anchor: a, rtl });
  it("sits in the margin at the start of the line: left of an LTR block, right of an RTL one", () => {
    expect(checkboxAt(row(false, rect(60, 100, 280, 20)), 400).left).toBeLessThan(60 - BOX + 1);
    expect(checkboxAt(row(true, rect(60, 100, 280, 20)), 400).left).toBeGreaterThan(340);
  });
  it("centres on a short block and pins to the top of a tall one", () => {
    expect(checkboxAt(row(false, rect(60, 100, 280, 30)), 400).top).toBe(100 + (30 - BOX) / 2);
    expect(checkboxAt(row(false, rect(60, 100, 280, 200)), 400).top).toBe(100);
  });
  it("stays on screen when the page is fitted edge to edge", () => {
    expect(checkboxAt(row(false, rect(4, 100, 380, 20)), 400).left).toBeGreaterThanOrEqual(0);
    expect(checkboxAt(row(true, rect(16, 100, 380, 20)), 400).left).toBeLessThanOrEqual(400 - BOX);
  });
});

describe("rowAt", () => {
  const rows: SelectRow[] = [
    { index: 1, boxes: [rect(60, 100, 280, 20)], anchor: rect(60, 100, 280, 20), rtl: false },
    { index: 2, boxes: [rect(60, 130, 280, 200)], anchor: rect(60, 130, 280, 200), rtl: true },
  ];
  it("hits a checkbox with a fingertip's reach around it", () => {
    const c = checkboxAt(rows[0], 400);
    expect(rowAt(rows, c.left - 6, c.top + 4, 400)).toBe(1);
    const d = checkboxAt(rows[1], 400);
    expect(rowAt(rows, d.left + BOX + 4, d.top + 2, 400)).toBe(2);
  });
  it("falls back to the block's own boxes (a chart over its carrier), and nothing elsewhere", () => {
    expect(rowAt(rows, 200, 250, 400)).toBe(2);
    expect(rowAt(rows, 200, 600, 400)).toBeNull();
  });
});

describe("sameRows", () => {
  const a: SelectRow = { index: 1, boxes: [rect(0, 0, 10, 10)], anchor: rect(0, 0, 10, 10), rtl: false };
  it("ignores sub-pixel jitter but not a side change or a moved box", () => {
    expect(sameRows([a], [{ ...a, boxes: [rect(0.2, 0, 10, 10)] }])).toBe(true);
    expect(sameRows([a], [{ ...a, rtl: true }])).toBe(false);
    expect(sameRows([a], [{ ...a, anchor: rect(0, 5, 10, 10) }])).toBe(false);
  });
});

describe("blockTextAt", () => {
  it("joins every painted fragment of the block", () => {
    const r = root([para(5, "split across", rect(0, 0, 1, 1), 0), para(6, "other", rect(0, 0, 1, 1)), para(5, "two pages", rect(0, 0, 1, 1), 1)]);
    expect(blockTextAt(r, 5)).toBe("split across two pages");
  });
});

describe("reconcileFlips", () => {
  it("drops a flip once the host agrees, keeps it while the host lags", () => {
    const flips = new Map([[3, true], [4, false]]);
    const r = reconcileFlips(flips, new Set([3, 4]));
    expect([...r]).toEqual([[4, false]]);
    expect(reconcileFlips(r, new Set([3]))).toEqual(new Map());
  });
  it("returns the same map when nothing changed (no re-render)", () => {
    const flips = new Map([[3, true]]);
    expect(reconcileFlips(flips, new Set())).toBe(flips);
  });
});

describe("drawnBoxes", () => {
  const row = (index: number, top: number, height: number, rtl = false) => ({
    index, rtl, boxes: [], anchor: { left: 60, right: 340, top, bottom: top + height, width: 280, height },
  });
  it("leaves out a box that would overlap the one above it on the same side", () => {
    // A cover page: five 12px empty lines in a row, then a real paragraph.
    const rows = [row(1, 100, 12), row(2, 112, 12), row(3, 124, 12), row(4, 136, 12), row(5, 148, 12), row(6, 200, 60)];
    expect([...drawnBoxes(rows, 402)]).toEqual([1, 3, 5, 6]); // boxes at 96, 120, 144 — 4px apart, none overlapping
  });
  it("tracks each side on its own", () => {
    const rows = [row(1, 100, 12), row(2, 104, 12, true)];
    expect([...drawnBoxes(rows, 402)]).toEqual([1, 2]);
  });
});
