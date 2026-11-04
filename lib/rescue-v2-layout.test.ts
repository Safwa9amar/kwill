import { describe, expect, it } from "vitest";
import type { RescueScreen } from "./rescue-v2-screen";
import { SHEET_TOP_PCT, STAGE_LAYOUT, scaleFor } from "./rescue-v2-layout";

const ALL: Exclude<RescueScreen, "failure">[] = [
  "start", "parts", "reading", "rules_choice", "notes", "understood",
  "diagnosis", "preview", "payment", "rules", "question", "cover",
  "repairing", "result", "changed", "revisions",
  "timeline", "version", "compare", "edit_rerun",
];

describe("rescue v2 layout tables", () => {
  it.each(ALL)("%s has a sheet top and a stage layout", (screen) => {
    expect(SHEET_TOP_PCT[screen]).toBeTypeOf("number");
    expect(STAGE_LAYOUT[screen]).toBeDefined();
  });

  it("every sheet top is between 0 and 100", () => {
    for (const screen of ALL) {
      expect(SHEET_TOP_PCT[screen]).toBeGreaterThan(0);
      expect(SHEET_TOP_PCT[screen]).toBeLessThan(100);
    }
  });

  it("scales the 222-wide mock to the screen width", () => {
    expect(scaleFor(390)).toBeCloseTo(1.757, 2);
    expect(scaleFor(222)).toBe(1);
  });
});
