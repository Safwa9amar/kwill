import { create } from "zustand";
import { Alert, AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { getThesisDocument, getThesisHistory, type DocumentDTO } from "@/lib/api";
import { getDocCache, setDocCache } from "@/lib/thesis-doc-cache";
import { applyOpToDoc, editTextCoalesces, executeOp, isRetryableError, type ThesisOp } from "@/lib/thesis-ops";
import { ifMatchValue, tagOfRead, tagOfWrite } from "@/lib/thesis-op-tag";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";
import { rescueThesisIds } from "@/lib/rescue-v2-thesis-sync";
import {
  newOpId,
  enqueueOp,
  confirmOp,
  bumpOpAttempts,
  listQueuedOps,
  clearQueuedOps,
} from "@/lib/thesis-op-queue";
import i18n from "@/lib/i18n";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";

// Owns the live-.docx block model per thesis so editing feels instant AND survives
// failure:
//   • On open we hydrate from the on-device SQLite cache (paint immediately),
//     replay any queued-but-unsent ops on top, then revalidate from the server in
//     the background (stale-while-revalidate).
//   • Manual edits are serializable OPS (lib/thesis-ops.ts): applied to the local
//     blocks optimistically (no network wait), persisted to the durable queue
//     (lib/thesis-op-queue.ts) BEFORE the server call, then flushed strictly in
//     order by a per-thesis pump. The edit endpoints echo the mutated document,
//     so the last op's response reconciles the state (no extra GET).
//   • A NETWORK failure keeps the op queued — the pump retries with backoff and
//     wakes on reconnect; edits survive an app kill and replay on next open.
//   • A SERVER REJECTION (4xx — the doc changed under us) poisons the positional
//     indices of everything queued after it: the whole queue for that thesis is
//     dropped and the server's truth re-fetched.
//
// The server stays the source of truth; this store is a fast local mirror.

interface PumpItem {
  id: string;
  op: ThesisOp;
  attempts: number;
  // Resolves when the op's durable SQLite row is written. The pump awaits it
  // before executing, so a forced flush can never confirm-delete an op whose
  // INSERT hasn't landed yet (which would leak a ghost row that replays later).
  persisted?: Promise<void>;
  resolve?: () => void;
  reject?: (e: unknown) => void;
}

interface Pump {
  queue: PumpItem[];
  running: boolean;
  // Resolves the pump's current backoff sleep early (reconnect / new op).
  wake?: () => void;
}

// Fired on every optimistic manual-edit op — lets live renderers (the Word
// WebView) patch their DOM in place immediately instead of waiting for the
// confirm-time silent refresh. Fires BEFORE the network flush.
type DocOpListener = (thesisId: string, op: ThesisOp) => void;
const opListeners = new Set<DocOpListener>();
export function onThesisDocOp(listener: DocOpListener): () => void {
  opListeners.add(listener);
  return () => {
    opListeners.delete(listener);
  };
}

// Module-level (non-reactive) pump state; the store mirrors only the counts.
const pumps = new Map<string, Pump>();
// Composing gate: while a thesis's hold count is >0 the pump does NOT flush —
// edits stay in the durable local queue (SQLite + memory) and only sync when the
// last holder releases (composer exit / preview switch / screen blur). Counted,
// not boolean, so overlapping holders (workspace + block-editor during a push
// transition) compose correctly regardless of effect ordering. `forcedFlushes`
// (also counted) lets an explicit flush — AI turn, app background — bypass holds.
const holdCounts = new Map<string, number>();
const forcedFlushes = new Map<string, number>();
const isHeld = (thesisId: string): boolean =>
  (holdCounts.get(thesisId) ?? 0) > 0 && (forcedFlushes.get(thesisId) ?? 0) === 0;

// ── Local undo/redo (works entirely on-device, pairs with the op queue) ───────
// Every mutate records {op, doc-before-op}; undo pops the NEWEST entry, removes
// its op from the queue (memory + SQLite — it never reaches the server) and
// restores the snapshot; redo re-applies the op through mutate. Snapshots are
// cheap: applyOpToDoc shallow-copies, so consecutive docs share block objects.
// An entry dies when its op confirms on the server (the flushed edit is then
// covered by the SERVER history ring buffer — the buttons fall back to it once
// the queue is empty). A server reconcile (drain echo/restore) clears redo.
type LiveDoc = Extract<DocumentDTO, { available: true }>;
interface UndoEntry {
  opId: string;
  op: ThesisOp;
  before: LiveDoc;
}
const histories = new Map<string, { undo: UndoEntry[]; redo: ThesisOp[] }>();
const MAX_LOCAL_HISTORY = 100;
// True while redoLocal re-applies an op through mutate — mutate must then keep
// the remaining redo stack instead of clearing it (a redo is not a fresh edit).
let redoApplying = false;

function histFor(thesisId: string): { undo: UndoEntry[]; redo: ThesisOp[] } {
  let h = histories.get(thesisId);
  if (!h) {
    h = { undo: [], redo: [] };
    histories.set(thesisId, h);
  }
  return h;
}
// ── The docx Writer applies edits LOCALLY first (lexical-editor-store.applyOp) ──
// Its verdict is async (a bridge round-trip into the WebView), so an op it does
// not take is enqueued only once the verdict is in. Verdicts are taken strictly in
// call order per thesis — the chain below — so the queue keeps call order, and a
// drain (flushOps, an AI turn) waits for any edit still being decided. While a
// verdict is pending nothing is queued yet, so `routing` stands in for `pending`
// in revalidate's guard: a fetch must not clobber that edit's optimistic patch.
// A LOCAL op is never queued and never gets a local-undo entry here: it is in the
// engine's own history, which the history buttons step first (canUndo/canRedo).
const surfaceRoutes = new Map<string, Promise<unknown>>();
const routing = new Map<string, number>();
const isRouting = (thesisId: string): boolean => (routing.get(thesisId) ?? 0) > 0;

// One-shot restore of the disk queue per thesis per session (memoized promise).
// Pump starts are gated on it so a restore can never splice older disk ops into
// a queue whose head is already in flight (which would misorder the replay).
const restorePromises = new Map<string, Promise<void>>();

// The document tag (P-66, lib/thesis-op-tag.ts) of the server state the local doc and its queue are built on. Set only from a read of the
// server or from a write's own answer, and cleared whenever the local doc is replaced by a document whose tag is not known. A batch sent
// with this tag is refused by the server once any other writer has moved the document on. Module-level, not reactive.
const opTags = new Map<string, string>();
/** The tag after a write: its answer's history tag, or none (then the next batch goes untagged, as before). */
const rememberWrite = (thesisId: string, res: unknown) => {
  const tag = tagOfWrite(res);
  if (tag) opTags.set(thesisId, tag);
  else opTags.delete(thesisId);
};
/** The tag after a read: the document's own tag, for a live document. */
const rememberRead = (thesisId: string, doc: unknown) => {
  const tag = tagOfRead(doc);
  if (tag) opTags.set(thesisId, tag);
  else opTags.delete(thesisId);
};

function pumpFor(thesisId: string): Pump {
  let p = pumps.get(thesisId);
  if (!p) {
    p = { queue: [], running: false };
    pumps.set(thesisId, p);
  }
  return p;
}

// Backoff sleep that a reconnect or a new mutate() can cut short.
function sleepWithWake(p: Pump, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      p.wake = undefined;
      resolve();
    }, ms);
    p.wake = () => {
      clearTimeout(t);
      p.wake = undefined;
      resolve();
    };
  });
}

