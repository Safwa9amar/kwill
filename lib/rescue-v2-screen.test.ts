import { describe, expect, it } from "vitest";
import type { RescuePhase, RescueProjectDTO } from "@/types/rescue-v2";
import {
  INITIAL_NAV,
  backFor,
  isRunning,
  needsPolling,
  needsSlowPolling,
  pageIsInRange,
  revisionsStageVersion,
  screenFor,
  thesisIsRtl,
  type RescueNav,
  type RescueScreen,
} from "./rescue-v2-screen";

const nav = (patch: Partial<RescueNav> = {}): RescueNav => ({ ...INITIAL_NAV, ...patch });
const proj = (
  phase: RescuePhase,
  failure: RescueProjectDTO["failure"] = null,
): Pick<RescueProjectDTO, "phase" | "failure"> => ({ phase, failure });

const failureOf = (code: NonNullable<RescueProjectDTO["failure"]>["code"]) => ({
  versionId: "v1",
  code,
  page: null,
  refund: "none" as const,
  previousVersionN: 0,
  reviewable: code === "not_same_thesis",
  reviewRequested: false,
});

// One row per phase in the §1.1 table.
const TABLE: [RescuePhase | "none", RescueScreen][] = [
  ["none", "start"],
  ["uploading", "reading"],
  ["proposing_order", "parts"],
  ["await_part_order", "parts"],
  ["reading", "reading"],
  ["understanding", "understood"],
  ["diagnosing", "understood"],
  ["diagnosed", "diagnosis"],
  ["confirm_rules", "rules"],
  ["confirm_questions", "question"],
  ["confirm_cover", "cover"],
  ["repairing", "repairing"],
  ["done", "result"],
];

describe("screenFor: one row per phase of the §1.1 table", () => {
  it.each(TABLE)("phase %s shows %s", (phase, screen) => {
    const project = phase === "none" ? null : proj(phase as RescuePhase);
    expect(screenFor(project, nav())).toBe(screen);
  });

  it("await_setup follows the setup step in the navigation", () => {
    expect(screenFor(proj("await_setup"), nav({ setupStep: "rules_choice" }))).toBe("rules_choice");
    expect(screenFor(proj("await_setup"), nav({ setupStep: "notes" }))).toBe("notes");
  });

  it("diagnosed shows the diagnosis, then the preview on the after tab, then payment", () => {
    expect(screenFor(proj("diagnosed"), nav())).toBe("diagnosis");
    expect(screenFor(proj("diagnosed"), nav({ diagnosisTab: "after" }))).toBe("preview");
    expect(screenFor(proj("diagnosed"), nav({ paying: true }))).toBe("payment");
  });

  it("paying beats diagnosisTab", () => {
    expect(screenFor(proj("diagnosed"), nav({ paying: true, diagnosisTab: "after" }))).toBe("payment");
  });

  it("done shows the overlay when one is open, the result otherwise", () => {
    expect(screenFor(proj("done"), nav())).toBe("result");
    expect(screenFor(proj("done"), nav({ overlay: "timeline" }))).toBe("timeline");
    expect(screenFor(proj("done"), nav({ overlay: "compare" }))).toBe("compare");
  });

  it("overlay is ignored while repairing", () => {
    expect(screenFor(proj("repairing"), nav({ overlay: "timeline" }))).toBe("repairing");
  });

  it("failed shows the failure sheet, and not_same_thesis shows revisions", () => {
    expect(screenFor(proj("failed", failureOf("word_refused")), nav())).toBe("failure");
    expect(screenFor(proj("failed", failureOf("not_same_thesis")), nav())).toBe("revisions");
  });

  it("uploading with overlay revisions stays on revisions", () => {
    expect(screenFor(proj("uploading"), nav({ overlay: "revisions" }))).toBe("revisions");
    expect(screenFor(proj("uploading"), nav({ overlay: "timeline" }))).toBe("reading");
  });
});

