// Did the assistant's last turn already DO something?
//
// The client-side half of the server's `assessTurnWork`
// (~/kwill-server/src/lib/ai/continue-turn.ts), and deliberately WEAKER
// than it. A turn that stopped mid-job — eight of twelve plan steps applied, the
// socket gone — must be CONTINUED, never restarted: restarting deletes the plan
// card with its ticks and re-applies edits that are already in the student's
// .docx. The server refuses such a regenerate with 409 `continue_instead`, and
// that refusal is the guarantee. This file exists only so the button can say the
// right word BEFORE the round trip, and so the transcript is not torn down and
// put back for a regenerate the server was always going to refuse.
//
// ⚠️ WHAT THIS CANNOT SEE. The server counts the .docx versions the turn wrote;
// the app has no such record. `[[MODK_DOCCHANGES]]` is stripped before the
// message is persisted, so once the app has been reloaded, a turn that silently
// rewrote four chapters looks exactly like a turn that said nothing. So a false
// from here is NOT a promise the turn was idle — it means "the app cannot tell",
// and the 409 is what catches the rest.
//
// What DOES survive on this side is the plan tick: the server persists
// [[MODK_PLAN_STEP]] onto the executing message, so a reopened conversation can
// still prove the run started.

import { parsePlanFrames, parsePlanStepFrames, type PlanPayload, type PlanStepProgress } from "./plan-frames";

/** The shape this needs of a loaded message, and nothing more — so the decision
 *  can be exercised without a store, a screen or a network. */
export interface TurnWorkMessage {
  role: string;
  content: string;
  /** Plans attached live by the stream pump (the frame never reached `content`). */
  plans?: PlanPayload[];
}

export interface TurnWorkSignals {
  /**
   * This session watched the turn edit the document ([[MODK_DOCCHANGES]] on the
   * live stream). In-memory only — it does not survive a reload, which is the
   * whole reason the 409 exists.
   */
  docChanged?: boolean;
}

/**
 * Can the app SEE that the last assistant turn did work a regenerate would redo?
 *
 * The window is everything after the student's last message — one uninterrupted
 * stretch of assistant work, however many turns it ran under (executing a plan
 * adds no user message). Same window the server draws.
 *
 * Two visible signals, mirroring the server's two:
 *
 *   • a PLAN THAT STARTED. Either a [[MODK_PLAN_STEP]] frame persisted on a
 *     message in the window (the reload route), or a plan card in the window
 *     whose id has ticks in the store's planId-keyed record (the live route,
 *     where the pump ate the frame before it ever reached `content`).
 *     ⚠️ A plan card ALONE is not work — a proposal the student disliked is a
 *     draft they are rejecting, and Regenerate is how they say so. The server
 *     regenerates that case happily; so must this.
 *   • the DOCUMENT MOVED, from `docChanged` above.
 *
 * Returns false when the thread holds no assistant message at all: there is
 * nothing for POST /api/chat/continue-turn to carry on from, and it answers 400.
 */
export function lastTurnDidWork(
  messages: TurnWorkMessage[],
  planSteps: Record<string, PlanStepProgress[]>,
  signals?: TurnWorkSignals,
): boolean {
  const list = messages ?? [];
  if (!list.some((m) => m?.role === "assistant")) return false;
  if (signals?.docChanged) return true;

  let from = list.length - 1;
  while (from >= 0 && list[from]?.role !== "user") from--;

  for (let i = from + 1; i < list.length; i++) {
    const m = list[i];
    if (m?.role !== "assistant") continue;
    const content = m.content ?? "";
    // The reload route: the tick is right there in the stored text.
    if (parsePlanStepFrames(content).length > 0) return true;
    // The live route: the card is on this message, the ticks are in the store.
    const plans = m.plans?.length ? m.plans : parsePlanFrames(content);
    for (const p of plans) {
      if ((planSteps?.[p.id]?.length ?? 0) > 0) return true;
    }
  }
  return false;
}

/**
 * The server refused a regenerate because the turn it would have replaced is
 * half-finished, and wants a continuation instead.
 *
 * Shape is `409 { code: "continue_instead", action: "continue", reason }` — see
 * the /send and /stream routes. `code` is what is matched: `status` alone would
 * also catch any other conflict those endpoints might ever answer with.
 */
export function isContinueInstead(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "continue_instead";
}
