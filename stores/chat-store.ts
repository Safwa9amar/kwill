import { create } from "zustand";
import type { ChatMessage, AskPayload, ChatImage, FilePayload, ConfirmPayload, DocChangesPayload, ToolTracePayload } from "@/types/chat";
import type { PlanPayload } from "@/lib/plan-frames";

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

// The generating state, wound all the way down. Stop and a turn's own teardown
// both land here so a cancelled turn can't leave a half-idle chat behind.
const IDLE_TURN = {
  isGenerating: false,
  generatingPhase: "idle" as const,
  generatingStep: 0,
  retryAttempt: 0,
  streamingId: null,
  abortController: null,
  activeTurnId: null,
  activeThreadId: null,
  turnStartedAt: null,
  lastEventAt: null,
  toolTrace: [] as ToolTracePayload[],
};

// Stable empty trace — a fresh `[]` from a selector would re-render forever.
const EMPTY_TOOL_TRACE: ToolTracePayload[] = [];

// Same reason: the "already run" list starts as ONE array, shared by every
// selector until a plan actually finishes.
const NO_PLANS_DONE: string[] = [];

// Stamp the end of reasoning on `id` wherever it lives. Stop is a global control
// with no thread in hand, so the bubble is found by id across the loaded
// windows; one whose clock never started or already stopped is left alone.
function stampThinkingEnded(
  messages: Record<string, ChatMessage[]>,
  id: string,
): Record<string, ChatMessage[]> {
  for (const [threadId, list] of Object.entries(messages)) {
    const target = list.find((m) => m.id === id);
    if (!target) continue;
    if (!target.thinkingStartedAt || target.thinkingEndedAt) return messages;
    return {
      ...messages,
      [threadId]: list.map((m) => (m.id === id ? { ...m, thinkingEndedAt: new Date().toISOString() } : m)),
    };
  }
  return messages;
}

// Stable reference for the "no messages yet" case. Returning a fresh `[]` from
// the selector makes zustand's useSyncExternalStore see a new snapshot every
// render, causing an infinite render loop ("Maximum update depth exceeded").
const EMPTY_MESSAGES: ChatMessage[] = [];

// How recently an identical message must have been added for `addMessage` to
// treat a repeat as the same send rather than a new one. Long enough to cover a
// student re-tapping send on a turn that appears frozen; short enough that
// deliberately asking the same question again later still gets its own bubble.
const DUPLICATE_WINDOW_MS = 60_000;

// Phase of the AI turn, surfaced in the chat UI as a typing indicator.
//  - "thinking": request sent, no tokens received yet
//  - "writing":  tokens are streaming into the assistant bubble
//  - "idle":     no generation in progress
export type GeneratingPhase = "idle" | "thinking" | "writing";

