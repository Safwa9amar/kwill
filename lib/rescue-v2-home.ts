/**
 * Which card the chat's welcome shows for rescue (plan A9 step 2). Pure: the card reads the project list and this decides what it says.
 * A project still in progress comes first, newest first; else the newest of the failed and the finished ones (a failed one waits on the
 * student at screen 18, so it continues); else no project yet. A failed project is not in progress: a newer touch on it (a refund marked,
 * say) must not hide the rescue the student left mid-way, which the cold start no longer reopens after a day, and an old failure must not
 * hide a newer finished rescue.
 */
import type { RescueProjectSummaryDTO } from "@/types/rescue-v2";

export type HomeCard = { kind: "none" } | { kind: "continue"; id: string } | { kind: "ready"; id: string };

function newestFirst(a: RescueProjectSummaryDTO, b: RescueProjectSummaryDTO): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function homeCard(projects: RescueProjectSummaryDTO[]): HomeCard {
  const active = projects.filter((p) => p.phase !== "done" && p.phase !== "failed").sort(newestFirst)[0];
  if (active) return { kind: "continue", id: active.id };
  const settled = projects.filter((p) => p.phase === "done" || p.phase === "failed").sort(newestFirst)[0];
  if (settled) return settled.phase === "failed" ? { kind: "continue", id: settled.id } : { kind: "ready", id: settled.id };
  return { kind: "none" };
}