interface ThesisDocState {
  // Last-known document per thesis. `undefined` = never loaded (show a spinner);
  // `available:false` = legacy/unseeded (fall back to the section render).
  byId: Record<string, DocumentDTO | undefined>;
  // Monotonic per-thesis token bumped ONLY when the server bytes change (a real
  // reconcile), not on optimistic patches — the Word/PDF WebViews key their reload
  // URL on it, so it must track actual .docx changes, not in-memory previews.
  tick: Record<string, number>;
  // Unconfirmed ops per thesis (queued + in-flight). Drives the "saving" hint and
  // gates revalidate so a stale fetch can't clobber unflushed optimistic edits.
  pending: Record<string, number>;
  // Bumped when a thesis's op queue fully drains (all edits confirmed) — the
  // workspace re-fetches the OnlyOffice editor-config on it so the Word/PDF
  // layers reload the new bytes (their document.key derives from updatedAt).
  drainTick: Record<string, number>;
  revalidating: Record<string, boolean>;
  // Server-reported undo/redo availability (from edit echoes + GET /history).
  history: Record<string, { canUndo: boolean; canRedo: boolean }>;
  // Reactive mirror of the composing gate — true while at least one editing
  // surface holds this thesis (edits accumulate locally, no network flush).
  held: Record<string, boolean>;
  // Local undo/redo depth (mirrors the module-level `histories`). Drives the
  // header/dock buttons: local steps are instant and offline; when both are 0
  // and the queue is empty the buttons fall back to the SERVER history.
  localUndo: Record<string, number>;
  localRedo: Record<string, number>;

