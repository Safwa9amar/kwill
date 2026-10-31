// The live half of the bridge. Runs inside the engine's React context (a child
// of <DocxEditor>), so the paragraph style/format hooks resolve. Owns: the
// selection report (engine → LexicalState), command execution (LexicalCommand →
// engine), the save loop's triggers, flush, reload and scroll-to-index.
//
// ⚠️ Everything the REPORT reads is asked of the engine at the moment it runs.
// `report` is dispatched from the engine's own event loop, BEFORE React has
// re-rendered, so any value captured from a render — a `useEditorCommand` result
// object, a memoised callback's closure — is by construction one event stale, and
// for a slot table that only re-memoises on a state change it is frozen at mount
// (that bug shipped: undo/redo permanently disabled, lists never reported).
// `toolbarCommandState(editor, id)` and `runToolbarCommand(editor, id)` are the
// hook-free forms of the same can/exec path, so nothing here needs a slot table.

import { useEffect, useRef, type RefObject } from "react";
import {
  commandForSlot,
  runToolbarCommand,
  toolbarCommandState,
  useEditorEvent,
  useParagraphFormat,
  useParagraphStyle,
} from "@docx-editor.dev/react";
import type { ChromeSlotId, DocxEditorRef, Editor } from "@docx-editor.dev/react";
// ⚠️ `commandForSlotValue` is exported by @docx-editor.dev/core/editor but NOT
// re-exported from the react package at 2.16 (its index re-exports
// `commandForSlot` and not this one). That subpath is already in the runtime
// graph — the react bundle requires it itself — and metro.config.js maps it to
// dist/editor.cjs, so importing from it adds no new resolution risk.
import { commandForSlotValue } from "@docx-editor.dev/core/editor";
import type { LexicalCommand, LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { mapCommand } from "./command-map";
import { findBlockMatch } from "./find-block";
import { spannedBlocks } from "./dom-selectors";
import { fetchDocument } from "./load-document";
import type { OpEnvelope } from "./op-map";
import { classifyReport } from "./report-kind";
import { readSelectionFacts } from "./selection-facts";
import type { SaveLoop } from "./save-loop";
import { useApplyOp } from "./use-apply-op";
import { placeCaret } from "./apply-op";

// A report counts as the student's own doing for this long after a touch/key.
// Lexical's EditorBridge uses 700ms; this surface is a WebView over a paginated
// engine whose selection settles later, so it keeps the plan's wider window.
const DRIVING_MS = 1500;
const DRIVING_EVENTS = ["pointerdown", "touchstart", "mousedown", "keydown", "beforeinput"] as const;

// How long a pending caret restore keeps retrying after a load(). The engine
// re-parses asynchronously, so the first events after `load()` can still see the
// old (or no) document; each one retries, and this bounds it.
const RESTORE_WINDOW_MS = 8000;

// The twelve slots the native chrome can reach, as a runtime guard: mapCommand
// hands back a plain string and ChromeSlotId is a compile-time union.
const SLOTS = new Set<string>([
  "text.bold", "text.italic", "text.underline",
  "alignment.left", "alignment.center", "alignment.right", "alignment.justify",
  "list.bullet", "list.numbered", "format.clear", "history.undo", "history.redo",
]);
const asSlot = (s: string): ChromeSlotId | null => (SLOTS.has(s) ? (s as ChromeSlotId) : null);

// SET semantics over a TOGGLE vocabulary. The engine has no "make it bold"
// command — `toggleMark` flips — while the pill's blockFormat carries booleans
// that mean "make it so", so each mark is compared against the engine's own
// answer (`isActive`, which derives from the selection's agreed formatting) and
// only toggled when the two differ. Colour is a genuine set: `setMarkAttr` with
// the picked value, or "auto" to fall back to the style.
const MARK_SLOTS: readonly (readonly [key: string, slot: ChromeSlotId])[] = [
  ["bold", "text.bold"],
  ["italic", "text.italic"],
  ["underline", "text.underline"],
];

function applyMarks(editor: Editor, marks: Record<string, unknown>): void {
  for (const [key, slot] of MARK_SLOTS) {
    if (!(key in marks)) continue;
    const cmd = commandForSlot(slot);
    if (!cmd) continue;
    if (editor.isActive(cmd) !== (marks[key] === true)) editor.exec(cmd);
  }
  if ("color" in marks) {
    const c = marks.color as { kind?: string; value?: string } | null | undefined;
    const cmd = commandForSlotValue("text.color", c?.kind === "hex" && c.value ? c.value : "auto");
    if (cmd) editor.exec(cmd);
  }
}

export type BlockRef = { index: number; text: string };

export type BridgeProps = {
  editorRef: RefObject<DocxEditorRef | null>;
  saveLoop: SaveLoop;
  apiBase: string;
  thesisId: string;
  token: string;
  command: LexicalCommand | null | undefined;
  scrollToIndex: { index: number; text: string; nonce: number } | null | undefined;
  reloadNonce: number | undefined;
  flushNonce: number | undefined;
  onState: (s: LexicalState) => void;
  onFlushed: ((nonce: number) => void) | undefined;
  onReloaded: ((docHash: string | null) => void) | undefined;
  // The block carries its TEXT as well as its index: between a local structural
  // edit and the re-parse that follows the save, an index alone can name the
  // wrong paragraph, and the host re-resolves by text before it mutates.
  onServerFormat: ((target: BlockRef, changes: { direction: "rtl" | "ltr" }) => void) | undefined;
  // Student edits planned by the host, run here first (bridge/use-apply-op.ts).
  ops?: readonly OpEnvelope[] | null;
  onOpApplied?: (nonce: number, ok: boolean) => void;
  /** First block index of each section (DTO order) — a header/footer report names its section by it. */
  sectionStarts?: readonly number[];
};

export function Bridge(p: BridgeProps) {
  const editorOf = () => p.editorRef.current?.getEditor() ?? null;
  const drivenAt = useRef(0);
  const pageFocused = useRef(true);
  const lastFocus = useRef<BlockRef | null>(null);
  const structureChanged = useRef(false);
  const restore = useRef<(BlockRef & { until: number; caret?: { anchor: number; head: number } | null }) | null>(null);
  // The first change after mount belongs to the document the host handed in as a
  // prop, not to the student. See `onChange` below.
  const programmatic = useRef(true);
  // The store replays its last command to a freshly mounted surface; that nonce
  // was already acted on by whoever was mounted before us.
  const seenNonce = useRef(p.command?.nonce ?? -1);

  const style = useParagraphStyle();
  const para = useParagraphFormat();
  // Declared before the command and flush effects: an op must land before a flush
  // that arrives with it (see use-apply-op.ts).
  const { runExtra, caret } = useApplyOp({ editorRef: p.editorRef, saveLoop: p.saveLoop, ops: p.ops, onOpApplied: p.onOpApplied });

  // Two independent signals, because neither is trustworthy alone on a WebView:
  // `hasFocus()` lags a focus change, and the page can keep `activeElement` after
  // the native view has taken focus away. Mirrors EditorBridge's `focused ||
  // recent` — an AND would make every report after a lagging blur `userDriven:
  // false`, and the host refuses a selection shrink on exactly that flag.
  useEffect(() => {
    const stamp = () => { drivenAt.current = Date.now(); pageFocused.current = true; };
    const gained = () => { pageFocused.current = true; };
    const lost = () => { pageFocused.current = false; };
    for (const e of DRIVING_EVENTS) document.addEventListener(e, stamp, true);
    window.addEventListener("focus", gained);
    window.addEventListener("blur", lost);
    return () => {
      for (const e of DRIVING_EVENTS) document.removeEventListener(e, stamp, true);
      window.removeEventListener("focus", gained);
      window.removeEventListener("blur", lost);
    };
  }, []);

  const isUserDriven = (): boolean => {
    const root = document.querySelector('[contenteditable="true"]');
    const focused =
      pageFocused.current &&
      (typeof document.hasFocus !== "function" || document.hasFocus()) &&
      // Nothing editable on the page yet — never veto on a signal we don't have.
      (!root || root === document.activeElement || root.contains(document.activeElement));
    return focused || Date.now() - drivenAt.current < DRIVING_MS;
  };

  // ── engine → native: the selection report ──
  // NOT memoised: `useEditorEvent` keeps the latest handler in a ref and
  // subscribes once, so a fresh closure every render is both correct and the
  // only way this reads current props.
  const report = () => {
    const editor = editorOf();
    if (!editor) return;
    const sel = window.getSelection();
    const { blocks, focus } = spannedBlocks(sel);
    const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    // null when nothing is selected or nothing is derivable — read as "no formatting".
    const fmt = editor.getSelectionFormatting();
    const styleId = fmt?.styleId ?? "";
    const h = /^Heading([1-6])$/.exec(styleId);
    const blockType = toolbarCommandState(editor, "list.bullet").active ? "bullet"
      : toolbarCommandState(editor, "list.numbered").active ? "number"
      : h ? `h${h[1]}`
      : styleId === "Quote" ? "quote"
      : "paragraph";
    if (focus) lastFocus.current = { index: focus.index, text: focus.text };
    // Header/footer story, selected picture, caret in a table → the kind the native
    // chrome expects (report-kind.ts); anything else passes through unchanged.
    p.onState(classifyReport({
      bold: !!fmt?.bold, italic: !!fmt?.italic, underline: !!fmt?.underline,
      blockType,
      isRTL: focus ? getComputedStyle(focus.el).direction === "rtl" : false,
      alignment: (fmt?.alignment as LexicalState["alignment"]) ?? null,
      index: focus?.index ?? -1,
      text: focus?.text ?? "",
      blocks: blocks.map(({ index, text }) => ({ index, text })),
      // A caret's range rect can be zero-height; the block's own box still
      // anchors the native pill at the right height.
      y: rect && rect.height > 0 ? rect.top : (focus ? focus.el.getBoundingClientRect().top : -1),
      canUndo: toolbarCommandState(editor, "history.undo").enabled,
      canRedo: toolbarCommandState(editor, "history.redo").enabled,
      userDriven: isUserDriven(),
    }, readSelectionFacts(editor), { sectionStarts: p.sectionStarts ?? [] }));
  };

  // Put the caret back after a load(): the engine re-parses and every node id is
  // new, so the position is re-found by TEXT. Driven by the engine's own events
  // rather than `snapshot().isLoading` — that flag means "no bytes handed over
  // yet" and is false from the first load onwards, so an effect keyed on it fires
  // exactly once, before any restore is ever pending.
  const tryRestore = (editor: Editor) => {
    const keep = restore.current;
    if (!keep) return;
    if (Date.now() > keep.until) { restore.current = null; return; }
    const m = findBlockMatch(editor, keep.index, keep.text);
    if (!m) return; // not re-parsed yet — the next event retries
    restore.current = null; // cleared BEFORE the selection moves, which re-enters here
    // ⚠️ A CARET, never selectMatch(m): that SELECTS the matched prefix (up to 120
    // chars), and the student's next keystroke replaced it. See placeCaret.
    placeCaret(editor, m, keep.caret ?? null);
    editor.scrollToBlock(m.blockId);
  };

  /** Hand the engine bytes WE produced: the caret is remembered and the change it
   *  emits must not be mistaken for the student typing. */
  const loadDocument = (bytes: ArrayBuffer) => {
    const keep = lastFocus.current;
    if (keep) restore.current = { ...keep, until: Date.now() + RESTORE_WINDOW_MS, caret: caret() };
    programmatic.current = true;
    p.editorRef.current?.load(bytes);
  };

  useEditorEvent("selectionChange", () => {
    const editor = editorOf();
    if (editor) tryRestore(editor);
    report();
  });

  useEditorEvent("change", (change) => {
    const created = change.created?.length ?? 0;
    const deleted = change.deleted?.length ?? 0;
    if (created + deleted > 0) structureChanged.current = true;
    const wasProgrammatic = programmatic.current;
    programmatic.current = false;
    // A load() we asked for emits a change that carries a revision and no block
    // ids; marking THAT dirty would PUT back the bytes we just took in — on open,
    // after every reload, and after every D7 re-parse. A student's edit names the
    // blocks it touched, so it still marks dirty even if the flag was left armed
    // by a load that turned out to emit nothing.
    if (!(wasProgrammatic && created + deleted + (change.dirty?.length ?? 0) === 0)) {
      p.saveLoop.markDirty();
    }
    const editor = editorOf();
    if (editor) tryRestore(editor);
    report();
  });

  // ── native → engine: commands ──
  useEffect(() => {
    const cmd = p.command;
    const editor = editorOf();
    if (!cmd || !editor || cmd.nonce === seenNonce.current) return;
    seenNonce.current = cmd.nonce;
    for (const a of mapCommand(cmd)) {
      switch (a.kind) {
        case "slot": { const s = asSlot(a.slot); if (s) runToolbarCommand(editor, s); break; }
        case "style": style.setValue(a.styleId); break;
        case "paragraph": para.apply(a.update); break;
        case "marks": applyMarks(editor, a.marks); break;
        case "selectParagraph": {
          const f = lastFocus.current;
          const m = f ? findBlockMatch(editor, f.index, f.text, Infinity) : null;
          if (m) editor.selectMatch(m);
          break;
        }
        case "server": { const f = lastFocus.current; if (f) p.onServerFormat?.({ ...f }, a.changes); break; }
        case "noop": break;
        default: runExtra(a); break;
      }
    }
  }, [p.command?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── flush (awaited by ai-service before a turn) ──
  useEffect(() => {
    const n = p.flushNonce;
    if (n == null) return;
    void p.saveLoop.flush().catch(() => {}).finally(() => p.onFlushed?.(n));
  }, [p.flushNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // The WebView can be torn down or backgrounded without React unmounting us in
  // time to await anything, so the debounce window is flushed on the page's own
  // last-gasp events too.
  useEffect(() => {
    const flush = () => { void p.saveLoop.flush().catch(() => {}); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [p.saveLoop]);

  // ── reload from the server (spec D3), conditional on the hash we hold ──
  useEffect(() => {
    if (p.reloadNonce == null || p.reloadNonce === 0) return;
    void (async () => {
      try {
        // ⚠️ Unsaved edits leave FIRST. A load replaces what the engine holds, and the
        // armed debounce would then PUT the reloaded bytes back — the edit silently
        // gone. Flushed, they either land (the hash moves to ours → 304 below) or are
        // refused because the server moved (412 → the host's "changed elsewhere").
        await p.saveLoop.flush().catch(() => {});
        // ⚠️ …and if they could NOT leave (offline, expired token), the page stays.
        // Loading over them would take the student's text off the screen; it would
        // survive only as an IndexedDB copy. The next tick, or the next save that
        // lands, brings the reload back round.
        if (p.saveLoop.isDirty() && p.saveLoop.lastSaveFailed()) {
          p.onReloaded?.(p.saveLoop.getHash());
          return;
        }
        const r = await fetchDocument({ apiBase: p.apiBase, thesisId: p.thesisId, token: p.token, ifNoneMatch: p.saveLoop.getHash() });
        if (r.status === 304) { p.onReloaded?.(p.saveLoop.getHash()); return; }
        loadDocument(r.bytes);
        // Whatever was still dirty described the bytes just replaced: nothing to save,
        // and a refused (412) save left dirty set would re-PUT on every reload after.
        p.saveLoop.discard();
        p.saveLoop.setHash(r.docHash);
        p.onReloaded?.(r.docHash);
      } catch (e) {
        console.warn("[docx] reload failed", e);
        p.onReloaded?.(p.saveLoop.getHash());
      }
    })();
  }, [p.reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a save that changed paragraph STRUCTURE, re-parse our own bytes so the
  // node ids are positional again (D7). No network: the bytes are the ones we
  // just sent. The caret is put back by tryRestore.
  useEffect(() => {
    const unsub = p.saveLoop.onSaved((bytes) => {
      if (!structureChanged.current) return;
      // Typed since those bytes were taken: re-parsing them would drop the keystrokes.
      // The next save carries both, and re-parses then.
      if (p.saveLoop.isDirty()) return;
      structureChanged.current = false;
      loadDocument(bytes);
    });
    return unsub;
  }, [p.saveLoop, p.editorRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── scroll to a block index (outline drawer, modk:// links, deep link) ──
  useEffect(() => {
    const t = p.scrollToIndex;
    const editor = editorOf();
    if (!t || !editor) return;
    const m = findBlockMatch(editor, t.index, t.text);
    if (m) editor.scrollToBlock(m.blockId);
  }, [p.scrollToIndex?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
