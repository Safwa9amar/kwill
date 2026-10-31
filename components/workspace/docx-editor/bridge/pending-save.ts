// Offline safety for the student's edits (spec D6): the bytes of every save are
// written to IndexedDB INSIDE the WebView before the PUT leaves, and cleared once
// the server has them. The WebView's storage outlives an app kill, so a save the
// network never carried — offline, a dead socket, the OS reaping the app
// mid-request — is still on the device at the next open.
//
// Ported from kwill-dashboard src/features/editor/lib/idb.ts (the same
// best-effort promise wrapper), cut down to one store and one purpose.
//
//   pending:<thesisId>                 the bytes of the save in flight / not yet landed
//   recovered:<thesisId>:<at, padded>  bytes the server REFUSED (412 — it moved under
//                                      us, D4), kept for the student to restore
//
// Replay is not a separate path: on open, a pending record is shown AT ONCE (it is
// the student's newest text — no network round trip before they see it) and the
// ordinary save loop PUTs it with the `If-Match` it was written against. A 2xx
// clears it; a 412 turns it into a recovered copy and the host offers Restore /
// Discard; a network error leaves it for the next try.
//
// Everything here is best-effort and must never cost a save: a WebView with no
// IndexedDB (or a broken one) degrades to exactly the old, memory-only behaviour.
//
// Pure apart from `openIdbPendingStore`, which touches `indexedDB` only when
// called — pending-save.test.ts drives the rest through an in-memory store.

import type { FetchDocumentResult } from "./load-document";

export type PendingRecord = {
  key: string;
  thesisId: string;
  bytes: ArrayBuffer;
  /** The server hash the bytes were edited from — the `If-Match` a replay carries. */
  baseHash: string | null;
  at: number;
};

export type RecoveredRef = { key: string; at: number };

/** The storage the logic below needs; IndexedDB in the WebView, a Map in tests. */
export interface PendingStore {
  put(rec: PendingRecord): Promise<void>;
  get(key: string): Promise<PendingRecord | undefined>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`, ascending. */
  keys(prefix: string): Promise<string[]>;
}

/** How many refused copies to keep per thesis — each is a whole .docx. */
export const MAX_RECOVERED = 3;

export const pendingKey = (thesisId: string) => `pending:${thesisId}`;
const recoveredPrefix = (thesisId: string) => `recovered:${thesisId}:`;
// Zero-padded so key order is time order.
export const recoveredKey = (thesisId: string, at: number) => `${recoveredPrefix(thesisId)}${String(at).padStart(15, "0")}`;

export function recoveredAt(key: string): number | null {
  const m = /:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** The recovered keys to delete so at most `keep` (the newest) remain. */
export function pruneRecovered(keys: readonly string[], keep = MAX_RECOVERED): string[] {
  const sorted = [...keys].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/** `p`'s value, or undefined if it rejects or outlasts `ms` — for writes that
 *  must not hold up the save they protect. */
export function settleWithin<T>(p: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); console.warn("[docx] pending-save store:", String((e as Error)?.message ?? e)); resolve(undefined); },
    );
  });
}

export type PendingSave = ReturnType<typeof createPendingSave>;

export function createPendingSave(store: PendingStore, thesisId: string, now: () => number = Date.now) {
  const key = pendingKey(thesisId);
  return {
    /** BEFORE the PUT: these bytes are the student's until the server has them. */
    put(bytes: ArrayBuffer, baseHash: string | null): Promise<void> {
      return store.put({ key, thesisId, bytes, baseHash, at: now() });
    },
    /** After a 2xx. */
    clear(): Promise<void> {
      return store.delete(key);
    },
    /** The pending record, if a previous session left one. */
    async take(): Promise<PendingRecord | null> {
      return (await store.get(key)) ?? null;
    },
    /** A 412: the refused bytes become a recovered copy (newest MAX_RECOVERED kept). */
    async keep(): Promise<RecoveredRef | null> {
      const rec = await store.get(key);
      if (!rec) return null;
      const at = now();
      const ref = { key: recoveredKey(thesisId, at), at };
      await store.put({ ...rec, key: ref.key, at });
      await store.delete(key);
      const all = await store.keys(recoveredPrefix(thesisId));
      for (const k of pruneRecovered(all)) await store.delete(k);
      return ref;
    },
    async latestRecovered(): Promise<RecoveredRef | null> {
      const all = (await store.keys(recoveredPrefix(thesisId))).sort();
      const last = all[all.length - 1];
      const at = last ? recoveredAt(last) : null;
      return last && at != null ? { key: last, at } : null;
    },
    async readRecovered(k: string): Promise<ArrayBuffer | null> {
      // Only this thesis's copies — the key arrives over the bridge.
      if (!k.startsWith(recoveredPrefix(thesisId))) return null;
      return (await store.get(k))?.bytes ?? null;
    },
    discard(k: string): Promise<void> {
      if (!k.startsWith(recoveredPrefix(thesisId))) return Promise.resolve();
      return store.delete(k);
    },
  };
}

/**
 * What the editor opens with: a pending record if one is waiting (shown at once,
 * then replayed by the save loop — `replay: true`), else the server's bytes. The
 * IndexedDB read is bounded, so a hung store costs at most `waitMs` before the
 * network path runs as it always did.
 */
export async function openInitial(o: {
  pending: Pick<PendingSave, "take"> | null;
  fetchDoc: () => Promise<FetchDocumentResult>;
  waitMs?: number;
}): Promise<{ bytes: ArrayBuffer; docHash: string | null; replay: boolean } | null> {
  const rec = o.pending ? await settleWithin(o.pending.take(), o.waitMs ?? 1500) : undefined;
  if (rec) return { bytes: rec.bytes, docHash: rec.baseHash, replay: true };
  const r = await o.fetchDoc();
  if (r.status !== 200) return null;
  return { bytes: r.bytes, docHash: r.docHash, replay: false };
}

// ── IndexedDB ──

const DB_NAME = "kwill-docx";
const DB_VERSION = 1;
const STORE = "pending_saves";

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    }).catch((e) => {
      // Never cache a rejection: a transient failure must not disable the store
      // for the life of the page.
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/** Run `fn` in one transaction, resolving when it COMMITS — a write is only
 *  durable then, and resolving earlier would let the PUT race an unwritten copy. */
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await getDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    let out: T;
    const req = fn(t.objectStore(STORE));
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

export function openIdbPendingStore(): PendingStore {
  return {
    put: (rec) => tx("readwrite", (s) => { s.put(rec); }).then(() => undefined),
    get: (key) => tx<PendingRecord | undefined>("readonly", (s) => s.get(key) as IDBRequest<PendingRecord | undefined>),
    delete: (key) => tx("readwrite", (s) => { s.delete(key); }).then(() => undefined),
    keys: (prefix) =>
      tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))
        .then((ks) => ks.map(String).sort()),
  };
}
