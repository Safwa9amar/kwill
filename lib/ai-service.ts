import { AppState } from "react-native";
import { useChatStore } from "@/stores/chat-store";
import { useChatThreadsStore } from "@/stores/chat-threads-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useOutlineStore } from "@/stores/outline-store";
import { useThesisStore } from "@/stores/thesis-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { chatSend, chatSendStream, chatConfirmAction, chatCancelAction, chatExecutePlan, chatStopTurn, getChatHistory, getChatHistoryPage, listThreads, type ChatStreamHandlers } from "./api";
import { getLatestMessages, getOlderMessages, upsertMessages, deletePending, deleteStalePending, getLastSyncedAt, setLastSyncedAt } from "./chat-cache";
import { IMG_FRAME_OPEN, splitImageFrames, restageImage, toAttachment, toChatImage, type StagedImage } from "./chat-images";
import i18n from "./i18n";
import { backoffMs, backoffSleep, isTransientFailure, MAX_TURN_ATTEMPTS } from "./retry";
import { userFacingError } from "./safe-error";
import { useBillingStore } from "@/stores/billing-store";
import { isQuotaError } from "@/types/billing";
import type { ChatMessage } from "@/types/chat";
import type { ChatMode } from "./chat-modes";

// The first view shows only the most recent few messages; scrolling to the top
// pages in older history a larger batch at a time.
const INITIAL_PAGE_SIZE = 5;
const OLDER_PAGE_SIZE = 20;

// ============================================================
// Leaving the app must not lose the turn
// ============================================================
//
// A student sends a message and switches away — to look something up, to answer
// a call, because the screen locked. The OS tears the socket down, the stream
// read fails, and every symptom the student ever saw came from what the app did
// NEXT: it read a dead socket as a transient failure, spent all four attempts on
// it (each one dying the same way, because the app was still in the background),
// and left them looking at "that didn't get through" with a Retry button.
//
// Nothing about that was ever true. The server no longer treats a disconnect as a
// cancellation: it runs the turn to completion, saves the assistant message,
// applies the .docx edits and writes the history. So by the time the student is
// back, the answer EXISTS — it just isn't on this device yet.
//
// That flips the right behaviour completely. Re-sending is no longer the harmless
// repeat of work that never happened; it is a SECOND turn, with a second answer
// and a second set of edits to the thesis. So the app stops attempting, and the
// return to the foreground fetches the finished answer instead (see
// `resumeInterruptedTurns`). No attempt is spent, no error note is written, and
// the question is never marked undelivered — because it was delivered.

// Anything but a foreground app. iOS "inactive" is counted as away on purpose: it
// is the state the app passes THROUGH on its way out (and back in), so an error
// that surfaces during the handover belongs to the trip, not to the turn.
function isForeground(): boolean {
  const state = AppState.currentState;
  return state !== "background" && state !== "inactive";
}

// When the app last stopped being in the foreground. An attempt is judged against
// this rather than against `isForeground()` alone, because the socket's death and
// the app's return race each other: a student who flicks away and straight back is
// foreground again by the time the failed read finally rejects, and the plain
// check would call that a real failure and re-send the turn.
let leftForegroundAt = 0;

// Turns abandoned mid-flight, threadId → the thesis they were editing (null when
// the conversation has none). Read once on the way back to the foreground and
// cleared, so a refresh only ever happens for a thread that actually had a turn
// running — never on every foreground.
const interruptedTurns = new Map<string, string | null>();

function markTurnInterrupted(threadId: string, thesisId: string | null): void {
  interruptedTurns.set(threadId, thesisId);
  // The chat is about to go idle with an unanswered question in it. Say that it
  // is still catching up, or the student comes back to their own message wearing
  // a "this went unanswered" retry chip a second before the answer lands on it.
  useChatStore.getState().setRecoveringThread(threadId);
  // The app may be back ALREADY: a socket cut by the OS often does not reject
  // until the app is running again, so the "active" event that normally starts the
  // catch-up has been and gone before this turn even learned it had failed.
  // Nothing else would ever fire for it, and the thread would sit registered
  // forever behind a spinner. Scheduled rather than called, so the turn's own
  // teardown (which releases the chat) runs first — the poll below refuses to
  // touch a thread that still has a turn on it.
  if (isForeground()) setTimeout(resumeInterruptedTurns, 0);
}

// How long to keep asking the server for the interrupted turn's answer. The first
// look is immediate — an app backgrounded for ten minutes usually has the reply
// waiting — and the rest cover the case the student came straight back and the
// turn is still running there. The budget is deliberately the same order as the
// retry backoff it replaces (~13s), after which the unanswered-message retry chip
// is the honest thing to show.
const RESUME_POLL_MS = [0, 1_500, 4_000, 8_000];

