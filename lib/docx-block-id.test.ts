import { describe, it, expect } from "vitest";
import { blockIndexFromId, isBodyId } from "./docx-block-id";

describe("blockIndexFromId", () => {
  it("reads the third segment of a body node id", () => {
    expect(blockIndexFromId("/word/document.xml#0.1.220.1.0")).toBe(220);
  });
  it("reads a bare paragraph id (no run suffix)", () => {
    expect(blockIndexFromId("/word/document.xml#0.1.7")).toBe(7);
  });
  it("reads block zero", () => {
    expect(blockIndexFromId("/word/document.xml#0.1.0.0.0")).toBe(0);
  });
  it("returns null for anything else", () => {
    expect(blockIndexFromId("")).toBeNull();
    expect(blockIndexFromId(null)).toBeNull();
    expect(blockIndexFromId(undefined)).toBeNull();
    expect(blockIndexFromId("/word/document.xml")).toBeNull();
    expect(blockIndexFromId("/word/document.xml#0.1")).toBeNull();
    expect(blockIndexFromId("garbage#a.b.c")).toBeNull();
  });
});

describe("isBodyId", () => {
  it("is true only for the main document part", () => {
    expect(isBodyId("/word/document.xml#0.1.3")).toBe(true);
    expect(isBodyId("/word/header1.xml#0.0.3")).toBe(false);
    expect(isBodyId("/word/footnotes.xml#0.2.1")).toBe(false);
    expect(isBodyId(null)).toBe(false);
  });
});
