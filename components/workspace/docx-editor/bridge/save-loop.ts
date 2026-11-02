// The student's edits leave as WHOLE BYTES (spec D2): `editor.save()` → PUT
// /api/thesis/:id/docx, debounced on typing pauses and forced by `flush()`
// (the `flushEdits` contract ai-service awaits before a turn). Every PUT carries
// `If-Match: "<hash we loaded or last saved>"`; a 412 means the server moved
// under us — a second device, the web — and is REPORTED, never merged (D4). The
// host decides what to do with a stale state; this loop just refuses to guess.
//
// Saves are chained. A flush landing while a save is in flight waits for it and
// then saves against the hash that save returned — two PUTs racing would have the
// second one refused with a 412 it did not deserve.
//
// No React, no engine: `getBytes` is injected (the DOM component binds it to
// `ref.save()`), which is what makes this testable under node.

import { settleWithin } from "./pending-save";

export type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number; docHash: string | null }
  // `recovered`: where the refused bytes were kept (pending-save.ts), when they were.
  | { kind: "stale"; serverHash: string | null; recovered?: { key: string; at: number } | null }
  | { kind: "error"; message: string };

/** The offline copy (spec D6, bridge/pending-save.ts) as the loop sees it. Every
 *  call is bounded and best-effort: a broken store must never cost the save. */
export type PendingPort = {
  put(bytes: ArrayBuffer, baseHash: string | null): Promise<void>;
  clear(): Promise<void>;
  keep(): Promise<{ key: string; at: number } | null>;
};

// Long enough for IndexedDB to commit a few MB; short enough that a hung store is
// a pause, not a save that never leaves.
const PENDING_MS = 2000;

// A save that failed comes back by itself. The page already shows the edit, so a
// student has no reason to touch it again — and a flaky uplink (seen 11-02) would
// otherwise leave the server behind the screen until their next keystroke.
const RETRY_MS = [5000, 15000, 30000, 60000];

export interface SaveLoop {
  markDirty(): void;
  flush(): Promise<void>;
  setHash(h: string | null): void;
  getHash(): string | null;
  /** Fires after every SUCCESSFUL PUT with the bytes that were saved (never on a
   *  412 or a network error). The bridge uses it to re-parse its own bytes after
   *  a structural edit (spec D7). Returns the unsubscribe. */
  onSaved(fn: (bytes: ArrayBuffer) => void): () => void;
  dispose(): void;
  /** Whether there are edits no successful PUT has carried yet (pending debounce,
   *  or a save that failed / was refused). */
  isDirty(): boolean;
  /** The engine's bytes were REPLACED (a reload): what was dirty described the old
   *  ones. Drops the flag and the armed debounce without saving. */
  discard(): void;
  /** The last save attempt FAILED (network, expired token, 5xx) — as opposed to
   *  landing, or being refused as stale (412). A reload must not replace the page
   *  then: the student's unsaved text would leave the screen with nowhere to go but
   *  IndexedDB. A 412 is different — the server moved and the refused bytes were
   *  kept as a recovery copy, so reloading is the right answer. */
  lastSaveFailed(): boolean;
}