// Did the interrupted turn's answer land? The refreshed window ends in an
// assistant row that came from the server (a pending one is this device's own
// optimistic copy, which proves nothing).
function turnAnswerLanded(threadId: string): boolean {
  const list = useChatStore.getState().getMessages(threadId);
  const last = list[list.length - 1];
  return !!last && last.role === "assistant" && !last.pending;
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Catch one thread up with the turn that finished while the app was away.
 *
 * Deliberately the SAME path the chat screen uses to reconcile a thread with the
 * server (`syncLatestFromServer`) — the optimistic user row and the half-streamed
 * assistant bubble are both `pending`, and that path already replaces pending rows
 * with the server's copies. There is no second notion of "refresh" here.
 *
 * The document is re-read too, unconditionally: the app never saw the turn's
 * `docChanges` frame, so it cannot know whether the .docx was edited — and the
 * cost of assuming it wasn't is a student shown the pre-turn document by an
 * assistant that just rewrote it (see syncDocumentAfterTurn).
 */
async function resumeInterruptedTurn(threadId: string, thesisId: string | null): Promise<void> {
  try {
    // Re-asserted rather than assumed: a thread registered, dropped and picked up
    // on a LATER return to the foreground has had the flag cleared in between.
    useChatStore.getState().setRecoveringThread(threadId);
    // The question, as this device last held it. syncLatestFromServer REAPS
    // optimistic rows — correctly, the server is the authority — but a server that
    // has not written this turn yet answers "nothing new", and the reap would take
    // the student's own message off the screen with it. Kept so the ending below
    // can put it back if the server turns out to have nothing at all.
    const optimistic = useChatStore.getState().getMessages(threadId).filter((m) => m.pending);
    for (let i = 0; i < RESUME_POLL_MS.length; i++) {
      await wait(RESUME_POLL_MS[i]);
      // The student started a new turn on this thread while we were polling — it
      // owns the conversation now, and its own teardown refreshes everything.
      if (useChatStore.getState().activeThreadId === threadId) return;
      // Away again already: stop rather than poll from the background, and leave
      // the thread registered so the NEXT return picks it up.
      if (!isForeground()) {
        interruptedTurns.set(threadId, thesisId);
        return;
      }
      try {
        await syncLatestFromServer(threadId);
      } catch {
        return; // offline — whatever is cached stays on screen
      }
      if (turnAnswerLanded(threadId)) break;
    }
    // Out of the loop either way: with the answer, or with a question the server
    // never answered. The document may have been edited in both cases.
    syncDocumentAfterTurn(thesisId, true);
    // Nothing came back over the whole budget, so the turn really did die before
    // the server could record it — and the reap above may have taken the question
    // with it. Put it back, marked undelivered, which is the ending this used to
    // have and the only one that leaves a way forward: the Retry on that bubble
    // re-runs THIS row rather than making them type it again. Matched on TEXT, not
    // id: a server copy of the same question carries a different id, and restoring
    // next to it would show the student their message twice.
    if (!turnAnswerLanded(threadId)) restoreUnrecordedQuestion(threadId, optimistic);
  } finally {
    // Only if it is still ours: a new turn (or a later interruption) may have
    // claimed the flag while this one was polling.
    const s = useChatStore.getState();
    if (s.recoveringThreadId === threadId) s.setRecoveringThread(null);
  }
}

// Put back a question the server never recorded — see the call site.
function restoreUnrecordedQuestion(threadId: string, optimistic: ChatMessage[]): void {
  const store = useChatStore.getState();
  const current = store.getMessages(threadId);
  const lost = optimistic.filter(
    (m) =>
      m.role === "user" &&
      !!m.content &&
      !current.some((c) => c.role === "user" && c.content === m.content),
  );
  if (lost.length === 0) return;
  store.setMessages(threadId, [...current, ...lost.map((m) => ({ ...m, failed: true }))]);
}

// One in-flight resume per thread, so two foreground events in quick succession
// (iOS fires inactive→active around a dismissed notification) can never start the
// same poll twice.
const resuming = new Set<string>();

function resumeInterruptedTurns(): void {
  if (interruptedTurns.size === 0) return;
  const pending = [...interruptedTurns.entries()];
  interruptedTurns.clear();
  for (const [threadId, thesisId] of pending) {
    // Already being caught up with. Dropping the entry is right: the poll in
    // flight reads the same thread from the same server, so it collects this
    // registration's answer too.
    if (resuming.has(threadId)) continue;
    resuming.add(threadId);
    void resumeInterruptedTurn(threadId, thesisId).finally(() => resuming.delete(threadId));
  }
}

// One listener for the whole app, registered at module scope like the doc store's
// background flush. Every AI turn — the chat screen's, the workspace composer's,
// the block editor's — runs through THIS file, so there is exactly one place that
// knows a turn was interrupted and exactly one that needs to hear about the
// return. A per-screen listener would have to be repeated three times and would
// miss any turn whose screen unmounted while the app was away.
AppState.addEventListener("change", (state) => {
  if (state === "background" || state === "inactive") {
    leftForegroundAt = Date.now();
    return;
  }
  resumeInterruptedTurns();
});

// ============================================================
// Stop
// ============================================================

// Stops the app has asked the server for and not yet had an answer to, by thread.
// A send that follows a Stop closely waits on these (see settlePendingStop): the
// endpoint cancels "whatever is live on this thread", so a stop still in flight
// when the next turn opens would cancel THAT one instead.
const pendingStops = new Map<string, Promise<void>>();

// The longest a new turn will wait for a preceding Stop to land. Ordering is all
// this buys, and it is not worth more than a moment of the student's time: past
// the cap the send goes ahead regardless.
const STOP_SETTLE_MS = 1_500;

async function settlePendingStop(threadId: string): Promise<void> {
  const inFlight = pendingStops.get(threadId);
  if (!inFlight) return;
  await Promise.race([inFlight, wait(STOP_SETTLE_MS)]);
}

/**
 * Stop the running turn — both halves, in the right order.
 *
 * The LOCAL abort goes first and is what the student feels: the chat is idle in
 * the same tick as the tap, whatever the transport does afterwards (see
 * chat-store.stopGenerating — expo/fetch can hang `reader.read()` forever, and a
 * UI that waited for it stayed stuck on a Stop button with nothing left to press).
 *
 * The SERVER half is what actually ends the work, now that a dropped socket means
 * nothing there. It is fire-and-forget on purpose: this function returns void, so
 * there is no path by which a failed request can leave the chat generating. The
 * worst a lost Stop costs is a turn that finishes in the background and shows up
 * in the thread on the next refresh — which is the same thing that happens when
 * the student stops a turn a moment after it has already finished.
 */
export function stopTurn(): void {
  const { isGenerating, activeThreadId } = useChatStore.getState();
  // Unconditional and first — the UI is freed here.
  useChatStore.getState().stopGenerating();
  if (!isGenerating || !activeThreadId) return;
  const threadId = activeThreadId;
  const request = chatStopTurn(threadId).then(
    () => {},
    () => {
      // Offline, or the server is an older build with no /stop route. Nothing to
      // do: the student's chat is already stopped.
    },
  );
  pendingStops.set(threadId, request);
  void request.finally(() => {
    if (pendingStops.get(threadId) === request) pendingStops.delete(threadId);
  });
}

// Map a raw server chat row into the app's ChatMessage shape.
function mapServerMessages(rows: any[], threadId: string): ChatMessage[] {
  return (rows ?? []).map((m: any) => ({
    id: m.id,
    threadId,
    role: m.role,
    content: m.content,
    chapterId: m.chapterId ?? undefined,
    sectionId: m.sectionId ?? undefined,
    createdAt: m.createdAt,
  }));
}

// Shown when a turn ends without producing anything the student can see. The
// server normally sends its own (localised) note; this is the app's backstop for
// the cases it can't cover — a stream that just ends mid-flight, or an older
// server build. Localised so it doesn't land in English inside an Arabic chat.
// `docChanged` keeps it honest: when the turn's tools already edited the .docx,
// it must not say nothing happened, or the student re-runs an edit that landed.
/**
 * Re-read what the turn changed — the DOCUMENT and the Thesis Structure outline —
 * after a turn that touched the .docx.
 *
 * The outline lives in its OWN cached store, so an AI turn that adds headings —
 * a table of contents promoting plain titles, set_heading, a new chapter — left
 * the navigator showing the pre-turn structure. thesis-workspace.tsx already
 * syncs on the isGenerating edge, but only while THAT screen is mounted: the
 * student reading the drawer from the chat screen saw "2 sections, 0 chapters"
 * next to an assistant claiming it had just built the whole hierarchy.
 *
 * The DOCUMENT had the same hole, and it was the more visible one. Nothing on the
 * chat screen re-read it, so the cached DTO stayed at its pre-turn state; opening
 * the Writer seeds Lexical from exactly that cache (see WorkspaceLexicalView's
 * enter-path), so the student was shown the OLD document by an assistant that had
 * just finished rewriting it. The only thing that eventually refreshed it was the
 * workspace's 20-second scheduled-run poll — which is why closing and reopening the
 * Writer a few times "fixed" it.
 *
 * Here both are tied to the TURN instead of to a screen, so they hold wherever the
 * student happens to be. Fire-and-forget: a failed refresh keeps the last good copy
 * and must never delay ending the turn. `revalidate` no-ops while local edits are
 * still queued (the flush is the authoritative reconcile there).
 */
function syncDocumentAfterTurn(thesisId: string | null, docChanged: boolean): void {
  // No thesis attached → nothing to sync, and nothing CAN have changed anyway:
  // the unattached system prompt carries none of the doc-editing tools.
  if (!thesisId || !docChanged) return;
  void useThesisDocStore.getState().revalidate(thesisId);
  void useOutlineStore.getState().sync(thesisId);
}

/**
 * Pick up a thesis the assistant created during the turn.
 *
 * create_thesis runs entirely on the server: nothing in the stream announces it,
 * so the student is congratulated on a brand-new thesis that exists in no list
 * this app holds — not the drawer, not the picker sheet, not the header title.
 * The server also ATTACHES the conversation it was created in to it (see the
 * tool), and that too is invisible here: left alone, the next turn would go out
 * as an unattached chat, which is offered no document tools at all.
 *
 * So once the turn is over, the conversation asks the two questions it cannot
 * answer locally: which theses exist now, and what is this thread attached to.
 * Both are best-effort and neither delays anything the student is looking at —
 * a failure leaves things exactly as stale as they already were.
 */
async function syncThesisAfterTurn(threadId: string, thesisId: string | null): Promise<void> {
  const theses = useThesisStore.getState();
  // Already attached: the assistant can still have RENAMED the thesis, so the
  // list is worth re-reading, but the attachment cannot have moved — the server
  // only ever fills an EMPTY one, never reassigns a conversation.
  if (thesisId) {
    await theses.refreshTheses();
    return;
  }
  try {
    const [rows] = await Promise.all([listThreads(), theses.refreshTheses()]);
    const row = rows.find((r) => r.id === threadId);
    if (!row?.thesisId) return;
    // The chat screen watches this row and adopts the attachment from it, so the
    // composer stops offering "attach" and the next turn is scoped to the new
    // document. Selecting it app-wide is the same move attaching by hand makes:
    // the Writer, the outline and the drawer follow the conversation.
    useChatThreadsStore.getState().applyThread(row);
    useThesisStore.getState().setCurrentThesis(row.thesisId);
  } catch {
    // Offline, or the server is down. Nothing is lost — the attachment is
    // recorded server-side and the next thread-list read finds it.
  }
}

function emptyTurnNote(docChanged: boolean): string {
  return docChanged
    ? i18n.t("chat.noResponseDocChanged", {
        defaultValue: "I made the changes to your thesis but couldn't write a summary of them. Open your document to check them before trying again.",
      })
    : i18n.t("chat.noResponse", {
        defaultValue: "I couldn't produce a response this time. Tap Regenerate to try again.",
      });
}


// How long streamed text is allowed to pool before it is written to the store.
//
// A chunk arrives per model token, and every store write re-renders the whole
// chat: the list, the live bubble, its markdown, the reasoning window. At 30-60
// chunks a second that IS the JS thread's entire budget — and RN dispatches
// touches on that same thread, so for the whole of a long turn nothing on screen
// answers a tap. (It gets worse as the turn runs: each re-render re-scans the
// message, so the cost per chunk grows with the answer.) Coalescing to one write
// per FLUSH_MS makes that ~11 writes a second, which still reads as continuous
// typing while leaving the thread free to handle presses in between.
const FLUSH_MS = 90;

interface StreamPump {
  /** Queue an answer-text chunk for message `id`. */
  delta: (id: string, chunk: string) => void;
  /** Queue a reasoning chunk for message `id`. */
  thinking: (id: string, chunk: string) => void;
  /** Write what's queued NOW. Call before anything that has to land AFTER the
   *  text — a question sheet, a file card, an error note, the end of the turn. */
  flush: () => void;
  /** Drop what's queued and disarm the timer (a stopped or finished turn). */
  cancel: () => void;
}

/**
 * Batches a turn's streamed chunks into periodic store writes (see FLUSH_MS).
 *
 * Ordering is preserved the only way it matters: reasoning and answer text land
 * in the same flush, reasoning first, and `flush()` is the caller's lever for
 * everything that must be sequenced against the text. Writes are gated on `live`
 * exactly like the direct ones were, so a stopped turn's tail is discarded
 * rather than typed into the chat the student already moved on from.
 */
function createStreamPump(threadId: string, live: () => boolean): StreamPump {
  let target: string | null = null; // the bubble the buffers belong to
  let content = "";
  let think = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    disarm();
    const id = target;
    const reasoning = think;
    const answer = content;
    think = "";
    content = "";
    if (!id || (!reasoning && !answer) || !live()) return;
    const s = useChatStore.getState();
    if (reasoning) s.appendToThinking(threadId, id, reasoning);
    if (answer) s.appendToMessage(threadId, id, answer);
  };

  const arm = (id: string) => {
    // A different bubble (a continuation, a regenerate) must never inherit the
    // previous one's queued text — land it where it belongs first.
    if (target !== null && target !== id) flush();
    target = id;
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };

  return {
    delta: (id, chunk) => {
      arm(id);
      content += chunk;
    },
    thinking: (id, chunk) => {
      arm(id);
      think += chunk;
    },
    flush,
    cancel: () => {
      disarm();
      content = "";
      think = "";
    },
  };
}

