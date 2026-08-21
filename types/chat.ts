import type { PlanPayload } from "@/lib/plan-frames";

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  chapterId?: string;
  sectionId?: string;
  createdAt: string;
  // Optimistic message created on-device, not yet reconciled with the server.
  // Dropped and replaced by the authoritative server copy on the next sync.
  pending?: boolean;
  // The turn this message asked for never completed (network gone, provider
  // error, stream died). Set on the USER row, because that is what the student
  // is looking at when they decide whether to type it again — and typing it
  // again is exactly what a send that LOOKS delivered provokes. Rendered as a
  // failed bubble with Retry; cleared when a retry succeeds.
  failed?: boolean;
  // Reasoning ("thinking") tokens from a reasoning model, shown in a collapsible
  // section. Ephemeral — streamed live, not persisted server-side.
  thinking?: string;
  // When reasoning started / ended (ISO). Drives the "Thought for Xs" chip; set
  // by the chat-store as tokens stream (start) and by ai-service at the first
  // answer token / turn end (end).
  thinkingStartedAt?: string;
  thinkingEndedAt?: string;
  // Downloadable artifacts (e.g. a DOCX/LaTeX export) attached to this message,
  // rendered as file cards. Carried live via the stream's [[MODK_FILE]] frame;
  // on history reload they're re-parsed from the frame embedded in `content`.
  files?: FilePayload[];
  // Images the STUDENT attached to this message. Set optimistically at send time
  // (pointing at the local file, so the thumbnail is there before the upload
  // finishes); once the server row syncs back they are re-parsed from the
  // [[MODK_IMG]] frames in `content` and point at the stored URL instead.
  images?: ChatImage[];
  // Plans the assistant proposed on this turn (Plan mode), rendered as cards with
  // an Execute button. Carried live via the stream's [[MODK_PLAN]] frame, which
  // the pump CONSUMES — so a live message's `content` never holds it. The server
  // persists the frame onto the stored message, so a reload re-parses it from
  // `content` instead (parsePlanFrames). Both routes are real; see MessageBubble.
  plans?: PlanPayload[];
}

// One image on a user message. Exactly one of `url` / `uri` is meaningful at a
// time: `uri` while the send is still optimistic, `url` once it's stored.
export interface ChatImage {
  kind: "image";
  /** Public URL of the stored object — present on anything the server has seen. */
  url?: string;
  /** Local file, used for the thumbnail before the upload lands and on retry. */
  uri?: string;
  mime: string;
  width?: number;
  height?: number;
}

// A downloadable file produced by the assistant (e.g. a thesis export). Sent by
// the server inside a [[MODK_FILE]]…[[/MODK_FILE]] frame; the app renders it as a
// tappable file card. Preview happens IN-APP only — the url is never opened
// externally.
export interface FilePayload {
  kind: "file";
  url: string;
  filename: string;
  title?: string;
  /** "docx" | "latex" — drives the file icon. */
  format: string;
  bytes: number;
  /** Human-readable size, e.g. "9.3 KB". */
  size: string;
  /** Estimated page count. */
  pages?: number;
}

// Payload the model sends (via the ask_user tool) to open a question bottom sheet.
/** One visual choice on the ask sheet — a preview card instead of a text chip.
 *  Mirrors the server's AskPreview (lib/ai/tool-loop.ts). */
export interface AskPreview {
  id: string;
  label: string;
  description?: string;
  /** Server-relative API path returning the preview SVG; fetched with the
   *  app's own auth (see fetchOrnamentPreview). Serves SVG source for a vector
   *  ornament and image bytes for uploaded artwork. */
  previewUrl: string;
}

export interface AskPayload {
  question: string;
  options: string[];
  allowFreeText: boolean;
  /** When present the sheet renders a visual picker (AskPreviewGrid) instead of
   *  text chips. Older servers simply never send it. */
  previews?: AskPreview[];
}

// A destructive tool the model requested; parked server-side until the student
// approves. Sent inside a [[MODK_CONFIRM]] frame; rendered as Approve/Cancel
// chips. Approval calls /api/chat/confirm-action — NOT a chat message.
export interface ConfirmPayload {
  kind: "confirmAction";
  actionId: string;
  toolName: string;
  preview: {
    kind: string; // tool name — maps to a localized template
    data: Record<string, unknown>;
    text: string; // server-built English fallback
  };
}

// End-of-turn frame: this AI turn changed the .docx. checkpointSeq is the
// history snapshot to restore for one-tap "Undo AI changes".
export interface DocChangesPayload {
  kind: "docChanges";
  turnId: string;
  checkpointSeq: number;
  tools: string[];
}

// DEVELOPER TRACE. One frame as a tool starts and another when it finishes, so a
// turn's tool work is visible while it runs. Sent only when the server has
// AI_SHOW_TOOLS on outside production — a student's build never receives these,
// which is why nothing here is translated or persisted.
export interface ToolTracePayload {
  kind: "tool";
  /** Stable across the running → done pair, so the row updates in place. */
  id: string;
  name: string;
  state: "running" | "done" | "error";
  /** Short argument summary, e.g. `index: 41, text: "…"`. */
  detail?: string;
  /** Wall time of the call, on the terminal frame only. */
  ms?: number;
}
