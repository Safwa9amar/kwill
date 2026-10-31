import { describe, expect, it } from "vitest";
import type { DocBlockDTO, DocSectionDTO } from "@/lib/api";
import { changedBlocks, changedSides, docChanges } from "./doc-diff";

const para = (index: number, text: string): DocBlockDTO => ({
  index, kind: "paragraph", text, styleId: null, level: 0, alignment: null, direction: null,
});
const reindex = (bs: DocBlockDTO[]) => bs.map((b, i) => ({ ...b, index: i }) as DocBlockDTO);

describe("changedBlocks", () => {
  const prev = [para(0, "a"), para(1, "b"), para(2, "c"), para(3, "d")];

  it("finds an in-place change (a chart patch, a restyle)", () => {
    const next = [...prev];
    next[2] = { index: 2, kind: "image", svg: "<svg/>" };
    expect(changedBlocks(prev, next)).toEqual([2]);
  });

  it("finds nothing when only the references changed (a server echo of the same doc)", () => {
    expect(changedBlocks(prev, prev.map((b) => ({ ...b })))).toEqual([]);
  });

  it("marks only the inserted block, not everything it shifted (an equation insert)", () => {
    // Every block after the insert carries a new index; content still matches.
    const next = reindex([prev[0], prev[1], para(0, "x²"), prev[2], prev[3]]);
    expect(changedBlocks(prev, next)).toEqual([2]);
  });

  it("marks the block that closed the gap after a deletion", () => {
    const next = reindex([prev[0], prev[2], prev[3]]);
    expect(changedBlocks(prev, next)).toEqual([1]);
  });

  it("caps a sweeping rewrite", () => {
    const big = Array.from({ length: 40 }, (_, i) => para(i, `p${i}`));
    const rewritten = big.map((b) => ({ ...b, text: "new" }) as DocBlockDTO);
    expect(changedBlocks(big, rewritten, 5)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("changedSides", () => {
  const sec = (header: string | null, footer: string | null): DocSectionDTO => ({
    startBlockIndex: 0,
    header: header == null ? null : { text: header, segments: [header], border: { bottom: false, color: null } },
    footer: footer == null ? null : { text: footer, pageNumbers: null },
  });
  it("names the edge a header/footer apply changed", () => {
    expect(changedSides([sec("A", "1")], [sec("B", "1")])).toEqual(["header"]);
    expect(changedSides([sec("A", "1")], [sec("A", "2")])).toEqual(["footer"]);
    expect(changedSides([sec("A", "1")], [sec("A", "1")])).toEqual([]);
  });
  it("treats a section that appeared as a change on both edges", () => {
    expect(changedSides([sec("A", "1")], [sec("A", "1"), sec("A", "1")])).toEqual(["header", "footer"]);
  });
});

describe("docChanges", () => {
  it("combines both", () => {
    expect(docChanges({ blocks: [para(0, "a")] }, { blocks: [para(0, "b")] })).toEqual({ blocks: [0], sides: [] });
  });
});