export async function sendMessageToAI(
  threadId: string,
  thesisId: string | null,
  userMessage: string,
  opts?: { chapterId?: string; sectionId?: string; selection?: string; docBlockIndex?: number | null; docBlockIndices?: number[]; images?: StagedImage[]; mode?: ChatMode }
): Promise<void> {
  // Add user message immediately (optimistic). Marked pending until reconciled.
  // addMessage returns the EXISTING id when this repeats a just-sent message, so
  // a student tapping send on an apparently-frozen turn doesn't stack bubbles.
  const store = useChatStore.getState();
  // The optimistic row keeps only the LOCAL file reference, never the bytes: the
  // thumbnail renders from it straight away, and the base64 (megabytes of string)
  // would otherwise sit in the store for the life of the session. The server row
  // that replaces it carries the stored URL in a [[MODK_IMG]] frame.
  const userId = store.addMessage(threadId, "user", userMessage, {
    chapterId: opts?.chapterId,
    pending: true,
    images: opts?.images?.map(toChatImage),
  });
  // A retry of a failed send starts clean: clear the marker, and let the turn
  // below set it again if this attempt fails too.
  store.setMessageFailed(threadId, userId, false);
  await runAssistantTurn(threadId, thesisId, userMessage, { ...opts, userMessageId: userId });
}

/**
 * Re-send a message whose turn never completed — the Retry on a failed bubble.
 *
 * Runs the turn for the EXISTING user row rather than appending another one.
 * That distinction is the whole point: re-typing the question is what produced
 * the repeated bubbles in the first place, so the affordance that replaces it
 * must not do the same thing.
 */
export async function retryFailedMessage(threadId: string, thesisId: string | null, messageId: string): Promise<void> {
  const store = useChatStore.getState();
  if (store.isGenerating) return;
  const msg = store.getMessages(threadId).find((m) => m.id === messageId);
  if (!msg || msg.role !== "user") return;
  store.setMessageFailed(threadId, messageId, false);
  // A failed send never reached storage, so its images have to go up again — the
  // bytes are re-read from the local files the staged copies left behind. One the
  // OS has already reclaimed simply drops out: answering the question without a
  // picture beats refusing to retry at all.
  const images = (await Promise.all((msg.images ?? []).map(restageImage))).filter(
    (i): i is StagedImage => i !== null,
  );
  await runAssistantTurn(threadId, thesisId, displayText(msg), {
    chapterId: msg.chapterId,
    sectionId: msg.sectionId,
    userMessageId: messageId,
    images,
  });
}

