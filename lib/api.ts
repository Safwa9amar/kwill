import { fetch as expoFetch } from "expo/fetch";
import { supabase } from "./supabase";
import i18n from "./i18n";
import type {
  AppNotification,
  NotificationPreferences,
} from "@/types/notification";
import type { AskPayload, FilePayload, ConfirmPayload, DocChangesPayload, ToolTracePayload } from "@/types/chat";
import type { NewsArticle, NewsCopy, NewsPagination, NewsRow } from "@/types/news";
import type {
  Align,
  DocumentContent,
  DocumentRecord,
  ParagraphMutationResult,
} from "@/types/document";
import type { Thesis, Template, NormProfile, University, StartingPoint } from "@/types/thesis";
import type { QuotaResponse, PlanCatalogue, SubscriptionState, PlanCode } from "@/types/billing";
import type { ThesisSource } from "@/types/source";
import { byokHeaders, whenByokHydrated, useByokStore, isByokErrorCode } from "@/stores/byok-store";

const API_URL = process.env.EXPO_PUBLIC_API_URL

async function getAuthHeaders(): Promise<Record<string, string>> {
  // Wait for the keychain read before deciding whose AI key this request uses.
  // Without it, anything fired during app start would go out with no BYOK
  // header and quietly run on the platform's keys — the student would believe
  // they were paying their own way while we picked up the bill.
  const [{ data: { session } }] = await Promise.all([
    supabase.auth.getSession(),
    whenByokHydrated(),
  ]);
  const token = session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...byokHeaders(),
  };
}

/**
 * Turn a failed response into the thrown Error every caller already expects,
 * and record the failures that belong to the student's own AI key so the
 * settings screen can tell them what to fix (top up, re-enter, wait).
 */
async function raiseApiError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (body?.byok && isByokErrorCode(body.error)) {
    useByokStore.getState().setLastError(body.error);
  }
  throw decorateApiError(new Error(body?.error || `API Error: ${response.status}`), response.status, body);
}

/**
 * Carry the machine-readable part of an error body onto the thrown Error.
 *
 * Callers have always caught a plain Error and shown its message, which is fine
 * for "something went wrong" but wrong for a refusal the student can act on: a
 * spent message allowance needs the paywall and the remaining counts, not a
 * sentence in a dead chat bubble. `status` was already being attached on the
 * streaming path; this keeps the two paths telling the same story.
 */
function decorateApiError(err: Error, status: number, body: any): Error {
  const e = err as Error & {
    status?: number;
    code?: string;
    reason?: string;
    quota?: unknown;
    plan?: string;
    limit?: number | null;
    used?: number;
  };
  e.status = status;
  if (body?.code) e.code = body.code;
  if (body?.reason) e.reason = body.reason;
  if (body?.quota) e.quota = body.quota;
  // The thesis limit (402 + code:"thesis_limit") carries its counts here rather
  // than inside `quota`: it is not the message ledger, and the screen that shows
  // it needs to say "1 of 1" without a second round trip.
  if (body?.plan) e.plan = body.plan;
  if (body?.limit !== undefined) e.limit = body.limit;
  if (body?.used !== undefined) e.used = body.used;
  return e;
}

/**
 * An authed audio source for the neural text-to-speech endpoint, ready to hand
 * to `createAudioPlayer`. Returned as a URL rather than bytes so the audio
 * streams straight into the player with no intermediate file write — the app
 * never holds the WAV itself. Send ONE sentence per call; the voice loop splits
 * replies as they stream so the first words play while the rest is still coming.
 */
export async function ttsAudioSource(
  text: string,
  lang: string,
  rate?: number,
  provider?: string
): Promise<{ uri: string; headers: Record<string, string> }> {
  const headers = await getAuthHeaders();
  const params = new URLSearchParams({ text, lang });
  if (rate && rate > 0) params.set("rate", String(rate));
  if (provider) params.set("provider", provider);
  // The ".wav" path matters: Android's ExoPlayer partly infers the audio
  // container from the URL, and an extensionless one can fail to play silently
  // even when the bytes and content-type are right.
  return { uri: `${API_URL}/api/tts/speech.wav?${params.toString()}`, headers };
}

export interface TtsCapabilities {
  enabled: boolean;
  /** e.g. ["piper", "gemini"] — empty means the OS voice is the only option. */
  providers: string[];
  default: string | null;
}

/** Which neural voices the server can offer this session. */
export async function ttsCapabilities(): Promise<TtsCapabilities> {
  try {
    const res = await apiGet<TtsCapabilities>("/api/tts/health");
    return {
      enabled: !!res?.enabled,
      providers: Array.isArray(res?.providers) ? res.providers : [],
      default: res?.default ?? null,
    };
  } catch {
    return { enabled: false, providers: [], default: null };
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${path}`, { headers });
  if (!response.ok) {
    await raiseApiError(response);
  }
  return response.json();
}

/** An ornament preview, in whichever form the catalogue holds it. Vector rows
 *  come back as SVG source (rendered with SvgXml, so it recolours and stays
 *  sharp); uploaded artwork comes back as a data URI for a plain <Image>. */
export type OrnamentPreview =
  | { kind: "svg"; svg: string }
  | { kind: "image"; dataUri: string };

/** Base64 for a byte array, without Buffer or btoa.
 *
 *  Hermes has no Buffer, and btoa is binary-string-only — building that
 *  intermediate string for a full-page PNG is the slow, memory-heavy path. This
 *  walks the bytes directly. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

/**
 * Fetch an ornament preview for the visual ask sheet (AskPreviewGrid).
 * `previewUrl` is the server-relative path carried by an AskPreview; it is
 * fetched with the app's own auth like every API call.
 *
 * The form is decided by the response's Content-Type, not by guessing at the
 * bytes: the endpoint serves SVG for a vector ornament and the stored image for
 * uploaded artwork. Anything that is neither (an HTML login page from a proxy,
 * say) is rejected rather than handed to a renderer.
 *
 * The image branch inlines the bytes as a data URI instead of letting <Image>
 * re-fetch the URL, because the endpoint needs an Authorization header that
 * RN's image loader does not reliably send on both platforms — and the bytes
 * are already in hand here.
 */
export async function fetchOrnamentPreview(previewUrl: string): Promise<OrnamentPreview> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${previewUrl}`, { headers });
  if (!response.ok) {
    await raiseApiError(response);
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();

  if (type.includes("image/svg")) {
    const text = await response.text();
    if (!/^\s*<svg[\s>]/i.test(text)) throw new Error("Not an SVG preview");
    return { kind: "svg", svg: text };
  }

  if (type.startsWith("image/")) {
    const buf = await response.arrayBuffer();
    const mime = type.split(";")[0].trim();
    return { kind: "image", dataUri: `data:${mime};base64,${bytesToBase64(new Uint8Array(buf))}` };
  }

  throw new Error(`Unsupported preview type: ${type || "unknown"}`);
}

/** Long jobs get minutes, not iOS's 60-second default. */
const LONG_JOB_TIMEOUT_MS = 10 * 60 * 1000;

export interface LongPostOptions {
  /** Fraction of the body that has reached the server, 0..1. */
  onUploadProgress?: (fraction: number) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * POST for the jobs that take minutes: importing a thesis, combining several.
 *
 * `fetch` cannot outlive iOS's NSURLSession default of 60 seconds and offers no
 * way to raise it, so a real thesis died with "fetch failed: The request timed
 * out" while the server was still working on it. XHR takes an explicit timeout —
 * and, unlike fetch in React Native, reports how much of the body has actually
 * gone up, which is the one part of these jobs the client can honestly measure.
 */
async function apiPostLong<T>(path: string, body: any, opts: LongPostOptions = {}): Promise<T> {
  const headers = await getAuthHeaders();
  const payload = JSON.stringify(body);

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}${path}`);
    xhr.timeout = opts.timeoutMs ?? LONG_JOB_TIMEOUT_MS;
    // Headers only after open(), or React Native drops them.
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onUploadProgress?.(e.loaded / e.total);
    };
    // Guarantees the 100% tick. Without it a platform that reports no progress
    // events (or stops short of `total`) would leave the caller's UI showing
    // "uploading" for the whole server-side job.
    xhr.upload.onload = () => opts.onUploadProgress?.(1);

    xhr.onload = () => {
      let parsed: any;
      try {
        parsed = JSON.parse(xhr.responseText || "{}");
      } catch {
        parsed = { error: xhr.statusText || `API Error: ${xhr.status}` };
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(parsed as T);
      // Same BYOK bookkeeping the fetch path does, so the settings screen still
      // learns that the student's own key was the thing that failed.
      if (parsed?.byok && isByokErrorCode(parsed.error)) {
        useByokStore.getState().setLastError(parsed.error);
      }
      // Same decoration the fetch verbs get from raiseApiError — without it,
      // a caller matching on err.status/err.code (isThesisLimitError, the
      // rescue lane's 402/409/410) never fires for anything sent through XHR.
      reject(decorateApiError(new Error(parsed?.error || `API Error: ${xhr.status}`), xhr.status, parsed));
    };
    // No response ever arrived on these three, so there is no status/body to
    // decorate with — left as plain Errors, `.status` stays undefined, same
    // as before.
    xhr.onerror = () => reject(new Error("Network request failed"));
    xhr.ontimeout = () =>
      reject(new Error(`The server took longer than ${Math.round(xhr.timeout / 60000)} minutes`));
    xhr.onabort = () => reject(new Error("Canceled"));
    opts.signal?.addEventListener("abort", () => xhr.abort());

    xhr.send(payload);
  });
}

export async function apiPost<T>(path: string, body: any, signal?: AbortSignal): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    await raiseApiError(response);
  }
  return response.json();
}

async function apiPut<T>(path: string, body: any): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await raiseApiError(response);
  }
  return response.json();
}

export async function apiPatch<T>(path: string, body: any): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await raiseApiError(response);
  }
  return response.json();
}

export async function apiDelete(path: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${path}`, { method: "DELETE", headers });
  if (!response.ok) {
    await raiseApiError(response);
  }
}

async function apiDeleteWithBody<T>(path: string, body: any): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await raiseApiError(response);
  }
  return response.json();
}

// ============================================================
// Chat API
// ============================================================

export interface ChatSendResponse {
  response: string;
  model: string;
  provider: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  // Set when the turn ended on a question → the app opens the ask bottom sheet.
  ask?: AskPayload;
  // Downloadable artifacts produced this turn (e.g. an export), rendered as cards.
  files?: FilePayload[];
  // Set when the turn requested a destructive tool that's parked pending approval.
  confirmAction?: ConfirmPayload;
  // Set when this turn changed the .docx (drives the "Undo AI changes" affordance).
  docChanges?: DocChangesPayload;
}

/** One image on its way up with a chat message. Base64 because RN mangles
 *  multipart bodies — the same reason avatars and source documents go this way. */
export interface ChatAttachmentUpload {
  base64: string;
  mime: string;
  width?: number;
  height?: number;
}

export async function chatSend(
  threadId: string,
  message: string,
  options?: { chapterId?: string; sectionId?: string; selection?: string; docBlockIndex?: number | null; docBlockIndices?: number[]; regenerate?: boolean; attachments?: ChatAttachmentUpload[] }
): Promise<ChatSendResponse> {
  return apiPost("/api/chat/send", {
    threadId,
    message,
    chapterId: options?.chapterId,
    sectionId: options?.sectionId,
    selection: options?.selection,
    // See chatSendStream: a re-ask of a question already saved server-side.
    regenerate: options?.regenerate ?? false,
    attachments: options?.attachments,
    // Live-.docx (L2): the engine block index the student selected, so the AI
    // edits that exact paragraph. `null` when nothing block-specific is focused.
    docBlockIndex: options?.docBlockIndex ?? null,
    // Multi-select: every block the student long-pressed, so the AI acts on the
    // whole set. Omitted when there's a single (or no) selection.
    docBlockIndices: options?.docBlockIndices,
  });
}

