import { apiGet, apiPost, apiDelete } from "./api";

/**
 * Scheduled tasks — the student queues jobs, picks a time, and the server runs
 * them with the app closed. Mirrors ~/kwill-server/src/routes/tasks.ts.
 *
 * Deliberately separate from lib/api.ts, which is already 2000+ lines: this is a
 * self-contained surface and reads better on its own. The four request helpers
 * are reused from there so the auth/error plumbing isn't duplicated.
 */

export type TaskMode = "apply" | "propose";
export type TaskFamily = "hygiene" | "formatting" | "language" | "content";

/** A job on the menu, as the server describes it. */
export interface JobDef {
  id: string;
  family: TaskFamily;
  /** Param names this job needs the student to supply, e.g. ["scope"]. */
  params: string[];
  defaultMode: TaskMode;
}

export interface TaskTarget {
  /** A human label — "الفصل الثاني". Never an index. */
  scope?: string;
  anchor?: { index: number; snippet: string };
}

export interface TaskItem {
  id: string;
  runId: string;
  position: number;
  kind: string;
  params: Record<string, string>;
  target: TaskTarget;
  mode: TaskMode;
  status: "pending" | "done" | "failed" | "skipped";
  result?: { message: string; reason?: string } | null;
}

export interface RunSummary {
  applied: number;
  proposed: number;
  failed: number;
  stoppedForBudget?: boolean;
  lateMinutes?: number;
}

export interface TaskRun {
  id: string;
  thesisId: string;
  title: string;
  status: "draft" | "scheduled" | "running" | "cancelling" | "done" | "failed" | "cancelled";
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** thesis_doc_history.seq taken before the first task — the run's undo point. */
  historyCheckpoint: number | null;
  summary: RunSummary | null;
  createdAt: string;
}

export interface TaskProposal {
  id: string;
  taskId: string;
  anchor: { index: number; snippet: string; label?: string };
  beforeText: string;
  afterText: string;
  note: string;
  status: "pending" | "accepted" | "rejected" | "stale";
}

export async function listJobs(): Promise<JobDef[]> {
  const r = await apiGet<{ jobs: JobDef[] }>("/api/tasks/jobs");
  return r.jobs;
}

/** The one draft run collecting tasks for this thesis. Created on demand. */
export async function nextRun(thesisId: string): Promise<{ run: TaskRun; tasks: TaskItem[] }> {
  return apiGet(`/api/tasks/runs/next?thesisId=${encodeURIComponent(thesisId)}`);
}

export async function addTask(
  runId: string,
  input: { kind: string; params?: Record<string, string>; target?: TaskTarget; mode?: TaskMode },
): Promise<TaskItem> {
  const r = await apiPost<{ task: TaskItem }>(`/api/tasks/runs/${runId}/tasks`, input);
  return r.task;
}

export async function removeTask(taskId: string): Promise<void> {
  return apiDelete(`/api/tasks/tasks/${taskId}`);
}

/** `scheduledAt` is an ISO string built from the DEVICE's clock — see lib/task-schedule.ts. */
export async function scheduleRun(runId: string, scheduledAt: string, title?: string): Promise<TaskRun> {
  const r = await apiPost<{ run: TaskRun }>(`/api/tasks/runs/${runId}/schedule`, { scheduledAt, title });
  return r.run;
}

export async function runNow(runId: string): Promise<TaskRun> {
  const r = await apiPost<{ run: TaskRun }>(`/api/tasks/runs/${runId}/run-now`, {});
  return r.run;
}

export async function cancelRun(runId: string): Promise<TaskRun> {
  const r = await apiPost<{ run: TaskRun }>(`/api/tasks/runs/${runId}/cancel`, {});
  return r.run;
}

export async function listRuns(thesisId: string): Promise<TaskRun[]> {
  const r = await apiGet<{ runs: TaskRun[] }>(`/api/tasks/runs?thesisId=${encodeURIComponent(thesisId)}`);
  return r.runs;
}

export async function getRun(
  runId: string,
): Promise<{ run: TaskRun; tasks: TaskItem[]; proposals: TaskProposal[] }> {
  return apiGet(`/api/tasks/runs/${runId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewing proposals
// ─────────────────────────────────────────────────────────────────────────────

/** A proposal as the review flow needs it — with the run it came from. */
export interface PendingProposal {
  id: string;
  taskId: string;
  runId: string;
  anchor: { index: number; snippet: string; label?: string };
  beforeText: string;
  afterText: string;
  note: string;
  status: "pending";
}

/** Everything still waiting on this thesis, whichever run produced it. */
export async function listPendingProposals(thesisId: string): Promise<PendingProposal[]> {
  const r = await apiGet<{ proposals: PendingProposal[] }>(
    `/api/tasks/proposals?thesisId=${encodeURIComponent(thesisId)}`,
  );
  return r.proposals;
}

export async function decideProposal(
  proposalId: string,
  decision: "accept" | "reject" | "stale",
): Promise<void> {
  await apiPost(`/api/tasks/proposals/${proposalId}/${decision}`, {});
}

/**
 * Decide every still-pending proposal in a run, server-side. Returns how many
 * changed.
 *
 * Used for REJECT ALL. Accept-all deliberately does not go through here — see
 * tasks-store.approveAllPending: marking rows accepted without applying them
 * would drop them out of the pending list the Writer hydrates from, leaving the
 * student told "approved" over text that never changed.
 */
export async function decideAllProposals(
  runId: string,
  decision: "accept" | "reject",
): Promise<number> {
  const r = await apiPost<{ changed: number }>(`/api/tasks/runs/${runId}/proposals/${decision}`, {});
  return r.changed;
}

/** Restore the document to the checkpoint taken before this run started. */
export async function undoRun(runId: string): Promise<void> {
  await apiPost(`/api/tasks/runs/${runId}/undo`, {});
}
