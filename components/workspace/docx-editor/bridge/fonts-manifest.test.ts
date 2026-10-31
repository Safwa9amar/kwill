import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GOOGLE_FONT_CATALOG } from "@docx-editor.dev/fonts/google";
import { BUNDLED_FACES, WORD_ARABIC_SUBSTITUTES, bestFace, planBundledFonts } from "./fonts-manifest";

const DIR = fileURLToPath(new URL("../../../../assets/fonts/docx/", import.meta.url));

describe("the bundled files", () => {
  it("match the table byte for byte (the engine refuses a hash mismatch)", () => {
    for (const f of BUNDLED_FACES) {
      const bytes = readFileSync(DIR + f.file);
      expect(bytes.length, f.file).toBe(f.byteLength);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, f.file).toBe(f.hash);
    }
  });
  it("every face file is in the table, and every family ships its licence", () => {
    const onDisk = readdirSync(DIR);
    expect(onDisk.filter((n) => n.endsWith(".ttf")).sort()).toEqual(BUNDLED_FACES.map((f) => f.file).sort());
    for (const lic of ["OFL-Amiri.txt", "OFL-ScheherazadeNew.txt", "OFL-NotoNaskhArabic.txt"]) {
      expect(readFileSync(DIR + lic, "utf8")).toMatch(/SIL Open Font License, Version 1\.1/);
    }
  });
  it("Amiri is the very file the engine's Google catalogue pins", () => {
    for (const f of BUNDLED_FACES.filter((x) => x.family === "Amiri")) {
      const g = GOOGLE_FONT_CATALOG.find((c) => c.family === "Amiri" && c.weight === f.weight && c.style === f.style);
      expect(g?.hash, f.file).toBe(f.hash);
    }
  });
  it("no face is variable (the shaper refuses variation axes)", () => {
    for (const f of BUNDLED_FACES) {
      const b = readFileSync(DIR + f.file);
      const n = b.readUInt16BE(4);
      const tags = Array.from({ length: n }, (_, i) => b.toString("latin1", 12 + i * 16, 16 + i * 16));
      expect(tags, f.file).not.toContain("fvar");
    }
  });
});

describe("planBundledFonts", () => {
  it("answers a Word Arabic family with its bundled substitute and the WORD face's line box", () => {
    const p = planBundledFonts(["Traditional Arabic", "Calibri"], "Calibri");
    expect(p.faces.map((f) => f.file)).toEqual(["ScheherazadeNew-Regular.ttf", "ScheherazadeNew-Bold.ttf"]);
    expect(p.families).toEqual([{ requested: "Traditional Arabic", via: "Scheherazade New", direct: false }]);
    expect(p.substitutions).toHaveLength(4);
    const bold = p.substitutions.find((s) => s.from.weight === 700 && s.from.style === "normal");
    expect(bold?.to).toEqual({ family: "Scheherazade New", weight: 700, style: "normal" });
    expect(bold?.lineMetrics).toEqual({ heightEm: 1.49462890625, baselineEm: 0.994140625 });
    // No italic face → the upright face of the same weight.
    const italicBold = p.substitutions.find((s) => s.from.weight === 700 && s.from.style === "italic");
    expect(italicBold?.to).toEqual({ family: "Scheherazade New", weight: 700, style: "normal" });
  });
  it("matches families case-insensitively and keeps the document's spelling in `from`", () => {
    const p = planBundledFonts(["sakkal majalla"]);
    expect(p.substitutions[0].from.family).toBe("sakkal majalla");
    expect(p.substitutions[0].to.family).toBe("Noto Naskh Arabic");
    expect(p.substitutions[0].lineMetrics).toEqual({ heightEm: 1.396484375, baselineEm: 0.8837890625 });
  });
  it("serves a bundled family named directly as itself, with no substitution", () => {
    const p = planBundledFonts(["Amiri"]);
    expect(p.faces).toHaveLength(4);
    expect(p.substitutions).toEqual([]);
    expect(p.families).toEqual([{ requested: "Amiri", via: "Amiri", direct: true }]);
  });
  it("loads a face once when two Word families share a substitute", () => {
    const p = planBundledFonts(["Simplified Arabic", "Arabic Typesetting", "Amiri"]);
    expect(p.faces.map((f) => f.file)).toEqual(["Amiri-Regular.ttf", "Amiri-Bold.ttf", "Amiri-Italic.ttf", "Amiri-BoldItalic.ttf"]);
    // Arabic Typesetting was not measurable → no line box claimed for it.
    expect(p.substitutions.filter((s) => s.from.family === "Arabic Typesetting").every((s) => !s.lineMetrics)).toBe(true);
    expect(p.substitutions.filter((s) => s.from.family === "Simplified Arabic").every((s) => s.lineMetrics?.heightEm === 1.65771484375)).toBe(true);
  });
  it("covers the document default family too, once", () => {
    const p = planBundledFonts(["Traditional Arabic"], "traditional arabic");
    expect(p.families).toHaveLength(1);
  });
  it("leaves alone what it cannot answer and what an earlier origin already paints", () => {
    expect(planBundledFonts(["Calibri", "Times New Roman"]).faces).toEqual([]);
    const already = ([400, 700] as const).flatMap((weight) => (["normal", "italic"] as const).map((style) => ({ family: "Traditional Arabic", weight, style })));
    expect(planBundledFonts(["Traditional Arabic"], undefined, already).faces).toEqual([]);
  });
  it("every substitute names a bundled family", () => {
    for (const { to } of Object.values(WORD_ARABIC_SUBSTITUTES)) expect(bestFace(to, { weight: 400, style: "normal" }).family).toBe(to);
  });
});