interface ChatState {
  messages: Record<string, ChatMessage[]>; // keyed by threadId — the loaded window, oldest→newest
  // Infinite scroll: whether earlier messages exist before the loaded window, and
  // whether an older page is currently being fetched. Both keyed by threadId.
  hasMoreOlder: Record<string, boolean>;
  loadingOlder: Record<string, boolean>;
  isGenerating: boolean;
  generatingStep: number;
  generatingPhase: GeneratingPhase;
  // Which try of the current turn is running, once it is past the first. 0 means
  // "the first attempt" — i.e. nothing has failed yet. A turn that dies for a
  // reason that passes (the provider at capacity, a dropped socket) is repeated
  // by ai-service without asking; this is how the student is told that is what
  // the wait is, rather than being shown an error and a button. See lib/retry.ts.
  retryAttempt: number;
  // Wall clock of the CURRENT turn (epoch ms), and the last moment anything
  // streamed in (reasoning, answer text or a file). A long agentic turn spends
  // most of its time running tools, where neither arrives — the gap between
  // `lastEventAt` and now is what tells the UI the AI is busy but silent, so it
  // can say so instead of looking hung. Both null while idle.
  turnStartedAt: number | null;
  lastEventAt: number | null;
  streamingId: string | null; // id of the assistant message currently streaming
  abortController: AbortController | null; // aborts the in-flight AI turn when the user taps Stop
  // Id of the turn that OWNS the generating state above. Stop clears it, which
  // instantly disowns the in-flight request: its callbacks stop writing and its
  // teardown can no longer touch a turn the user has since started. Without this
  // the UI could only leave "generating" when the network call itself unwound —
  // and a transport that ignores the abort left the composer locked forever.
  activeTurnId: string | null;
  // WHICH conversation the turn above belongs to. Stop is a global control with no
  // thread in hand (three different screens press it, and one of them — the block
  // editor — resolves its thread inside the send), and the server's stop endpoint
  // is scoped to a thread. So the turn records its own. Cleared with the rest of
  // the turn state.
  activeThreadId: string | null;
  // The thread whose interrupted turn is being recovered from the server right
  // now — see ai-service's foreground resume. Deliberately OUTSIDE the turn state
  // above: there is no turn running, the app is only catching up with one that
  // finished while it was in the background. The chat screen reads it to keep the
  // "this went unanswered" retry chip off a question that is about to be answered.
  recoveringThreadId: string | null;
  pendingAsk: AskPayload | null; // active model question → drives the AskBottomSheet
  pendingConfirm: ConfirmPayload | null; // parked destructive action → Approve/Cancel chips
  // Tools the CURRENT turn has run, oldest→newest. Populated only when the server
  // is a developer one (AI_SHOW_TOOLS); empty in every student build, which is why
  // the UI reading it renders nothing at all rather than a translated fallback.
  toolTrace: ToolTracePayload[];
  // The plan currently EXECUTING, by id, or null. A primitive on purpose: it is
  // read by every plan card on screen to decide whether its Execute button is
  // live, and the whole point of it is to refuse a second run — running a plan
  // twice applies every edit in it twice.
  runningPlanId: string | null;
  // Plans whose run has finished. Their cards stay as the record of what was
  // done, with Execute retired rather than offered again. In memory only: the
  // frame the card is rebuilt from on a reload carries no "already run" bit, so
  // this lasts the session, which is as long as the temptation does.
  donePlanIds: string[];
  // Last AI turn's doc changes per thesis → drives the "Undo AI changes" chip.
  // Deliberately keyed by thesisId, not threadId: the checkpoint belongs to
  // the DOCUMENT, and two threads editing the same thesis must share it. Do not
  // "fix" this to match the rest of the store.
  docChanges: Record<string, DocChangesPayload | null>;