/** One AI-generated composer quick-action chip. */
export interface ComposerSuggestion {
  label: string;
  prompt: string;
}

// Fetch dynamic composer quick-action chips, grounded in the recent conversation
// + the current selection + RAG context. Best-effort: the server returns an empty
// array on any failure, and callers fall back to static presets.
//
// `threadId` is what the chips ground on — WHICH conversation, not which thesis.
// Omitting it makes the server fall back to the thesis's newest thread, which is
// right for a caller that has no thread of its own (the workspace dock) and wrong
// for one that does: the chat screen can be looking at any thread in the history,
// and chips about a different conversation are worse than none.
export async function getComposerSuggestions(
  thesisId: string | null,
  options?: {
    threadId?: string | null;
    selection?: string;
    docBlockIndex?: number | null;
    docBlockIndices?: number[];
  },
  signal?: AbortSignal
): Promise<ComposerSuggestion[]> {
  const res = await apiPost<{ suggestions?: ComposerSuggestion[] }>(
    "/api/chat/suggestions",
    {
      thesisId,
      // Explicitly absent, never null-with-a-thesis: the server reads a sent-but-
      // malformed threadId as a client bug and answers nothing, while an absent
      // one is the documented "resolve it for me" signal.
      ...(options?.threadId ? { threadId: options.threadId } : {}),
      selection: options?.selection,
      docBlockIndex: options?.docBlockIndex ?? null,
      docBlockIndices: options?.docBlockIndices,
    },
    signal
  );
  return Array.isArray(res?.suggestions) ? res.suggestions : [];
}

// Pass `since` (an ISO timestamp) to fetch only messages created after it —
// the incremental sync path used by the on-device cache.
export async function getChatHistory(threadId: string, since?: string | null) {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  return apiGet<any[]>(`/api/threads/${threadId}/messages${query}`);
}

// Fetch one page of history for infinite scroll: the newest `limit` messages,
// optionally older than the `before` ISO cursor. Returns a chronological array;
// a full-length page means older messages still remain.
export async function getChatHistoryPage(
  threadId: string,
  opts: { limit: number; before?: string | null }
) {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.before) params.set("before", opts.before);
  return apiGet<any[]>(`/api/threads/${threadId}/messages?${params.toString()}`);
}

export interface ChatStreamHandlers {
  onDelta: (chunk: string) => void;
  onAsk?: (ask: AskPayload) => void;
  onThinking?: (chunk: string) => void;
  onFile?: (file: FilePayload) => void;
  onConfirm?: (confirm: ConfirmPayload) => void;
  onDocChanges?: (changes: DocChangesPayload) => void;
  /** Developer tool trace — only ever arrives from a server with AI_SHOW_TOOLS on. */
  onTool?: (tool: ToolTracePayload) => void;
  /** Fired once, mid-stream, when this thread gets its first generated title —
   *  lets the history panel update live instead of waiting for a refetch. */
  onTitle?: (p: { threadId: string; title: string }) => void;
}

// The streaming endpoint escapes emoji (astral chars) to \uXXXX because RN's
// native networking corrupts 4-byte UTF-8 mid-stream. Reverse it here. Adjacent
// escapes for a surrogate pair sit next to each other, so the two code units
// reconstruct the astral character.
function unescapeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Index up to which `s` is safe to decode now — everything except a trailing
// partial \uXXXX (or lone backslash) that may complete in the next chunk.
function safeEscapeBoundary(s: string): number {
  const m = s.match(/\\(?:u[0-9a-fA-F]{0,3})?$/);
  return m && m.index !== undefined ? m.index : s.length;
}

/**
 * Wraps `signal` so a pending `reader.read()` can be raced against it.
 *
 * `expo/fetch` handles an abort by cancelling the NATIVE request and waiting for
 * the platform to report back before it errors the body stream. When that report
 * never comes — a stalled socket, a cancel the OS swallows — `reader.read()`
 * never settles, the read loop below never unwinds, and the caller is stuck: the
 * chat stays "generating" with a Stop button that has nothing left to stop.
 * Racing the read against the signal makes the abort itself authoritative.
 */