/**
 * Re-run the assistant's answer to the most recent user message — the
 * "regenerate" / "try again" affordance. Drops the previous assistant reply
 * (everything after the last user turn) and streams a fresh one for the same
 * prompt; the user's own message is left in place. No-op while a turn is already
 * generating, or when there's no user message to answer.
 */
export async function regenerateLastResponse(threadId: string, thesisId: string | null): Promise<void> {
  const store = useChatStore.getState();
  if (store.isGenerating) return;

  const msgs = store.getMessages(threadId);
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role !== "user") i--;
  if (i < 0) return; // nothing the user asked — nothing to regenerate

  const userMsg = msgs[i];
  // Keep up to and including the user message; discard the stale reply so the
  // new one streams into a fresh bubble.
  store.setMessages(threadId, msgs.slice(0, i + 1));
  // `regenerate` tells the server this question is already in its history: don't
  // save it twice, and drop the reply being replaced. It sends the PROSE only —
  // the stored row already holds the image frames, so the re-run sees the same
  // pictures without re-uploading them, and the server's "is this the same
  // question?" check compares against frame-stripped content.
  await runAssistantTurn(threadId, thesisId, displayText(userMsg), { chapterId: userMsg.chapterId, sectionId: userMsg.sectionId, regenerate: true });
}

// What the student actually typed. A synced user row carries its attached images
// as [[MODK_IMG]] frames inside `content`; those are payload, and re-sending them
// as if they were the question is how a frame ends up quoted back at them.
function displayText(m: ChatMessage): string {
  return m.content.includes(IMG_FRAME_OPEN) ? splitImageFrames(m.content).text : m.content;
}

