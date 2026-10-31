import { describe, expect, it } from "vitest";
import { editsFor, engineStart, liveEdits, ordinalOf, pickMatch, replaceOrder, targetFor } from "./search-resolve";

const P = "/word/document.xml#0.1.";

describe("targetFor", () => {
  it("carries the literal the hit covers (diacritics and all) and its position", () => {
    const text = "الدراسة الأولى ثم الدِّراسة الثانية";
    // The panel's folded matcher found "الدراسة" twice; the second carries tashkeel.
    const second = text.indexOf("الدِّراسة");
    expect(targetFor(4, text, second, second + "الدِّراسة".length)).toEqual({
      blockIndex: 4, literal: "الدِّراسة", start: second, ordinal: 0,
    });
  });
  it("counts the literal's earlier copies as the ordinal", () => {
    expect(targetFor(1, "ab ab ab", 6, 8)).toMatchObject({ literal: "ab", ordinal: 2 });
    expect(ordinalOf("aaaa", "aa", 2)).toBe(1);
  });
  it("refuses an empty span", () => {
    expect(targetFor(1, "abc", 1, 1)).toBeNull();
  });
});

describe("pickMatch", () => {
  const t = { blockIndex: 3, literal: "x", start: 10, ordinal: 1 };
  it("takes the nearest start in a body paragraph", () => {
    const ms = [{ blockId: `${P}3`, start: 2 }, { blockId: `${P}3`, start: 12 }, { blockId: `${P}3`, start: 30 }];
    expect(pickMatch(ms, t)).toBe(ms[1]);
  });
  it("takes the ordinal in a table, whose cells have their own offsets", () => {
    const ms = [{ blockId: `${P}3.0.0.0`, start: 0 }, { blockId: `${P}3.0.1.0`, start: 0 }, { blockId: `${P}3.1.0.0`, start: 4 }];
    expect(pickMatch(ms, t)).toBe(ms[1]);
    expect(pickMatch(ms, { ...t, ordinal: 9 })).toBeNull();
  });
  it("is null with nothing to pick from", () => {
    expect(pickMatch([], t)).toBeNull();
  });
});

describe("replaceOrder", () => {
  it("goes back to front within a paragraph and drops duplicates", () => {
    const a = { blockId: `${P}1`, start: 3 };
    const b = { blockId: `${P}1`, start: 9 };
    const c = { blockId: `${P}2`, start: 0 };
    const order = replaceOrder([a, c, b, { ...a }]);
    expect(order.map((m) => `${m.blockId}@${m.start}`)).toEqual([`${P}1@9`, `${P}1@3`, `${P}2@0`]);
  });
});

// The panel keeps DTO offsets after a local replace; the engine has moved on. With
// the ledger the pick must land on the next real hit — the bare DTO offset would
// tie between two engine hits.
describe("the replace ledger", () => {
  const dto = "foo x foo y foo"; // hits at 0, 6, 12
  const t1 = targetFor(4, dto, 6, 9)!;
  const t2 = targetFor(4, dto, 12, 15)!;

  it("shifts later hits of the paragraph by the replacement's length difference", () => {
    // Engine after replacing the first with "barbaz": "barbaz x foo y foo" (foo at 9, 15).
    const edits = editsFor([targetFor(4, dto, 0, 3)!], "barbaz");
    const engine = [{ blockId: `${P}4`, start: 9 }, { blockId: `${P}4`, start: 15 }];
    expect(pickMatch(engine, { ...t1, start: engineStart(t1, edits) })).toBe(engine[0]);
    expect(pickMatch(engine, { ...t2, start: engineStart(t2, edits) })).toBe(engine[1]);
    // Another block, or an earlier hit, is not moved.
    expect(engineStart({ ...t2, blockIndex: 5 }, edits)).toBe(12);
  });

  it("forgets an edit once the DTO shows it", () => {
    const edits = editsFor([targetFor(4, dto, 0, 3)!], "barbaz");
    expect(liveEdits(edits, () => dto)).toHaveLength(1);
    expect(liveEdits(edits, () => "barbaz x foo y foo")).toHaveLength(0);
    expect(liveEdits(edits, () => undefined)).toHaveLength(0);
  });

  it("forgets a replacement that begins with the literal once it lands", () => {
    const edits = editsFor([targetFor(1, "ab ab", 0, 2)!], "abc");
    expect(liveEdits(edits, () => "ab ab")).toHaveLength(1);
    expect(liveEdits(edits, () => "abc ab")).toHaveLength(0);
  });
});