describe("isRunning and needsPolling", () => {
  it("a running phase polls", () => {
    expect(isRunning("repairing")).toBe(true);
    expect(isRunning("uploading")).toBe(true);
    expect(isRunning(undefined)).toBe(false);
  });

  const quiet = {
    phase: "confirm_rules" as RescuePhase,
    note: { state: "none" },
    setup: { guide: { state: "none" } },
    cover: null,
    entitlement: { purchase: { state: "none" }, kind: "purchase" },
  };
  type Polled = Parameters<typeof needsPolling>[0];
  const with_ = (patch: Partial<Record<keyof typeof quiet, unknown>>) => ({ ...quiet, ...patch }) as Polled;

  it("is false for null and for a quiet confirm_rules", () => {
    expect(needsPolling(null)).toBe(false);
    expect(needsPolling(with_({}))).toBe(false);
  });

  it("is true for a running phase, a parsing note, a guide being read, samples rendering, a pending payment", () => {
    expect(needsPolling(with_({ phase: "repairing" }))).toBe(true);
    expect(needsPolling(with_({ note: { state: "parsing" } }))).toBe(true);
    expect(needsPolling(with_({ setup: { guide: { state: "reading" } } }))).toBe(true);
    expect(needsPolling(with_({ cover: { samples: "rendering" } }))).toBe(true);
    expect(needsPolling(with_({ entitlement: { purchase: { state: "pending_card" }, kind: null } }))).toBe(true);
    expect(needsPolling(with_({ entitlement: { purchase: { state: "pending_manual" }, kind: null } }))).toBe(true);
  });

  it("is true for paid with no entitlement yet, so confirming ends by itself (P-62)", () => {
    expect(needsPolling(with_({ entitlement: { purchase: { state: "paid" }, kind: null } }))).toBe(true);
    expect(needsPolling(with_({ entitlement: { purchase: { state: "paid" }, kind: "purchase" } }))).toBe(false);
  });
});

describe("backFor", () => {
  const base = nav();
  it("notes goes to rules_choice, preview to the before tab, payment un-pays", () => {
    expect(backFor("notes", base)).toEqual({ setupStep: "rules_choice" });
    expect(backFor("preview", base)).toEqual({ diagnosisTab: "before" });
    expect(backFor("payment", base)).toEqual({ paying: false });
  });

  it("changed returns to version when it was opened from there, else closes", () => {
    expect(backFor("changed", nav({ versionId: "v2" }))).toEqual({ overlay: "version" });
    expect(backFor("changed", base)).toEqual({ overlay: null });
  });

  it("revisions with a failed not_same_thesis returns ack, every other revisions closes the overlay", () => {
    expect(backFor("revisions", base, proj("failed", failureOf("not_same_thesis")))).toBe("ack");
    expect(backFor("revisions", base, proj("uploading"))).toEqual({ overlay: null });
    expect(backFor("revisions", base)).toEqual({ overlay: null });
  });

  it("timeline closes; version and edit_rerun go to timeline; compare goes to version", () => {
    expect(backFor("timeline", base)).toEqual({ overlay: null });
    expect(backFor("version", base)).toEqual({ overlay: "timeline" });
    expect(backFor("edit_rerun", base)).toEqual({ overlay: "timeline" });
    expect(backFor("compare", base)).toEqual({ overlay: "version" });
  });

  it("a screen with no way back returns null", () => {
    expect(backFor("start", base)).toBeNull();
    expect(backFor("result", base)).toBeNull();
    expect(backFor("reading", base)).toBeNull();
    expect(backFor("failure", base)).toBeNull();
  });
});

describe("thesisIsRtl: the detected language decides, the title only until one is detected", () => {
  const thesis = (title: string | null, language: RescueProjectDTO["language"]) => ({ title: title as string, language });

  it("a detected Arabic thesis is RTL, whatever its title says", () => {
    expect(thesisIsRtl(thesis("Mémoire de master", "ar"))).toBe(true);
  });

  it("a detected French or English thesis is LTR, even with an Arabic title", () => {
    expect(thesisIsRtl(thesis("مذكرة ماستر في القانون", "fr"))).toBe(false);
    expect(thesisIsRtl(thesis("مذكرة ماستر في القانون", "en"))).toBe(false);
  });

  it("with no language yet, an Arabic title is RTL and a Latin one is LTR", () => {
    expect(thesisIsRtl(thesis("مذكرة ماستر في القانون", null))).toBe(true);
    expect(thesisIsRtl(thesis("Mémoire de master", null))).toBe(false);
  });

  it("handles a missing title, with no language, as no evidence: LTR", () => {
    expect(thesisIsRtl(thesis(null, null))).toBe(false);
    expect(thesisIsRtl(thesis("", null))).toBe(false);
    expect(thesisIsRtl(thesis(null, "ar"))).toBe(true);
  });

  it("no project is LTR", () => {
    expect(thesisIsRtl(null)).toBe(false);
  });
});

