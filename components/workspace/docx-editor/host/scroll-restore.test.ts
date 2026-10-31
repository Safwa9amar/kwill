import { describe, it, expect } from "vitest";
import type { DocBlockDTO } from "@/lib/api";
import { anchorTextFor, anchorToSave, restoreAnchor, textsAgree } from "./scroll-restore";

const para = (index: number, text: string) =>
  ({ index, kind: "paragraph", text, styleId: null, level: 0, alignment: null, direction: null }) as DocBlockDTO;
const table = (index: number) => ({ index, kind: "table", rows: [["a"]] }) as unknown as DocBlockDTO;

const blocks = [para(0, "Title"), para(1, ""), table(2), para(3, "Chapter one opens here")];

describe("anchorTextFor", () => {
  it("a paragraph's own text, else the nearest paragraph with words above it", () => {
    expect(anchorTextFor(blocks, 3)).toEqual({ index: 3, text: "Chapter one opens here" });
    expect(anchorTextFor(blocks, 2)).toEqual({ index: 0, text: "Title" });
    expect(anchorTextFor(blocks, 99)).toEqual({ index: 3, text: "Chapter one opens here" });
    expect(anchorTextFor(undefined, 1)).toBeNull();
  });
});

describe("restoreAnchor", () => {
  it("a deep link replaces the saved position and lands its block at the top", () => {
    const a = restoreAnchor({ saved: { index: 0, delta: 50, y: 10, text: "Title" }, deepLinkBlock: 3, blocks });
    expect(a).toEqual({ index: 3, text: "Chapter one opens here", delta: 0, y: 0 });
  });
  it("a docx anchor comes back as saved", () => {
    expect(restoreAnchor({ saved: { index: 3, delta: -12, y: 400, text: "Chapter one" }, deepLinkBlock: null, blocks }))
      .toEqual({ index: 3, text: "Chapter one", delta: -12, y: 400 });
  });
  it("a Lexical anchor keeps only its block — its offsets belong to another layout", () => {
    expect(restoreAnchor({ saved: { index: 2, delta: 80, y: 3000 }, deepLinkBlock: undefined, blocks }))
      .toEqual({ index: 0, text: "Title", delta: 0, y: 0 });
  });
  it("nothing saved, or nothing usable → null", () => {
    expect(restoreAnchor({ saved: null, deepLinkBlock: null, blocks })).toBeNull();
    expect(restoreAnchor({ saved: { index: -1, delta: 0, y: 0 }, deepLinkBlock: null, blocks })).toBeNull();
  });
});

describe("anchorToSave", () => {
  it("prefers the DTO's logical text when it is the same paragraph", () => {
    expect(anchorToSave({ index: 3, text: "Chapter one", delta: 4, y: 9 }, blocks).text).toBe("Chapter one opens here");
  });
  it("accepts painted RTL words in visual order as the same paragraph", () => {
    expect(textsAgree("مقدمة عامة حول الموضوع", "الموضوع حول عامة مقدمة")).toBe(true);
  });
  it("keeps the painted text when the DTO's index names a different paragraph (not caught up yet)", () => {
    expect(anchorToSave({ index: 0, text: "A brand new paragraph", delta: 0, y: 0 }, blocks).text).toBe("A brand new paragraph");
  });
});