function watchAbort(signal: AbortSignal | undefined) {
  if (!signal) return { race: <T,>(p: Promise<T>) => p, cleanup: () => {} };
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) return fail();
    onAbort = fail;
    signal.addEventListener("abort", fail);
  });
  // The race is this promise's only consumer; keep a rejection that lands after
  // the loop has exited from surfacing as an unhandled promise rejection.
  aborted.catch(() => {});
  return {
    race: <T,>(p: Promise<T>) => Promise.race([p, aborted]),
    cleanup: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Streams an AI response from a chat-protocol POST endpoint, invoking
 * `onDelta` for each text chunk as it arrives. Uses `expo/fetch`, whose
 * Response exposes a real `ReadableStream` body (the standard RN fetch
 * buffers the whole response). Bytes are decoded with a streaming TextDecoder
 * so multi-byte UTF-8 (Arabic) isn't corrupted when a character is split
 * across chunks. Shared by `/api/chat/stream`, `/api/chat/confirm-action`, and
 * `/api/chat/cancel-action` — they all speak the same frame protocol.
 */
async function postChatStream(
  path: string,
  body: Record<string, unknown>,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await expoFetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    // A BYOK failure arrives here as a small JSON error rather than a stream —
    // read it so a dead or empty key is reported as itself instead of a bare
    // "API Error: 402" in the middle of a chat.
    const body = await response.json().catch(() => null);
    if (body?.byok && isByokErrorCode(body.error)) {
      useByokStore.getState().setLastError(body.error);
    }
    // A spent message allowance also arrives here as JSON rather than a stream
    // (402 + code:"quota_exhausted"); decorateApiError carries the counts up so
    // the chat can raise the paywall instead of a bubble with a dead Retry.
    throw decorateApiError(
      new Error(body?.error || `API Error: ${response.status}`),
      response.status,
      body,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // Holds a trailing partial \uXXXX escape that straddles a chunk boundary until
  // the rest arrives, so an emoji is never decoded half-formed.
  let pending = "";

  // Control-region markers (must match the server). Reasoning streams between the
  // THINK markers → onThinking; the ask frame carries JSON between ASK markers.
  const THINK_OPEN = "[[MODK_THINK]]";
  const THINK_CLOSE = "[[/MODK_THINK]]";
  const ASK_OPEN = "[[MODK_ASK]]";
  const ASK_CLOSE = "[[/MODK_ASK]]";
  const FILE_OPEN = "[[MODK_FILE]]";
  const FILE_CLOSE = "[[/MODK_FILE]]";
  const CONFIRM_OPEN = "[[MODK_CONFIRM]]";
  const CONFIRM_CLOSE = "[[/MODK_CONFIRM]]";
  const DC_OPEN = "[[MODK_DOCCHANGES]]";
  const DC_CLOSE = "[[/MODK_DOCCHANGES]]";
  const TOOL_OPEN = "[[MODK_TOOL]]";
  const TOOL_CLOSE = "[[/MODK_TOOL]]";
  const TITLE_OPEN = "[[MODK_TITLE]]";
  const TITLE_CLOSE = "[[/MODK_TITLE]]";

  let mode: "answer" | "think" = "answer";
  let buf = ""; // unescaped text awaiting routing

  // How many trailing chars of `s` to hold back because they may be the start of
  // one of `markers` that completes in the next chunk.
  const heldLen = (s: string, markers: string[]): number => {
    let max = 0;
    for (const m of markers) {
      for (let k = Math.min(m.length - 1, s.length); k > 0; k--) {
        if (s.endsWith(m.slice(0, k))) { if (k > max) max = k; break; }
      }
    }
    return max;
  };

  const pump = (chunk: string, isFinal: boolean) => {
    buf += chunk;
    while (true) {
      if (mode === "answer") {
        const ti = buf.indexOf(THINK_OPEN);
        const ai = buf.indexOf(ASK_OPEN);
        const fi = buf.indexOf(FILE_OPEN);
        const ci = buf.indexOf(CONFIRM_OPEN);
        const di = buf.indexOf(DC_OPEN);
        const oi = buf.indexOf(TOOL_OPEN);
        const li = buf.indexOf(TITLE_OPEN);
        const first = [ti, ai, fi, ci, di, oi, li].filter((i) => i !== -1).sort((a, b) => a - b)[0];
        if (first === undefined) {
          const hold = isFinal ? 0 : heldLen(buf, [THINK_OPEN, ASK_OPEN, FILE_OPEN, CONFIRM_OPEN, DC_OPEN, TOOL_OPEN, TITLE_OPEN]);
          const out = buf.slice(0, buf.length - hold);
          if (out) handlers.onDelta(out);
          buf = buf.slice(buf.length - hold);
          break;
        }
        const before = buf.slice(0, first);
        if (before) handlers.onDelta(before);
        if (first === ti) {
          buf = buf.slice(first + THINK_OPEN.length);
          mode = "think";
          continue;
        }
        if (first === fi) {
          // FILE frame: need the closing marker before we can parse the JSON. The
          // frame never reaches onDelta, so the raw JSON is never shown as text.
          const closeAt = buf.indexOf(FILE_CLOSE, first + FILE_OPEN.length);
          if (closeAt === -1) { buf = buf.slice(first); break; }
          try { handlers.onFile?.(JSON.parse(buf.slice(first + FILE_OPEN.length, closeAt))); } catch {}
          buf = buf.slice(closeAt + FILE_CLOSE.length);
          continue;
        }
        if (first === ci) {
          // CONFIRM frame: need the closing marker before we can parse the JSON.
          // The frame never reaches onDelta, so the raw JSON is never shown as text.
          const closeAt = buf.indexOf(CONFIRM_CLOSE, first + CONFIRM_OPEN.length);
          if (closeAt === -1) { buf = buf.slice(first); break; }
          try { handlers.onConfirm?.(JSON.parse(buf.slice(first + CONFIRM_OPEN.length, closeAt))); } catch {}
          buf = buf.slice(closeAt + CONFIRM_CLOSE.length);
          continue;
        }
        if (first === di) {
          // DOCCHANGES frame: need the closing marker before we can parse the JSON.
          // The frame never reaches onDelta, so the raw JSON is never shown as text.
          const closeAt = buf.indexOf(DC_CLOSE, first + DC_OPEN.length);
          if (closeAt === -1) { buf = buf.slice(first); break; }
          try { handlers.onDocChanges?.(JSON.parse(buf.slice(first + DC_OPEN.length, closeAt))); } catch {}
          buf = buf.slice(closeAt + DC_CLOSE.length);
          continue;
        }
        if (first === oi) {
          // TOOL frame (developer trace): mid-turn, so several arrive per turn —
          // parsed and routed, never shown as text.
          const closeAt = buf.indexOf(TOOL_CLOSE, first + TOOL_OPEN.length);
          if (closeAt === -1) { buf = buf.slice(first); break; }
          try { handlers.onTool?.(JSON.parse(buf.slice(first + TOOL_OPEN.length, closeAt))); } catch {}
          buf = buf.slice(closeAt + TOOL_CLOSE.length);
          continue;
        }
        if (first === li) {
          // TITLE frame: fires at most once, when a thread gets its first
          // generated title. Need the closing marker before we can parse the
          // JSON. The frame never reaches onDelta, so the raw JSON is never
          // shown as text.
          const closeAt = buf.indexOf(TITLE_CLOSE, first + TITLE_OPEN.length);
          if (closeAt === -1) { buf = buf.slice(first); break; }
          try { handlers.onTitle?.(JSON.parse(buf.slice(first + TITLE_OPEN.length, closeAt))); } catch {}
          buf = buf.slice(closeAt + TITLE_CLOSE.length);
          continue;
        }
        // ASK frame: need the closing marker before we can parse the JSON.
        const closeAt = buf.indexOf(ASK_CLOSE, first + ASK_OPEN.length);
        if (closeAt === -1) { buf = buf.slice(first); break; }
        try { handlers.onAsk?.(JSON.parse(buf.slice(first + ASK_OPEN.length, closeAt))); } catch {}
        buf = buf.slice(closeAt + ASK_CLOSE.length);
        continue;
      } else {
        const ci = buf.indexOf(THINK_CLOSE);
        if (ci === -1) {
          const hold = isFinal ? 0 : heldLen(buf, [THINK_CLOSE]);
          const out = buf.slice(0, buf.length - hold);
          if (out) handlers.onThinking?.(out);
          buf = buf.slice(buf.length - hold);
          break;
        }
        const reason = buf.slice(0, ci);
        if (reason) handlers.onThinking?.(reason);
        buf = buf.slice(ci + THINK_CLOSE.length);
        mode = "answer";
        continue;
      }
    }
  };

  const watch = watchAbort(signal);
  try {
    while (true) {
      const { done, value } = await watch.race(reader.read());
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const cut = safeEscapeBoundary(pending);
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      if (ready) pump(unescapeUnicode(ready), false);
    }
    pending += decoder.decode();
    pump(pending ? unescapeUnicode(pending) : "", true);
  } finally {
    watch.cleanup();
    if (signal?.aborted) {
      // Hang up on the native request, but never await it: `cancel()` resolves
      // through the same native layer that may be unresponsive. `releaseLock()`
      // is skipped here — a read can still be pending after an abort.
      reader.cancel().catch(() => {});
    } else {
      reader.releaseLock();
    }
  }
}

/**
 * Streams the AI response from `/api/chat/stream` for a new user message. Thin
 * wrapper over `postChatStream` — see its doc comment for the streaming
 * protocol details.
 */
export async function chatSendStream(
  threadId: string,
  message: string,
  handlers: ChatStreamHandlers,
  options?: { chapterId?: string; sectionId?: string; selection?: string; docBlockIndex?: number | null; docBlockIndices?: number[]; regenerate?: boolean; attachments?: ChatAttachmentUpload[]; signal?: AbortSignal }
): Promise<void> {
  // `docBlockIndex` (live-.docx, L2): the selected engine block index → the AI
  // edits that paragraph. `docBlockIndices` carries a multi-select set so the AI
  // acts on all of them. Legacy fields (chapterId/sectionId/selection) stay so
  // the server's legacy chapter/section path keeps working unchanged.
  // `regenerate`: this question is ALREADY saved server-side (the app is re-asking
  // it) — the server must not store it twice, and drops the reply being replaced.
  const body = {
    threadId,
    message,
    chapterId: options?.chapterId,
    sectionId: options?.sectionId,
    selection: options?.selection,
    docBlockIndex: options?.docBlockIndex ?? null,
    docBlockIndices: options?.docBlockIndices,
    regenerate: options?.regenerate ?? false,
    // Images the student attached, as base64 (binary/multipart bodies are
    // unreliable from RN — same convention as every other upload here). The
    // server stores them and writes a [[MODK_IMG]] frame onto the saved message,
    // so a regenerate re-answers the question WITH its pictures and never
    // re-uploads them.
    attachments: options?.attachments,
    // The student's clock. The server has no timezone signal of its own, so
    // without this "schedule it for tonight" is unresolvable there — and a
    // server-local guess would be the wrong hour in every deployment. Minutes
    // EAST of UTC, so Algiers is +60.
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  };
  return postChatStream("/api/chat/stream", body, handlers, options?.signal);
}

// Approve / decline a parked destructive AI action. The server executes (or
// discards) the STORED args and streams a follow-up assistant reply through
// the same frame protocol as /api/chat/stream.
export async function chatConfirmAction(actionId: string, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  return postChatStream("/api/chat/confirm-action", { actionId }, handlers, signal);
}

export async function chatCancelAction(actionId: string, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  return postChatStream("/api/chat/cancel-action", { actionId }, handlers, signal);
}

// ============================================================
// Chat Threads API (mounted at /api/threads)
// Conversations are first-class: a thesis can hold several, and a thread can be
// unattached. `GET /api/threads` already returns them in display order (pinned
// first, then most recent — a brand-new empty thread ranks first on purpose);
// callers must not re-sort.
// ============================================================

export interface ChatThread {
  id: string;
  thesisId: string | null;
  title: string | null;
  pinned: boolean;
  archivedAt: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadSearchResult {
  thread: ChatThread;
  messageId: string;
  snippet: string;
  createdAt: string | null;
}

export async function listThreads(opts?: { thesisId?: string; archived?: boolean }): Promise<ChatThread[]> {
  const params = new URLSearchParams();
  if (opts?.thesisId) params.set("thesisId", opts.thesisId);
  if (opts?.archived) params.set("archived", "1");
  const q = params.toString();
  return apiGet<ChatThread[]>(`/api/threads${q ? `?${q}` : ""}`);
}

export async function createThread(thesisId?: string | null): Promise<ChatThread> {
  return apiPost<ChatThread>("/api/threads", { thesisId: thesisId ?? null });
}

/**
 * The Writer's ✦ entry point: the conversation this thesis is currently in,
 * created on demand. Deliberately a server call rather than the client picking
 * from `listThreads` — that list ranks a brand-new empty thread FIRST (the
 * student just tapped ＋ and wants to see it), whereas here the right answer is
 * the thread with something in it. Same question, opposite orderings.
 */
export async function threadForThesis(thesisId: string): Promise<ChatThread> {
  return apiPost<ChatThread>("/api/threads/for-thesis", { thesisId });
}

export async function patchThread(
  threadId: string,
  patch: { title?: string | null; pinned?: boolean; archived?: boolean; thesisId?: string }
): Promise<ChatThread> {
  return apiPatch<ChatThread>(`/api/threads/${threadId}`, patch);
}

export async function deleteThread(threadId: string): Promise<void> {
  return apiDelete(`/api/threads/${threadId}`);
}

export async function searchThreads(q: string): Promise<ThreadSearchResult[]> {
  return apiGet<ThreadSearchResult[]>(`/api/threads/search?q=${encodeURIComponent(q)}`);
}

// ============================================================
// Thesis API
// ============================================================

export async function listTheses() {
  return apiGet<Thesis[]>("/api/thesis");
}

export async function getThesis(id: string) {
  return apiGet<Thesis>(`/api/thesis/${id}`);
}

export async function createThesis(input: {
  title: string;
  templateId?: string;
  normProfileId?: string;
  language?: string;
  // Canonical placeholder values collected in the wizard's fields step; the
  // server substitutes them into the copied template cover.
  frontMatter?: Record<string, unknown>;
  // The generated outline that SEEDS the working .docx. It is not persisted as
  // section/chapter rows — the .docx is the source of truth.
  sections?: Array<{ title: string; kind?: "introduction" | "section" | "conclusion"; chapters?: Array<{ title: string; content?: string }> }>;
}) {
  return apiPost<Thesis>("/api/thesis", input);
}

// AI autocomplete for the thesis title — returns a few suggested titles for the
// user's partial input. Best-effort: never throws (returns [] on failure).
export async function suggestThesisTitles(input: string, language?: string): Promise<string[]> {
  try {
    const res = await apiPost<{ suggestions: string[] }>("/api/thesis/title-suggestions", {
      input,
      // Only a tiebreaker for short/ambiguous input — the server primarily matches
      // the language the user is actually typing in.
      language: language ?? i18n.language,
    });
    return res.suggestions ?? [];
  } catch {
    return [];
  }
}

// Best-effort AI hint: classify the most likely methodology from the student's
// topic. Returns null on any failure (or when AI Suggestions are off) so it never
// blocks the wizard. One of: experimental | theoretical | case_study | survey | mixed.
export async function suggestMethodology(input: { title?: string; description: string; keywords?: string; language?: string }): Promise<string | null> {
  try {
    const res = await apiPost<{ methodology: string | null }>("/api/thesis/methodology-suggestion", {
      title: input.title ?? "",
      description: input.description,
      keywords: input.keywords ?? "",
      language: input.language ?? i18n.language,
    });
    return res.methodology ?? null;
  } catch {
    return null;
  }
}

export async function updateThesis(id: string, updates: any) {
  return apiPut<any>(`/api/thesis/${id}`, updates);
}

export async function deleteThesis(id: string) {
  return apiDelete(`/api/thesis/${id}`);
}

/**
 * Active templates. Pass a `universityId` to get just that institution's —
 * an institution can have several (Licence / Master / Doctorat, Arabic /
 * French), which is what the per-university browse screen lists.
 */
export async function listTemplates(universityId?: string) {
  const path = universityId
    ? `/api/templates?universityId=${encodeURIComponent(universityId)}`
    : "/api/templates";
  return apiGet<Template[]>(path);
}

/**
 * The 130 Algerian institutions. PUBLIC on the server (mounted outside /api/*)
 * because the signup screen needs it before a session exists.
 */
export async function listUniversities(q?: string): Promise<University[]> {
  const path = q ? `/universities?q=${encodeURIComponent(q)}` : "/universities";
  const res = await apiGet<{ count: number; universities: University[] }>(path);
  return res.universities ?? [];
}

/**
 * The single ranking endpoint: what this student should start from, best first.
 * Each entry carries the rung that produced it plus everything needed to render
 * a card, so showing a result costs ONE request rather than N+1.
 */
export async function getStartingPoints(input: {
  universityId?: string | null;
  level?: string | null;
  language?: string;
  discipline?: string;
  /**
   * "templates" is catalogue mode: every active template, best matches first,
   * with the rules-only starting points filtered out. Only the Browse-all
   * screen passes it — the "For you" card must keep showing the full ladder,
   * rulesets included.
   */
  scope?: "templates";
}): Promise<StartingPoint[]> {
  const params = new URLSearchParams();
  if (input.universityId) params.set("universityId", input.universityId);
  if (input.level) params.set("level", input.level);
  params.set("language", input.language ?? i18n.language);
  if (input.discipline) params.set("discipline", input.discipline);
  if (input.scope) params.set("scope", input.scope);
  const res = await apiGet<{ count: number; startingPoints: StartingPoint[] }>(
    `/api/starting-points?${params.toString()}`
  );
  return res.startingPoints ?? [];
}

/** One template by id, taxonomy already resolved from its norm profile. */
export async function getTemplate(id: string) {
  return apiGet<Template>(`/api/templates/${id}`);
}

export async function listNormProfiles() {
  return apiGet<NormProfile[]>("/api/norm-profiles");
}

export async function getNormProfile(id: string) {
  return apiGet<NormProfile>(`/api/norm-profiles/${id}`);
}

export interface PlanBrief { description?: string; objectives?: string; keywords?: string; methodology?: string }

export type PlanSectionDTO = { title: string; kind: "introduction" | "section" | "conclusion"; chapters: Array<{ title: string; hint?: string; content?: string }> };

export async function generateThesisPlan(input: { title: string; language?: string; bodyPreset?: string; templateId?: string; brief?: PlanBrief }) {
  return apiPost<{ sections: PlanSectionDTO[] }>("/api/thesis/generate-plan", input);
}

/**
 * Streams the generated outline from `/api/thesis/generate-plan` (stream:true),
 * invoking `onSection` for each NDJSON section as it arrives. Uses `expo/fetch`
 * (real ReadableStream body; core RN fetch buffers the whole response) with a
 * streaming TextDecoder so multi-byte UTF-8 (Arabic) isn't split. Throws on a
 * non-OK/bodyless response so callers can fall back to `generateThesisPlan`.
 */
export async function streamThesisPlan(
  input: { title: string; language?: string; bodyPreset?: string; templateId?: string; brief?: PlanBrief },
  onSection: (section: PlanSectionDTO) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await expoFetch(`${API_URL}/api/thesis/generate-plan`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    // A BYOK failure arrives here as a small JSON error rather than a stream —
    // read it so a dead or empty key is reported as itself instead of a bare
    // "API Error: 402" in the middle of a chat.
    const body = await response.json().catch(() => null);
    if (body?.byok && isByokErrorCode(body.error)) {
      useByokStore.getState().setLastError(body.error);
    }
    // A spent message allowance also arrives here as JSON rather than a stream
    // (402 + code:"quota_exhausted"); decorateApiError carries the counts up so
    // the chat can raise the paywall instead of a bubble with a dead Retry.
    throw decorateApiError(
      new Error(body?.error || `API Error: ${response.status}`),
      response.status,
      body,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const drain = (flushAll: boolean) => {
    const parts = buf.split("\n");
    // Keep the last (possibly partial) line buffered — unless this is the final
    // flush, in which case every part (including the last) is complete.
    buf = flushAll ? "" : (parts.pop() ?? "");
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj.title === "string") onSection(obj as PlanSectionDTO);
      } catch { /* partial/garbage line — skip */ }
    }
  };
  const watch = watchAbort(signal); // see watchAbort: an ignored abort must not hang the loop
  try {
    while (true) {
      const { done, value } = await watch.race(reader.read());
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      drain(false);
    }
    buf += decoder.decode();
    drain(true);
  } finally {
    watch.cleanup();
    if (signal?.aborted) reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}

// ============================================================
// Thesis Import & Analysis API
// ============================================================

export interface AnalysisSuggestion {
  id: string;
  category: "structure" | "formatting" | "content";
  severity: "error" | "warning" | "info";
  message: string;
  fix: string | null;
}

export interface AnalysisReport {
  structure: AnalysisSuggestion[];
  formatting: AnalysisSuggestion[];
  content: AnalysisSuggestion[];
}

export async function importThesis(
  input: { base64: string; filename: string; language?: string; normProfileId?: string },
  opts?: LongPostOptions,
): Promise<{ thesis: Thesis; analysisReport: AnalysisReport | null }> {
  // Minutes, not seconds: a real thesis is megabytes of base64 and the server
  // uploads, parses and analyses it before answering.
  return apiPostLong("/api/thesis/import", input, opts);
}

export async function getThesisAnalysis(thesisId: string): Promise<AnalysisReport> {
  return apiGet(`/api/thesis/${thesisId}/analysis`);
}

export async function applyThesisSuggestions(thesisId: string, acceptedIds: string[]): Promise<{ applied: string[] }> {
  return apiPost(`/api/thesis/${thesisId}/apply`, { acceptedIds });
}

export async function formatThesis(
  thesisId: string,
  normProfileId?: string
): Promise<{ formatted: boolean; applied: string[]; skipped: string[] }> {
  return apiPost(`/api/thesis/${thesisId}/format`, normProfileId ? { normProfileId } : {});
}

// ============================================================
// Rescue lane API — mirrors the server DTOs from /api/rescue/*.
// Diagnosis is FREE and creates no thesis; repair 402s on the free plan.
//
// The four endpoints do NOT all return the same shape — RescueRun below is
// the union of every field any of them can send; each function's return type
// picks the subset that endpoint actually sends (verified against
// modakerati-server/src/routes/rescue.ts's c.json(...) calls, not just the
// route's intent):
//   - POST /diagnose        → runId, status, degraded, verdict, questions, steps
//   - GET /:id               → all of the above PLUS thesisId, conformity
//   - POST /:id/answers      → runId, verdict, questions, steps (no status/degraded)
//   - POST /:id/repair       → runId, status, thesisId, conformity, steps?
//                              (steps is present on the normal completion path,
//                              ABSENT on the early "already done" short-circuit —
//                              never verdict/questions/degraded either way)
// ============================================================

export type RescueStepId =
  | "snapshot" | "clean" | "structure" | "norms"
  | "sections-numbering" | "pagination" | "captions" | "apparatus" | "finish";

export interface RescueStep {
  id: RescueStepId;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error?: string;
}

export interface RescueVerdictIssue {
  code: string;
  severity: "error" | "warning" | "info";
  count: number;
  message: string;
}

export interface RescueVerdict { issues: RescueVerdictIssue[]; total: number }

export interface RescueQuestion {
  id: string;
  index: number;
  textHead: string;
  before: string;
  after: string;
  suggested: { role: string; level?: number };
  choices: Array<{ role: string; level?: number }>;
}

export interface RescueConformityCheck { code: string; ok: boolean; detail: string }

export interface RescueRun {
  runId: string;
  status: "diagnosing" | "diagnosed" | "repairing" | "done" | "failed" | "expired";
  degraded: boolean;
  verdict: RescueVerdict | null;
  questions: RescueQuestion[];
  steps: RescueStep[];
  thesisId?: string | null;
  conformity?: { checks: RescueConformityCheck[]; degraded: boolean } | null;
}

export async function rescueDiagnose(
  input: { base64: string; filename: string; normProfileId: string },
  opts?: LongPostOptions,
): Promise<RescueRun> {
  // Minutes on a real thesis: upload + parse + one windowed AI pass.
  return apiPostLong("/api/rescue/diagnose", input, opts);
}

export async function getRescueRun(runId: string): Promise<RescueRun> {
  return apiGet(`/api/rescue/${runId}`);
}

export async function submitRescueAnswers(
  runId: string,
  answers: Record<string, { role: string; level?: number }>,
): Promise<Pick<RescueRun, "runId" | "verdict" | "questions" | "steps">> {
  return apiPost(`/api/rescue/${runId}/answers`, { answers });
}

export async function rescueRepair(
  runId: string,
  opts?: LongPostOptions,
): Promise<Pick<RescueRun, "runId" | "status" | "thesisId" | "conformity"> & { steps?: RescueStep[] }> {
  // The longest call in the lane — the whole FormatPlan runs inside it. Note
  // for callers: on a non-2xx response this rejects with a bare Error whose
  // `.message` is the server's `error` string ("payment_required" / 402,
  // "repair_in_progress" / 409, "source_expired" / 410) — apiPostLong does
  // NOT attach `.status` or `.code` the way the fetch-based apiPost/apiGet do
  // (see decorateApiError), so detect these by matching `err.message`, not
  // `err.status`.
  return apiPostLong(`/api/rescue/${runId}/repair`, {}, opts);
}

// ============================================================
// Combine documents API
// Mirrors the server DTOs from POST /api/thesis/combine/classify and /combine.
// ============================================================

export type PartRole =
  | "introduction"
  | "revue_litterature"
  | "partie_theorique"
  | "methodologie"
  | "partie_pratique"
  | "resultats"
  | "discussion"
  | "conclusion"
  | "bibliographie"
  | "annexe"
  | "autre";

export type ClassifyFailure =
  | "key_rejected"
  | "no_credit"
  | "rate_limited"
  | "model_denied"
  | "model_missing"
  | "unreachable"
  | "bad_reply"
  | "error";

export interface ClassifiedPartDTO {
  filename: string;
  suggestedTitle: string;
  role: PartRole;
  wordCount: number;
  pageCount: number;
}

// Classify uploaded parts (read content → role + suggested title + default order).
export async function classifyCombineParts(
  parts: { filename: string; base64: string }[],
  opts?: LongPostOptions,
): Promise<{
  parts: ClassifiedPartDTO[];
  suggestedOrder: string[];
  /** How the labels were produced — "heuristic" means the model call failed and
   *  the roles/titles come from the parts' own text. The arrange screen says so
   *  rather than passing a guess off as the AI's reading. */
  classifiedBy?: "ai" | "heuristic";
  /** Why the model call failed, when it did. A revoked key and a network blip
   *  need different words — and different fixes. */
  classifyReason?: ClassifyFailure;
}> {
  // The model call inside can retry up to three times; the client must not give
  // up before the server has.
  return apiPostLong("/api/thesis/combine/classify", { parts }, opts);
}

// Combine ordered parts into one new live-docx thesis (returns the import shape).
export async function combineThesis(input: {
  title: string;
  normProfileId?: string;
  language?: string;
  /**
   * "full" (default) — chapter headings, numbering, divider pages and one font
   * from the norm profile. "plain" — join the files and nothing else; each part
   * keeps its own formatting and starts its own Word section.
   */
  structure?: "full" | "plain";
  /**
   * `role` rides along so the server knows which parts are body chapters (only
   * those get a number and a "Chapitre N" divider page), and
   * `continuesPrevious` marks a file that is the rest of the part above it.
   */
  parts: {
    filename: string;
    base64: string;
    title: string;
    order: number;
    role?: PartRole;
    continuesPrevious?: boolean;
  }[];
}, opts?: LongPostOptions): Promise<{ thesis: Thesis; analysisReport: AnalysisReport | null }> {
  // The longest job in the product: merge, structure passes, an AI call, the
  // doctor, then the upload and the analysis.
  return apiPostLong("/api/thesis/combine", input, opts);
}

// ============================================================
// Live-.docx thesis document (read-only block render)
// Mirrors the server DTO from GET /api/thesis/:id/document.
// ============================================================

// One paragraph inside a Word shape's text box (see the `textbox` block below).
export type TextBoxLine = {
  text: string;
  alignment: "left" | "center" | "right" | "both" | null;
  direction: "rtl" | "ltr" | null;
  bold?: boolean;
  sizePt?: number;
};

// The drawn box itself — enough to redraw it recognisably outside Word.
export type TextBoxShape = {
  rounded: boolean;
  border: { color: string; pt: number } | null;
  fill: string | null;
  width?: number;
  height?: number;
};

// One FLOATING drawing (`<wp:anchor>`) hanging off a paragraph — a chapter
// divider's title box, a decorative picture behind the text, a grouped shape.
// Mirror of the server's AnchoredShape (src/lib/docx-shapes.ts).
//
// Word positions these itself and paints them over/under the flow, so they are
// NOT part of the block they hang off: the block keeps its own kind and carries
// these beside it for the editor to draw as an absolutely-positioned overlay.
// Everything is in EMU (914400 per inch) exactly as Word stored it — the app
// scales them against the page's real text-column width (lib/page-layout.ts).
export type AnchoredShape = {
  /** What the shape is. `other` is a group OR a native chart — see the render rule. */
  kind: "textbox" | "picture" | "other";
  /** Text content, when it is a textbox. Same shape as the `textbox` block's. */
  lines?: TextBoxLine[];
  box?: TextBoxShape;
  /** Picture bytes. The server DROPS this when it duplicates the carrier block's
   *  own image, so "no dataUri on a picture anchor" means "the block already
   *  renders these very bytes". `hasMedia` only marks that bytes exist — it has
   *  NO addressable endpoint of its own (see anchorIsBlocksOwnShape). */
  dataUri?: string;
  hasMedia?: boolean;
  /** Placement, in EMU (914400 per inch) — the app scales them. `x` is an
   *  INLINE-START offset, so an RTL document mirrors correctly. */
  x: { from: "column" | "page" | "margin"; offsetEmu?: number; align?: "left" | "center" | "right" };
  y: { from: "paragraph" | "page" | "margin" | "line"; offsetEmu?: number; align?: "top" | "center" | "bottom" };
  widthEmu: number;
  heightEmu: number;
  /** true = painted BEHIND the text (Word's "Send Behind Text"). */
  behindDoc: boolean;
  /** Word's z-order among floating shapes. */
  z: number;
  wrap: "none" | "square" | "tight" | "through" | "topAndBottom";
};

// A picture that lives INSIDE a table cell (a cover page's institution logos).
// Same inline/on-demand split as an image block: small ones arrive as `dataUri`,
// bigger ones set `hasMedia` and the bytes come from thesisCellImageUrl().
export type CellImageDTO = { dataUri?: string; hasMedia?: boolean; width?: number; height?: number };

// Word list kind of a paragraph (mirrors the server's ListKind).
export type DocListKind = "bullet" | "number";

// One equation sitting inside a paragraph. Word keeps an equation's characters in
// `<m:oMath>`/`<m:t>`, which NO reader of `<w:t>` can see — so `text` and `runs`
// both miss it and the line used to render blank. `at` is the offset into `text`
// where it belongs, so the renderer splits the sentence and drops it in.
//
// `mathml` is self-contained <math> markup, typeset natively by the Writer's
// WebView. `text` is a Unicode linearisation ("σᵣᵣ=1/(√2πr)cos θ") for the native
// surfaces that cannot typeset. `image` is Word's own preview bitmap for a legacy
// OLE equation (Equation.3 / MathType), whose binary is unreadable outside Word.
export type InlineMathDTO = {
  at: number;
  display?: boolean;
  mathml?: string;
  text: string;
  /** The equation as LaTeX — what the Equation sheet opens for editing. Absent for
   *  a legacy OLE object, which is a binary with no readable structure. */
  latex?: string;
  image?: { dataUri?: string; width?: number; height?: number };
};

export type DocBlockDTO =
  | {
      index: number; kind: "paragraph"; text: string; styleId: string | null;
      level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
      alignment: "left" | "center" | "right" | "both" | null;
      direction: "rtl" | "ltr" | null;
      math?: InlineMathDTO[]; anchors?: AnchoredShape[];
      /** Effective typography resolved server-side through the OOXML cascade —
       *  what the MEASURING host paginates with. Display typography is untouched.
       *  Optional: older cached DTOs predate it. */
      fmt?: {
        sizePt: number;
        line: { rule: "auto" | "exact" | "atLeast"; value: number };
        beforePt: number;
        afterPt: number;
      };
    }
  | {
      index: number;
      kind: "table";
      rows: string[][];
      // Pictures per cell, and the list kind of each LINE of a cell's text
      // (cellLists[row][col][lineIndex], lines being rows[row][col].split("\n")).
      // Both are absent when the table has no images / no lists.
      cellImages?: (CellImageDTO | null)[][];
      cellLists?: (DocListKind | null)[][][];
    }
  // A Word SHAPE with text in it — the rounded banner a cover page puts its title
  // in. Structural like a table: it draws as a card and round-trips verbatim.
  // `text` is the HOST paragraph's own runs, which sit beside the floating shape
  // (before this existed, both the box and those runs were silently dropped and
  // the block rendered as an empty "figure" placeholder).
  | {
      index: number;
      kind: "textbox";
      text: string;
      lines: TextBoxLine[];
      shape: TextBoxShape;
      alignment: "left" | "center" | "right" | "both" | null;
      direction: "rtl" | "ltr" | null;
      anchors?: AnchoredShape[];
    }
  // L4c: image blocks (charts/figures). The server inlines small images (charts
  // ≤ ~200KB) as a base64 `dataUri` so the workspace can render the real image;
  // larger figures omit `dataUri` and the app shows a placeholder. `width`/`height`
  // are the intrinsic pixel size (for aspect-fit); `caption` is the adjacent label.
  | {
      index: number;
      kind: "image";
      dataUri?: string;
      // Real image bytes exist for this block (any size). When `dataUri` is absent
      // (figure too large to inline), the app lazily loads the bytes from
      // `thesisBlockImageUrl(id, index)`. Absent → render the "figure" placeholder.
      hasMedia?: boolean;
      // A NATIVE Word chart (word/charts/chartN.xml), rebuilt server-side as vector
      // source from the data the chart part caches about itself. A chart is not a
      // picture — Word stores no image bytes for it, so `dataUri`/`hasMedia` are
      // both absent and these blocks used to draw the empty figure placeholder.
      // Rendered with <SvgXml>, the same path as an equation.
      svg?: string;
      width?: number;
      height?: number;
      caption?: string;
      // A PAGE ORNAMENT frame (add_page_ornament): full-page artwork Word paints
      // BEHIND the page, sitting in a carrier paragraph of its own. It is page
      // decoration, not a figure in the flow — rendering it inline drew a huge empty
      // box above الإهداء / شكر وتقدير — so the writer and the figure lists skip it.
      // It still travels in the DTO: dropping the block would make the Lexical
      // write-back diff delete the ornament from the .docx.
      ornament?: boolean;
      // Floating shapes anchored to this block's carrier paragraph. A chapter
      // divider page is exactly this: the inline ornament frame IS the block, and
      // the chapter title floats over it as anchors[0].
      anchors?: AnchoredShape[];
    }
  | { index: number; kind: "other"; tag: string };

/**
 * A picture placed in a header/footer part (mirror of the server's
 * ChromeDrawingDTO), with the geometry needed to paint it where Word paints it.
 *
 * This is what a thesis cover frame IS: an anchored `behindDoc` picture that
 * deliberately overflows the header rectangle to cover the whole page. Sizes and
 * offsets are in EMU (914400 per inch) — `lib/page-layout.ts` converts.
 */
export type ChromeDrawingDTO = {
  /** Inline bytes when small enough; otherwise absent with `hasMedia` set. */
  dataUri?: string;
  /** Real bytes exist even when they were too big to inline. */
  hasMedia?: boolean;
  widthEmu: number;
  heightEmu: number;
  /** Floating (wp:anchor) rather than in the text flow (wp:inline). */
  anchored: boolean;
  /** Word's "Behind Text" — paints under the body text, not over it. */
  behindDoc: boolean;
  /** "none" | "square" | "tight" | "through" | "topAndBottom" | "inline" */
  wrap: string;
  posH: { relativeTo: string; offsetEmu: number | null; align: string | null };
  posV: { relativeTo: string; offsetEmu: number | null; align: string | null };
  /** Word's Recolor. The cover frame ships as a BLACK png painted in the theme
   *  accent — drawing the raw bytes gives a black border instead of gold. */
  duotone: { dark: string | null; light: string | null;
             shade: number | null; satMod: number | null } | null;
  descr?: string | null;
};

// One Word section's page chrome (mirror of the server's DocSectionDTO).
export type DocSectionDTO = {
  startBlockIndex: number;
  header: {
    text: string;
    // Tab-separated positioned parts (e.g. a right/left running header → two entries)
    // so the writer's band renders the header faithfully, not concatenated.
    segments: string[];
    // The header's bottom rule (Word's header line): present + 6-hex colour|null.
    border: { bottom: boolean; color: string | null };
    // Pictures in the part. A header can be text-free and still carry a full-page
    // frame, so this may be the ONLY reason the header is non-null. Optional:
    // older cached DTOs predate it.
    drawings?: ChromeDrawingDTO[];
  } | null;
  footer: {
    text: string; // "" when the footer is page-numbers-only
    pageNumbers: { format: string; startAt: number | null } | null;
    drawings?: ChromeDrawingDTO[];
  } | null;
  // Word "Link to Previous" state for this section's header+footer (both inherit
  // → true; has its own → false; null = first section). Older cached DTOs predate
  // it, hence optional. Drives the section-break bubble's link toggle.
  linkedToPrevious?: boolean | null;
  // The section begins on a fresh page (vs. a continuous break).
  startsOnNewPage?: boolean;
  /** Page size + margins in twips (1440 = 1 inch). Optional: older cached DTOs
   *  predate it — absent means "assume A4 at 1 inch" (lib/page-layout.ts). */
  page?: {
    widthTwips: number;
    heightTwips: number;
    margins: { top: number; bottom: number; left: number; right: number;
               header: number; footer: number; gutter: number };
  } | null;
  /** This section is a chapter divider page — no page number by design. */
  dividerPage?: boolean;
  /** Ornamented front-matter page ("dedication" | "thanks" | "abstract"), else
   *  null. Also unnumbered by convention. */
  pageOrnament?: string | null;
};

export type DocumentDTO =
  | {
      id: string;
      title: string;
      docMode: "live-docx";
      available: true;
      blocks: DocBlockDTO[];
      // Optional: older SQLite-cached DTOs predate this field.
      sections?: DocSectionDTO[];
      downloadUrl: string;
    }
  | { docMode: string; available: false };

// Fetch the live-.docx block model for a thesis. When `available:false` the
// thesis is still on the legacy section/chapter model — the workspace falls
// back to that render.
export async function getThesisDocument(id: string): Promise<DocumentDTO> {
  return apiGet<DocumentDTO>(`/api/thesis/${id}/document`);
}

// URL that streams a single figure's image bytes (by engine block index) out of
// the live .docx — the on-demand source for figures too large to inline as a
// `dataUri`. Loaded by an <Image> with an Authorization header (see
// `getAuthHeader`); `version` busts the cache after an edit changes the doc.
export function thesisBlockImageUrl(id: string, index: number, version?: number | string): string {
  const v = version != null ? `?v=${encodeURIComponent(String(version))}` : "";
  return `${API_URL}/api/thesis/${id}/document/media/${index}${v}`;
}

// Same, for a picture inside a TABLE cell (DTO `cellImages[row][col]`) — a cell
// picture has no block index of its own, so it is addressed by its coordinates.
export function thesisCellImageUrl(
  id: string,
  index: number,
  row: number,
  col: number,
  version?: number | string,
): string {
  const v = version != null ? `&v=${encodeURIComponent(String(version))}` : "";
  return `${API_URL}/api/thesis/${id}/document/media/${index}?r=${row}&c=${col}${v}`;
}

// Just the Bearer Authorization header (no Content-Type), for attaching to a
// native <Image source={{ uri, headers }}> that hits an authed API route.
export async function getAuthHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ============================================================
// Docx-as-source structural outline (detail screen)
// Mirrors GET /api/thesis/:id/outline. Sections (Partie) derived from the live
// .docx headings, each grouping its chapters (Chapitre). `index` is the engine
// block index → tapping navigates the workspace to that block.
// ============================================================

export type OutlineSectionDTO = {
  index: number;
  title: string;
  chapters: { index: number; title: string }[];
};
// Full multi-level heading tree (Thesis Structure sheet): every heading (H1..H6)
// nests the deeper headings that follow it, like a table of contents. `index` is
// the engine block index → tap navigates the workspace to it; `level` is depth (1+).
export type OutlineNodeDTO = {
  index: number;
  level: number;
  title: string;
  children: OutlineNodeDTO[];
};
export type OutlineDTO =
  | {
      id: string;
      title: string;
      docMode: "live-docx";
      available: true;
      wordCount: number;
      pageCount: number;
      sectionCount: number;
      chapterCount: number;
      headingCount: number;
      sections: OutlineSectionDTO[];
      nodes: OutlineNodeDTO[];
    }
  | { id: string; title: string; docMode: string; available: false };

export async function getThesisOutline(id: string): Promise<OutlineDTO> {
  return apiGet<OutlineDTO>(`/api/thesis/${id}/outline`);
}

// Semantic in-document search ("search by meaning"): the server embeds `q` and
// cosine-searches the thesis's RAG block index. `blockIndex` is the engine
// block index — feed it straight to requestScrollToBlock. `indexing: true`
// means the index is (re)building in the background; try again shortly.
export type ThesisSearchHit = {
  blockIndex: number;
  headingPath: string | null;
  snippet: string;
  score: number;
};
export async function searchThesisSemantic(
  id: string,
  q: string,
  k = 8,
): Promise<{ results: ThesisSearchHit[]; indexing?: boolean }> {
  return apiGet(`/api/thesis/${id}/search?q=${encodeURIComponent(q)}&k=${k}`);
}

// OnlyOffice Docs editor config (signed DocEditor config + the public Document
// Server URL). `enabled:false` when the server has no Document Server configured
// → the workspace falls back to the docx-preview viewer (WordDocxView). The
// signed `config.document.key` changes whenever the .docx changes, so a fresh
// fetch after an AI turn forces the OnlyOffice view to reload the new bytes.
export type EditorConfigDTO =
  | { enabled: false }
  | { enabled: true; documentServerUrl: string; config: any };

export async function getThesisEditorConfig(id: string): Promise<EditorConfigDTO> {
  return apiGet<EditorConfigDTO>(`/api/thesis/${id}/editor-config`);
}

// Signed URL to a TEMPORARY PDF render of the live .docx (converted on demand by
// the OnlyOffice Document Server, not persisted). `available:false` when no
// Document Server is configured ("disabled"), the thesis has no .docx
// ("not-seeded"), or the conversion failed ("failed") → the PDF view shows the
// matching message. Re-fetched after each AI turn so the preview reflects edits;
// the preview object is removed via deleteThesisPdf when the view closes.
export type ThesisPdfDTO =
  | { available: true; url: string }
  | { available: false; reason: "disabled" | "not-seeded" | "failed" };

export async function getThesisPdf(id: string): Promise<ThesisPdfDTO> {
  return apiGet<ThesisPdfDTO>(`/api/thesis/${id}/pdf`);
}

// Discard the transient PDF preview — called when the user switches away from the
// PDF view or leaves the workspace, so the throwaway render isn't kept around.
export async function deleteThesisPdf(id: string): Promise<void> {
  return apiDelete(`/api/thesis/${id}/pdf`);
}

// Export the thesis to a downloadable file (default .docx) → signed URL.
export async function exportThesis(thesisId: string, format: "docx" | "latex" = "docx") {
  return apiPost<{ success: boolean; url: string; filename: string; format: string; bytes: number; pageCount?: number }>(`/api/export/${thesisId}`, { format });
}

// ============================================================
// Source materials API (helper files mounted at /api/thesis/:id/sources)
// ============================================================

export async function listSources(thesisId: string) {
  return apiGet<ThesisSource[]>(`/api/thesis/${thesisId}/sources`);
}

// Add a reference file. The file is sent as base64 (binary/multipart bodies are
// unreliable from RN); the server stores it and extracts its text for the AI.
export async function addSource(
  thesisId: string,
  input: { base64: string; filename: string; title?: string; description?: string }
) {
  return apiPost<ThesisSource>(`/api/thesis/${thesisId}/sources`, input);
}

export async function deleteSource(thesisId: string, sourceId: string) {
  return apiDelete(`/api/thesis/${thesisId}/sources/${sourceId}`);
}

// ============================================================
// Enhance API
// ============================================================

export async function checkGrammar(text: string, language?: string) {
  return apiPost<any>("/api/enhance/grammar", { text, language });
}

export async function paraphraseText(text: string, language?: string) {
  return apiPost<any>("/api/enhance/paraphrase", { text, language });
}

export async function generateCitations(topic: string, style?: string) {
  return apiPost<any>("/api/enhance/citations", { topic, style });
}

// ============================================================
// User API
// ============================================================

export async function getProfile() {
  return apiGet<any>("/api/user/profile");
}

export async function updateProfile(updates: any) {
  return apiPut<any>("/api/user/profile", updates);
}

// Upload a profile picture. The image is sent as base64 (binary/multipart bodies
// are unreliable from RN); the server stores it and returns the updated profile.
export async function uploadAvatar(base64: string, mimeType: string) {
  return apiPost<any>("/api/user/avatar", { base64, mimeType });
}

// Permanently delete the account and all associated data (irreversible). The
// caller is responsible for signing the user out afterwards — the auth user no
// longer exists, so the cached session is dead.
export async function deleteAccount() {
  return apiDelete("/api/user/account");
}

// ============================================================
// Notifications API (server router mounted at /api/notifications)
// ============================================================

export async function listNotifications(opts?: {
  limit?: number;
  before?: string; // ISO createdAt cursor — returns only older notifications
}) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", opts.before);
  const query = params.toString();
  return apiGet<AppNotification[]>(
    `/api/notifications${query ? `?${query}` : ""}`
  );
}

export async function getUnreadCount() {
  return apiGet<{ count: number }>("/api/notifications/unread-count");
}

export async function markNotificationRead(id: string) {
  return apiPut<{ success: true }>(`/api/notifications/${id}/read`, {});
}

export async function markAllNotificationsRead() {
  return apiPut<{ success: true }>("/api/notifications/read-all", {});
}

export async function deleteNotification(id: string) {
  return apiDelete(`/api/notifications/${id}`) as Promise<void>;
}

export async function clearAllNotifications() {
  return apiDelete("/api/notifications") as Promise<void>;
}

export async function registerPushToken(token: string, platform: string) {
  return apiPost<{ success: true }>("/api/notifications/push-token", {
    token,
    platform,
  });
}

export async function unregisterPushToken(token: string) {
  return apiDeleteWithBody<{ success: true }>("/api/notifications/push-token", {
    token,
  });
}

export async function getNotificationPreferences() {
  return apiGet<NotificationPreferences>("/api/notifications/preferences");
}

export async function updateNotificationPreferences(
  patch: Partial<NotificationPreferences>
) {
  return apiPut<NotificationPreferences>(
    "/api/notifications/preferences",
    patch
  );
}

// ============================================================
// News
// ============================================================

const EMPTY_COPY: NewsCopy = { title: "", sum: "", body: "" };

// Resolve the article copy for the current UI language, falling back across the
// other languages so a post is never blank just because one translation is missing.
function pickCopy(row: NewsRow): NewsCopy {
  const lang = (i18n.language || "en").split("-")[0];
  const byLang: Record<string, NewsCopy | null> = {
    en: row.contentEng,
    fr: row.contentFr,
    ar: row.contentAr,
  };
  return byLang[lang] ?? row.contentEng ?? row.contentFr ?? row.contentAr ?? EMPTY_COPY;
}

function toArticle(row: NewsRow): NewsArticle {
  const copy = pickCopy(row);
  return {
    id: row.id,
    slug: row.slug,
    category: row.category,
    imageUrl: row.coverUrl ?? undefined,
    title: copy.title,
    summary: copy.sum,
    body: copy.body,
    ctaLabel: row.ctaLabel ?? undefined,
    ctaHref: row.ctaHref ?? undefined,
    pinned: row.pinned,
    views: row.views ?? 0,
    publishedAt: row.publishedAt ?? row.createdAt ?? "",
  };
}

export async function listNews(opts?: {
  q?: string;
  category?: string;
  page?: number;
  limit?: number;
}): Promise<{ news: NewsArticle[]; pagination: NewsPagination }> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.category && opts.category !== "all") params.set("category", opts.category);
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await apiGet<{ news: NewsRow[]; pagination: NewsPagination }>(
    `/api/news${qs ? `?${qs}` : ""}`
  );
  return { news: res.news.map(toArticle), pagination: res.pagination };
}

