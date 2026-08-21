// The [[MODK_PLAN]] frame — a plan the assistant proposed, rendered as a card with
// an Execute button. Mirrors ~/modakerati-server/src/lib/ai/plan-frames.ts.
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
