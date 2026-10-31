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

export type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number; docHash: string | null }
  | { kind: "stale"; serverHash: string | null }
  | { kind: "error"; message: string };

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
}

export function createSaveLoop(o: {
  apiBase: string;
  thesisId: string;
  token: () => string | null;
  getBytes: () => Promise<ArrayBuffer | null>;
  onState: (s: SaveState) => void;
  debounceMs?: number;
  fetchImpl?: typeof fetch;
}): SaveLoop {
  const f = o.fetchImpl ?? fetch;
  const debounceMs = o.debounceMs ?? 1500;
  let hash: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  const savedListeners = new Set<(bytes: ArrayBuffer) => void>();

  async function saveOnce(): Promise<void> {
    if (disposed) return;
    const token = o.token();
    if (!token) { dirty = true; o.onState({ kind: "error", message: "no token" }); return; }
    o.onState({ kind: "saving" });
    try {
      const bytes = await o.getBytes();
      if (!bytes) throw new Error("editor returned no bytes");
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Authorization: `Bearer ${token}`,
      };
      if (hash) headers["If-Match"] = `"${hash}"`;
      const res = await f(`${o.apiBase}/api/thesis/${o.thesisId}/docx`, { method: "PUT", headers, body: bytes });
      const body = (await res.json().catch(() => ({}))) as { docHash?: string | null; error?: string };
      if (res.status === 412) {
        dirty = true; // the bytes are still the student's; the host decides
        o.onState({ kind: "stale", serverHash: body.docHash ?? null });
        return;
      }
      if (!res.ok) throw new Error(`save ${res.status}`);
      if (typeof body.docHash === "string") hash = body.docHash;
      o.onState({ kind: "saved", at: Date.now(), docHash: hash });
      for (const l of savedListeners) l(bytes);
    } catch (e) {
      dirty = true;
      o.onState({ kind: "error", message: String((e as Error)?.message ?? e) });
    }
  }

  function enqueue(): Promise<void> {
    const run = chain.then(saveOnce);
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
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (dirty) void scheduleSaveNow(); }, debounceMs);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
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
    },
    isDirty() { return dirty; },
    discard() {
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = false;
    },
  };
}