export async function getNewsArticle(idOrSlug: string): Promise<NewsArticle> {
  const res = await apiGet<{ news: NewsRow }>(`/api/news/${idOrSlug}`);
  return toArticle(res.news);
}

export async function getNewsCategories(): Promise<string[]> {
  const res = await apiGet<{ categories: string[] }>(`/api/news/categories`);
  return res.categories;
}

export async function recordNewsClick(idOrSlug: string) {
  return apiPost<{ message: string; clicks: number }>(
    `/api/news/${idOrSlug}/click`,
    {}
  );
}

// ============================================================
// Documents API (imported .docx, mounted at /api/documents)
// ============================================================

// Import a .docx → new document. The file is sent as base64 (binary/multipart
// bodies are unreliable from RN); the server copies it into storage and parses it.
export async function importDocument(
  base64: string,
  filename: string,
  language?: string
): Promise<DocumentRecord> {
  return apiPost<DocumentRecord>("/api/documents/import", { base64, filename, language });
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  return apiGet<DocumentRecord[]>("/api/documents");
}

export async function getDocument(id: string): Promise<DocumentRecord> {
  return apiGet<DocumentRecord>(`/api/documents/${id}`);
}

export async function getDocumentContent(id: string): Promise<DocumentContent> {
  return apiGet<DocumentContent>(`/api/documents/${id}/content`);
}

