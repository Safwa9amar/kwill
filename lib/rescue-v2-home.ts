/**
 * Which card the chat's welcome shows for rescue (plan A9 step 2). Pure: the card reads the project list and this decides what it says.
 * A project still in progress comes first, newest first; then a failed one, which waits on the student (screen 18); then a finished one;
 * else no project yet. A failed project is not in progress: a newer touch on it (a refund marked, say) must not hide the rescue the student
 * left mid-way, which the cold start no longer reopens after a day.
 */
import type { RescueProjectSummaryDTO } from "@/types/rescue-v2";

export type HomeCard = { kind: "none" } | { kind: "continue"; id: string } | { kind: "ready"; id: string };

function newestFirst(a: RescueProjectSummaryDTO, b: RescueProjectSummaryDTO): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function homeCard(projects: RescueProjectSummaryDTO[]): HomeCard {
  const active = projects.filter((p) => p.phase !== "done" && p.phase !== "failed").sort(newestFirst)[0];
  if (active) return { kind: "continue", id: active.id };
  const failed = projects.filter((p) => p.phase === "failed").sort(newestFirst)[0];
  if (failed) return { kind: "continue", id: failed.id };
  const done = projects.filter((p) => p.phase === "done").sort(newestFirst)[0];
  if (done) return { kind: "ready", id: done.id };
  return { kind: "none" };
}