  getMessages: (threadId: string) => ChatMessage[];
  setMessages: (threadId: string, messages: ChatMessage[]) => void;
  // Insert an older page at the FRONT of the loaded window (deduped by id).
  prependMessages: (threadId: string, older: ChatMessage[]) => void;
  getHasMoreOlder: (threadId: string) => boolean;
  setHasMoreOlder: (threadId: string, value: boolean) => void;
  getLoadingOlder: (threadId: string) => boolean;
  setLoadingOlder: (threadId: string, value: boolean) => void;
  addMessage: (threadId: string, role: "user" | "assistant", content: string, opts?: { chapterId?: string; pending?: boolean; images?: ChatImage[] }) => string;
  /** Remove a message from the loaded window. For an assistant bubble whose
   *  attempt is being retried — see ai-service's discardAttempt. */
  dropMessage: (threadId: string, id: string) => void;
  /** Mark (or clear) a message as a send whose turn never completed. */
  setMessageFailed: (threadId: string, id: string, failed: boolean) => void;
  /** The most recent user message, for the failed-send retry. */
  getLastUserMessage: (threadId: string) => ChatMessage | undefined;
  appendToMessage: (threadId: string, id: string, chunk: string) => void;
  appendToThinking: (threadId: string, id: string, chunk: string) => void;
  markThinkingEnded: (threadId: string, id: string) => void;
  addFileToMessage: (threadId: string, id: string, file: FilePayload) => void;
  /** Attach a plan the LIVE stream produced. The pump consumes the frame, so it
   *  is never in `content` for a streaming message — a reload re-parses it from
   *  there instead (see lib/plan-frames). Deduped by plan id. */
  addPlanToMessage: (threadId: string, id: string, plan: PlanPayload) => void;
  /** Claim the single execute slot. Returns false when a plan is already running
   *  — the caller must NOT start a second one. */
  beginPlanRun: (planId: string) => boolean;
  /** Release the slot. `done: true` also retires the card's Execute button. */
  endPlanRun: (planId: string, done: boolean) => void;
  setGenerating: (generating: boolean) => void;
  // Turn ownership. `beginTurn` claims the generating state and returns the
  // token the caller must carry; `isTurnActive` gates every write the turn makes;
  // `endTurn` releases it — and does nothing if the turn no longer owns it.
  // The threadId is recorded so Stop can name the conversation to the server.
  beginTurn: (threadId: string) => string;
  isTurnActive: (turnId: string) => boolean;
  endTurn: (turnId: string) => void;
  setGeneratingStep: (step: number) => void;
  setGeneratingPhase: (phase: GeneratingPhase) => void;
  /** Which try of the current turn is now running (0 = the first). */
  setRetryAttempt: (attempt: number) => void;
  /** Mark (or clear) the thread being caught up with after a backgrounded turn. */
  setRecoveringThread: (threadId: string | null) => void;
  setStreamingId: (id: string | null) => void;
  setAbortController: (controller: AbortController | null) => void;
  setPendingAsk: (ask: AskPayload | null) => void;
  setPendingConfirm: (confirm: ConfirmPayload | null) => void;
  /** Record a tool frame: a "running" row is appended, its terminal frame updates
   *  that same row in place (matched on id). */
  pushToolTrace: (tool: ToolTracePayload) => void;
  /** thesisId, not threadId — see the `docChanges` field comment. */
  setDocChanges: (thesisId: string, changes: DocChangesPayload | null) => void;
  stopGenerating: () => void;
  clearMessages: (threadId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  hasMoreOlder: {},
  loadingOlder: {},
  isGenerating: false,
  generatingStep: 0,
  generatingPhase: "idle",
  retryAttempt: 0,
  turnStartedAt: null,
  lastEventAt: null,
  streamingId: null,
  abortController: null,
  activeTurnId: null,
  activeThreadId: null,
  recoveringThreadId: null,
  pendingAsk: null,
  pendingConfirm: null,
  toolTrace: EMPTY_TOOL_TRACE,
  runningPlanId: null,
  donePlanIds: NO_PLANS_DONE,
  docChanges: {},

  getMessages: (threadId) => get().messages[threadId] ?? EMPTY_MESSAGES,

  setMessages: (threadId, messages) =>
    set((s) => ({ messages: { ...s.messages, [threadId]: messages } })),

  // Prepend an older page, skipping any ids already loaded. `older` is
  // chronological and strictly older than the current window, so front-concat
  // keeps the whole list ordered oldest→newest.
  prependMessages: (threadId, older) =>
    set((s) => {
      const existing = s.messages[threadId] ?? [];
      const have = new Set(existing.map((m) => m.id));
      const fresh = older.filter((m) => !have.has(m.id));
      if (fresh.length === 0) return s;
      return { messages: { ...s.messages, [threadId]: [...fresh, ...existing] } };
    }),

  getHasMoreOlder: (threadId) => get().hasMoreOlder[threadId] ?? false,
  setHasMoreOlder: (threadId, value) =>
    set((s) => (s.hasMoreOlder[threadId] === value ? s : { hasMoreOlder: { ...s.hasMoreOlder, [threadId]: value } })),
  getLoadingOlder: (threadId) => get().loadingOlder[threadId] ?? false,
  setLoadingOlder: (threadId, value) =>
    set((s) => (s.loadingOlder[threadId] === value ? s : { loadingOlder: { ...s.loadingOlder, [threadId]: value } })),

  addMessage: (threadId, role, content, opts) => {
    // Re-sending the same question must not stack up another bubble.
    //
    // A student whose turn dies silently types the same thing again — three
    // times, in the case this guard was written for — and every send appended a
    // fresh row with a fresh local id. Nothing deduped, and `persistCache`
    // wrote them all to SQLite, so they came back after a restart too.
    //
    // Guarded HERE rather than at the call sites because there are eight of
    // them, and the next one added would forget. Empty content is exempt:
    // streaming assistant bubbles all start as "" and must stay distinct.
    // Attached images are exempt: sending the same photo again with the same
    // caption ("and this one?") is a deliberate second message, not the
    // frozen-turn double-tap this guard exists for.
    const existing = get().messages[threadId] ?? [];
    if (content && !opts?.images?.length) {
      const last = existing[existing.length - 1];
      if (last && last.role === role && last.content === content && !last.images?.length) {
        const age = Date.now() - Date.parse(last.createdAt);
        if (Number.isFinite(age) && age >= 0 && age < DUPLICATE_WINDOW_MS) return last.id;
      }
    }
    const id = generateId();
    set((s) => ({
      messages: {
        ...s.messages,
        [threadId]: [
          ...(s.messages[threadId] ?? []),
          { id, threadId, role, content, chapterId: opts?.chapterId, pending: opts?.pending, images: opts?.images, createdAt: new Date().toISOString() },
        ],
      },
    }));
    return id;
  },

  // Drop a row from the loaded window. Only ever used on an assistant bubble the
  // turn is about to replace: a retried attempt must not append its answer under
  // the abandoned one's reasoning trace. Nothing is persisted here — the cache
  // write happens once, at the end of the turn (persistCache).
  dropMessage: (threadId, id) =>
    set((s) => {
      const list = s.messages[threadId];
      if (!list) return s;
      const next = list.filter((m) => m.id !== id);
      if (next.length === list.length) return s;
      return {
        messages: { ...s.messages, [threadId]: next },
        // A bubble that no longer exists must not stay the streaming target.
        streamingId: s.streamingId === id ? null : s.streamingId,
      };
    }),

  setMessageFailed: (threadId, id, failed) =>
    set((s) => {
      const list = s.messages[threadId];
      if (!list) return s;
      return {
        messages: {
          ...s.messages,
          // New object for the target so the memoized bubble re-renders into
          // (or out of) its failed state.
          [threadId]: list.map((m) => (m.id === id ? { ...m, failed } : m)),
        },
      };
    }),

  getLastUserMessage: (threadId) => {
    const list = get().messages[threadId] ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].role === "user") return list[i];
    return undefined;
  },

  appendToMessage: (threadId, id, chunk) =>
    set((s) => {
      const list = s.messages[threadId];
      if (!list) return s;
      return {
        lastEventAt: Date.now(),
        messages: {
          ...s.messages,
          // New object for the target message so memoized bubbles re-render.
          [threadId]: list.map((m) => (m.id === id ? { ...m, content: m.content + chunk } : m)),
        },
      };
    }),

  appendToThinking: (threadId, id, chunk) =>
    set((s) => {
      const list = s.messages[threadId];
      if (!list) return s;
      return {
        lastEventAt: Date.now(),
        messages: {
          ...s.messages,
          [threadId]: list.map((m) =>
            m.id === id
              ? {
                  ...m,
                  thinking: (m.thinking ?? "") + chunk,
                  // First reasoning token → start the clock (idempotent).
                  thinkingStartedAt: m.thinkingStartedAt ?? new Date().toISOString(),
                }
              : m,
          ),
        },
      };
    }),

  addFileToMessage: (threadId, id, file) =>
    set((s) => {
      const list = s.messages[threadId];
      if (!list) return s;
      return {
        lastEventAt: Date.now(),
        messages: {
          ...s.messages,
          [threadId]: list.map((m) => {
            if (m.id !== id) return m;
            // Dedupe by url so a re-export / replayed frame doesn't double the card.
            if (m.files?.some((f) => f.url === file.url)) return m;
            return { ...m, files: [...(m.files ?? []), file] };
          }),
        },
      };
    }),

  addPlanToMessage: (threadId, id, plan) =>
    set((s) => {
      const list = s.messages[threadId];
      if (!list) return s;
      return {
        lastEventAt: Date.now(),
        messages: {
          ...s.messages,
          [threadId]: list.map((m) => {
            if (m.id !== id) return m;
            // Deduped by id so a replayed frame doesn't stack two identical cards
            // — each with its own Execute button for the same work.
            if (m.plans?.some((p) => p.id === plan.id)) return m;
            return { ...m, plans: [...(m.plans ?? []), plan] };
          }),
        },
      };
    }),

  // One plan at a time, for the whole app. The check and the claim happen in the
  // same tick — a card that asks twice (a double tap, or two cards showing the
  // same plan) gets false the second time and must stop there.
  beginPlanRun: (planId) => {
    if (get().runningPlanId) return false;
    set({ runningPlanId: planId });
    return true;
  },

  endPlanRun: (planId, done) =>
    set((s) => ({
      // Only if this run still owns the slot: a stale unwind must not release a
      // run that has since started.
      runningPlanId: s.runningPlanId === planId ? null : s.runningPlanId,
      donePlanIds: done && !s.donePlanIds.includes(planId) ? [...s.donePlanIds, planId] : s.donePlanIds,
    })),

  // Starting a turn arms the wall clock the "still working" note counts from,
  // and seeds `lastEventAt` so the quiet gap is measured from the send, not from
  // 1970. Ending it disarms both so a finished turn can never look busy.
  // Prefer beginTurn/endTurn for anything that runs an AI turn — they carry the
  // ownership token Stop needs; this raw setter leaves the turn unstoppable.
  setGenerating: (generating) =>
    set(
      generating
        ? { isGenerating: true, turnStartedAt: Date.now(), lastEventAt: Date.now() }
        : { isGenerating: false, turnStartedAt: null, lastEventAt: null },
    ),

  // Claim the chat for a new turn and hand back the token that proves ownership.
  // Any turn already running is disowned on the spot: it keeps unwinding in the
  // background but can no longer write to the chat or end this one.
  beginTurn: (threadId) => {
    // A turn still in flight (the user sent again before the last one unwound)
    // is hung up on here, so two streams can never write to the same chat.
    try {
      get().abortController?.abort();
    } catch {
      // Best effort — the ownership swap below is what actually disowns it.
    }
    const turnId = generateId();
    // A thread that starts a real turn is no longer waiting to be caught up with
    // after a backgrounded one — this turn's own ending is what refreshes it now.
    const recoveringThreadId = get().recoveringThreadId;
    set({
      activeTurnId: turnId,
      activeThreadId: threadId,
      recoveringThreadId: recoveringThreadId === threadId ? null : recoveringThreadId,
      abortController: null,
      isGenerating: true,
      generatingPhase: "thinking",
      generatingStep: 0,
      retryAttempt: 0, // a new turn starts on its first try, whatever the last one spent
      streamingId: null,
      turnStartedAt: Date.now(),
      lastEventAt: Date.now(),
      toolTrace: EMPTY_TOOL_TRACE, // last turn's tools are not this turn's story
    });
    return turnId;
  },

  isTurnActive: (turnId) => get().activeTurnId === turnId,

  // Release the generating state — but only if this turn still holds it. A turn
  // the user stopped (or superseded) must not idle a chat that has since moved on.
  endTurn: (turnId) =>
    set((s) => (s.activeTurnId === turnId ? IDLE_TURN : s)),

  setGeneratingStep: (step) => set({ generatingStep: step }),
  setGeneratingPhase: (phase) => set({ generatingPhase: phase }),
  setRetryAttempt: (attempt) =>
    set((s) => (s.retryAttempt === attempt ? s : { retryAttempt: attempt })),
  setRecoveringThread: (threadId) =>
    set((s) => (s.recoveringThreadId === threadId ? s : { recoveringThreadId: threadId })),
  setStreamingId: (id) => set({ streamingId: id }),
  setAbortController: (controller) => set({ abortController: controller }),
  setPendingAsk: (ask) => set({ pendingAsk: ask }),
  setPendingConfirm: (confirm) => set({ pendingConfirm: confirm }),
  pushToolTrace: (tool) =>
    set((s) => {
      const at = s.toolTrace.findIndex((t) => t.id === tool.id);
      // A tool finishing is also a sign of life: it keeps the "still working"
      // note from reading as a hang through a long stretch of tool calls.
      const lastEventAt = Date.now();
      if (at === -1) return { toolTrace: [...s.toolTrace, tool], lastEventAt };
      const next = s.toolTrace.slice();
      next[at] = { ...next[at], ...tool };
      return { toolTrace: next, lastEventAt };
    }),
  // thesisId, not threadId — see the `docChanges` field comment above.
  setDocChanges: (thesisId, changes) =>
    set((s) => ({ docChanges: { ...s.docChanges, [thesisId]: changes } })),
  // Stamp when reasoning ended. Idempotent: only stamps if thinking actually
  // started and the end isn't already set. Called at the first answer token and
  // again in ai-service's finally (covers tool-only turns and aborts).
  markThinkingEnded: (threadId, id) =>
    set((s) => {
      const list = s.messages[threadId];
      if (!list) return s;
      let changed = false;
      const next = list.map((m) => {
        if (m.id !== id || !m.thinkingStartedAt || m.thinkingEndedAt) return m;
        changed = true;
        return { ...m, thinkingEndedAt: new Date().toISOString() };
      });
      return changed ? { messages: { ...s.messages, [threadId]: next } } : s;
    }),
  // Cancel the in-flight AI turn — the LOCAL half of Stop. Nothing here reaches the
  // server: hanging up the socket is no longer read as a cancellation there (that
  // is what made a backgrounded turn a lost turn), so the server has to be TOLD.
  // ⚠️ The UI calls ai-service's `stopTurn()`, not this — it fires both halves.
  // On its own this leaves the turn running server-side.
  //
  // Stop is the user's escape hatch, so it must be
  // unconditional: the chat goes idle HERE, in the same tick as the tap, and the
  // abort below is only a best-effort request to the transport to hang up. The
  // old shape — abort and wait for the reader to reject — meant that any stream
  // that swallowed the abort (a stalled socket, a native layer that never errors
  // the body) left the composer disabled and the Stop button stuck on screen with
  // nothing left to press. Whatever streamed so far stays in the bubble.
  stopGenerating: () => {
    const { abortController, streamingId, isGenerating } = get();
    if (!isGenerating) return;
    try {
      abortController?.abort();
    } catch {
      // An abort that throws must not keep the UI generating — fall through.
    }
    set((s) => ({
      ...IDLE_TURN,
      // Stop must leave NOTHING latched. A plan run whose transport never honours
      // the abort (expo/fetch can hang reader.read()) would otherwise hold the
      // single execute slot for the rest of the session and kill every Execute
      // button on screen. Retired rather than merely released: the server may
      // already have applied part of the plan, so offering to run it again is the
      // one thing this must not do.
      runningPlanId: null,
      donePlanIds:
        s.runningPlanId && !s.donePlanIds.includes(s.runningPlanId)
          ? [...s.donePlanIds, s.runningPlanId]
          : s.donePlanIds,
      // The turn is over: stop the reasoning clock on the bubble it was writing.
      messages: streamingId ? stampThinkingEnded(s.messages, streamingId) : s.messages,
    }));
  },
  clearMessages: (threadId) =>
    set((s) => {
      const msgs = { ...s.messages };
      delete msgs[threadId];
      return { messages: msgs };
    }),
}));
