import { describe, it, expect } from "vitest";
import { isBlockLevelId } from "./dom-selectors";

describe("isBlockLevelId", () => {
  it("is true for a paragraph/table id (exactly three segments)", () => {
    expect(isBlockLevelId("/word/document.xml#0.1.42")).toBe(true);
  });
  it("is false for a run or text id (deeper) and for other parts", () => {
    expect(isBlockLevelId("/word/document.xml#0.1.42.0")).toBe(false);
    expect(isBlockLevelId("/word/document.xml#0.1.42.1.0")).toBe(false);
    expect(isBlockLevelId("/word/header1.xml#0.0.2")).toBe(false);
    expect(isBlockLevelId(null)).toBe(false);
  });
});
