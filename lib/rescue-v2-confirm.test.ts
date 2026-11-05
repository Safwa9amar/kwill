import { describe, expect, it } from "vitest";
import {
  ZOOM_SCALE,
  ZOOM_TARGET,
  coverFieldsAfter,
  coverLabelKey,
  coverMoreOpen,
  coverSourceWord,
  missingRow,
  currentQuestionIndex,
  groupRuleRows,
  marginLines,
  pickedCover,
  stepRuleNumber,
  unsavedRuleEdits,
  zoomFor,
} from "./rescue-v2-confirm";
import type { RescueRuleFieldDTO } from "@/types/rescue-v2";

const field = (id: RescueRuleFieldDTO["id"], row: RescueRuleFieldDTO["row"], value: RescueRuleFieldDTO["value"] = 1, extra: Partial<RescueRuleFieldDTO> = {}): RescueRuleFieldDTO =>
  ({ id, row, kind: "number", value, source: "default", ...extra });

describe("groupRuleRows", () => {
  it("groups by row in the order of the rules table, not in the order the server sent", () => {
    const groups = groupRuleRows([
      field("captionNumbers", "additions"),
      field("marginTop", "margins"),
      field("bodyFont", "font"),
      field("h1Size", "headings"),
      field("lineSpacing", "spacing"),
      field("deposit", "deposit"),
    ]);
    expect(groups.map((g) => g.row)).toEqual(["font", "spacing", "headings", "margins", "deposit", "additions"]);
  });

  it("keeps the server's order of fields inside one row, and drops rows the server did not send", () => {
    const groups = groupRuleRows([field("bodySize", "font"), field("bodyFont", "font")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fields.map((f) => f.id)).toEqual(["bodySize", "bodyFont"]);
  });
});

describe("unsavedRuleEdits", () => {
  const fields = [field("bodySize", "font", 12), field("headingBold", "headings", true, { kind: "switch" })];

  it("keeps only the edits that differ from what the server holds", () => {
    expect(unsavedRuleEdits(fields, { bodySize: 14, headingBold: true })).toEqual({ bodySize: 14 });
  });

  it("is empty once the server holds every edit (a retry that landed clears it)", () => {
    expect(unsavedRuleEdits(fields, { bodySize: 12 })).toEqual({});
  });
});

describe("marginLines", () => {
  const m = { top: 2.5, bottom: 2.5, binding: 3, opposite: 2 };

  it("measures top and bottom from the A4 height (29.7 cm) and the sides from the width (21 cm)", () => {
    const lines = marginLines(m, "right");
    expect(lines.top).toBeCloseTo(2.5 / 29.7);
    expect(lines.bottom).toBeCloseTo(2.5 / 29.7);
  });

  it("gives the binding margin to the side the student binds on", () => {
    const right = marginLines(m, "right");
    expect(right.end).toBeCloseTo(3 / 21);
    expect(right.start).toBeCloseTo(2 / 21);
    const left = marginLines(m, "left");
    expect(left.start).toBeCloseTo(3 / 21);
    expect(left.end).toBeCloseTo(2 / 21);
  });
});

describe("zoomFor", () => {
  // The page is centred in a stage of height `stageH`. After the zoom scales about the centre and the translation is applied, the point at
  // `topPct` of the page must sit at ZOOM_TARGET of the stage.
  it.each([0.2, 0.5, 0.8])("puts the line at topPct %s at the target height", (topPct) => {
    const stageH = 640;
    const pageH = 300;
    const { scale, translateY } = zoomFor(pageH, stageH, topPct, ZOOM_SCALE);
    const lineY = stageH / 2 + (topPct * pageH - pageH / 2) * scale + translateY;
    expect(scale).toBe(ZOOM_SCALE);
    expect(lineY).toBeCloseTo(ZOOM_TARGET * stageH);
  });
});

describe("stepRuleNumber", () => {
  const range = { min: 10, max: 14, step: 1 };

  it("moves by one step and stops at the range's ends", () => {
    expect(stepRuleNumber(12, 1, range)).toBe(13);
    expect(stepRuleNumber(12, -1, range)).toBe(11);
    expect(stepRuleNumber(14, 1, range)).toBe(14);
    expect(stepRuleNumber(10, -1, range)).toBe(10);
  });

  it("keeps half steps exact, with no float drift", () => {
    expect(stepRuleNumber(2.5, 1, { min: 1.5, max: 4.5, step: 0.5 })).toBe(3);
    expect(stepRuleNumber(3, -1, { min: 1.5, max: 4.5, step: 0.5 })).toBe(2.5);
  });
});

describe("currentQuestionIndex", () => {
  const q = (key: string, answered: boolean) => ({
    key, text: "", excerpt: "", page: 1, topPct: 0.1, options: [], answer: answered ? { role: "body" } : null,
  });

  it("is the first question with no answer, and -1 when every question is answered", () => {
    expect(currentQuestionIndex([q("a", true), q("b", false), q("c", false)])).toBe(1);
    expect(currentQuestionIndex([q("a", true)])).toBe(-1);
    expect(currentQuestionIndex([])).toBe(-1);
  });
});

describe("cover helpers", () => {
  it("shows the student's own pick first, then the server's choice, then its default", () => {
    expect(pickedCover("generated", { choice: "keep", defaultChoice: "clean" })).toBe("generated");
    expect(pickedCover(null, { choice: "keep", defaultChoice: "clean" })).toBe("keep");
    expect(pickedCover(null, { choice: null, defaultChoice: "clean" })).toBe("clean");
  });

  it("opens More by itself under the generated cover when an extra field holds a value", () => {
    expect(coverMoreOpen(null, "generated", { university: "Université fictive" })).toBe(true);
    expect(coverMoreOpen(null, "generated", { title: "Titre" })).toBe(false);
    expect(coverMoreOpen(null, "keep", { university: "Université fictive" })).toBe(false);
    // The student's own toggle wins over the automatic opening.
    expect(coverMoreOpen(false, "generated", { university: "Université fictive" })).toBe(false);
    expect(coverMoreOpen(true, "keep", {})).toBe(true);
  });

  it("maps the year row to the academicYear field and every row to a word key", () => {
    expect(coverLabelKey("year")).toBe("rescueV2.cover.fieldYear");
    expect(coverLabelKey("coSupervisor")).toBe("rescueV2.cover.fieldCoSupervisor");
  });

  it("tags only a value from the profile or the catalogue", () => {
    expect(coverSourceWord("profile")).toBe("rescueV2.cover.fromProfile");
    expect(coverSourceWord("catalogue")).toBe("rescueV2.cover.fromCatalogue");
    expect(coverSourceWord("cover")).toBeNull();
    expect(coverSourceWord("student")).toBeNull();
    expect(coverSourceWord(undefined)).toBeNull();
  });

  it("names the first missing field by its row, and falls back to the generic title for an unknown key", () => {
    expect(missingRow(["academicYear", "title"])).toBe("year");
    expect(missingRow(["unknownField"])).toBeNull();
    expect(missingRow([])).toBeNull();
  });

  it("writes one row back into the fields, and removes a row that became empty", () => {
    const base = { title: "Titre", students: ["Étudiant fictif"] };
    expect(coverFieldsAfter(base, "title", "  Nouveau titre ")).toEqual({ title: "Nouveau titre", students: ["Étudiant fictif"] });
    expect(coverFieldsAfter(base, "title", "   ")).toEqual({ students: ["Étudiant fictif"] });
    expect(coverFieldsAfter(base, "students", ["", " Second "])).toEqual({ title: "Titre", students: ["Second"] });
    // The jury is never sent: the server drops it, so a jury the file gave the screen is stripped from every save.
    expect(coverFieldsAfter({ ...base, jury: [{ name: "Président fictif" }] }, "year", "2026 / 2027")).toEqual({
      title: "Titre", students: ["Étudiant fictif"], academicYear: "2026 / 2027",
    });
    expect(coverFieldsAfter(base, "year", "2026 / 2027")).toEqual({ title: "Titre", students: ["Étudiant fictif"], academicYear: "2026 / 2027" });
  });
});
