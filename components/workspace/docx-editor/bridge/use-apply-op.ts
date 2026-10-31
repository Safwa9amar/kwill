// The DOM half of `applyOp` (stores/lexical-editor-store.ts): a student's edit,
// planned by the host (bridge/op-map.ts), runs HERE in the engine so the page
// changes under the student's finger, then leaves as bytes through the save loop.
// Answers every envelope with `onOpApplied(nonce, ok)`; on `false` the host sends
// the op to the server and marks its blocks pending (stores/docx-surface-store).
//
// ⚠️ Call it from Bridge BEFORE the flush effect. React runs a component's effects
// in declaration order, and an op and a flush that arrive in the same render (an
// approve tapped just before a chat message is sent) must apply-then-flush, or
// the AI turn starts on bytes without the edit and the next save is refused.

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useDocxEditor } from "@docx-editor.dev/react";
import type { DocxEditorRef } from "@docx-editor.dev/react";
import { applySteps, engineOf } from "./apply-op";
import { runCommandAction } from "./command-actions";
import type { EngineAction } from "./command-map";
import type { OpEnvelope } from "./op-map";
import type { SaveLoop } from "./save-loop";

// Older than this and the host may already have given up waiting (it waits longer,
// see ../use-surface-ops.ts) and sent the op to the server: running it too would
// apply it twice. Refused, answered false — the server path stands.
const MAX_AGE_MS = 1500;

const topNonce = (ops: readonly OpEnvelope[] | null | undefined): number =>
  (ops ?? []).reduce((m, o) => (o.nonce > m ? o.nonce : m), -1);

export function useApplyOp(p: {
  editorRef: RefObject<DocxEditorRef | null>;
  saveLoop: SaveLoop;
  ops: readonly OpEnvelope[] | null | undefined;
  onOpApplied: ((nonce: number, ok: boolean) => void) | undefined;
}): {
  /** Runs the command kinds that need the paginated surface (command-actions.ts). */
  runExtra: (a: EngineAction) => void;
  /** The caret's offsets in its paragraph, when it sits in one — what a load()
   *  must put back (Bridge's tryRestore). */
  caret: () => { anchor: number; head: number } | null;
} {
  const inst = useDocxEditor();
  const instRef = useRef(inst);
  instRef.current = inst;
  const engine = () => engineOf(p.editorRef.current?.getEditor() ?? null, instRef.current);
  // What the host replays to a freshly mounted surface was answered by whoever
  // was mounted before (or timed out) — never run it again.
  const seen = useRef(topNonce(p.ops));
  const top = topNonce(p.ops);

  useEffect(() => {
    const list = [...(p.ops ?? [])].filter((o) => o.nonce > seen.current).sort((a, b) => a.nonce - b.nonce);
    for (const env of list) {
      seen.current = env.nonce;
      const e = engine();
      if (!e || Date.now() - env.at > MAX_AGE_MS) {
        p.onOpApplied?.(env.nonce, false);
        continue;
      }
      const r = applySteps(e, env.steps);
      if (r.ok) {
        // The engine's own `change` marks dirty too, but not when the first change
        // after a load is still armed as programmatic; the edit must leave either way.
        if (env.steps.length) p.saveLoop.markDirty();
      } else {
        console.warn("[docx] local op refused → server:", r.reason);
      }
      p.onOpApplied?.(env.nonce, r.ok);
    }
  }, [top]); // eslint-disable-line react-hooks/exhaustive-deps

  const runExtra = useCallback((a: EngineAction) => {
    if (a.kind === "list" || a.kind === "indent" || a.kind === "insert" || a.kind === "focus" || a.kind === "blur") {
      runCommandAction(engine(), a);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const caret = useCallback(() => {
    try {
      const s = instRef.current?.surface?.state().selection;
      if (!s || s.anchor.paragraphId !== s.head.paragraphId) return null;
      return { anchor: s.anchor.offset, head: s.head.offset };
    } catch {
      return null;
    }
  }, []);

  return { runExtra, caret };
}