// Short-lived signed URL for opening the real .docx in the OS viewer.
export async function getDocumentDownload(
  id: string
): Promise<{ url: string; filename: string }> {
  return apiGet<{ url: string; filename: string }>(`/api/documents/${id}/download`);
}

// OnlyOffice editor config to VIEW an imported .docx (same shape as the thesis
// editor-config; `{ enabled:false }` → the app falls back to docx-preview).
export async function getDocumentEditorConfig(id: string): Promise<EditorConfigDTO> {
  return apiGet<EditorConfigDTO>(`/api/documents/${id}/editor-config`);
}

export async function editDocumentParagraph(
  id: string,
  index: number,
  changes: { text?: string; alignment?: Align; styleId?: string }
): Promise<ParagraphMutationResult> {
  return apiPut<ParagraphMutationResult>(`/api/documents/${id}/paragraphs/${index}`, changes);
}

// Manual single-paragraph edit of a live-.docx THESIS (the in-app block editor).
// Distinct from editDocumentParagraph above, which targets the imported-documents
// feature; theses are edited through their own thesis-scoped route (which shares
// the AI's thesis lock). `index` is the engine block index from the document DTO.
export async function editThesisParagraph(
  thesisId: string,
  index: number,
  changes: { text?: string; level?: number; alignment?: "left" | "center" | "right" | "justify"; direction?: "rtl" | "ltr"; clearFormatting?: boolean }
): Promise<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPut<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/paragraphs/${index}`, changes);
}

// Split a live-.docx paragraph at the caret: block `index` keeps `before`, and a
// NEW paragraph holding `after` is inserted right after it (inheriting the source's
// style + direction/alignment). Engine block index. Shares the AI's thesis lock.
export async function splitThesisParagraph(
  thesisId: string,
  index: number,
  body: { before: string; after: string }
): Promise<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/paragraphs/${index}/split`, body);
}

