/**
 * Which card the chat's welcome shows for rescue (plan A9 step 2). Pure: the card reads the project list and this decides what it says.
 * A project still in progress comes first, newest first; then a finished one; else no project yet.
 */
import type { RescueProjectSummaryDTO } from "@/types/rescue-v2";

export type HomeCard = { kind: "none" } | { kind: "continue"; id: string } | { kind: "ready"; id: string };

function newestFirst(a: RescueProjectSummaryDTO, b: RescueProjectSummaryDTO): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function homeCard(projects: RescueProjectSummaryDTO[]): HomeCard {
  const active = projects.filter((p) => p.phase !== "done").sort(newestFirst)[0];
  if (active) return { kind: "continue", id: active.id };
  const done = projects.filter((p) => p.phase === "done").sort(newestFirst)[0];
  if (done) return { kind: "ready", id: done.id };
  return { kind: "none" };
}
