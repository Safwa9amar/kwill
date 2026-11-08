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
  // Which document the engine holds: `discard()` (a reload replaced the bytes) moves
  // it on. A save belongs to the epoch it was COMMITTED in, and one that outlives
  // its epoch must neither run, nor re-arm `dirty`, nor adopt a hash. That leak was
  // the phantom "edited in Kwill" step (11-08): a 412'd save left `dirty` set, the
  // reload's flush re-PUT it, the stale it reported asked for a SECOND reload whose
  // flush overlapped the first one's fetch — and its 412 came back after
  // `discard()`, re-arming `dirty` on the freshly loaded server bytes. The next
  // reload's flush then PUT those bytes back: same text, new hash.
  let epoch = 0;
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

  async function saveOnce(e: number): Promise<void> {
    if (disposed) return;
    // Committed to before a reload replaced the bytes: what it would read now is the
    // reloaded document, not an edit.
    if (e !== epoch) return;
    const token = o.token();
    if (!token) { dirty = true; failed = true; armRetry(); o.onState({ kind: "error", message: "no token" }); return; }
    o.onState({ kind: "saving" });
    try {
      const bytes = await o.getBytes();
      if (!bytes) throw new Error("editor returned no bytes");
      if (e !== epoch) { o.onState({ kind: "idle" }); return; }
      // Durable BEFORE the request leaves: a kill mid-PUT, or no network at all,
      // leaves these bytes for the next open to show and replay (spec D6).
      await settleWithin(o.pending?.put(bytes, hash), PENDING_MS);
      if (e !== epoch) {
        // The reload landed while the copy was being written: these bytes are the
        // replaced document's, and the hash may already be the reloaded one — sent,
        // they would overwrite the server with text the student no longer sees.
        await settleWithin(o.pending?.clear(), PENDING_MS);
        o.onState({ kind: "idle" });
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Authorization: `Bearer ${token}`,
      };
      if (hash) headers["If-Match"] = `"${hash}"`;
      const res = await f(`${o.apiBase}/api/thesis/${o.thesisId}/docx`, { method: "PUT", headers, body: bytes });
      const body = (await res.json().catch(() => ({}))) as { docHash?: string | null; error?: string };
      if (res.status === 412) {
        // The bytes are still the student's; the host decides — unless a reload has
        // replaced them since, and then nothing on screen is unsaved.
        if (e === epoch) dirty = true;
        failed = false;
        failures = 0; // refused, not failed: retrying the same bytes cannot help
        // Set aside as a recovered copy, so the reload the host answers with
        // cannot take the student's text with it.
        const recovered = await settleWithin(o.pending?.keep(), PENDING_MS);
        o.onState({ kind: "stale", serverHash: body.docHash ?? null, ...(recovered ? { recovered } : {}) });
        return;
      }
      if (!res.ok) throw new Error(`save ${res.status}`);
      const current = e === epoch;
      // Landed after a reload: the engine holds the reloaded bytes, so the hash stays
      // theirs (the host's next tick sees the server moved and reloads again), and
      // the D7 re-parse must not put these older bytes back on screen.
      if (current && typeof body.docHash === "string") hash = body.docHash;
      failed = false;
      failures = 0;
      // Awaited, not fire-and-forget: the next chained save writes the same key,
      // and a late delete would erase the copy that save depends on.
      await settleWithin(o.pending?.clear(), PENDING_MS);
      o.onState({ kind: "saved", at: Date.now(), docHash: hash });
      if (current) for (const l of savedListeners) l(bytes);
    } catch (err) {
      // A failure after a reload leaves nothing unsaved on screen: re-arming would
      // retry with the RELOADED bytes. Its own copy is still in the pending store.
      if (e === epoch) {
        dirty = true;
        failed = true;
        armRetry();
      }
      o.onState({ kind: "error", message: String((err as Error)?.message ?? err) });
    }
  }

  // At most ONE save waits behind the one in flight. A queued save reads the
  // editor's bytes only when it starts, so a second queued save would carry the
  // very same bytes — and every typing pause during a slow PUT used to add one:
  // a whole .docx (3.8MB on a 75-page thesis, ~70s on a slow uplink) per pause,
  // each holding the next. Joining the waiting save loses nothing: whatever it
  // reads when it starts includes every edit made up to then.
  // A waiting save is joined only within its epoch: one committed to before a
  // reload is dropped when it starts, and must not take a later edit down with it.
  let queued: { run: Promise<void>; epoch: number } | null = null;

  function enqueue(): Promise<void> {
    if (queued && queued.epoch === epoch) return queued.run;
    const e = epoch;
    const entry: { run: Promise<void>; epoch: number } = {
      epoch: e,
      run: chain.then(() => {
        // from here on it is reading bytes; a later edit needs a new save
        if (queued === entry) queued = null;
        return saveOnce(e);
      }),
    };
    queued = entry;
    chain = entry.run.catch(() => {});
    return entry.run;
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
      failed = false;
      dirty = false;
      epoch += 1;
    },
  };
}

/** The engine's `change` payload, as far as the save loop cares. */
export type ChangeLike = {
  readonly source?: string;
  readonly created?: readonly unknown[];
  readonly deleted?: readonly unknown[];
  readonly dirty?: readonly unknown[];
};

/**
 * Whether an engine `change` is the student's edit (→ `markDirty`). The engine tags
 * every REPLACEMENT — `load`, `refresh`, `recovery` — with a `source` (absent for
 * edits, engine 2.34); those carry the bytes we handed it and must never be PUT
 * back. `wasProgrammatic` covers an engine that emits a bare load change with no
 * ids: the first id-less change after a `load()` we asked for is ours too.
 */
export function changeIsStudentEdit(change: ChangeLike, wasProgrammatic: boolean): boolean {
  if (change.source) return false;
  const ids = (change.created?.length ?? 0) + (change.deleted?.length ?? 0) + (change.dirty?.length ?? 0);
  return !(wasProgrammatic && ids === 0);
}
