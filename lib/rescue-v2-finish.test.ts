import { describe, expect, it } from "vitest";
import {
  CHANGE_FIRST_ROWS,
  CHANGE_MORE_ROWS,
  changeItemKey,
  failureBody,
  failureTrust,
  orderedGroups,
  packNames,
  packView,
  repairBar,
  repairEta,
  repairSlots,
  repairWindow,
  visibleRows,
} from "./rescue-v2-finish";
import type { RescuePackDTO } from "@/types/rescue-v2";

const known = (key: string) => key.startsWith("rescueV2.result.packFiles.") || key.startsWith("rescueV2.changed.items.heading_real") || key === "rescueV2.changed.items.other_change";

describe("repairBar", () => {
  it("fills done parts before the current one and leaves the rest pending", () => {
    expect(repairBar(1)[0]).toBe("current");
    expect(repairBar(3)).toEqual(["done", "done", "current", "pending", "pending", "pending", "pending", "pending"]);
  });

  it("clamps an out-of-range step to the eight parts", () => {
    expect(repairBar(0)[0]).toBe("current");
    expect(repairBar(99)[7]).toBe("current");
  });
});

describe("repairWindow", () => {
  it("shows the previous, the current and the next step by the server's stepKey", () => {
    expect(repairWindow("toc", 6)).toEqual([
      { key: "cover", state: "done" },
      { key: "toc", state: "current" },
      { key: "captions", state: "pending" },
    ]);
  });

  it("falls back to the step number when the key is unknown", () => {
    expect(repairWindow("nope", 2).map((r) => r.key)).toEqual(["prepare", "styles", "typography"]);
  });

  it("holds at the first and last step without an empty row", () => {
    expect(repairWindow("prepare", 1).map((r) => r.key)).toEqual(["prepare", "styles"]);
    expect(repairWindow("check", 8).map((r) => r.key)).toEqual(["captions", "check"]);
  });
});

describe("repairEta", () => {
  it("names the waiting word from the server's waiting field, whatever the number is", () => {
    expect(repairEta(120, "brain")).toEqual({ key: "common.waitingBrain" });
    expect(repairEta(null, "converter")).toEqual({ key: "common.waitingWord" });
  });

  it("shows nothing when the server has no estimate", () => {
    expect(repairEta(null, null)).toBeNull();
  });

  it("says soon under a minute and rounds minutes up", () => {
    expect(repairEta(45, null)).toEqual({ key: "common.etaSoon" });
    expect(repairEta(61, null)).toEqual({ key: "common.etaMinutes", params: { minutes: 2 } });
    expect(repairEta(120, null)).toEqual({ key: "common.etaMinutes", params: { minutes: 2 } });
  });
});

describe("repairSlots", () => {
  it("shows three grey pages of v0 before any page of the new version is finished", () => {
    const s = repairSlots(0, true);
    expect(s.every((x) => x.from === "v0" && x.dim)).toBe(true);
    expect(repairSlots(3, false).every((x) => x.from === "v0")).toBe(true);
  });

  it("puts the newest finished page in the middle with the shimmer, and a finished page beside it", () => {
    const [side, mid, third] = repairSlots(5, true);
    expect(mid).toEqual({ from: "active", page: 5, done: true, dim: false, shimmer: true });
    expect(side).toEqual({ from: "active", page: 4, done: true, dim: false, shimmer: false });
    expect(third.from).toBe("v0");
    expect(third.dim).toBe(true);
  });

  it("holds a grey v0 page on the side while only one page is finished", () => {
    const [side, mid] = repairSlots(1, true);
    expect(side.from).toBe("v0");
    expect(mid.page).toBe(1);
  });
});

describe("failureBody", () => {
  it("names the page for a Prove or Regenerate failure that has one", () => {
    expect(failureBody("prove_failed", 88)).toEqual({ key: "failure.bodyPage", params: { page: 88 } });
    expect(failureBody("stage_crashed", null)).toEqual({ key: "failure.body" });
  });

  it("never blames the file for a Word fault on our side", () => {
    expect(failureBody("converter_unavailable", null)).toEqual({ key: "failure.bodyWait" });
  });

  it("maps the file and size codes, and falls back to the generic body", () => {
    expect(failureBody("not_docx", null).key).toBe("failure.bodyOpen");
    expect(failureBody("word_refused", null).key).toBe("failure.bodyOpen");
    expect(failureBody("merge_refused", null).key).toBe("failure.bodyMerge");
    expect(failureBody("too_big", null).key).toBe("failure.bodyBig");
    expect(failureBody("not_same_thesis", null).key).toBe("failure.body");
  });
});

