import type { RescuePhase, RescueProjectDTO } from "@/types/rescue-v2";

export type RescueScreen =
  | "start" | "parts" | "reading" | "rules_choice" | "notes" | "understood"
  | "diagnosis" | "preview" | "payment" | "rules" | "question" | "cover"
  | "repairing" | "result" | "changed" | "revisions" | "failure"
  | "timeline" | "version" | "compare" | "edit_rerun";

export type RescueOverlay = "changed" | "revisions" | "timeline" | "version" | "compare" | "edit_rerun";

export interface RescueNav {
  setupStep: "rules_choice" | "notes";
  diagnosisTab: "before" | "after";
  paying: boolean;
  overlay: RescueOverlay | null;
  versionId: string | null;
  compareWithId: string | null;
}
export const INITIAL_NAV: RescueNav = { setupStep: "rules_choice", diagnosisTab: "before", paying: false, overlay: null, versionId: null, compareWithId: null };

const RUNNING: ReadonlySet<RescuePhase> = new Set(["uploading", "proposing_order", "reading", "understanding", "diagnosing", "repairing"]);
export const isRunning = (phase: RescuePhase | undefined): boolean => !!phase && RUNNING.has(phase);
/** Also true on the quiet screens while something finishes behind them: a note, a guide, the cover samples, a payment under review. */
export function needsPolling(p: Pick<RescueProjectDTO, "phase" | "note" | "setup" | "cover" | "entitlement"> | null): boolean {
  if (!p) return false;
  return isRunning(p.phase)
    || p.note.state === "parsing"
    || p.setup.guide.state === "reading"
    || p.cover?.samples === "rendering"
    || p.entitlement.purchase.state === "pending_card"
    || p.entitlement.purchase.state === "pending_manual"
    || p.entitlement.purchase.state === "paid" && p.entitlement.kind === null;   // paid but not yet granted: 'confirming' must end by itself (P-62)
}

/** The way out of a step, as a nav patch; null means leave the route. The shell's BackPill and Android's back both use it. */
/**
 * `"ack"` (C8): `revisions` forced by `not_same_thesis` has no overlay to close, so back would do nothing for ever on both platforms.
 * The caller runs `ackVersion(failure.versionId)`, after which the phase falls to `done` (a previous version exists) and the screen to `result`.
 */
export function backFor(screen: RescueScreen, nav: RescueNav, project?: Pick<RescueProjectDTO, "phase" | "failure"> | null): Partial<RescueNav> | "ack" | null {
  switch (screen) {
    case "notes": return { setupStep: "rules_choice" };
    case "preview": return { diagnosisTab: "before" };
    case "payment": return { paying: false };
    case "changed": return { overlay: nav.versionId ? "version" : null };
    case "revisions": return project?.phase === "failed" && project.failure?.code === "not_same_thesis" ? "ack" : { overlay: null };
    case "timeline": return { overlay: null };
    case "version": case "edit_rerun": return { overlay: "timeline" };
    case "compare": return { overlay: "version" };
    default: return null;
  }
}

export function screenFor(project: Pick<RescueProjectDTO, "phase" | "failure"> | null, nav: RescueNav): RescueScreen {
  if (!project) return "start";
  switch (project.phase) {
    case "uploading": return nav.overlay === "revisions" ? "revisions" : "reading";
    case "proposing_order": case "await_part_order": return "parts";
    case "reading": return "reading";
    case "await_setup": return nav.setupStep;
    case "understanding": case "diagnosing": return "understood";
    case "diagnosed": return nav.paying ? "payment" : nav.diagnosisTab === "after" ? "preview" : "diagnosis";
    case "confirm_rules": return "rules";
    case "confirm_questions": return "question";
    case "confirm_cover": return "cover";
    case "repairing": return "repairing";
    case "failed": return project.failure?.code === "not_same_thesis" ? "revisions" : "failure";
    case "done": return nav.overlay ?? "result";
  }
}

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

/**
 * Whether the thesis reads right to left. The server now sends the language it detected from the file, so that decides once it is set. While
 * it is null (nothing detected yet), the title's own script is the only evidence: Arabic script is RTL, anything else is LTR. A missing title
 * (null, or empty) counts as no evidence.
 */
export function thesisIsRtl(project: Pick<RescueProjectDTO, "title" | "language"> | null): boolean {
  if (!project) return false;
  if (project.language === "ar") return true;
  if (project.language === "fr" || project.language === "en") return false;
  return ARABIC_SCRIPT.test(project.title ?? "");
}

/**
 * Whether a page slot should hold a page at all. `count` is null while the page list is not loaded: every page is then in range, so the
 * slot shows a skeleton. Once loaded, a version with zero pages has no slot with a page, so nothing is ever skeleton-shaped for ever.
 */
export function pageIsInRange(page: number, count: number | null): boolean {
  return page >= 1 && (count === null || page <= count);
}