describe("pageIsInRange: a version with no pages shows no skeletons (fix 9)", () => {
  it("while the count is unknown every page is in range, so a skeleton shows", () => {
    expect(pageIsInRange(1, null)).toBe(true);
    expect(pageIsInRange(2, null)).toBe(true);
  });

  it("a version known to have zero pages has none in range", () => {
    expect(pageIsInRange(1, 0)).toBe(false);
    expect(pageIsInRange(2, 0)).toBe(false);
  });

  it("with pages, 1..count are in range and nothing beyond", () => {
    expect(pageIsInRange(1, 3)).toBe(true);
    expect(pageIsInRange(3, 3)).toBe(true);
    expect(pageIsInRange(4, 3)).toBe(false);
    expect(pageIsInRange(0, 3)).toBe(false);
  });
});

describe("revisionsStageVersion (W7: 17 after a file that is not the same thesis)", () => {
  const v = (id: string, n: number, kind: "original" | "rescue" | "rerun" | "restore", status: "done" | "failed" | "running") => ({ id, n, kind, status });
  const versions = [v("v3", 3, "rerun", "failed"), v("v2", 2, "rerun", "done"), v("v1", 1, "rescue", "done"), v("v0", 0, "original", "done")];
  const current = { currentVersion: { id: "v3" } };

  it("a not_same_thesis failure shows the newest good version, never the failed one with no pages", () => {
    const p = { ...proj("failed", { ...failureOf("not_same_thesis"), versionId: "v3" }), ...current };
    expect(revisionsStageVersion(p, versions)).toBe("v2");
    // The list in any order: the highest n wins.
    expect(revisionsStageVersion(p, [...versions].reverse())).toBe("v2");
  });

  it("before the versions are read it has nothing to show (a skeleton), not the failed version", () => {
    const p = { ...proj("failed", { ...failureOf("not_same_thesis"), versionId: "v3" }), ...current };
    expect(revisionsStageVersion(p, [])).toBeNull();
  });

  it("the original is never the stage's version", () => {
    const p = { ...proj("failed", { ...failureOf("not_same_thesis"), versionId: "v1" }), currentVersion: { id: "v1" } };
    expect(revisionsStageVersion(p, [v("v1", 1, "rescue", "failed"), v("v0", 0, "original", "done")])).toBeNull();
  });

  it("otherwise 17 shows the current version", () => {
    expect(revisionsStageVersion({ ...proj("done"), currentVersion: { id: "v2" } }, versions)).toBe("v2");
    expect(revisionsStageVersion({ ...proj("done"), currentVersion: null }, versions)).toBeNull();
  });
});

describe("needsSlowPolling", () => {
  it("polls screen 17 forced by not_same_thesis only once a review was asked for", () => {
    expect(needsSlowPolling(proj("failed", failureOf("not_same_thesis")))).toBe(false);
    expect(needsSlowPolling(proj("failed", { ...failureOf("not_same_thesis"), reviewRequested: true }))).toBe(true);
  });
  it("polls screen 18 (any other failure)", () => {
    expect(needsSlowPolling(proj("failed", failureOf("prove_failed")))).toBe(true);
  });
  it("does not poll anything else", () => {
    expect(needsSlowPolling(null)).toBe(false);
    expect(needsSlowPolling(proj("done"))).toBe(false);
    expect(needsSlowPolling(proj("repairing"))).toBe(false);
    expect(needsSlowPolling(proj("failed", null))).toBe(false);
  });
});
