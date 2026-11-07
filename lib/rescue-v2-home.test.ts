import { describe, expect, it } from "vitest";
import type { RescueProjectSummaryDTO } from "@/types/rescue-v2";
import { homeCard } from "./rescue-v2-home";

const project = (id: string, phase: RescueProjectSummaryDTO["phase"], updatedAt: string): RescueProjectSummaryDTO => ({
  id, title: id, canDelete: true, thesisId: null, phase, currentVersionN: null, currentVersionAt: null,
  coverPageVersionId: null, resumeOnOpen: false, updatedAt,
});

describe("homeCard", () => {
  it("offers the start when there is no project", () => {
    expect(homeCard([])).toEqual({ kind: "none" });
  });

  it("continues the newest project still in progress, ahead of a finished one", () => {
    const list = [project("done", "done", "2026-11-05T10:00:00Z"), project("old", "diagnosed", "2026-11-01T10:00:00Z"), project("new", "repairing", "2026-11-04T10:00:00Z")];
    expect(homeCard(list)).toEqual({ kind: "continue", id: "new" });
  });

  it("continues a project in progress ahead of a newer failed one", () => {
    const list = [project("failed", "failed", "2026-11-06T22:00:00Z"), project("diag", "diagnosed", "2026-11-05T10:00:00Z")];
    expect(homeCard(list)).toEqual({ kind: "continue", id: "diag" });
  });

  it("still leads to a failed project when nothing is in progress", () => {
    const list = [project("done", "done", "2026-11-07T10:00:00Z"), project("failed", "failed", "2026-11-06T10:00:00Z")];
    expect(homeCard(list)).toEqual({ kind: "continue", id: "failed" });
  });

  it("says ready for a finished project when none is in progress", () => {
    expect(homeCard([project("a", "done", "2026-11-01T10:00:00Z"), project("b", "done", "2026-11-03T10:00:00Z")])).toEqual({ kind: "ready", id: "b" });
  });
});