  // Undo/redo the newest LOCAL edit — synchronous, no network. Returns false
  // when there's nothing locally undoable (empty stack, or the target op is
  // already flushed/in flight) so callers can fall back to the server restore.
  undoLocal: (thesisId: string) => boolean;
  redoLocal: (thesisId: string) => boolean;

  // Composing gate. holdSync pauses the flush pump for this thesis (edits still
  // apply optimistically + persist to SQLite); releaseSync resumes it — the queue
  // flushes in the background once the LAST holder releases. Callers must pair
  // them (effect + cleanup).
  holdSync: (thesisId: string) => void;
  releaseSync: (thesisId: string) => void;
  // Force-flush the queue NOW, bypassing holds (AI turn about to run against the
  // server doc; app going to background). Resolves true once the queue is empty,
  // false when it couldn't drain within `timeoutMs` (e.g. offline).
  flushOps: (thesisId: string, opts?: { timeoutMs?: number }) => Promise<boolean>;

  hydrate: (thesisId: string) => Promise<void>;
  revalidate: (thesisId: string) => Promise<void>;
  load: (thesisId: string) => Promise<void>;
  setDoc: (thesisId: string, doc: DocumentDTO) => void;
  // Apply `op` optimistically, persist it durably, and flush in the background.
  // Resolves when the server confirms; rejects only on a permanent (non-network)
  // rejection — never on offline (the op stays queued). Safe to ignore the result.
  mutate: (thesisId: string, op: ThesisOp) => Promise<void>;
  // Apply a table op the "silent" way (like the Lexical text auto-save): optimistic
  // patch + a direct server apply + a setDoc reconcile that bumps `tick` only — so
  // the table reseeds WITHOUT the durable-queue `drainTick` refetch cascade
  // (editor-config/outline/PDF). Falls back to the ordered queue while other ops
  // are pending (positional-index correctness). Used by the table bubble tools and
  // in-cell editing.
  applyTableOpSilent: (thesisId: string, op: ThesisOp) => Promise<void>;
  // Swap ONE native chart block's rendered SVG locally, so approving a chart
  // proposal repaints INSTANTLY instead of after the round trip. Not a guess: the
  // SVG is the one the server already rendered for that proposal's preview, from
  // the same patch the approve is about to send — so the echo brings back the same
  // bytes. POSITIONAL-SAFE, so no index can shift under the selection.
  applyChartSvgLocal: (thesisId: string, index: number, svg: string) => void;
  setHistoryState: (thesisId: string, h: { canUndo: boolean; canRedo: boolean }) => void;
  refreshHistoryState: (thesisId: string) => Promise<void>;
  // Replace the doc after a server-side restore (undo/redo/history sheet): full
  // reconcile — bumps tick (Word view reloads) AND drainTick (editor config/PDF
  // re-key). Callers must only invoke while pending === 0.
  applyRestoredDoc: (thesisId: string, doc: DocumentDTO, h: { canUndo: boolean; canRedo: boolean }) => void;
}

const bump = (map: Record<string, number>, id: string) => ({ ...map, [id]: (map[id] ?? 0) + 1 });

