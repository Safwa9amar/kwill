import { describe, expect, it } from "vitest";
import type { RescueScreen } from "./rescue-v2-screen";
import { SHEET_TOP_PCT, STAGE_LAYOUT, nextRoom, roomScale, scaleFor, stageFit, tallestMock } from "./rescue-v2-layout";

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

  it("leaves a stage whose pages clear the status bar as it is", () => {
    // Screen 7 on an iPhone 17: a 49% stage holds the 170-tall page with room above it.
    expect(stageFit(450, 308, 62)).toEqual({ factor: 1, shift: 0 });
  });

  it("shrinks and lowers pages that would run under the status bar", () => {
    // Screen 9 on an iPhone 17: a 23% stage, 98-tall mock pages scaled to 177.
    const { factor, shift } = stageFit(223, 177, 62);
    const h = 177 * factor;
    const top = 223 / 2 + shift - h / 2;
    expect(factor).toBeLessThan(1);
    expect(top).toBeGreaterThanOrEqual(66);
    expect(top + h).toBeLessThanOrEqual(223 - 22 - 4 + 1e-9);
  });

  it("moves pages that fit in height but sit under the status bar without shrinking them", () => {
    const { factor, shift } = stageFit(310, 192, 62);
    expect(factor).toBe(1);
    expect(shift).toBeGreaterThan(0);
  });
});

describe("roomScale (screens 7 and 8: the page fits the slot between the switch and the sheet)", () => {
  const diag = STAGE_LAYOUT.diagnosis;
  it("keeps the width's scale when the slot is tall enough", () => {
    expect(roomScale(390, diag, 1000)).toBeCloseTo(scaleFor(390));
  });
  it("shrinks so the tallest page is exactly the slot, aspect ratio kept", () => {
    const s = roomScale(390, diag, 250);
    expect(tallestMock(diag) * s).toBeCloseTo(250);
    if (diag.kind === "three") expect((diag.mid[0] * s) / (diag.mid[1] * s)).toBeCloseTo(diag.mid[0] / diag.mid[1]);
  });
  it("never grows the page, never goes negative", () => {
    expect(roomScale(390, diag, 99999)).toBe(scaleFor(390));
    expect(roomScale(390, diag, -5)).toBe(0);
    expect(roomScale(390, STAGE_LAYOUT.parts, 10)).toBe(scaleFor(390));
  });
});

describe("nextRoom", () => {
  it("takes the first measure and moves of 4 points or more, ignores smaller jitter", () => {
    expect(nextRoom(null, 300.7)).toBe(300);
    expect(nextRoom(300, 302)).toBeNull();
    expect(nextRoom(300, 296)).toBe(296);
    expect(nextRoom(300, -3)).toBe(0);
  });
});