// Streams one assistant turn for an already-present user message: opens the
// request, routes tokens/thinking/files/asks into the store, and handles
// abort + the buffered-endpoint fallback. Shared by the initial send and
// regenerate so both behave identically once the user turn exists.
async function runAssistantTurn(
  threadId: string,
  thesisId: string | null,
  userMessage: string,
  opts?: {
    chapterId?: string; sectionId?: string; selection?: string;
    docBlockIndex?: number | null; docBlockIndices?: number[]; regenerate?: boolean;
    /** Images to upload with this turn. Empty on a regenerate — those are already
     *  stored on the message the server is re-answering. */
    images?: StagedImage[];
    /** The user row this turn answers. Marked failed if the turn never lands, so
     *  the student sees an undelivered message as undelivered. */
    userMessageId?: string;
    /** The conversation mode this turn runs in. Omitted by retry/regenerate, which
     *  fall back to whatever the thread is currently set to — the composer that
     *  owns the picker is not in the loop for those. */
    mode?: ChatMode;
  }
): Promise<void> {
  const store = useChatStore.getState();
  store.setPendingConfirm(null);

  // Ask / Plan / Assist / Agent. The composer that started this turn passes what
  // the student picked; a retry or a regenerate has no picker in hand, so it
  // reads the thread's current mode instead of silently downgrading it to the
  // default. Sent on EVERY turn — that is what keeps the server's copy in step
  // (there is no PATCH for it).
  const mode = opts?.mode ?? useChatThreadsStore.getState().modeFor(threadId);

  // flushOps / the outline sync / docChanges all need the real THESIS id, not
  // the thread id — the doc history checkpoint and the outline are per-document,
  // shared by every thread on it (see chat-store's `docChanges` comment). None of
  // that exists for an unattached thread (no thesis → no document, no outline).
  if (thesisId) store.setDocChanges(thesisId, null);

  // Lets the user cancel this turn from the UI (chat-store.stopGenerating).
  const controller = new AbortController();

  // Claim the turn BEFORE the pre-flight flush below — that flush is a network
  // round-trip, and until the turn is marked generating the chat still looks
  // idle: the composer would take a second send, and the "unanswered question"
  // retry chip would flash under the message already on its way.
  const turnId = store.beginTurn(threadId);
  store.setAbortController(controller);

  // Move the counter now rather than when the turn returns: a message that
  // visibly costs nothing until a minute later reads as free. The server stays
  // the authority — it refunds a turn that fails, and the reconcile in the
  // `finally` below replaces this guess with the real figure either way.
  useBillingStore.getState().spendOne();

  // False once the user hits Stop or a newer turn takes over. Every write below
  // is gated on it: the request may keep unwinding for a while (an abort the
  // transport is slow to honour, or never honours), and a stopped turn that
  // still streamed into the chat would undo the Stop the user just pressed.
  const live = () => useChatStore.getState().isTurnActive(turnId);

  // The AI edits the SERVER copy of the .docx. Any locally-held manual edits
  // (the composing gate defers their sync) must land first, or the AI works on
  // a stale doc AND the held ops' positional indices get poisoned by its edits
  // (flush-time rejection would drop the user's local work). The turn needs the
  // network anyway; a failed drain (offline) just proceeds to fail like the
  // chat call itself would. Lexical Writer typing serializes FIRST (it lives in
  // the WebView until serialized — a pending pause-save isn't in the op queue).
  await (useLexicalEditorStore.getState().flushEdits?.() ?? Promise.resolve()).catch(() => {});
  // No thesis attached → no live .docx to flush.
  if (thesisId) await useThesisDocStore.getState().flushOps(thesisId).catch(() => {});

  // A Stop the student pressed a moment ago may still be on its way to the server.
  // /api/chat/stop cancels whatever is live on the THREAD, so one that overtakes
  // this request would cancel this turn instead of the one it was meant for. The
  // wait is capped and usually already over — the flushes above are round trips too.
  await settlePendingStop(threadId);

  // That flush is a network round-trip the user can hit Stop inside. Bail before
  // opening the stream rather than starting one only to abort it; the store is
  // already idle, so there is nothing to tear down.
  if (!live()) return;

  // Lazily created on the first streamed chunk so the "thinking" indicator
  // shows until the AI actually starts producing text. Hoisted above the attempt
  // loop so the teardown below can stamp whichever bubble the LAST attempt was
  // writing into; each attempt starts it over at null.
  let assistantId: string | null = null;
  // Whether this turn's tools actually mutated the .docx — decides WHICH note,
  // and, more importantly, forbids every further attempt (see mayRetry).
  // Accumulated across attempts on purpose: an edit that landed stays landed.
  let docChanged = false;
  // Streamed text is batched through this rather than written per chunk, so the
  // JS thread stays responsive for the length of the turn (see createStreamPump).
  const pump = createStreamPump(threadId, live);

  try {
    // The turn gets several goes at it. A failure the student did nothing to
    // cause — the provider at capacity, a socket dropped in a lift, a proxy
    // restarting mid-deploy — used to end here as a dead bubble with a Retry
    // button, and what people do with that button is tap it until one lands.
    // The app does the tapping now; the button stays for when even that fails.
    for (let attempt = 1; ; attempt++) {
      // When this attempt opened. Compared against the last time the app left the
      // foreground, so a failure can be attributed to the trip out of the app
      // rather than to the turn — see abandonedToBackground below.
      const attemptStartedAt = Date.now();
      // Per-ATTEMPT state. It is safe to start these over precisely because an
      // attempt is only ever replaced when it produced nothing at all.
      let sawContent = false;
      // Whether the attempt produced anything the student can actually SEE: answer
      // text, a file card, a question sheet or a confirmation. Reasoning does NOT
      // count — a turn that only "thought" leaves a bubble holding a thinking trace
      // and nothing else, which reads as the AI stopping mid-sentence with no way
      // to tell whether it failed. That case is retried, and finally turned into a
      // visible, retryable note.
      let producedOutput = false;

      // The app was not in the foreground for the whole of this attempt, so the
      // socket that just died was cut by the OS. The turn itself is fine: the
      // server runs it to completion whatever happens to the connection. Trying
      // again would not repeat a failure, it would start a SECOND turn — a second
      // answer, and a second pass of edits over the thesis — and it would do it
      // from a background app that cannot receive either. So the attempt is
      // abandoned rather than repeated, and the return to the foreground collects
      // what the server produced (resumeInterruptedTurn). Checked BEFORE mayRetry
      // at every exit: it outranks the whole budget, not just this attempt's turn
      // in it.
      const abandonedToBackground = () => !isForeground() || leftForegroundAt >= attemptStartedAt;

      // May this attempt be replaced by another one? Four gates, in the order of
      // how badly ignoring them would hurt:
      //
      //  - `live()`  — the student pressed Stop (or a newer turn took over).
      //                Retrying would undo the Stop in the tick after it.
      //  - `!docChanged` — the turn's tools ALREADY edited the .docx. The work
      //                landed server-side; running it again writes it twice, and
      //                no amount of transport failure makes that acceptable.
      //  - `!producedOutput` — some of the answer is already on screen. A second
      //                attempt would type a second answer under the first.
      //  - the budget, and (for a thrown error) whether it is worth repeating at
      //    all: a 400 or an expired session says the same thing four times.
      const mayRetry = (error?: unknown) =>
        live() &&
        !docChanged &&
        !producedOutput &&
        attempt < MAX_TURN_ATTEMPTS &&
        (error === undefined || isTransientFailure(error));

      // First sign of life from this attempt. A retry that lands must stop being
      // described as one: the "trying again" line only tells the truth while the
      // chat is silent, and a turn can fall silent again later (a long tool run)
      // with the stale wait line still on screen.
      const markAlive = () => {
        const s = useChatStore.getState();
        if (s.retryAttempt) s.setRetryAttempt(0);
      };

      // Wind the abandoned attempt back so the next one starts on a clean sheet:
      // drop its queued text, and remove the bubble it opened — otherwise the
      // retry's answer arrives underneath a stale reasoning trace, in a bubble
      // whose "Thought for Xs" clock belongs to a turn that never happened.
      const discardAttempt = () => {
        pump.cancel();
        if (assistantId) useChatStore.getState().dropMessage(threadId, assistantId);
        assistantId = null;
      };

      // Wait out the backoff, then hand the next attempt a chat that looks like a
      // turn still in progress — because it is one. Returns false if the student
      // stopped while we waited.
      const pauseThenRetry = async (): Promise<boolean> => {
        discardAttempt();
        await backoffSleep(backoffMs(attempt), live);
        if (!live()) return false;
        const s = useChatStore.getState();
        s.setRetryAttempt(attempt + 1);
        s.setGeneratingPhase("thinking");
        return true;
      };

      try {
        await chatSendStream(
          threadId,
          userMessage,
          {
            onDelta: (chunk) => {
              if (!live()) return;
              markAlive();
              const s = useChatStore.getState();
              if (!assistantId) {
                assistantId = s.addMessage(threadId, "assistant", "", { pending: true });
                s.setStreamingId(assistantId);
              }
              producedOutput = true;
              if (!sawContent) {
                sawContent = true;
                // First answer token → reasoning is over. Land the queued reasoning
                // BEFORE stamping its end, so the clock covers all of it.
                pump.flush();
                s.markThinkingEnded(threadId, assistantId);
                s.setGeneratingPhase("writing");
              }
              pump.delta(assistantId, chunk);
            },
            onAsk: (ask) => {
              if (!live()) return; // a stopped turn must not pop a question sheet
              producedOutput = true; // the sheet IS the turn's output
              pump.flush(); // the question follows the text that leads up to it
              useChatStore.getState().setPendingAsk(ask);
            },
            onConfirm: (confirm) => {
              if (!live()) return; // ditto for the approve/decline chips
              producedOutput = true; // the approve/decline chips ARE the turn's output
              pump.flush();
              useChatStore.getState().setPendingConfirm(confirm);
            },
            onDocChanges: (changes) => {
              // NOT producedOutput: an edited document with no reply still needs the
              // note below — but a doc-aware one (see emptyTurnNote). Recorded even
              // for a stopped turn: the .docx edits already happened server-side, so
              // the student still needs the "Undo AI changes" chip for them. It also
              // ends the retries: work that landed must never be run a second time.
              docChanged = true;
              // thesisId, not threadId — see the field comment on chat-store's docChanges.
              // Can't actually fire with no thesis attached (no doc-editing tools are
              // offered), but guarded rather than assumed.
              if (thesisId) useChatStore.getState().setDocChanges(thesisId, changes);
            },
            onThinking: (chunk) => {
              if (!live()) return;
              markAlive();
              const s = useChatStore.getState();
              // Reasoning can arrive before any answer token — make the bubble now.
              if (!assistantId) {
                assistantId = s.addMessage(threadId, "assistant", "", { pending: true });
                s.setStreamingId(assistantId);
              }
              // Only on a real change: this fires per chunk, and an unconditional set
              // notifies every store subscriber for nothing.
              if (s.generatingPhase !== "thinking") s.setGeneratingPhase("thinking");
              pump.thinking(assistantId, chunk);
            },
            onFile: (file) => {
              if (!live()) return;
              markAlive();
              const s = useChatStore.getState();
              // A file (e.g. an export) can arrive before any answer text — ensure the
              // assistant bubble exists, then attach the card to it.
              if (!assistantId) {
                assistantId = s.addMessage(threadId, "assistant", "", { pending: true });
                s.setStreamingId(assistantId);
              }
              producedOutput = true; // a file card alone is a valid answer (e.g. an export)
              pump.flush(); // the card belongs under the text that announced it
              s.addFileToMessage(threadId, assistantId, file);
            },
            // Plan mode. The stream pump CONSUMES the [[MODK_PLAN]] frame, so it
            // never reaches onDelta and the live message's content never holds it
            // — this handler is the only route to the card while the turn runs.
            // (A reopened conversation takes the other one: the server persists
            // the frame onto the stored message and MessageBubble re-parses it.)
            onPlan: (plan) => {
              if (!live()) return;
              markAlive();
              const s = useChatStore.getState();
              // A plan can arrive with no answer text in front of it.
              if (!assistantId) {
                assistantId = s.addMessage(threadId, "assistant", "", { pending: true });
                s.setStreamingId(assistantId);
              }
              producedOutput = true; // the card IS the turn's output, like a file or an ask
              pump.flush(); // the card belongs under the text that proposed it
              s.addPlanToMessage(threadId, assistantId, plan);
            },
            // One step of a RUNNING plan is done. Mid-turn, several per run, and
            // the tick lands on a card that may belong to an EARLIER message —
            // which is why it goes to the store's planId-keyed record rather
            // than onto this bubble. No pump.flush() for that same reason:
            // nothing is being inserted into this message's text, so there is no
            // ordering to preserve.
            //
            // producedOutput, and it matters twice: a run that ticked steps and
            // then died has done real work server-side, so it must neither be
            // retried (mayRetry reads this) nor end with a note saying nothing
            // happened.
            onPlanStep: (step) => {
              if (!live()) return;
              markAlive();
              producedOutput = true;
              useChatStore.getState().recordPlanStep(step);
            },
            // Developer trace only (server-side AI_SHOW_TOOLS): NOT producedOutput —
            // running tools is not an answer to the student.
            onTool: (tool) => {
              if (!live()) return;
              useChatStore.getState().pushToolTrace(tool);
            },
            // Fires at most once, when this thread gets its first generated title.
            onTitle: ({ threadId: titledId, title }) => {
              useChatThreadsStore.getState().applyTitle(titledId, title);
            },
          },
          { chapterId: opts?.chapterId, sectionId: opts?.sectionId, selection: opts?.selection, docBlockIndex: opts?.docBlockIndex ?? null, docBlockIndices: opts?.docBlockIndices, regenerate: opts?.regenerate, mode, attachments: opts?.images?.map(toAttachment), signal: controller.signal }
        );

        // Everything still queued belongs to this attempt — land it before the
        // checks below read what it produced.
        pump.flush();

        // The stream ended cleanly but the student got nothing — either no bubble
        // at all, or one holding only a thinking trace. That is a turn that died
        // wearing a success suit: it looks identical to a hang, and it is exactly
        // as worth repeating as one that threw. So repeat it, silently, while
        // there are attempts left.
        if (!producedOutput) {
          // Silent because the app was away, not because the turn failed.
          if (abandonedToBackground()) {
            markTurnInterrupted(threadId, thesisId);
            return;
          }
          if (mayRetry()) {
            if (await pauseThenRetry()) continue;
            return; // stopped during the backoff
          }
          if (!live()) return;
          // Out of attempts (or the .docx already changed, which forbids another
          // run). Say what happened; the note also gives the bubble content, which
          // is what the chat's Regenerate affordance keys off.
          const note = emptyTurnNote(docChanged);
          if (assistantId) store.appendToMessage(threadId, assistantId, note);
          else store.addMessage(threadId, "assistant", note, { pending: true });
        }
        return;
      } catch (error: any) {
        // User tapped Stop (or a newer turn took over) — keep whatever streamed so
        // far and suppress the error note; the abort is intentional, not a failure.
        if (!live()) {
          return;
        }

        // Whatever arrived before the failure is still the turn's answer — land it
        // so the note below reads as its ending, not as a replacement for it. (A
        // retry drops it again a moment later, along with the bubble it sits in.)
        pump.flush();

        // If the streaming endpoint isn't available (e.g. an older server build),
        // fall back to the buffered /send endpoint so the chat still works.
        if (!assistantId && (error?.status === 404 || error?.status === 405)) {
          try {
            store.setGeneratingPhase("thinking");
            const result = await chatSend(threadId, userMessage, { chapterId: opts?.chapterId, sectionId: opts?.sectionId, selection: opts?.selection, docBlockIndex: opts?.docBlockIndex ?? null, docBlockIndices: opts?.docBlockIndices, regenerate: opts?.regenerate, attachments: opts?.images?.map(toAttachment) });
            // The buffered endpoint takes no signal, so Stop can't cut it short —
            // it can only be ignored. Drop the whole reply rather than dumping it
            // into a chat the student already walked away from.
            if (!live()) return;
            const id = store.addMessage(threadId, "assistant", result.response || emptyTurnNote(!!result.docChanges), { pending: true });
            // Mirror the streaming path: surface any file cards and open the ask sheet.
            result.files?.forEach((f) => store.addFileToMessage(threadId, id, f));
            if (result.ask) store.setPendingAsk(result.ask);
            if (result.confirmAction) store.setPendingConfirm(result.confirmAction);
            // Mark the turn as having edited the .docx, exactly as the streaming
            // path's onDocChanges does — the outer finally reads this to decide
            // whether the outline needs re-syncing. thesisId, not threadId — see
            // the field comment on chat-store's docChanges.
            if (result.docChanges) { docChanged = true; if (thesisId) store.setDocChanges(thesisId, result.docChanges); }
            return;
          } catch (fallbackError: any) {
            error = fallbackError;
          }
        }

        // Out of messages. Handled before every other exit because none of them
        // fit: retrying cannot help, and the ordinary dead-end below would leave
        // an assistant bubble explaining the problem in a chat the student then
        // has to scroll past, with a Retry button that can only fail again.
        // Instead the question stays marked undelivered — so Retry works the
        // moment they have credit — and the paywall comes up over the chat.
        if (isQuotaError(error)) {
          if (opts?.userMessageId) store.setMessageFailed(threadId, opts.userMessageId, true);
          useBillingStore.getState().setBlocked(error.reason ?? "period-exhausted", error.quota);
          return;
        }

        // Not this turn's failure to report: the app was in the background, so the
        // socket died with it while the turn carried on server-side. Say nothing,
        // spend no attempt, and leave the question looking delivered — because it
        // was. The foreground resume brings back the answer it produced.
        if (abandonedToBackground()) {
          markTurnInterrupted(threadId, thesisId);
          return;
        }

        // Nothing of this attempt reached the student, and the failure is one that
        // passes on its own — go again rather than handing over a button. This is
        // the path that used to end every "the service is very busy right now".
        if (mayRetry(error)) {
          if (await pauseThenRetry()) continue;
          return; // stopped during the backoff
        }

        // Out of road: either the attempts are spent or this failure would say the
        // same thing however many times it were asked.
        //
        // Mark the QUESTION as undelivered, not just the answer: a user bubble that
        // looks identical to a delivered one is what makes a student type the same
        // request again — three times, in the case this was written for. The Retry
        // on that bubble re-runs THIS row, and is now the last resort rather than
        // the first thing anyone reaches for.
        if (opts?.userMessageId) store.setMessageFailed(threadId, opts.userMessageId, true);

        const note = userFacingError(error);
        if (assistantId) {
          store.appendToMessage(threadId, assistantId, `\n\n_${note}_`);
        } else {
          store.addMessage(threadId, "assistant", note, { pending: true });
        }
        return;
      }
    }
  } finally {
    // Nothing may write into the chat after the turn ends: every path above has
    // already flushed what it meant to keep, so a chunk still queued here is a
    // stopped turn's tail.
    pump.cancel();
    // Covers turns that end with no answer text (tool-only actions) or a mid-think
    // abort — markThinkingEnded is a no-op if reasoning never started or already ended.
    if (assistantId) store.markThinkingEnded(threadId, assistantId);
    // Ownership-checked: a turn the user stopped may only unwind here long after
    // the next one started, and must not idle THAT one's chat.
    store.endTurn(turnId);
    // The turn's tools may have added or promoted headings — refresh the outline
    // wherever the student is, not only in the workspace screen. thesisId, not
    // threadId — see the field comment on chat-store's docChanges.
    syncDocumentAfterTurn(thesisId, docChanged);
    // …and it may have created a whole THESIS (create_thesis), which only the
    // server knows about. Fire-and-forget for the same reason: the turn is over,
    // and this must not hold up the chat going idle.
    void syncThesisAfterTurn(threadId, thesisId);
    // Replace the optimistic decrement above with the server's real figure. It
    // matters in both directions: a turn that failed was REFUNDED server-side,
    // so the message the student was provisionally charged has to come back.
    // Fire-and-forget — the turn is over and the counter is not worth a wait.
    void useBillingStore.getState().refreshQuota();
    // Persist the new turn to the device so it survives restarts and shows
    // instantly next time. Server-id reconciliation happens on the next open.
    await persistCache(threadId);
  }
}

