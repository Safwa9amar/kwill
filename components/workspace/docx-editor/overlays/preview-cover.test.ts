import { describe, it, expect, vi } from "vitest";
import { deferToPreview, getPreviewCover, previewIndices, setPreviewCover, subscribePreviewCover } from "./preview-cover";

describe("previewIndices", () => {
  it("covers a range's blocks, a table's one block, and nothing without a preview", () => {
    expect(previewIndices({ nonce: 1, kind: "range", start: 4, end: 6, paragraphs: ["a"] })).toEqual([4, 5, 6]);
    expect(previewIndices({ nonce: 2, kind: "table", index: 9, rows: [["x"]] })).toEqual([9]);
    expect(previewIndices(null)).toEqual([]);
  });
});

describe("deferToPreview", () => {
  it("drops the marks the preview covers and keeps the rest", () => {
    const r = deferToPreview([3, 9, 12], [9], new Set());
    expect(r.shown).toEqual([3, 12]);
    expect([...r.absorbed]).toEqual([9]);
  });

  it("keeps a mark absorbed after the preview fades, until the host drops it — no shimmer flash in between", () => {
    // Covered and pending together (the server echo marked the table).
    let s = deferToPreview([9], [9], new Set());
    expect(s.shown).toEqual([]);
    // The reload landed: the preview faded (cover lifted) but the host's settle() is
    // still on its way across the bridge.
    s = deferToPreview([9], [], s.absorbed);
    expect(s.shown).toEqual([]);
    // settle() arrived: the mark is gone, and so is the latch.
    s = deferToPreview([], [], s.absorbed);
    expect(s.absorbed.size).toBe(0);
    // A NEW server edit on the same block later shimmers as usual.
    expect(deferToPreview([9], [], s.absorbed).shown).toEqual([9]);
  });

  it("does not hide a block marked only after the cover lifted", () => {
    expect(deferToPreview([5], [], new Set()).shown).toEqual([5]);
  });
});

describe("the shared cover", () => {
  it("notifies only on a real change and returns a stable reference", () => {
    const fn = vi.fn();
    const off = subscribePreviewCover(fn);
    setPreviewCover([1, 2]);
    const ref = getPreviewCover();
    setPreviewCover([1, 2]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getPreviewCover()).toBe(ref);
    setPreviewCover([]);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });
});