// Bulk-apply ONE formatting change (level / alignment / direction / clearFormatting —
// text is per-paragraph, so it's excluded) to several live-.docx paragraph blocks at
// once: the workspace multi-select edit tools. Non-paragraph blocks in `indices` are
// skipped server-side. One locked pass, so it can't race the AI. Engine block indices.
export async function editThesisParagraphs(
  thesisId: string,
  indices: number[],
  changes: { level?: number; alignment?: "left" | "center" | "right" | "justify"; direction?: "rtl" | "ltr"; clearFormatting?: boolean }
): Promise<{ ok: true; changed: number; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; changed: number; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/paragraphs/bulk`, { indices, ...changes });
}

// Batch several manual edit ops into ONE server call + ONE .docx save + ONE history
// entry (the block-editor write-back path). Ops are POSITIONAL and replayed in order
// under a single thesis lock, exactly like the per-op routes — turning N round-trips
// into one. Echoes the mutated document so the caller reconciles without a re-GET.
// `ops` is the durable ThesisOp[] shape (typed loosely here to avoid a circular import).
export async function applyThesisOps(
  thesisId: string,
  ops: unknown[],
): Promise<{ ok: true; applied: number; skipped: string[]; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; applied: number; skipped: string[]; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/ops`, { ops });
}

// Direct (non-AI) header/footer/section-break edits for the writer's chrome-band
// bubble. `index` is a block index INSIDE the target Word section (the band's
// startBlockIndex). Server applies via the mdocxengine section API and echoes the
// mutated document for the optimistic doc store.
export type ChromeOp =
  | { op: "setHeaderText"; index: number; text: string }
  | { op: "setFooter"; index: number; text: string; pageNumbers: boolean; alignment?: "left" | "center" | "right" }
  | { op: "startOnNewPage"; index: number; breakType?: "nextPage" | "evenPage" | "oddPage" }
  // Word's "Link to Previous" toggle for this section's whole running chrome
  // (header + footer). Link → the section inherits the previous section's;
  // unlink → it gets its own independent copy. `index` is the section's start block.
  | { op: "linkToPrevious"; index: number }
  | { op: "unlinkFromPrevious"; index: number }
  // Apply a saved Header/Footer Studio template (full OOXML: running-title
  // segments, tables, live fields, embedded logos) to the section containing
  // `index`. `region` scopes it: the header band applies "header", the footer
  // band applies "footer" (omit → both). `values` fills the template's {tokens}
  // (see HfTemplateSummary.tokens) with what the student typed — omit for a
  // template with no tokens.
  | { op: "applyTemplate"; index: number; templateId: string; region?: "header" | "footer"; values?: Record<string, string> }
  // Apply an AI-GENERATED model (from generateChromeModel below) — same full-OOXML
  // apply path as a saved template, just not persisted as one. `model` is exactly
  // what the app was shown in the preview (opaque — validated server-side).
  | { op: "applyModel"; index: number; model: Record<string, unknown>; region?: "header" | "footer" };

