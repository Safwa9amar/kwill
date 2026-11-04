import { describe, expect, it } from "vitest";
import type { RescueChipKey, RescueDotDTO } from "@/types/rescue-v2";
import { chipTarget, chipsWithDots, firstPage, firstVisibleN, problemKey, problemSentence, visibleDots } from "./rescue-v2-diagnosis";

const dot = (n: number, page: number, chip: RescueChipKey, topPct = 0.5): RescueDotDTO =>
  ({ n, chip, code: "margins", page, topPct, params: {} }) as RescueDotDTO;

// Dots arrive in reading order, but a dot's `n` is the only order the student sees, so the helpers sort by it.
const dots: RescueDotDTO[] = [
  dot(3, 2, "headings"),
  dot(1, 1, "headings"),
  dot(2, 1, "toc"),
  dot(4, 5, "headings"),
  dot(5, 5, "text"),
];

describe("visibleDots", () => {
  it("returns the page's dots in n order", () => {
    expect(visibleDots(dots, 1, null).map((d) => d.n)).toEqual([1, 2]);
  });

  it("filters by chip when one is picked", () => {
    expect(visibleDots(dots, 1, "toc").map((d) => d.n)).toEqual([2]);
    expect(visibleDots(dots, 1, "figures")).toEqual([]);
  });

  it("is empty on a page with no dots", () => {
    expect(visibleDots(dots, 3, null)).toEqual([]);
  });
});

describe("firstVisibleN", () => {
  it("is the lowest n on the page, or null", () => {
    expect(firstVisibleN(dots, 5, null)).toBe(4);
    expect(firstVisibleN(dots, 5, "text")).toBe(5);
    expect(firstVisibleN(dots, 3, null)).toBeNull();
  });
});

describe("firstPage", () => {
  it("is the lowest page holding a dot, or 1 when there are none", () => {
    expect(firstPage(dots)).toBe(1);
    expect(firstPage([dot(1, 4, "cover")])).toBe(4);
    expect(firstPage([])).toBe(1);
  });
});

describe("chipTarget", () => {
  it("jumps to the next page after the current one that holds the chip, selecting its first dot", () => {
    expect(chipTarget(dots, "headings", 1)).toEqual({ page: 2, n: 3 });
    expect(chipTarget(dots, "headings", 2)).toEqual({ page: 5, n: 4 });
  });

  it("wraps to the first page holding the chip when none comes after", () => {
    expect(chipTarget(dots, "headings", 5)).toEqual({ page: 1, n: 1 });
  });

  it("finds the chip's own page again when it is the only one", () => {
    expect(chipTarget(dots, "toc", 1)).toEqual({ page: 1, n: 2 });
  });

  it("is null when no dot carries the chip", () => {
    expect(chipTarget(dots, "cover", 1)).toBeNull();
  });
});

describe("chipsWithDots", () => {
  it("keeps only the chips that have a count, so a chip never leads nowhere", () => {
    const chips = [
      { key: "headings" as const, count: 9 },
      { key: "cover" as const, count: 0 },
      { key: "toc" as const, count: 4 },
    ];
    expect(chipsWithDots(chips).map((c) => c.key)).toEqual(["headings", "toc"]);
  });
});

describe("problemKey", () => {
  it("uses the code's own sentence when the locale has one", () => {
    expect(problemKey("margins", (k) => k === "rescueV2.diagnosis.problems.margins")).toBe("rescueV2.diagnosis.problems.margins");
  });

  it("falls back to the generic sentence, never the raw code", () => {
    expect(problemKey("some-new-code", () => false)).toBe("rescueV2.diagnosis.problems.generic");
  });
});

describe("problemSentence", () => {
  // A fake translator: returns the key and its values, so the test can see which key was chosen and with what.
  const t = (key: string, o: Record<string, string | number> = {}) => `${key}|${JSON.stringify(o)}`;
  const has = (...keys: string[]) => (k: string) => keys.includes(k);

  it("uses the code's sentence with its params", () => {
    expect(problemSentence(t, has("rescueV2.diagnosis.problems.body-font"), "body-font", { expected: "Times" }))
      .toBe('rescueV2.diagnosis.problems.body-font|{"expected":"Times"}');
  });

  it("names a section from the sections table", () => {
    const out = problemSentence(t, has("rescueV2.diagnosis.problems.section-missing", "rescueV2.diagnosis.sections.toc"), "section-missing", { section: "toc" });
    expect(out).toBe('rescueV2.diagnosis.problems.section-missing|{"section":"toc","sectionName":"rescueV2.diagnosis.sections.toc|{}"}');
  });

  it("falls back to the generic sentence for an unknown code or an unknown section", () => {
    expect(problemSentence(t, has(), "brand-new", {})).toBe("rescueV2.diagnosis.problems.generic|{}");
    expect(problemSentence(t, has("rescueV2.diagnosis.problems.section-empty"), "section-empty", { section: "annexes-2" }))
      .toBe("rescueV2.diagnosis.problems.generic|{}");
  });
});