// How long an unconfirmed optimistic row may survive before it is treated as a
// failed send. Generous enough to outlast the longest agentic turn (the step cap
// is 32 model calls), short enough that a message from a previous app session is
// never shown as if it had been sent.
const STALE_PENDING_MS = 10 * 60 * 1000;

export async function loadInitialMessages(threadId: string) {
  const store = useChatStore.getState();
  // Already loaded in memory this session — nothing to do.
  if (store.getMessages(threadId).length > 0) return;

  // A pending row that survived a restart is a send that failed — its turn died
  // long ago. Reap before reading, so the cache can't resurrect it into the list.
  await deleteStalePending(threadId, STALE_PENDING_MS);

  // 1. Instant: show the latest page from the device cache (also works offline).
  const cached = await getLatestMessages(threadId, INITIAL_PAGE_SIZE);
  if (cached.messages.length) {
    store.setMessages(threadId, cached.messages);
    store.setHasMoreOlder(threadId, cached.hasMore);
  }

  // 2. Reconcile the newest messages with the server (latest page on first sync,
  //    delta after). On failure the cached messages simply remain visible.
  try {
    await syncLatestFromServer(threadId);
  } catch {
    // offline / backend unavailable
  }

  // 3. Nothing locally or on the server → the screen renders <ChatWelcome/>.
  //
  // This used to insert a fake assistant message here. It read as though the
  // model had spoken before the student said anything, and because it was a real
  // row in the store it could be read aloud, regenerated, and made the thread
  // look non-empty. An empty conversation is now empty, and the welcome is
  // rendered rather than pretended.
}

