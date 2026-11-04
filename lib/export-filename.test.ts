import { describe, expect, it } from "vitest";
import { safeFilename } from "./export-filename";

// The on-disk name of an export. expo-file-system/legacy reads a raw path as a URI: a `#` starts a fragment (the part after it, the extension
// included, is lost), a `?` starts a query, and a `%` breaks the decode on iOS. Those three never reach the path.

describe("safeFilename", () => {
  it("replaces # so the extension survives the URI read", () => {
    expect(safeFilename("Thesis #1", "docx")).toBe("Thesis -1.docx");
    expect(safeFilename("Thesis #1.docx", "docx")).toBe("Thesis -1.docx");
  });

  it("replaces % so an iOS path does not fail to parse", () => {
    expect(safeFilename("100% final", "docx")).toBe("100- final.docx");
  });

  it("replaces ? (already in the reserved set)", () => {
    expect(safeFilename("Why? A study", "pdf")).toBe("Why- A study.pdf");
  });

  it("keeps spaces, collapsing runs of them", () => {
    expect(safeFilename("My  thesis   final", "docx")).toBe("My thesis final.docx");
  });

  it("keeps Arabic names whole", () => {
    expect(safeFilename("مذكرة الماستر", "docx")).toBe("مذكرة الماستر.docx");
    expect(safeFilename("مذكرة #٢.docx", "docx")).toBe("مذكرة -٢.docx");
  });

  it("adds the format when the name has no extension", () => {
    expect(safeFilename("Mémoire", "docx")).toBe("Mémoire.docx");
    expect(safeFilename("Mémoire", "pdf")).toBe("Mémoire.pdf");
  });

  it("keeps an extension the name already has", () => {
    expect(safeFilename("Rapport.pdf", "pdf")).toBe("Rapport.pdf");
  });

  it("falls back to thesis when the name is empty", () => {
    expect(safeFilename("   ", "docx")).toBe("thesis.docx");
  });

  it("leaves an ordinary title exactly as it was before the # and % change", () => {
    expect(safeFilename("Mémoire de fin d'études 2026", "docx")).toBe("Mémoire de fin d'études 2026.docx");
    expect(safeFilename("Thèse: partie 1/2", "docx")).toBe("Thèse- partie 1-2.docx");
  });
});
