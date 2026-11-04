import { describe, expect, it } from "vitest";
import {
  dayLabel,
  impactLines,
  libraryChips,
  nextVersionN,
  orderPair,
  pillKey,
  railItems,
  rowMetaKey,
  changesOnPage,
  versionActions,
} from "./rescue-v2-history";
import type { RescueChangeItemDTO, RescueImpactDTO, RescueVersionSummaryDTO } from "@/types/rescue-v2";

const ver = (over: Partial<RescueVersionSummaryDTO> & { id: string; n: number }): RescueVersionSummaryDTO => ({
  kind: "rescue", trigger: "first_rescue", triggerN: null, status: "done", createdAt: "2026-11-02T09:00:00Z",
  finishedAt: "2026-11-02T09:10:00Z", pages: 150, fixes: 47, changedPages: null, published: true,
  editedBefore: false, changedBlocks: null, pack: null, ...over,
});

const original = ver({ id: "v0", n: 0, kind: "original", trigger: "first_diagnosis", fixes: 0, published: false });

describe("railItems", () => {
  it("lists newest first, the original last, and a grey step under the version that absorbed an edit", () => {
    const v2 = ver({ id: "v2", n: 2, editedBefore: true, changedBlocks: 2 });
    const v1 = ver({ id: "v1", n: 1 });
    const rows = railItems([v2, v1, original], { edited: false, changedBlocks: null });
    expect(rows.map((r) => r.key)).toEqual(["v2", "edit-v2", "v1", "v0"]);
    expect(rows[1]).toEqual({ kind: "edit", key: "edit-v2", changedBlocks: 2 });
  });

  it("puts an edit not yet absorbed above the newest version", () => {
    const v1 = ver({ id: "v1", n: 1 });
    const rows = railItems([v1, original], { edited: true, changedBlocks: 3 });
    expect(rows[0]).toEqual({ kind: "edit", key: "edit-now", changedBlocks: 3 });
    expect(rows[1].key).toBe("v1");
  });

  it("never puts an edit step under the original", () => {
    const rows = railItems([original], { edited: false, changedBlocks: null });
    expect(rows.map((r) => r.key)).toEqual(["v0"]);
  });
});

describe("versionActions", () => {
  it("shows nothing for a version that is not finished", () => {
    expect(versionActions({ kind: "rescue", status: "failed" })).toEqual([]);
    expect(versionActions({ kind: "rerun", status: "running" })).toEqual([]);
  });

  it("gives the original only download and compare (P-44)", () => {
    expect(versionActions({ kind: "original", status: "done" })).toEqual(["pdf", "word", "compare"]);
  });

  it("gives a finished repair every action", () => {
    expect(versionActions({ kind: "rerun", status: "done" })).toEqual(["pdf", "word", "compare", "changed", "open", "restore"]);
  });
});

describe("libraryChips", () => {
  const base = { phase: "done" as const, thesisId: "t1", canDelete: false };

  it("offers history, redo and open for a delivered rescue", () => {
    expect(libraryChips(base)).toEqual({ history: true, rerun: true, open: true, continue: false, delete: false });
  });

  it("offers continue, not history, while a rescue is not done", () => {
    expect(libraryChips({ ...base, phase: "repairing" })).toEqual({ history: false, rerun: false, open: true, continue: true, delete: false });
  });

  it("offers no open without a thesis, and delete only when the server allows it", () => {
    expect(libraryChips({ phase: "diagnosed", thesisId: null, canDelete: true })).toEqual({
      history: false, rerun: false, open: false, continue: true, delete: true,
    });
  });
});

describe("pillKey", () => {
  it("maps phases to the four pill words", () => {
    expect(pillKey("done")).toBe("ready");
    expect(pillKey("failed")).toBe("failed");
    expect(pillKey("diagnosed")).toBe("diagnosed");
    expect(pillKey("repairing")).toBe("working");
    expect(pillKey("confirm_rules")).toBe("working");
  });
});

describe("rowMetaKey", () => {
  it("says what the row can show", () => {
    expect(rowMetaKey(ver({ id: "a", n: 1, status: "failed" }))).toBe("metaFailed");
    expect(rowMetaKey(ver({ id: "a", n: 1, changedPages: 6 }))).toBe("metaPages");
    expect(rowMetaKey(ver({ id: "a", n: 1 }))).toBe("meta");
  });
});

describe("orderPair", () => {
  it("puts the earlier version first, whichever order the caller gives", () => {
    const a = { id: "a", n: 3 };
    const b = { id: "b", n: 2 };
    expect(orderPair(a, b)).toEqual([b, a]);
    expect(orderPair(b, a)).toEqual([b, a]);
  });
});

describe("changesOnPage", () => {
  const item = (page: number | null, code: string): RescueChangeItemDTO => ({ page, code, count: 1, params: {} });

  it("keeps only the rows of the page on show, and never invents one", () => {
    const items = [item(24, "moved_annex"), item(25, "added_abbrev"), item(null, "toc_refreshed")];
    expect(changesOnPage(items, 24).map((i) => i.code)).toEqual(["moved_annex"]);
    expect(changesOnPage(items, 26)).toEqual([]);
    expect(changesOnPage(items, undefined)).toEqual([]);
  });
});

describe("impactLines", () => {
  const impact = (over: Partial<RescueImpactDTO>): RescueImpactDTO => ({
    scope: "none", pages: [], toc: false, nextN: 4, changedBlocks: null, ...over,
  });

  it("names nothing to redo as nothing", () => {
    expect(impactLines(impact({ scope: "none" }), ", ")).toEqual([{ key: "editRerun.impactNone" }]);
  });

  it("names the pages and the contents when the change reaches both", () => {
    expect(impactLines(impact({ scope: "pages", pages: [13], toc: true }), ", ")).toEqual([
      { key: "editRerun.impactPages", params: { pages: "13" } },
      { key: "editRerun.impactToc" },
    ]);
  });

  it("uses one line for each whole-document scope", () => {
    expect(impactLines(impact({ scope: "all" }), ", ")).toEqual([{ key: "editRerun.impactAll" }]);
    expect(impactLines(impact({ scope: "pack" }), ", ")).toEqual([{ key: "editRerun.impactPack" }]);
    expect(impactLines(impact({ scope: "note" }), ", ")).toEqual([{ key: "editRerun.impactNote" }]);
  });

  it("treats pages with nothing named as nothing to redo", () => {
    expect(impactLines(impact({ scope: "pages", pages: [] }), ", ")).toEqual([{ key: "editRerun.impactNone" }]);
  });
});

describe("nextVersionN", () => {
  it("is one past the newest version, whatever order the list is in", () => {
    expect(nextVersionN([original, ver({ id: "v2", n: 2 }), ver({ id: "v1", n: 1 })])).toBe(3);
  });
});

describe("dayLabel", () => {
  it("names the day of a timestamp, read at midday so no timezone moves it", () => {
    expect(dayLabel("2026-11-09T12:00:00Z", "en")).toContain("9");
  });
});
