// The NATIVE half of `applyOp` (stores/lexical-editor-store.ts): every student
// edit a native tool hands to `thesis-doc-store.mutate` — the bubble, the pill, the
// insert drawer, the table bar, an approved AI suggestion, an accepted completion —
// is planned here against the block model (bridge/op-map.ts) and, when the engine
// can do it, run in the WebView FIRST (bridge/use-apply-op.ts). The page changes
// under the finger; the bytes follow through the save loop (spec D2). What the
// engine cannot do answers `false` at once and takes the server path, after
// painting an in-flight mark on the blocks it will change.
//
// Also owns the pill's whole-block format (`blockFormat`): it is exactly a
// `format` op, so it goes through mutate like every other edit instead of being
// half-translated in the DOM (see bridge/command-map.ts).
//
// ⚠️ applyOp runs SYNCHRONOUSLY inside mutate, before the store's optimistic
// patch: the model it reads is the one the op was computed against.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormatChange, ThesisOp } from "@/lib/thesis-ops";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { planOp, type OpEnvelope } from "./bridge/op-map";

// How long mutate waits for the WebView's answer before it takes the server path.
// The DOM refuses an envelope older than 1500ms (bridge/use-apply-op.ts), so a
// late answer can never follow a timeout that already sent the op to the server.
const OP_REPLY_MS = 4000;
// Envelopes kept in the prop. Answered ones are dropped as they are answered; this
// only bounds in-flight marks nobody answers.
const KEEP = 24;

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

  const applyOp = useCallback((tid: string, op: ThesisOp): Promise<boolean> => {
    if (tid !== thesisId || !activeRef.current || !ready.current) return Promise.resolve(false);
    const d = useThesisDocStore.getState().byId[tid];
    if (!d?.available) return Promise.resolve(false);
    const plan = planOp(op, d.blocks);
    if (!plan.local) {
      if (plan.pending?.at.length) push({ nonce: ++seq.current, at: Date.now(), pending: plan.pending });
      // Paragraph direction cannot be written by the engine (op-map.ts), so the
      // pill shows the student's choice now; the reload after the server op paints
      // the page, and the next selection report confirms it.
      if (plan.direction) {
        const lex = useLexicalEditorStore.getState();
        lex.setFormat({ ...lex.format, isRTL: plan.direction === "rtl" });
      }
      if (__DEV__) console.log("[docx] op → server:", plan.reason);
      return Promise.resolve(false);
    }
    if (!plan.steps.length) return Promise.resolve(true); // nothing to change
    const nonce = ++seq.current;
    return new Promise<boolean>((resolve) => {
      waiters.current.set(nonce, resolve);
      push({ nonce, at: Date.now(), steps: plan.steps });
      setTimeout(() => {
        const w = waiters.current.get(nonce);
        if (!w) return;
        waiters.current.delete(nonce);
        w(false);
      }, OP_REPLY_MS);
    });
  }, [thesisId, push]);

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