export const useThesisDocStore = create<ThesisDocState>((set, get) => {
  const setPending = (thesisId: string, n: number) =>
    set((s) => ({ pending: { ...s.pending, [thesisId]: n } }));

  // Mirror the module-level history depths into reactive state (buttons).
  const syncHistCounts = (thesisId: string) => {
    const h = histFor(thesisId);
    set((s) => ({
      localUndo: { ...s.localUndo, [thesisId]: h.undo.length },
      localRedo: { ...s.localRedo, [thesisId]: h.redo.length },
    }));
  };

  const clearLocalHistory = (thesisId: string) => {
    histories.delete(thesisId);
    syncHistCounts(thesisId);
  };

  // Flush the thesis's queue strictly in order. Head-of-line blocking is the
  // POINT: a retrying op must hold back later ops or replays land out of order
  // (indices are positional). One pump runs per thesis at a time.
  const runPump = async (thesisId: string): Promise<void> => {
    const p = pumpFor(thesisId);
    if (p.running) return;
    p.running = true;
    try {
      while (p.queue.length > 0) {
        // Composing gate: stop flushing (ops stay queued + durable) until the
        // last hold releases. Re-checked every iteration so a hold taken while
        // the pump is mid-queue (or mid-backoff) pauses it at the next op.
        if (isHeld(thesisId)) break;
        const item = p.queue[0];
        try {
          // Never send an op whose durable row is still being written — the
          // confirm-time DELETE must always run after the INSERT.
          if (item.persisted) await item.persisted;
          // ⚠️ The docx Writer's unsaved BYTES reach the server before any op does.
          // Ops are positional against the server's copy, and one that lands first
          // moves the hash under those bytes: their save is refused (412) and the
          // student's typing is gone. Under Lexical (no applyOp) nothing changes —
          // its flushEdits enqueues ops into THIS queue and must not run from here.
          const surface = useLexicalEditorStore.getState();
          // A docx surface writes its own bytes at any moment, so a tag held here would be stale: that batch goes without one, as today.
          const docx = !!surface.applyOp;
          if (docx) opTags.delete(thesisId);
          if (surface.applyOp && surface.flushEdits) await surface.flushEdits().catch(() => {});
          const res = await executeOp(thesisId, item.op, docx ? null : ifMatchValue(opTags.get(thesisId)));
          rememberWrite(thesisId, docx ? null : res);
          await confirmOp(item.id);
          // Remove by identity (not blind shift) — belt-and-braces against any
          // future path that mutates the queue while this op was in flight.
          const at = p.queue.indexOf(item);
          if (at >= 0) p.queue.splice(at, 1);
          setPending(thesisId, p.queue.length);
          // A flushed op is no longer locally undoable — its snapshot entry
          // retires and the SERVER history (which just recorded this edit)
          // covers it once the queue is empty.
          const h = histories.get(thesisId);
          if (h) {
            const hi = h.undo.findIndex((e) => e.opId === item.id);
            if (hi >= 0) {
              h.undo.splice(hi, 1);
              syncHistCounts(thesisId);
            }
          }
          if (p.queue.length === 0) {
            // Only the LAST op reconciles with authoritative state — reconciling
            // mid-queue would wipe the later ops' optimistic patches (flicker).
            if (res && typeof res === "object" && "document" in res && res.document) {
              get().setDoc(thesisId, res.document);
              rememberWrite(thesisId, res);
              if ("history" in res && res.history) get().setHistoryState(thesisId, res.history);
            } else {
              try {
                const fetched = await getThesisDocument(thesisId);
                // A new op may have been enqueued during this fetch — its
                // optimistic patch must not be clobbered by the older snapshot.
                if (p.queue.length === 0) {
                  get().setDoc(thesisId, fetched);
                  rememberRead(thesisId, fetched);
                }
              } catch {
                /* keep optimistic state; next revalidate reconciles */
              }
            }
            set((s) => ({ drainTick: bump(s.drainTick, thesisId) }));
          }
          item.resolve?.();
        } catch (e) {
          if (isRetryableError(e)) {
            // Offline / flaky network: keep the op (and its optimistic state),
            // back off, retry the SAME head. Reconnect wakes the sleep early.
            item.attempts++;
            void bumpOpAttempts(item.id);
            const delay = Math.min(2_000 * 2 ** Math.min(item.attempts - 1, 5), 60_000);
            await sleepWithWake(p, delay + Math.random() * 500);
          } else {
            // The server REJECTED the op — the doc changed under us (AI edit,
            // other device). Later queued ops carry indices computed on top of
            // this one → all poisoned. Drop the queue and re-fetch server truth.
            const dropped = p.queue.splice(0);
            await clearQueuedOps(thesisId);
            setPending(thesisId, 0);
            // The local snapshots chain through the dropped ops — all invalid.
            clearLocalHistory(thesisId);
            for (const d of dropped) d.reject?.(e);
            Alert.alert(
              i18n.t("common.error", { defaultValue: "Error" }),
              i18n.t("workspace.editsRejected", {
                defaultValue: "Some edits couldn't be saved because the document changed. It has been reloaded.",
              }),
            );
            void get().revalidate(thesisId);
            // Earlier ops in this batch may have landed before the rejected one —
            // the server bytes changed, so the editor config must refresh too.
            set((s) => ({ drainTick: bump(s.drainTick, thesisId) }));
          }
        }
      }
    } finally {
      p.running = false;
    }
  };

  // Replay the durable queue on (re)open: re-apply unsent ops' patches onto the
  // hydrated doc so the user still sees their edits after an app kill, then flush.
  // Runs at most once per thesis per session; every pump start awaits it so disk
  // ops (older) always enter the queue before any in-session op is executed.
  const ensureRestored = (thesisId: string): Promise<void> => {
    let pr = restorePromises.get(thesisId);
    if (!pr) {
      pr = (async () => {
        const disk = await listQueuedOps(thesisId);
        if (disk.length === 0) return;
        const p = pumpFor(thesisId);
        const fresh = disk.filter((d) => !p.queue.some((q) => q.id === d.id));
        if (fresh.length === 0) return;
        // Disk ops predate anything enqueued this session — replay them FIRST.
        p.queue.unshift(...fresh.map((d) => ({ id: d.id, op: d.op, attempts: d.attempts })));
        setPending(thesisId, p.queue.length);
        const cur = get().byId[thesisId];
        if (cur?.available) {
          // Re-applying the disk ops one by one also rebuilds the local undo
          // stack (snapshot-before-each), so undo works across an app kill.
          const h = histFor(thesisId);
          let doc = cur;
          for (const d of fresh) {
            h.undo.push({ opId: d.id, op: d.op, before: doc });
            doc = applyOpToDoc(doc, d.op);
          }
          if (h.undo.length > MAX_LOCAL_HISTORY) h.undo.splice(0, h.undo.length - MAX_LOCAL_HISTORY);
          syncHistCounts(thesisId);
          set((s) => ({ byId: { ...s.byId, [thesisId]: doc } }));
        }
        void runPump(thesisId);
      })().catch(() => {});
      restorePromises.set(thesisId, pr);
    }
    return pr;
  };

  // Queue `op` durably and flush it in order. `cur` is the document as it was
  // BEFORE the op (its local-undo snapshot). Moved verbatim out of mutate so the
  // docx surface's server verdicts take exactly the same path.
  const enqueue = (thesisId: string, op: ThesisOp, cur: DocumentDTO | undefined): Promise<void> => {
    const hist = histFor(thesisId);
    const p = pumpFor(thesisId);

    // Coalesce rapid same-block typing: if the pending TAIL is an editText for
    // the same index as this one, replace its op in place (latest text wins)
    // instead of appending a second round-trip. The pump only ever executes
    // p.queue[0]; while it's running that head op is IN FLIGHT (being sent) and
    // must not be mutated, so we refuse to fold onto it. Any op after the head
    // is pending-not-started and safe. Reusing the tail's durable row (same id)
    // + promise slot keeps SQLite and the pending count consistent — the
    // optimistic patch above already painted the newest text.
    const tail = p.queue[p.queue.length - 1];
    const tailInFlight = p.running && tail === p.queue[0];
    if (tail && !tailInFlight && editTextCoalesces(tail.op, op)) {
      // Folded typing burst = ONE undo step: the tail's existing entry keeps
      // its pre-burst snapshot; only the op it re-applies on redo updates.
      // (No entry exists only if the doc wasn't loaded at the first fold —
      // then seed one from the current snapshot, still newest-in-queue.)
      const tailEntry = hist.undo.find((e) => e.opId === tail.id);
      if (tailEntry) tailEntry.op = op;
      else if (cur?.available) hist.undo.push({ opId: tail.id, op, before: cur });
      syncHistCounts(thesisId);
      tail.op = op;
      tail.attempts = 0; // pending-not-started; discarded text was never sent
      const prevResolve = tail.resolve;
      const prevReject = tail.reject;
      const promise = new Promise<void>((resolve, reject) => {
        tail.resolve = () => {
          prevResolve?.();
          resolve();
        };
        tail.reject = (e) => {
          prevReject?.(e);
          reject(e);
        };
      });
      promise.catch(() => {});
      // Persist the replacement (INSERT OR REPLACE on the same id) then flush.
      const persisted = enqueueOp(tail.id, thesisId, op);
      tail.persisted = persisted;
      void Promise.all([persisted, ensureRestored(thesisId)]).finally(() => {
        if (p.wake) p.wake();
        void runPump(thesisId);
      });
      return promise;
    }

    const id = newOpId();
    const persisted = enqueueOp(id, thesisId, op);
    const promise = new Promise<void>((resolve, reject) => {
      p.queue.push({ id, op, attempts: 0, persisted, resolve, reject });
    });
    if (cur?.available) {
      hist.undo.push({ opId: id, op, before: cur });
      if (hist.undo.length > MAX_LOCAL_HISTORY) hist.undo.shift();
    }
    syncHistCounts(thesisId);
    // Fire-and-forget callers must not trip "unhandled rejection" when a
    // permanent failure is already surfaced via the Alert in the pump.
    promise.catch(() => {});
    setPending(thesisId, p.queue.length);

    // Durably persist BEFORE flushing, then flush (or cut a backoff short).
    // Gated on the one-shot disk restore so older queued ops always execute
    // before this one — the pump replays strictly in order.
    void Promise.all([persisted, ensureRestored(thesisId)]).finally(() => {
      if (p.wake) p.wake();
      void runPump(thesisId);
    });

    return promise;
  };

  // The docx surface's verdict decides between "done" (the engine applied it; its
  // bytes carry it) and the queue. See surfaceRoutes above.
  const routeViaSurface = (thesisId: string, op: ThesisOp, cur: DocumentDTO | undefined, verdict: Promise<boolean>): Promise<void> => {
    routing.set(thesisId, (routing.get(thesisId) ?? 0) + 1);
    const prev = surfaceRoutes.get(thesisId) ?? Promise.resolve();
    // Only the DECISION is chained (wrapped, so the queue promise is not adopted):
    // the next edit waits for this one's verdict, never for its server confirm.
    const decided = prev
      .then(() => verdict.catch(() => false))
      .then((local) => {
        if (local) {
          syncHistCounts(thesisId); // mutate may have dropped the redo stack
          return { done: Promise.resolve() };
        }
        return { done: enqueue(thesisId, op, cur) };
      })
      .finally(() => {
        const n = (routing.get(thesisId) ?? 1) - 1;
        if (n > 0) routing.set(thesisId, n);
        else routing.delete(thesisId);
      });
    surfaceRoutes.set(thesisId, decided.catch(() => {}));
    const result = decided.then((d) => d.done);
    result.catch(() => {});
    return result;
  };

  return {
    byId: {},
    tick: {},
    pending: {},
    drainTick: {},
    revalidating: {},
    history: {},
    held: {},
    localUndo: {},
    localRedo: {},

    undoLocal: (thesisId) => {
      const h = histories.get(thesisId);
      const entry = h?.undo[h.undo.length - 1];
      if (!h || !entry) return false;
      const p = pumpFor(thesisId);
      const tailIdx = p.queue.length - 1;
      const tail = p.queue[tailIdx];
      // Only the NEWEST queued op can be unwound locally (LIFO — the snapshot is
      // exactly the doc minus that op), and never while it's being sent. Any
      // mismatch (op already flushed / in flight) → server-history fallback.
      if (!tail || tail.id !== entry.opId) return false;
      if (p.running && tailIdx === 0) return false;
      p.queue.pop();
      setPending(thesisId, p.queue.length);
      // Delete the durable row AFTER its INSERT settles — deleting first would
      // let a late INSERT resurrect the undone op as a ghost replay on reopen.
      void (tail.persisted ?? Promise.resolve()).then(() => confirmOp(entry.opId));
      // The op will never run; settle its mutate() promise so no caller hangs.
      tail.resolve?.();
      h.undo.pop();
      h.redo.push(entry.op);
      // Restore the snapshot. No tick bump (same rule as mutate: server bytes
      // didn't change — the Word/PDF WebViews must not reload mid-compose) and
      // no doc-cache write (the cache holds the last server reconcile; a kill
      // replays the remaining queued ops on top of it, which is exactly this).
      set((s) => ({ byId: { ...s.byId, [thesisId]: entry.before } }));
      syncHistCounts(thesisId);
      return true;
    },

    redoLocal: (thesisId) => {
      const h = histories.get(thesisId);
      const op = h?.redo[h.redo.length - 1];
      if (!h || !op) return false;
      h.redo.pop();
      // Re-apply through the normal mutate pipeline (optimistic patch + durable
      // enqueue + a fresh undo entry). The flag stops mutate from clearing the
      // rest of the redo stack — a redo is not a fresh fork.
      redoApplying = true;
      try {
        void get().mutate(thesisId, op);
      } finally {
        redoApplying = false;
      }
      syncHistCounts(thesisId);
      return true;
    },

    holdSync: (thesisId) => {
      holdCounts.set(thesisId, (holdCounts.get(thesisId) ?? 0) + 1);
      set((s) => (s.held[thesisId] ? {} : { held: { ...s.held, [thesisId]: true } }));
    },

    releaseSync: (thesisId) => {
      const n = (holdCounts.get(thesisId) ?? 0) - 1;
      if (n > 0) {
        holdCounts.set(thesisId, n);
        return;
      }
      holdCounts.delete(thesisId);
      set((s) => (s.held[thesisId] ? { held: { ...s.held, [thesisId]: false } } : {}));
      // Last holder gone → background-sync everything that accumulated.
      const p = pumps.get(thesisId);
      if (p && p.queue.length > 0) {
        if (p.wake) p.wake();
        void runPump(thesisId);
      }
    },

    flushOps: async (thesisId, opts) => {
      // An edit still waiting on the docx surface's verdict may yet become a queued
      // op: let it be decided first, or this drain misses it (and an AI turn starts
      // before it lands).
      const deciding = surfaceRoutes.get(thesisId);
      if (deciding) await deciding;
      const p = pumpFor(thesisId);
      if (p.queue.length === 0) return true;
      forcedFlushes.set(thesisId, (forcedFlushes.get(thesisId) ?? 0) + 1);
      try {
        const deadline = Date.now() + (opts?.timeoutMs ?? 15_000);
        if (p.wake) p.wake();
        void runPump(thesisId);
        // The pump may already be alive (mid-request or in a backoff sleep), in
        // which case runPump returned immediately — poll until the queue drains.
        // A permanent rejection also empties the queue, so this always settles.
        while (p.queue.length > 0 && Date.now() < deadline) {
          if (p.wake) p.wake();
          await new Promise((r) => setTimeout(r, 200));
        }
        return p.queue.length === 0;
      } finally {
        const c = (forcedFlushes.get(thesisId) ?? 0) - 1;
        if (c > 0) forcedFlushes.set(thesisId, c);
        else forcedFlushes.delete(thesisId);
      }
    },

    hydrate: async (thesisId) => {
      // A doc already in memory is fresher than disk — don't clobber it.
      if (get().byId[thesisId]) return;
      const cached = await getDocCache(thesisId);
      if (cached && !get().byId[thesisId]) {
        set((s) => ({ byId: { ...s.byId, [thesisId]: cached }, tick: bump(s.tick, thesisId) }));
      }
    },

    revalidate: async (thesisId) => {
      if (get().revalidating[thesisId]) return;
      // Unflushed local ops → the flush is the authoritative reconcile and the
      // fetched doc would be discarded below anyway. Skip the network round-trip
      // entirely (matters while composing holds the queue for long stretches).
      if (((get().pending[thesisId] ?? 0) > 0 || isRouting(thesisId)) && get().byId[thesisId]?.available) return;
      set((s) => ({ revalidating: { ...s.revalidating, [thesisId]: true } }));
      try {
        const doc = await getThesisDocument(thesisId);
        // Ops are mid-flight → their flush is the authoritative reconcile; a doc
        // fetched before they landed would be stale. Skip.
        if ((get().pending[thesisId] ?? 0) > 0 || isRouting(thesisId)) return;
        get().setDoc(thesisId, doc);
        rememberRead(thesisId, doc);
      } catch {
        // Keep whatever we last showed; only fall back to a legacy marker if we've
        // never had anything to render for this thesis.
        set((s) =>
          s.byId[thesisId]
            ? {}
            : { byId: { ...s.byId, [thesisId]: { docMode: "legacy-db", available: false } } },
        );
      } finally {
        set((s) => ({ revalidating: { ...s.revalidating, [thesisId]: false } }));
      }
    },

    load: async (thesisId) => {
      await get().hydrate(thesisId);
      await ensureRestored(thesisId);
      await get().revalidate(thesisId);
    },

    setDoc: (thesisId, doc) => {
      // The doc is replaced by one whose tag is not known here: callers that know it set it after (rememberRead / rememberWrite).
      opTags.delete(thesisId);
      set((s) => ({ byId: { ...s.byId, [thesisId]: doc }, tick: bump(s.tick, thesisId) }));
      void setDocCache(thesisId, doc);
      // Server truth landed (drain echo / revalidate / restore) — redo ops were
      // computed against the pre-reconcile doc and may no longer apply cleanly.
      // (The undo stack self-empties via confirm-removal; only redo needs this.)
      const h = histories.get(thesisId);
      if (h && h.redo.length > 0) {
        h.redo = [];
        syncHistCounts(thesisId);
      }
    },

    setHistoryState: (thesisId, h) =>
      set((s) => ({ history: { ...s.history, [thesisId]: h } })),

    refreshHistoryState: async (thesisId) => {
      try {
        const st = await getThesisHistory(thesisId);
        get().setHistoryState(thesisId, { canUndo: st.canUndo, canRedo: st.canRedo });
      } catch {
        // Endpoint missing (old server) or offline — leave buttons as they were.
      }
    },

    applyTableOpSilent: async (thesisId, op) => {
      // The docx Writer runs a table edit in its engine first; what it cannot do
      // takes the ordered queue (whose pump saves its bytes before the op). The
      // "silent" shortcut below exists to spare LEXICAL a reseed — no such thing here.
      if (useLexicalEditorStore.getState().applyOp) {
        void get().mutate(thesisId, op);
        return;
      }
      // Ordered queue when other ops are still in flight — table ops are
      // positional and must land after them.
      if ((get().pending[thesisId] ?? 0) > 0) {
        void get().mutate(thesisId, op);
        return;
      }
      const cur = get().byId[thesisId];
      if (cur?.available) get().setDoc(thesisId, applyOpToDoc(cur, op)); // optimistic (tick reseed, no cascade)
      try {
        const res = await executeOp(thesisId, op);
        if (res && typeof res === "object" && "document" in res && res.document) {
          get().setDoc(thesisId, res.document as DocumentDTO);
        }
        rememberWrite(thesisId, res);
        void get().refreshHistoryState(thesisId);
      } catch {
        void get().revalidate(thesisId);
      }
    },

    applyChartSvgLocal: (thesisId, index, svg) => {
      const cur = get().byId[thesisId];
      if (!cur?.available) return;
      const block = cur.blocks[index];
      // A chart is an image block carrying `svg`; anything else means the document
      // moved under us (a reindex mid-approve) — paint nothing rather than the
      // wrong block, and let the server echo be the truth.
      if (!block || block.kind !== "image" || !block.svg) return;
      const blocks = cur.blocks.slice();
      blocks[index] = { ...block, svg };
      get().setDoc(thesisId, { ...cur, blocks });
    },

    applyRestoredDoc: (thesisId, doc, h) => {
      get().setDoc(thesisId, doc);
      rememberRead(thesisId, doc);
      get().setHistoryState(thesisId, h);
      // A server-side restore replaces the doc wholesale — local snapshots are
      // meaningless against it (callers ensure pending === 0, so the undo stack
      // is already empty; this is belt-and-braces).
      clearLocalHistory(thesisId);
      set((s) => ({ drainTick: bump(s.drainTick, thesisId) }));
    },

    mutate: (thesisId, op) => {
      // The docx Writer applies the edit in its ENGINE first, so the page changes
      // without waiting for the server (lexical-editor-store.applyOp). ⚠️ Asked
      // BEFORE the optimistic patch below: the host plans against the pre-op model,
      // synchronously, inside this call. Under Lexical it is null and nothing below
      // changes.
      const surfaceApply = useLexicalEditorStore.getState().applyOp;
      const verdict = surfaceApply ? surfaceApply(thesisId, op) : null;

      // Optimistic: patch the live blocks now so the outline view updates
      // instantly. We do NOT bump `tick` — the server bytes haven't changed yet,
      // so the Word/PDF WebViews must not reload to still-stale bytes mid-edit.
      const cur = get().byId[thesisId];
      if (cur?.available) {
        set((s) => ({
          byId: { ...s.byId, [thesisId]: applyOpToDoc(cur, op) },
        }));
      }
      for (const l of opListeners) l(thesisId, op);

      // A fresh edit forks history: whatever was redoable is gone — except when
      // this mutate IS a redo re-applying its op (redoLocal popped its own entry).
      const hist = histFor(thesisId);
      if (!redoApplying && hist.redo.length > 0) hist.redo = [];

      if (!verdict) return enqueue(thesisId, op, cur);
      return routeViaSurface(thesisId, op, cur, verdict);
    },
  };
});