describe("failureTrust", () => {
  const base = { ios: false, refund: "none" as const, purchaseState: "none", previousVersionN: null, rescueRun: false };

  it("always says the original is untouched and nothing more when nothing applies", () => {
    expect(failureTrust(base).map((r) => r.key)).toEqual(["failure.trustOriginal", "failure.noCharge"]);
  });

  it("states a due or done refund on web, and as status words with no amount on iOS", () => {
    expect(failureTrust({ ...base, refund: "due" }).map((r) => r.key)).toContain("failure.refundDue");
    expect(failureTrust({ ...base, refund: "done" }).map((r) => r.key)).toContain("failure.refundDone");
    const ios = failureTrust({ ...base, ios: true, refund: "due" }).map((r) => r.key);
    expect(ios).toContain("failure.refundDueStatus");
    expect(ios).not.toContain("failure.noCharge");
  });

  it("drops the no-charge line on iOS and when a purchase exists", () => {
    expect(failureTrust({ ...base, ios: true }).map((r) => r.key)).not.toContain("failure.noCharge");
    expect(failureTrust({ ...base, purchaseState: "paid" }).map((r) => r.key)).not.toContain("failure.noCharge");
  });

  it("adds the previous version with its number and the team line for a rescue", () => {
    const rows = failureTrust({ ...base, previousVersionN: 2, rescueRun: true });
    expect(rows).toContainEqual({ key: "failure.previousSafe", params: { n: 2 } });
  });

  it("does not name the original as a previous version (n 0): trustOriginal already says it", () => {
    const rows = failureTrust({ ...base, previousVersionN: 0, rescueRun: true });
    expect(rows.map((r) => r.key)).not.toContain("failure.previousSafe");
    expect(rows.map((r) => r.key)).toContain("failure.trustOriginal");
    expect(rows.map((r) => r.key)).toContain("failure.team");
  });
});

describe("packNames and packView", () => {
  it("drops any kind it cannot name, so no raw key is shown", () => {
    expect(packNames(["thesis-pdf", "zip", "cd-note"], known)).toEqual(["rescueV2.result.packFiles.thesis-pdf", "rescueV2.result.packFiles.cd-note"]);
  });

  it("is null without a pack", () => {
    expect(packView(null, known)).toBeNull();
  });

  const pack = (over: Partial<RescuePackDTO>): RescuePackDTO => ({ state: "ready", files: ["thesis-pdf", "thesis-docx"], omitted: [], ...over });

  it("offers the share for a ready pack and no rebuild", () => {
    const v = packView(pack({}), known);
    expect(v?.mode).toBe("ready");
    expect(v?.share).toBe(true);
    expect(v?.rebuild).toBe(false);
  });

  it("names the omitted kinds and offers a rebuild when partial, but says no-abstracts without one", () => {
    const v = packView(pack({
      state: "partial",
      omitted: [{ kind: "abstract-sheet", reason: "render-failed" }, { kind: "cd-note", reason: "no-abstracts" }],
    }), known);
    expect(v?.omitted).toEqual(["rescueV2.result.packFiles.abstract-sheet"]);
    expect(v?.noAbstracts).toBe(true);
    expect(v?.rebuild).toBe(true);
    expect(v?.share).toBe(true);
  });

  it("says the zip was too large with no share and no rebuild, and every file still there (P-64)", () => {
    const v = packView(pack({ state: "ready", omitted: [{ kind: "zip", reason: "zip-too-large" }] }), known);
    expect(v).toMatchObject({ mode: "ready", zipTooLarge: true, share: false, rebuild: false, omitted: null });
    expect(v?.files).toEqual(["rescueV2.result.packFiles.thesis-pdf", "rescueV2.result.packFiles.thesis-docx"]);
  });

  it("keeps the zip out of a partial pack's omitted names, and still offers a rebuild for what it can add", () => {
    const v = packView(pack({
      state: "partial",
      omitted: [{ kind: "zip", reason: "zip-too-large" }, { kind: "abstract-sheet", reason: "render-failed" }],
    }), known);
    expect(v).toMatchObject({ mode: "partial", zipTooLarge: true, share: false, rebuild: true });
    expect(v?.omitted).toEqual(["rescueV2.result.packFiles.abstract-sheet"]);
  });

  it("offers no share for a pruned zip, keeps the rebuild, and lists the forms still there", () => {
    const v = packView(pack({ state: "partial", files: ["abstract-sheet"], omitted: [{ kind: "zip", reason: "zip-pruned" }] }), known);
    expect(v).toMatchObject({ mode: "partial", zipTooLarge: false, share: false, rebuild: true, omitted: null });
    expect(v?.files).toEqual(["rescueV2.result.packFiles.abstract-sheet"]);
  });

  it("offers no share and a rebuild for a missing pack", () => {
    const v = packView(pack({ state: "missing", files: [] }), known);
    expect(v).toMatchObject({ mode: "missing", share: false, rebuild: true });
  });
});

describe("orderedGroups and visibleRows", () => {
  it("orders the groups as the mock, with captions after headings", () => {
    const keys = orderedGroups([{ key: "captions" as const }, { key: "cover" as const }, { key: "headings" as const }]).map((g) => g.key);
    expect(keys).toEqual(["cover", "headings", "captions"]);
  });

  it("shows the first rows, then the total", () => {
    expect(visibleRows(undefined, 500)).toBe(CHANGE_FIRST_ROWS);
    expect(visibleRows(CHANGE_FIRST_ROWS + CHANGE_MORE_ROWS, 30)).toBe(30);
  });

  it("uses the catch-all sentence for a code with no line", () => {
    expect(changeItemKey("toc_real", () => true)).toBe("changed.items.toc_real");
    expect(changeItemKey("made_up", () => false)).toBe("changed.items.other_change");
  });
});