// Reconcile the newest messages with the server. First sync (no cursor yet) pulls
// the latest page and marks whether older history exists; afterwards it pulls only
// the delta created since. Older history already paged in is never touched here —
// that grows through loadOlderMessages.
async function syncLatestFromServer(threadId: string): Promise<void> {
  const store = useChatStore.getState();
  const lastSyncedAt = await getLastSyncedAt(threadId);

  if (!lastSyncedAt) {
    // First sync: the server's latest page is authoritative for the tail.
    const server = await getChatHistoryPage(threadId, { limit: INITIAL_PAGE_SIZE }); // throws when offline
    const fromServer = mapServerMessages(server, threadId);
    // Empty server → keep whatever is local (e.g. a brand-new conversation just started).
    if (fromServer.length === 0) return;
    await upsertMessages(threadId, fromServer);
    await deletePending(threadId); // clear stale optimistic rows now superseded
    store.setMessages(threadId, fromServer);
    store.setHasMoreOlder(threadId, server.length >= INITIAL_PAGE_SIZE);
    await setLastSyncedAt(threadId, fromServer[fromServer.length - 1].createdAt);
    return;
  }

  // Incremental: fetch messages created after the last confirmed timestamp,
  // replace optimistic copies with their server-id versions, append new ones.
  const server = await getChatHistory(threadId, lastSyncedAt);
  const additions = mapServerMessages(server, threadId);
  // Reap FIRST, and unconditionally. This used to sit after the early return
  // below, so it only ran when the server happened to have something new — and a
  // pending row whose send had failed was therefore never cleared. Reaching this
  // line means the server answered, so it is authoritative: anything still
  // marked pending is a send that never landed.
  await deletePending(threadId);
  if (additions.length === 0) {
    // Nothing new upstream, but the reap above may have removed rows the store
    // is still showing — drop them from memory too, or they linger until reload.
    const live = store.getMessages(threadId).filter((m) => !m.pending);
    if (live.length !== store.getMessages(threadId).length) store.setMessages(threadId, live);
    return;
  }
  await upsertMessages(threadId, additions);
  const synced = store.getMessages(threadId).filter((m) => !m.pending);
  const have = new Set(synced.map((m) => m.id));
  const merged = [...synced, ...additions.filter((m) => !have.has(m.id))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  store.setMessages(threadId, merged);
  await setLastSyncedAt(threadId, merged[merged.length - 1].createdAt);
}

// Reveal the previous page of history (scroll-to-top). Server-authoritative with a
// device-cache fallback when offline; the store's loadingOlder/hasMoreOlder guards
// keep it from double-loading or paging past the beginning.
export async function loadOlderMessages(threadId: string): Promise<void> {
  const store = useChatStore.getState();
  if (store.getLoadingOlder(threadId) || !store.getHasMoreOlder(threadId)) return;

  const current = store.getMessages(threadId);
  // Cursor = oldest loaded message with a server row. Optimistic (pending) rows
  // carry a client clock and have no server row to page against, so skip them.
  const cursor = current.find((m) => !m.pending) ?? current[0];
  if (!cursor) return;
  const before = cursor.createdAt;

  store.setLoadingOlder(threadId, true);
  try {
    let older: ChatMessage[];
    let hasMore: boolean;
    try {
      const server = await getChatHistoryPage(threadId, { before, limit: OLDER_PAGE_SIZE });
      older = mapServerMessages(server, threadId);
      hasMore = server.length >= OLDER_PAGE_SIZE; // a full page → older messages may remain
      if (older.length) await upsertMessages(threadId, older);
    } catch {
      // Offline → serve the older page from the device cache instead.
      const page = await getOlderMessages(threadId, before, OLDER_PAGE_SIZE);
      older = page.messages;
      hasMore = page.hasMore;
    }
    if (older.length) store.prependMessages(threadId, older);
    // Stop paging once a page comes back empty or short (reached the beginning).
    store.setHasMoreOlder(threadId, older.length > 0 && hasMore);
  } finally {
    store.setLoadingOlder(threadId, false);
  }
}

// Persist the current in-memory window to the device cache. Upsert (not
// replace-all) so older pages already cached survive; optimistic rows reconcile to
// their server ids on the next open (see syncLatestFromServer).
async function persistCache(threadId: string): Promise<void> {
  const store = useChatStore.getState();
  await upsertMessages(threadId, store.getMessages(threadId));
}

// A follow-up the student authorised: approving or declining a parked destructive
// action, or executing a proposed plan. The continuation streams into a fresh
// assistant bubble through the same handlers as a normal turn, so the workspace's
// after-turn refresh (isGenerating true→false) fires as usual.
//
// Deliberately NOT auto-retried, unlike runAssistantTurn. The whole point of a
// parked action is that it is destructive, and the server executes the STORED
// args the moment this request lands: a failure here cannot tell "it never ran"
// from "it ran, and then the stream died on the way back". Repeating that guess
// three times is how a student's deleted section gets deleted twice. A failure
// here keeps its error note and its Retry — the one place where asking a human
// is the right answer. A plan run is the same bargain, several edits at a time.
async function runStreamContinuation(
  threadId: string,
  thesisId: string | null,
  call: (handlers: ChatStreamHandlers, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  // thesisId, not threadId — see the field comment on chat-store's docChanges.
  // syncDocumentAfterTurn and docChanges both need the real thesis id.
  const store = useChatStore.getState();
  store.setPendingConfirm(null);
  // Same ordering guard as runAssistantTurn: a Stop still in flight would cancel
  // THIS continuation instead of the turn it was pressed on.
  await settlePendingStop(threadId);
  const controller = new AbortController();
  const startedAt = Date.now();
  // See runAssistantTurn's abandonedToBackground: a continuation the app walked
  // away from is recovered, never reported as a failure and never re-run — the
  // work it started is already landing server-side.
  const abandoned = () => !isForeground() || leftForegroundAt >= startedAt;
  const turnId = store.beginTurn(threadId);
  store.setAbortController(controller);
  // See runAssistantTurn: gates every write so a stopped continuation goes quiet.
  const live = () => useChatStore.getState().isTurnActive(turnId);
  let assistantId: string | null = null;
  // See runAssistantTurn: reasoning alone is not an answer, and a continuation
  // that yields only a thinking trace must not end in silence either.
  let producedOutput = false;
  let docChanged = false;
  // See runAssistantTurn: streamed text is batched, not written per chunk.
  const pump = createStreamPump(threadId, live);
  const ensureBubble = () => {
    const s = useChatStore.getState();
    if (!assistantId) {
      assistantId = s.addMessage(threadId, "assistant", "", { pending: true });
      s.setStreamingId(assistantId);
    }
    return s;
  };
  try {
    await call({
      onDelta: (chunk) => {
        if (!live()) return;
        const s = ensureBubble();
        producedOutput = true;
        if (s.generatingPhase !== "writing") s.setGeneratingPhase("writing");
        pump.delta(assistantId!, chunk);
      },
      onThinking: (chunk) => {
        if (!live()) return;
        const s = ensureBubble();
        if (s.generatingPhase !== "thinking") s.setGeneratingPhase("thinking");
        pump.thinking(assistantId!, chunk);
      },
      onAsk: (ask) => { if (!live()) return; producedOutput = true; pump.flush(); useChatStore.getState().setPendingAsk(ask); },
      onConfirm: (confirm) => { if (!live()) return; producedOutput = true; pump.flush(); useChatStore.getState().setPendingConfirm(confirm); },
      // Not gated: the .docx was already edited, so the undo chip is owed either way.
      // (Can't fire with no thesis attached — no destructive tool exists to confirm — but guarded rather than assumed.)
      onDocChanges: (changes) => { docChanged = true; if (thesisId) useChatStore.getState().setDocChanges(thesisId, changes); },
      onFile: (file) => {
        if (!live()) return;
        const s = ensureBubble();
        producedOutput = true;
        pump.flush();
        s.addFileToMessage(threadId, assistantId!, file);
      },
      // A continuation can propose a plan of its own (an approved action that
      // turns out to need several steps). Same live route as runAssistantTurn.
      onPlan: (plan) => {
        if (!live()) return;
        const s = ensureBubble();
        producedOutput = true;
        pump.flush();
        s.addPlanToMessage(threadId, assistantId!, plan);
      },
      // THE path that matters for plan progress: tapping Execute runs
      // executePlan → runStreamContinuation, so every tick of a plan the student
      // actually launched arrives here. See runAssistantTurn's copy for why the
      // tick goes to the store rather than onto this bubble, and why it counts
      // as output.
      onPlanStep: (step) => {
        if (!live()) return;
        producedOutput = true;
        useChatStore.getState().recordPlanStep(step);
      },
      // Developer trace only — see runAssistantTurn.
      onTool: (tool) => { if (!live()) return; useChatStore.getState().pushToolTrace(tool); },
      onTitle: ({ threadId: titledId, title }) => {
        useChatThreadsStore.getState().applyTitle(titledId, title);
      },
    }, controller.signal);
    pump.flush();
    if (!producedOutput && live()) {
      // Silent because the app was away: the reply exists, it just had nowhere to
      // arrive. Recovered on the way back rather than papered over with a note.
      if (abandoned()) markTurnInterrupted(threadId, thesisId);
      else {
        const s = ensureBubble();
        s.appendToMessage(threadId, assistantId!, emptyTurnNote(docChanged));
      }
    }
  } catch (error: any) {
    if (live()) {
      pump.flush();
      // The app left the foreground while this ran, so the dead socket says
      // nothing about the work: an approved action, or a plan, keeps executing
      // server-side and its reply is persisted there. An error note here would be
      // a lie sitting under edits that actually landed — see the header comment on
      // interrupted turns. Recovered on the way back like any other turn.
      if (abandoned()) {
        markTurnInterrupted(threadId, thesisId);
      } else {
        const note = userFacingError(error);
        const s = ensureBubble();
        s.appendToMessage(threadId, assistantId!, `\n\n_${note}_`);
      }
    }
  } finally {
    pump.cancel();
    const s = useChatStore.getState();
    if (assistantId) s.markThinkingEnded(threadId, assistantId);
    s.endTurn(turnId);
    // An approved destructive action (deleting a hand-typed table of contents,
    // say) runs in THIS continuation, not the original turn — so the outline has
    // to be re-synced here too.
    syncDocumentAfterTurn(thesisId, docChanged);
    await persistCache(threadId);
  }
}

export function approvePendingAction(threadId: string, thesisId: string | null, actionId: string): Promise<void> {
  return runStreamContinuation(threadId, thesisId, (handlers, signal) =>
    chatConfirmAction(actionId, handlers, signal),
  );
}

export function declinePendingAction(threadId: string, thesisId: string | null, actionId: string): Promise<void> {
  return runStreamContinuation(threadId, thesisId, (handlers, signal) =>
    chatCancelAction(actionId, handlers, signal),
  );
}

/**
 * Run a plan the assistant proposed — the Execute button on its card.
 *
 * The work streams back through exactly the same handlers a normal turn uses, so
 * the reply lands in the thread like any other answer: same bubble, same
 * reasoning trace, same undo chip, same after-turn document sync. Not retried,
 * for the same reason an approved destructive action isn't (see
 * runStreamContinuation): the server starts applying the plan the moment the
 * request lands, and a stream that dies on the way back cannot tell "it never
 * ran" from "it ran". Guessing that twice edits the thesis twice.
 *
 * ⚠️ The double-run guard is the store's, not this function's caller's: the slot
 * is claimed BEFORE the request opens, so a second tap — or a second card
 * showing the same plan — is refused in the same tick rather than after a round
 * trip. Returns without doing anything when a plan is already running.
 */
export async function executePlan(threadId: string, thesisId: string | null, planId: string): Promise<void> {
  const store = useChatStore.getState();
  if (!store.beginPlanRun(planId)) return;
  try {
    await runStreamContinuation(threadId, thesisId, (handlers, signal) =>
      chatExecutePlan(threadId, planId, handlers, signal),
    );
  } finally {
    // Retired whatever happened, including a run that ended in an error note.
    // The request reached the server, and from here nothing can tell "it never
    // ran" from "it ran, and the stream died on the way back" — so the card
    // stops offering to do it again. A dead button costs the student one
    // sentence in the chat; a thesis edited twice costs them their document.
    // (The error note in the bubble is what tells them to ask again.)
    useChatStore.getState().endPlanRun(planId, true);
  }
}