// Reconnect → wake every backing-off pump so queued edits flush immediately.
// (A pump with a non-empty queue is always alive — either mid-request or in a
// backoff sleep — so cutting the sleep short is all a reconnect needs to do.)
// A held pump is NOT alive — releaseSync restarts it, so nothing to do here.
NetInfo.addEventListener((state) => {
  if (!(state.isConnected ?? true)) return;
  for (const p of pumps.values()) {
    if (p.queue.length > 0 && p.wake) p.wake();
  }
});

// App going to background = the user stopped composing. Force-flush every thesis
// with locally-held edits so work syncs even if the app is later killed (and the
// durable SQLite queue still covers the case where this window is cut short).
// Back in front: a thesis a repair may have changed while the app was away is re-read (P-66). Only the documents held open here are, and only
// when a rescue project points at them. Foreground is the app's, not one screen's, so this is one lookup per focus.
function revalidateOpenRescueTheses(): void {
  if (!RESCUE_V2_ENABLED) return;
  const open = Object.entries(useThesisDocStore.getState().byId)
    .filter(([, d]) => d?.available === true)
    .map(([id]) => id);
  if (open.length === 0) return;
  rescueThesisIds()
    .then((ids) => {
      for (const id of ids) if (open.includes(id)) void useThesisDocStore.getState().revalidate(id);
    })
    .catch((err) => console.warn("[rescue] thesis sync on focus failed", err));
}

AppState.addEventListener("change", (st) => {
  if (st === "active") {
    revalidateOpenRescueTheses();
    return;
  }
  if (st !== "background") return;
  for (const [thesisId, p] of pumps) {
    if (p.queue.length > 0) void useThesisDocStore.getState().flushOps(thesisId, { timeoutMs: 20_000 });
  }
});