export async function chromeOp(
  thesisId: string,
  op: ChromeOp,
): Promise<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO; note?: string }> {
  return apiPost<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO; note?: string }>(`/api/thesis/${thesisId}/chrome-op`, op);
}

// ── Captions (Word's References → Insert Caption) ───────────────────────────
//
// A caption is the real Word object — the `Caption` style, a self-numbering `SEQ`
// field and a bookmark — so the numbers renumber themselves and a List of Figures
// can collect them. The app never composes the "Figure 3" prefix: the label comes
// from the picker and the number from the field.

/** Word's Caption Numbering → Format list. */
export type CaptionNumberFormat = "arabic" | "ROMAN" | "roman" | "ALPHABETIC" | "alphabetic";
/** Word's "Use separator" list: hyphen, period, colon, en-dash, em-dash. */
export type CaptionSeparator = "-" | "." | ":" | "\u2013" | "\u2014";

export interface CaptionDTO {
  /** Block index of the caption paragraph (engine block space). */
  index: number;
  /** The label as it reads in the document ("Figure", "الشكل رقم"), "" if excluded. */
  label: string;
  /** The number the field currently shows. */
  number: string;
  /** The caption wording, without label or number. */
  text: string;
  /** True when the caption lives inside a table cell — `index` is then the table's. */
  inTable: boolean;
}

export interface CaptionsDTO {
  /** The document reads right-to-left (drives the sheet's default direction). */
  rtl: boolean;
  /** Labels for the picker: the document's own first, then the usual ones. */
  labels: { label: string; count: number }[];
  captions: CaptionDTO[];
}

export async function listThesisCaptions(thesisId: string): Promise<CaptionsDTO> {
  return apiGet<CaptionsDTO>(`/api/thesis/${thesisId}/captions`);
}

export interface InsertCaptionBody {
  /** Block the caption describes (the figure, table or equation). */
  nearIndex: number;
  label: string;
  text: string;
  position?: "above" | "below";
  /** Word's "Exclude label from caption" — number only. */
  excludeLabel?: boolean;
  format?: CaptionNumberFormat;
  includeChapterNumber?: boolean;
  /** "Heading1".."Heading9" — only with includeChapterNumber. */
  chapterStyle?: string;
  chapterSeparator?: CaptionSeparator;
}

/** Insert a caption. Shifts later block indices by +1 — reconcile from `document`. */
export async function insertThesisCaption(
  thesisId: string,
  body: InsertCaptionBody,
): Promise<{ ok: true; index: number; number: string | null; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost(`/api/thesis/${thesisId}/captions`, body);
}

/** Re-word a caption, keeping its label, number and bookmark. */
export async function updateThesisCaption(
  thesisId: string,
  index: number,
  text: string,
): Promise<{ ok: true; index: number; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPut(`/api/thesis/${thesisId}/captions/${index}`, { text });
}

// ── Equations ───────────────────────────────────────────────────────────────
// LaTeX travels in both directions; only the server ever sees OMML. `preview`
// validates and typesets WITHOUT touching the document, so the sheet can refuse a
// malformed formula before it reaches the .docx.

/** Typeset LaTeX for the sheet's live preview. `ok:false` = a parse error to show. */
export async function previewThesisEquation(
  thesisId: string,
  latex: string,
): Promise<{ ok: true; mathml: string; text: string } | { ok: false; error: string }> {
  return apiPost(`/api/thesis/${thesisId}/equations/preview`, { latex });
}

/**
 * Ask the AI to write or rewrite an equation from a plain-language instruction
 * ("add a shear term", "اكتب معادلة مساحة الدائرة"). Returns LaTeX for the sheet's
 * field — nothing is written to the document, so the student reviews the typeset
 * proposal and decides. The server validates by converting it, so what comes back
 * is always a formula that can actually become a Word equation.
 */
export async function askThesisEquationAI(
  thesisId: string,
  body: { prompt: string; latex?: string },
): Promise<{ ok: true; latex: string; mathml: string; text: string } | { ok: false; error: string }> {
  return apiPost(`/api/thesis/${thesisId}/equations/ai`, body);
}

/** Insert an equation as its own centred paragraph after `afterIndex` (-1 = first). */
export async function insertThesisEquation(
  thesisId: string,
  body: { latex: string; afterIndex: number; number?: string },
): Promise<{ ok: true; index: number; latex: string; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost(`/api/thesis/${thesisId}/equations`, body);
}

/** Replace the equation in a block, keeping its paragraph, tabs and number. */
export async function updateThesisEquation(
  thesisId: string,
  index: number,
  latex: string,
): Promise<{ ok: true; index: number; latex: string; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPut(`/api/thesis/${thesisId}/equations/${index}`, { latex });
}

/* ── native Word charts ────────────────────────────────────────────────────── */

/** The writable chart kinds. "bar" is vertical columns, "barH" horizontal bars. */
export type ChartKind = "pie" | "pie3D" | "doughnut" | "bar" | "barH" | "line" | "area";

/**
 * One NATIVE Word chart (`word/charts/chartN.xml`) — a real chart object, not the
 * flat picture the AI's insert_chart embeds. The block renders from `svg`; this is
 * what the chart bubble edits.
 */
export type ThesisChartDTO = {
  /** Engine block index — the same index every other block API uses. */
  index: number;
  /** "other" for a plot we can read but not write (radar, scatter, surface…). */
  kind: ChartKind | "other";
  plotTag: string;
  title?: string;
  labels: string[];
  values: number[];
  series: { name?: string; values: number[]; color?: string }[];
  /** Slice colours on a pie, series colours otherwise — resolved through the theme. */
  colors: (string | undefined)[];
  legend: "r" | "l" | "t" | "b" | "none";
  showPercent: boolean;
  showValues: boolean;
};

/** What a chart edit can change. Every field is optional; omitted = left alone. */
export type ThesisChartPatch = {
  labels?: string[];
  values?: number[];
  seriesValues?: number[][];
  /** "" or null removes the chart's own title (not the Figure caption). */
  title?: string | null;
  legend?: "r" | "l" | "t" | "b" | "none";
  showPercent?: boolean;
  showValues?: boolean;
  showCategories?: boolean;
  colors?: (string | null)[];
  type?: ChartKind;
  holeSize?: number;
};

/** Every native chart in the document, in document order. */
export async function getThesisCharts(thesisId: string): Promise<{ charts: ThesisChartDTO[] }> {
  return apiGet(`/api/thesis/${thesisId}/charts`);
}

/** One chart in full — what the chart editor sheet opens with. */
export async function getThesisChart(thesisId: string, index: number): Promise<{ chart: ThesisChartDTO }> {
  return apiGet(`/api/thesis/${thesisId}/charts/${index}`);
}

/**
 * Edit a chart in place. POSITIONAL-SAFE — no block is added or removed, so indices
 * never shift and the response's `document` can be applied straight to the store.
 *
 * `workbookSynced` is always false: Word draws the new values, but its "Edit Data"
 * button still opens the chart's original embedded workbook.
 */
export async function updateThesisChart(
  thesisId: string,
  index: number,
  patch: ThesisChartPatch,
): Promise<{
  ok: true;
  index: number;
  changed?: string[];
  unchanged?: boolean;
  chart: ThesisChartDTO;
  workbookSynced?: false;
  document?: DocumentDTO;
  history?: HistoryStateDTO;
}> {
  return apiPatch(`/api/thesis/${thesisId}/charts/${index}`, patch);
}

/**
 * PROPOSE a chart edit without applying it — the chart counterpart to the
 * paragraph/table inline suggestions. The server renders the preview by patching a
 * COPY of the chart part, so nothing is written until the student approves.
 *
 * `patch` is the exact change the preview shows; approving replays it through
 * `updateThesisChart`, so what is approved is what was seen.
 * `nothingToDo` = the model understood but had nothing to change.
 */
export async function suggestThesisChart(
  thesisId: string,
  index: number,
  instruction: string,
): Promise<{
  ok: true;
  index?: number;
  patch?: ThesisChartPatch;
  summary?: string;
  svg?: string;
  chart: ThesisChartDTO;
  nothingToDo?: boolean;
}> {
  return apiPost(`/api/thesis/${thesisId}/charts/${index}/suggest`, { instruction });
}

/** Delete a caption and renumber the rest of its sequence. */
export async function deleteThesisCaption(
  thesisId: string,
  index: number,
): Promise<{ ok: true; index: number; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiDeleteWithBody(`/api/thesis/${thesisId}/captions/${index}`, {});
}

/** Insert a List of Figures / List of Tables for `label` (References → Insert
 *  Table of Figures). Place it OUTSIDE any existing list. */
export async function insertThesisCaptionList(
  thesisId: string,
  body: { label: string; title?: string; atIndex?: number },
): Promise<{ ok: true; entries: number; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost(`/api/thesis/${thesisId}/caption-list`, body);
}

