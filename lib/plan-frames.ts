// The [[MODK_PLAN]] frame — a plan the assistant proposed, rendered as a card with
// an Execute button — and the [[MODK_PLAN_STEP]] frame that ticks its steps off
// while it runs (second half of this file). Mirrors
// ~/modakerati-server/src/lib/ai/plan-frames.ts.
//
// PERSISTED, unlike [[MODK_CONFIRM]]: the server saves it onto the message, so the
// card must survive reopening the conversation. That means parsing it in TWO
// places — the live stream pump AND stored message content. Same shape as
// lib/file-frames.ts, which solves the identical problem for [[MODK_FILE]].
export interface PlanStep { title: string; detail?: string }
export interface PlanPayload { id: string; title: string; steps: PlanStep[] }

export const PLAN_FRAME_OPEN = "[[MODK_PLAN]]";
const PLAN_FRAME_RE = /\[\[MODK_PLAN\]\]([\s\S]*?)\[\[\/MODK_PLAN\]\]/g;

/** Every plan in a message, oldest first. Malformed frames are skipped, never thrown. */
export function parsePlanFrames(text: string): PlanPayload[] {
  const out: PlanPayload[] = [];
  for (const m of text.matchAll(PLAN_FRAME_RE)) {
    try {
      const p = JSON.parse(m[1]) as PlanPayload;
      if (p && typeof p.id === "string" && Array.isArray(p.steps)) out.push(p);
    } catch {
      // A half-streamed frame is not a plan yet. Skip it.
    }
  }
  return out;
}

/** The message text with its plan frames removed — what the bubble should show. */
export function stripPlanFrames(text: string): string {
  return (
    text
      .replace(PLAN_FRAME_RE, "")
      // A frame that never got its closing marker — an aborted turn can persist
      // one — matches nothing above, and what is left is a wall of raw JSON at
      // the end of the answer. Everything from a dangling open marker onwards is
      // payload by definition, so it goes. Same guard as lib/file-frames.ts.
      .replace(/\[\[MODK_PLAN\]\][\s\S]*$/g, "")
      .trim()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The [[MODK_PLAN_STEP]] frame — one step of a RUNNING plan is done.
//
// The difference from [[MODK_PLAN]] above is the whole point: a plan frame ENDS
// the turn (it is an offer, and nothing happens until Execute is tapped), while
// a step frame arrives MID-TURN and the assistant carries straight on. Several
// go out over one execution, one per step finished, interleaved with the prose.
//
// PERSISTED, like the plan itself: a student who closes the chat and comes back
// tomorrow must still see which steps were done. So this too is parsed in TWO
// places — the live stream pump AND stored message content.
//
// ⚠️ The frames live in the EXECUTING message; the card lives in the message
// that PROPOSED the plan. Nothing here can join the two — that is the store's
// job (stores/chat-store.ts, `planSteps`), which folds every tick it can find in
// a thread into one planId-keyed record.
//
// Mirrors ~/modakerati-server/src/lib/ai/plan-frames.ts.
// ─────────────────────────────────────────────────────────────────────────────
export interface PlanStepProgress {
  /** Which plan was ticked. Minted server-side — never taken from the model. */
  planId: string;
  /** 0-based index into that plan's `steps`. */
  index: number;
  /** One short line in the student's language: what was actually done. */
  note?: string;
}

export const PLAN_STEP_FRAME_OPEN = "[[MODK_PLAN_STEP]]";
const PLAN_STEP_FRAME_RE = /\[\[MODK_PLAN_STEP\]\]([\s\S]*?)\[\[\/MODK_PLAN_STEP\]\]/g;

/** Every step tick in a message, oldest first. Malformed frames are skipped,
 *  never thrown — a half-streamed frame is not progress. */
export function parsePlanStepFrames(text: string): PlanStepProgress[] {
  const out: PlanStepProgress[] = [];
  for (const m of text.matchAll(PLAN_STEP_FRAME_RE)) {
    try {
      const p = JSON.parse(m[1]) as PlanStepProgress;
      // Same validation the server applies on the way out: a tick with no plan,
      // or an index that is not a real step number, ticks nothing.
      if (p && typeof p.planId === "string" && p.planId && Number.isInteger(p.index) && p.index >= 0) out.push(p);
    } catch {
      // A half-streamed or corrupted frame is not a tick. Skip it.
    }
  }
  return out;
}

/** The message text with its step frames removed — what the bubble should show. */
export function stripPlanStepFrames(text: string): string {
  return (
    text
      .replace(PLAN_STEP_FRAME_RE, "")
      // A frame that never got its closing marker — an aborted turn can persist
      // one, and mid-turn frames are far likelier to be cut off than the plan's
      // own closing word. Everything from a dangling open marker onwards is
      // payload by definition, so it goes. Same guard as stripPlanFrames.
      //
      // ⚠️ Safe to run alongside that one in either order: "[[MODK_PLAN]]" is
      // NOT a prefix of "[[MODK_PLAN_STEP]]" (the `]]` differs), so neither
      // regex can eat the other's frames.
      .replace(/\[\[MODK_PLAN_STEP\]\][\s\S]*$/g, "")
      .trim()
  );
}
