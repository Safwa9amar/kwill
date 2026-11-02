// The NATIVE half of `applyOp` (stores/lexical-editor-store.ts): every student
// edit a native tool hands to `thesis-doc-store.mutate` — the bubble, the pill, the
// insert drawer, the table bar, an approved AI suggestion, an accepted completion —
// is planned here against the block model (bridge/op-map.ts) and, when the engine
// can do it, run in the WebView FIRST (bridge/use-apply-op.ts). The page changes
// under the finger; the bytes follow through the save loop (spec D2). What the
// engine cannot do answers `false` and takes the server path — its blocks marked
// pending from the tap (stores/docx-surface-store → overlays/PendingLayer, the
// same shimmer the sheets use) until the queue drains, then until the reload
// that shows the result.
//
// Also owns the pill's whole-block format (`blockFormat`): it is exactly a
// `format` op, so it goes through mutate like every other edit instead of being
// half-translated in the DOM (see bridge/command-map.ts).
//
// ⚠️ applyOp runs SYNCHRONOUSLY inside mutate, before the store's optimistic
// patch: the model it reads is the one the op was computed against.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormatChange, ThesisOp } from "@/lib/thesis-ops";
import { useDocxSurfaceStore } from "@/stores/docx-surface-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { blocksOf, planOp, type OpEnvelope } from "./bridge/op-map";

// How long mutate waits for the WebView's answer before it takes the server path.
// The DOM refuses an envelope older than 1500ms (bridge/use-apply-op.ts), so a
// late answer can never follow a timeout that already sent the op to the server.
const OP_REPLY_MS = 4000;
// Envelopes kept in the prop. Answered ones are dropped as they are answered; this
// only bounds what the WebView never answered (it was remounting).
const KEEP = 24;
// A pending mark whose server op never drained (offline, queued) still has to go:
// after this it waits only for the next reload (the store caps that too).
const PENDING_MAX_MS = 30000;

export function useSurfaceOps({ thesisId, active }: { thesisId: string; active: boolean }) {
  const [ops, setOps] = useState<OpEnvelope[]>([]);
  const seq = useRef(0);
  const waiters = useRef(new Map<number, (ok: boolean) => void>());
  // Until the engine has opened the document there is nothing to apply to; an op
  // then goes straight to the server instead of waiting out the timeout.
  const ready = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const push = useCallback((env: OpEnvelope) => setOps((cur) => [...cur.slice(-(KEEP - 1)), env]), []);

  // Pending marks opened for server-path ops; each is ended (kept until the reload
  // that shows the result) once the op queue drains — see the effect below.
  const openMarks = useRef<((keepUntilReload?: boolean) => void)[]>([]);
  const markServer = useCallback((indices: readonly number[]) => {
    for (const i of indices) {
      const end = useDocxSurfaceStore.getState().beginPending(i);
      openMarks.current.push(end);
      setTimeout(() => end(true), PENDING_MAX_MS); // idempotent: a second end() is a noop
    }
  }, []);
  useEffect(
    () =>
      useThesisDocStore.subscribe((s, prev) => {
        if ((s.pending[thesisId] ?? 0) === 0 && (prev.pending[thesisId] ?? 0) > 0) {
          for (const end of openMarks.current.splice(0)) end(true);
        }
      }),
    [thesisId],
  );

  const applyOp = useCallback((tid: string, op: ThesisOp): Promise<boolean> => {
    if (tid !== thesisId || !activeRef.current || !ready.current) return Promise.resolve(false);
    const d = useThesisDocStore.getState().byId[tid];
    if (!d?.available) return Promise.resolve(false);
    const plan = planOp(op, d.blocks);
    if (!plan.local) {
      if (plan.pending?.at.length) markServer(plan.pending.at.map((r) => r.index));
      if (__DEV__) console.log("[docx] op → server:", plan.reason);
      return Promise.resolve(false);
    }
    if (!plan.steps.length) return Promise.resolve(true); // nothing to change
    // The pill reads the caret's direction off the page, one report later; the
    // student's own tap must not lag behind the page it just turned.
    if (op.type === "format" && op.changes.direction) {
      const lex = useLexicalEditorStore.getState();
      lex.setFormat({ ...lex.format, isRTL: op.changes.direction === "rtl" });
    }
    const nonce = ++seq.current;
    const steps = plan.steps;
    return new Promise<boolean>((resolve) => {
      // The engine could not place it after all → the server path: mark it.
      waiters.current.set(nonce, (ok) => {
        if (!ok) markServer(blocksOf(steps));
        resolve(ok);
      });
      push({ nonce, at: Date.now(), steps });
      setTimeout(() => {
        const w = waiters.current.get(nonce);
        if (!w) return;
        waiters.current.delete(nonce);
        w(false);
      }, OP_REPLY_MS);
    });
  }, [thesisId, push, markServer]);

  const onOpApplied = useCallback(async (nonce: number, ok: boolean) => {
    const w = waiters.current.get(nonce);
    if (w) {
      waiters.current.delete(nonce);
      w(ok);
    }
    setOps((cur) => (cur.some((e) => e.nonce <= nonce) ? cur.filter((e) => e.nonce > nonce) : cur));
  }, []);

  const markReady = useCallback(() => {
    ready.current = true;
  }, []);

  useEffect(() => {
    useLexicalEditorStore.getState().registerApplyOp(applyOp);
    // A waiter still open is left to its timeout, never settled `false` early: the
    // WebView may yet run it within its age window, and an early false would send
    // the same edit to the server as well.
    return () => {
      if (useLexicalEditorStore.getState().applyOp === applyOp) useLexicalEditorStore.getState().registerApplyOp(null);
    };
  }, [applyOp]);

  // The pill's whole-block format → the `format` op it describes.
  useEffect(
    () =>
      useLexicalEditorStore.subscribe((s, prev) => {
        const c = s.command;
        if (!c || c === prev.command || c.type !== "blockFormat" || !activeRef.current) return;
        let payload: { indices?: unknown; changes?: unknown };
        try {
          payload = JSON.parse(c.value ?? "{}") as typeof payload;
        } catch {
          return;
        }
        const indices = Array.isArray(payload.indices)
          ? payload.indices.filter((i): i is number => Number.isInteger(i) && i >= 0)
          : [];
        if (!indices.length || !payload.changes || typeof payload.changes !== "object") return;
        void useThesisDocStore.getState().mutate(thesisId, { type: "format", indices, changes: payload.changes as FormatChange });
      }),
    [thesisId],
  );

  return { ops, onOpApplied, markReady };
}