// A compact, render-agnostic preview digest of a template's header/footer that the
// writer's bubble stacks before applying. A line is a list of slots (start/center/
// end for paragraphs; cells for tables); a slot is a list of segments; fields stay
// as typed tokens ({ field: "pageNumber" | … }) so the app localizes them, and a
// { token } seg is a student-filled {placeholder} rendered as a fillable chip.
export type HfPreviewSeg = { text: string } | { field: string } | { logo: true } | { token: string };
export type HfPreviewLine = HfPreviewSeg[][];
export type HfPreview = { header: HfPreviewLine[]; footer: HfPreviewLine[] };

// A staff-authored header/footer template (from the dashboard HF Studio) the
// writer can apply to a section. List view only — the model/OOXML stays server-side.
// `tokens` = the distinct {placeholder} names the student must fill before this
// template applies (empty for a fully-literal template).
export type HfTemplateSummary = {
  id: string;
  name: string;
  language: string;
  university: string | null;
  discipline: string | null;
  preview?: HfPreview;
  tokens?: string[];
};

// List the active HF Studio templates (optionally filtered to one language) so
// the chrome-band bubble can offer them. Applied via chromeOp({op:"applyTemplate"}).
export async function listHfTemplates(language?: string): Promise<{ templates: HfTemplateSummary[] }> {
  const q = language ? `?language=${encodeURIComponent(language)}` : "";
  return apiGet<{ templates: HfTemplateSummary[] }>(`/api/hf-templates${q}`);
}

// The single ✦ entry point for a header/footer band: the AI drafts a full model
// grounded on the section's content, the CURRENT header/footer, and the
// university's own Studio templates (server-side style reference) — one prompt in,
// a faithful preview out. Nothing is applied; approve via
// chromeOp({op:"applyModel", model}). `index` is a block inside the target section.
export async function generateChromeModel(
  thesisId: string,
  index: number,
  kind: "top" | "bottom",
  instruction: string,
): Promise<{ model: Record<string, unknown>; preview: HfPreview; warnings: string[] }> {
  return apiPost<{ model: Record<string, unknown>; preview: HfPreview; warnings: string[] }>(
    `/api/thesis/${thesisId}/chrome-generate`,
    { index, kind, instruction },
  );
}

// Bulk-delete several live-.docx thesis blocks at once (the workspace multi-select).
// `indices` are engine block indices; the server removes them high-to-low so they
// stay valid as the list shrinks. Shares the AI's thesis lock.
// Move one block from engine index `from` to index `to` (drag-reorder / up-down).
export async function moveThesisBlock(
  thesisId: string,
  from: number,
  to: number
): Promise<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/blocks/move`, { from, to });
}

// Insert a base64 image as a new block AFTER `afterIndex` (-1 = top). width/height
// are the image's pixel size (server clamps the on-page width).
export async function insertThesisImage(
  thesisId: string,
  img: { data: string; format: string; width?: number; height?: number; afterIndex: number }
): Promise<{ ok: true; newIndex: number; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; newIndex: number; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/blocks/image`, img);
}

// One FIGURE out of an attached source .docx, as base64 + its size in the source.
// The writer's inline "insert the figure from the attached file" proposal uses this
// twice: to PREVIEW the picture in the suggestion card, and — on approve — as the
// bytes for the normal insertImage op, so what lands in the thesis is exactly what
// the student saw. `index` is the figure's block index inside the SOURCE document
// (the model picks it from the server's figure catalogue).
export async function fetchThesisSourceImage(
  thesisId: string,
  sourceId: string,
  index: number
): Promise<{ format: string; mime: string; width: number; height: number; data: string }> {
  return apiGet<{ format: string; mime: string; width: number; height: number; data: string }>(
    `/api/thesis/${thesisId}/sources/${sourceId}/images/${index}`,
  );
}

// Replace the image bytes of an existing figure block (engine block `index`) with
// new bytes produced on-device (crop / rotate / replace). `width`/`height` are the
// NEW pixel size — when the aspect ratio changed the server rescales the drawing so
// the picture isn't stretched.
export async function replaceThesisBlockImage(
  thesisId: string,
  index: number,
  img: { data: string; format: string; width?: number; height?: number }
): Promise<{ ok: true; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/blocks/${index}/image`, img);
}

// Remove the background from a figure block's image (server-side via the rembg
// sidecar → re-embeds a transparent PNG). No image bytes travel through the app.
export async function removeThesisBlockBg(
  thesisId: string,
  index: number
): Promise<{ ok: true; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/blocks/${index}/remove-bg`, {});
}

export async function deleteThesisBlocks(
  thesisId: string,
  indices: number[]
): Promise<{ ok: true; deleted: number; skipped: number; document?: DocumentDTO; history?: HistoryStateDTO }> {
  // `skipped` counts protected non-paragraph blocks (cover logo / jury table) the
  // server refused to delete.
  return apiPost<{ ok: true; deleted: number; skipped: number; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/blocks/delete`, { indices });
}

// Make each selected block start on a new page (a next-page section break), in one
// locked pass. `indices` are engine block indices.
export async function startThesisBlocksOnNewPage(
  thesisId: string,
  indices: number[],
  breakType?: "nextPage" | "evenPage" | "oddPage"
): Promise<{ ok: true; changed: number; document?: DocumentDTO; history?: HistoryStateDTO }> {
  return apiPost<{ ok: true; changed: number; document?: DocumentDTO; history?: HistoryStateDTO }>(`/api/thesis/${thesisId}/blocks/start-on-new-page`, { indices, breakType });
}

// ── Doc history (undo/redo snapshot ring buffer) ─────────────────────────────

export interface HistoryEntryDTO {
  seq: number;
  label: string;
  source: "ai" | "manual" | "onlyoffice" | "restore" | "import";
  turnId: string | null;
  createdAt: string | null;
}

export interface HistoryStateDTO {
  canUndo: boolean;
  canRedo: boolean;
}

export async function getThesisHistory(thesisId: string) {
  return apiGet<{ entries: HistoryEntryDTO[]; cursorSeq: number | null } & HistoryStateDTO>(
    `/api/thesis/${thesisId}/history`,
  );
}

export type HistoryRestoreResponse = { ok: true; document: DocumentDTO } & HistoryStateDTO;

export async function undoThesisHistory(thesisId: string) {
  return apiPost<HistoryRestoreResponse>(`/api/thesis/${thesisId}/history/undo`, {});
}

export async function redoThesisHistory(thesisId: string) {
  return apiPost<HistoryRestoreResponse>(`/api/thesis/${thesisId}/history/redo`, {});
}

export async function restoreThesisHistory(thesisId: string, seq: number) {
  return apiPost<HistoryRestoreResponse>(`/api/thesis/${thesisId}/history/restore`, { seq });
}

export interface ThesisPageSetup {
  marginPreset?: "normal" | "narrow" | "moderate" | "wide" | "mirrored";
  orientation?: "portrait" | "landscape";
  pageSize?: "A4" | "USLetter" | "USLegal" | "A3" | "A5";
  columns?: 1 | 2 | 3;
}

/** Document-wide page setup (margins / orientation / size / columns). Byte-safe on
 *  the server; pass only the field(s) you want to change. */
export async function setThesisPageSetup(
  thesisId: string,
  setup: ThesisPageSetup,
): Promise<{ ok: true; applied: string[] }> {
  return apiPost<{ ok: true; applied: string[] }>(`/api/thesis/${thesisId}/page-setup`, setup);
}

export async function addDocumentParagraph(
  id: string,
  body: { index?: number; text: string; styleId?: string; alignment?: Align }
): Promise<ParagraphMutationResult> {
  return apiPost<ParagraphMutationResult>(`/api/documents/${id}/paragraphs`, body);
}

export async function deleteDocumentParagraph(
  id: string,
  index: number
): Promise<{ document: DocumentRecord }> {
  return apiDeleteWithBody<{ document: DocumentRecord }>(
    `/api/documents/${id}/paragraphs/${index}`,
    {}
  );
}

export async function deleteDocument(id: string): Promise<void> {
  return apiDelete(`/api/documents/${id}`);
}

// ── Billing ──────────────────────────────────────────────────────────────────
// The message counter, the plan catalogue, and the Chargily checkout.
//
// Prices are NEVER hardcoded here. The catalogue comes from the server so the
// screen can only ever quote a number the server would actually honour — a
// hardcoded price that drifts is a student charged one amount and shown another.

/**
 * What the student has left: the message counter AND the thesis allowance.
 *
 * Cheap; safe to call on focus. `theses` is absent on a server that predates the
 * thesis limit — the store keeps its last-known value rather than inventing one.
 */
export async function fetchQuota(): Promise<QuotaResponse> {
  return apiGet<QuotaResponse>("/api/payment/quota");
}

/** The plans on offer, plus whether payments are configured at all. */
export async function fetchPlanCatalogue(): Promise<PlanCatalogue> {
  return apiGet<PlanCatalogue>("/api/payment/plans");
}

export async function fetchSubscription(): Promise<SubscriptionState> {
  return apiGet<SubscriptionState>("/api/payment/subscription");
}

/**
 * Open a Chargily checkout and get the hosted page's URL.
 *
 * The app never sees card details — Chargily's page collects them. `locale` is
 * passed so the payment page comes up in the language the student is using.
 */
export async function startCheckout(
  input: { plan: PlanCode } | { kind: "topup" },
  locale: string
): Promise<{ checkoutUrl: string; checkoutId: string; amountDzd: number; mode: "test" | "live" }> {
  return apiPost("/api/payment/checkout", { ...input, locale });
}

/** Ends the plan at the END of the paid term, not immediately. */
export async function cancelSubscription(): Promise<{ canceled: boolean; activeUntil: string }> {
  return apiPost("/api/payment/cancel", {});
}

// ============================================================
// Support API (server router mounted at /api/support)
// ============================================================

export type SupportStatus = "open" | "pending" | "resolved";

export type SupportMessage = {
  id: string;
  sender: "student" | "staff";
  authorName: string;
  body: string;
  createdAt: string;
};

export type SupportConversation = {
  id: string;
  subject: string;
  status: SupportStatus;
  topic: string | null;
  language: string;
  thesisId: string | null;
  /** Unread staff replies waiting for the student. */
  unread: number;
  lastMessageAt: string;
  createdAt: string;
};

export type SupportConversationSummary = SupportConversation & {
  lastMessage: string;
  lastSender: "student" | "staff";
};

export type SupportConversationDetail = SupportConversation & {
  messages: SupportMessage[];
};

/** The student's own support threads, most recent activity first. */
export async function listSupportConversations() {
  return apiGet<SupportConversationSummary[]>("/api/support/conversations");
}

/** One thread with its messages. Fetching it clears the student's unread badge. */
export async function getSupportConversation(id: string) {
  return apiGet<SupportConversationDetail>(`/api/support/conversations/${id}`);
}

/**
 * File a new support ticket. Only `message` is required — the rest is context
 * that helps whoever answers (which thesis, which app build, which topic).
 */
export async function createSupportConversation(input: {
  message: string;
  subject?: string;
  topic?: string;
  language?: string;
  thesisId?: string | null;
  appVersion?: string;
  platform?: string;
}) {
  return apiPost<SupportConversation>("/api/support/conversations", input);
}

/** Add to an existing thread. A student reply reopens a resolved ticket. */
export async function replyToSupportConversation(id: string, message: string) {
  return apiPost<SupportMessage>(`/api/support/conversations/${id}/messages`, { message });
}
