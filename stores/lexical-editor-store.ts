import { create } from "zustand";
import type { ThesisOp } from "@/lib/thesis-ops";

// Bridges the NATIVE formatting tools (BlockContextBar / bubble) to the Lexical
// Writer surface (WorkspaceLexicalView → LexicalDomEditor). The pill can't reach
// into the WebView directly, so it dispatches a serializable command here; the
// editor view subscribes and forwards it to the editor's `command` prop. The
// editor also reports the focused block's live format back here so the pill's
// active states (Bold on, H2, RTL, centered…) reflect the real Lexical selection.
//
// Formatting is WHOLE-BLOCK, matching the server's whole-paragraph `format` op
// (the pill applies the mark to every run of the selected block). The pill still
// persists through the durable op queue (mutate) exactly like the legacy composer;
// it also flags `skipReseed` so the optimistic doc change doesn't trigger a full
// Lexical rebuild — the editor already applied the change in place.

export interface LexicalFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  blockType: string; // paragraph | h1..h6 | quote | bullet | number
  isRTL: boolean;
  alignment: string | null; // left | center | right | justify | null
}

export interface LexicalCommand {
  type: string;
  value?: string;
  nonce: number;
}

const EMPTY_FORMAT: LexicalFormat = {
  bold: false,
  italic: false,
  underline: false,
  blockType: "paragraph",
  isRTL: false,
  alignment: null,
};

interface LexicalEditorState {
  // The latest command for the editor to run (nonce bumps per dispatch).
  command: LexicalCommand | null;
  // The focused block's live format (reported by the editor), for active states.
  format: LexicalFormat;
  // True while the Lexical Writer is the active surface (previewMode === null) —
  // the pill uses it to decide whether to route formatting to Lexical.
  active: boolean;
  // The in-editor HistoryPlugin's availability (reported by the editor). While the
  // Writer is active, the dock/header undo-redo step THIS history first — instant
  // and offline — before the op-queue / server-snapshot fallbacks.
  canUndo: boolean;
  canRedo: boolean;
  // Waitable flush of un-serialized Writer edits (registered by the Writer view).
  // Callers that are about to act on the SERVER doc (AI turn) await it so pending
  // typing lands first; resolves immediately when no Writer is mounted.
  flushEdits: (() => Promise<void>) | null;
  // Waitable RELOAD of the docx surface from the server's bytes (registered by the
  // docx Writer view; null under Lexical, which reseeds from the DTO instead).
  // Callers that just mutated the document on the SERVER — a sheet, a chart edit,
  // history undo — await it so the student sees the result. Conditional on the
  // document hash, so a no-op is one 304. Spec D3.
  reload: (() => Promise<void>) | null;
  // Visual-first RANGE rewrite (registered by the docx Writer view; null under
  // Lexical). Replaces blocks start..end with `paragraphs` IN THE ENGINE — the
  // student sees it at once, the save loop persists the bytes — and resolves true;
  // false means "not done, nothing changed": the caller applies it on the server.
  // See components/workspace/docx-editor/overlays/apply-range.ts.
  applyRange: ((thesisId: string, start: number, end: number, paragraphs: string[]) => Promise<boolean>) | null;
  // The docx Writer applying a student's edit IN THE ENGINE first, so the page
  // changes under the finger instead of after a server round-trip (registered by
  // the docx Writer view; null under Lexical). `thesis-doc-store.mutate` asks it
  // before it enqueues: `true` = the surface for that thesis executed the op
  // locally — the bytes leave through its save loop, so the op itself must NOT be
  // sent too (it would apply twice and 412 the next save, spec D2); `false` = not
  // handled (inactive, not loaded, an op the engine cannot do, a target it could
  // not prove) → the ordinary server path. ⚠️ Called BEFORE the store's optimistic
  // patch: the host reads the PRE-op block model synchronously to plan the edit.
  applyOp: ((thesisId: string, op: ThesisOp) => Promise<boolean>) | null;
  // Consume-once flag: set right before a pill edit mutates the doc so the editor
  // view skips the reseed (it already applied the edit in place).
  skipReseed: boolean;
  // Consume-once flag: set right before a DELIBERATE authoritative apply (e.g. a
  // range-rewrite approve) publishes its doc, so the editor view reseeds to it
  // UNCONDITIONALLY — bypassing the pending-save / proposal guards and cancelling any
  // stale debounced typing-save that would otherwise block it (revert bug).
  forceReseed: boolean;
  dispatch: (type: string, value?: string) => void;
  setFormat: (f: LexicalFormat) => void;
  setActive: (a: boolean) => void;
  setHistoryAvail: (canUndo: boolean, canRedo: boolean) => void;
  registerFlushEdits: (f: (() => Promise<void>) | null) => void;
  registerReload: (f: (() => Promise<void>) | null) => void;
  registerApplyRange: (f: LexicalEditorState["applyRange"]) => void;
  registerApplyOp: (fn: ((thesisId: string, op: ThesisOp) => Promise<boolean>) | null) => void;
  requestSkipReseed: () => void;
  consumeSkipReseed: () => boolean;
  requestForceReseed: () => void;
  consumeForceReseed: () => boolean;
}

let nonce = 0;

// Cheap equality so setFormat only bumps state (→ pill re-render) on real changes.
function sameFormat(a: LexicalFormat, b: LexicalFormat): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blockType === b.blockType &&
    a.isRTL === b.isRTL &&
    a.alignment === b.alignment
  );
}

export const useLexicalEditorStore = create<LexicalEditorState>((set, get) => ({
  command: null,
  format: EMPTY_FORMAT,
  active: false,
  canUndo: false,
  canRedo: false,
  flushEdits: null,
  reload: null,
  applyRange: null,
  applyOp: null,
  skipReseed: false,
  forceReseed: false,
  dispatch: (type, value) => set({ command: { type, value, nonce: ++nonce } }),
  setFormat: (f) => {
    if (!sameFormat(get().format, f)) set({ format: f });
  },
  setActive: (a) => set({ active: a }),
  setHistoryAvail: (canUndo, canRedo) => {
    const s = get();
    if (s.canUndo !== canUndo || s.canRedo !== canRedo) set({ canUndo, canRedo });
  },
  registerFlushEdits: (f) => set({ flushEdits: f }),
  registerReload: (f) => set({ reload: f }),
  registerApplyRange: (f) => set({ applyRange: f }),
  registerApplyOp: (fn) => set({ applyOp: fn }),
  requestSkipReseed: () => set({ skipReseed: true }),
  consumeSkipReseed: () => {
    if (!get().skipReseed) return false;
    set({ skipReseed: false });
    return true;
  },
  requestForceReseed: () => set({ forceReseed: true }),
  consumeForceReseed: () => {
    if (!get().forceReseed) return false;
    set({ forceReseed: false });
    return true;
  },
}));