export function createSaveLoop(o: {
  apiBase: string;
  thesisId: string;
  token: () => string | null;
  getBytes: () => Promise<ArrayBuffer | null>;
  onState: (s: SaveState) => void;
  debounceMs?: number;
  fetchImpl?: typeof fetch;
  pending?: PendingPort;
}): SaveLoop {
  const f = o.fetchImpl ?? fetch;
  const debounceMs = o.debounceMs ?? 1500;
  let hash: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  let failed = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const savedListeners = new Set<(bytes: ArrayBuffer) => void>();

  function cancelRetry(): void {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function armRetry(): void {
    if (disposed) return;
    cancelRetry();
    const ms = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
    failures += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (dirty && !disposed) void scheduleSaveNow();
    }, ms);
  }

  async function saveOnce(): Promise<void> {
    if (disposed) return;
    const token = o.token();
    if (!token) { dirty = true; failed = true; armRetry(); o.onState({ kind: "error", message: "no token" }); return; }
    o.onState({ kind: "saving" });
    try {
      const bytes = await o.getBytes();
      if (!bytes) throw new Error("editor returned no bytes");
      // Durable BEFORE the request leaves: a kill mid-PUT, or no network at all,
      // leaves these bytes for the next open to show and replay (spec D6).
      await settleWithin(o.pending?.put(bytes, hash), PENDING_MS);
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Authorization: `Bearer ${token}`,
      };
      if (hash) headers["If-Match"] = `"${hash}"`;
      const res = await f(`${o.apiBase}/api/thesis/${o.thesisId}/docx`, { method: "PUT", headers, body: bytes });
      const body = (await res.json().catch(() => ({}))) as { docHash?: string | null; error?: string };
      if (res.status === 412) {
        dirty = true; // the bytes are still the student's; the host decides
        failed = false;
        failures = 0; // refused, not failed: retrying the same bytes cannot help
        // Set aside as a recovered copy, so the reload the host answers with
        // cannot take the student's text with it.
        const recovered = await settleWithin(o.pending?.keep(), PENDING_MS);
        o.onState({ kind: "stale", serverHash: body.docHash ?? null, ...(recovered ? { recovered } : {}) });
        return;
      }
      if (!res.ok) throw new Error(`save ${res.status}`);
      if (typeof body.docHash === "string") hash = body.docHash;
      failed = false;
      failures = 0;
      // Awaited, not fire-and-forget: the next chained save writes the same key,
      // and a late delete would erase the copy that save depends on.
      await settleWithin(o.pending?.clear(), PENDING_MS);
      o.onState({ kind: "saved", at: Date.now(), docHash: hash });
      for (const l of savedListeners) l(bytes);
    } catch (e) {
      dirty = true;
      failed = true;
      armRetry();
      o.onState({ kind: "error", message: String((e as Error)?.message ?? e) });
    }
  }

  // At most ONE save waits behind the one in flight. A queued save reads the
  // editor's bytes only when it starts, so a second queued save would carry the
  // very same bytes — and every typing pause during a slow PUT used to add one:
  // a whole .docx (3.8MB on a 75-page thesis, ~70s on a slow uplink) per pause,
  // each holding the next. Joining the waiting save loses nothing: whatever it
  // reads when it starts includes every edit made up to then.
  let queued: Promise<void> | null = null;

  function enqueue(): Promise<void> {
    if (queued) return queued;
    const run = chain.then(() => {
      queued = null; // from here on it is reading bytes; a later edit needs a new save
      return saveOnce();
    });
    queued = run;
    chain = run.catch(() => {});
    return run;
  }

  // `dirty` is consumed HERE, synchronously, the instant a save is committed to
  // — not inside `saveOnce` once it actually runs. `saveOnce` only runs later
  // (chained behind whatever save is already in flight), so gating on `dirty`
  // there would let a second `markDirty()` that arrived before the first save
  // even started silently vanish: the first save's async prelude would still
  // observe (and clear) the flag the second call also depended on. Consuming it
  // at the call site means every `flush()`/timer-fire that saw `dirty === true`
  // is guaranteed an actual chained save, however many are queued.
  function scheduleSaveNow(): Promise<void> {
    dirty = false;
    return enqueue();
  }

  return {
    markDirty() {
      if (disposed) return;
      if (!dirty) o.onState({ kind: "dirty" });
      dirty = true;
      cancelRetry(); // the debounce below saves sooner, with these edits in it
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (dirty) void scheduleSaveNow(); }, debounceMs);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      cancelRetry();
      if (!dirty) return chain;
      return scheduleSaveNow();
    },
    setHash(h) { hash = h; },
    getHash() { return hash; },
    onSaved(fn) {
      savedListeners.add(fn);
      return () => { savedListeners.delete(fn); };
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      cancelRetry();
    },
    isDirty() { return dirty; },
    lastSaveFailed() { return failed; },
    discard() {
      if (timer) { clearTimeout(timer); timer = null; }
      cancelRetry();
      failures = 0;
      dirty = false;
    },
  };
}
