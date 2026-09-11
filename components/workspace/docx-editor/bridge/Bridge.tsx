// The live half of the bridge. Runs inside the engine's React context (a child
// of <DocxEditor>), so the slot/style/format hooks resolve. Owns: the selection
// report (engine → LexicalState), command execution (LexicalCommand → engine),
// the save loop's triggers, flush, reload and scroll-to-index.
//
// Hooks are called UNCONDITIONALLY and the slot table is fixed — React's rule.

import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  commandForSlot,
  useEditorCommand,
  useEditorEvent,
  useEditorState,
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
import type { SaveLoop } from "./save-loop";

// A report counts as the student's own doing for this long after a touch/key.
// Same constant, same reason as Lexical's EditorBridge: focus leaving the WebView
// (tapping ✦ Ask) collapses the selection, and the host must be able to refuse
// the phantom single-block report that follows.
const DRIVING_MS = 1500;

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
    const value = c?.kind === "hex" && c.value ? c.value : "auto";
    const cmd = commandForSlotValue("text.color", value);
    if (cmd) editor.exec(cmd);
  }
}

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
  onServerFormat: ((index: number, changes: { direction: "rtl" | "ltr" }) => void) | undefined;
};

export function Bridge(p: BridgeProps) {
  const editorOf = () => p.editorRef.current?.getEditor() ?? null;
  const drivenAt = useRef(0);
  const lastFocus = useRef<{ index: number; text: string } | null>(null);
  const structureChanged = useRef(false);
  const restore = useRef<{ index: number; text: string } | null>(null);

  // Fixed slot table (hooks, unconditional).
  const slots: Record<string, ReturnType<typeof useEditorCommand>> = {
    "text.bold": useEditorCommand("text.bold"),
    "text.italic": useEditorCommand("text.italic"),
    "text.underline": useEditorCommand("text.underline"),
    "alignment.left": useEditorCommand("alignment.left"),
    "alignment.center": useEditorCommand("alignment.center"),
    "alignment.right": useEditorCommand("alignment.right"),
    "alignment.justify": useEditorCommand("alignment.justify"),
    "list.bullet": useEditorCommand("list.bullet"),
    "list.numbered": useEditorCommand("list.numbered"),
    "format.clear": useEditorCommand("format.clear"),
    "history.undo": useEditorCommand("history.undo"),
    "history.redo": useEditorCommand("history.redo"),
  };
  const style = useParagraphStyle();
  const para = useParagraphFormat();
  const isLoading = useEditorState((s) => s.isLoading);

  useEffect(() => {
    const mark = () => { drivenAt.current = Date.now(); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) document.addEventListener(ev, mark, true);
    return () => { for (const ev of ["pointerdown", "keydown", "touchstart"]) document.removeEventListener(ev, mark, true); };
  }, []);

  // ── engine → native: the selection report ──
  const report = useCallback(() => {
    const editor = editorOf();
    if (!editor) return;
    const sel = window.getSelection();
    const { blocks, focus } = spannedBlocks(sel);
    const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    // null when nothing is selected or nothing is derivable — read as "no formatting".
    const fmt = editor.getSelectionFormatting();
    const styleId = fmt?.styleId ?? "";
    const h = /^Heading([1-6])$/.exec(styleId);
    const blockType = slots["list.bullet"].isActive ? "bullet"
      : slots["list.numbered"].isActive ? "number"
      : h ? `h${h[1]}`
      : styleId === "Quote" ? "quote"
      : "paragraph";
    if (focus) lastFocus.current = { index: focus.index, text: focus.text };
    p.onState({
      bold: !!fmt?.bold, italic: !!fmt?.italic, underline: !!fmt?.underline,
      blockType,
      isRTL: focus ? getComputedStyle(focus.el).direction === "rtl" : false,
      alignment: (fmt?.alignment as LexicalState["alignment"]) ?? null,
      index: focus?.index ?? -1,
      text: focus?.text ?? "",
      blocks: blocks.map(({ index, text }) => ({ index, text })),
      y: rect && rect.height > 0 ? rect.top : -1,
      canUndo: slots["history.undo"].isEnabled,
      canRedo: slots["history.redo"].isEnabled,
      userDriven: document.hasFocus() && Date.now() - drivenAt.current < DRIVING_MS,
    });
  }, [p.onState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEditorEvent("selectionChange", report);
  useEditorEvent("change", (change) => {
    if ((change.created?.length ?? 0) + (change.deleted?.length ?? 0) > 0) structureChanged.current = true;
    p.saveLoop.markDirty();
    report();
  });

  // ── native → engine: commands ──
  useEffect(() => {
    const cmd = p.command;
    const editor = editorOf();
    if (!cmd || !editor) return;
    for (const a of mapCommand(cmd)) {
      switch (a.kind) {
        case "slot": slots[a.slot]?.execute(); break;
        case "style": style.setValue(a.styleId); break;
        case "paragraph": para.apply(a.update); break;
        case "marks": applyMarks(editor, a.marks); break;
        case "selectParagraph": {
          const f = lastFocus.current;
          const m = f ? findBlockMatch(editor, f.index, f.text, Infinity) : null;
          if (m) editor.selectMatch(m);
          break;
        }
        case "server": { const f = lastFocus.current; if (f) p.onServerFormat?.(f.index, a.changes); break; }
        case "noop": break;
      }
    }
  }, [p.command?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── flush (awaited by ai-service before a turn) ──
  useEffect(() => {
    const n = p.flushNonce;
    if (n == null) return;
    void p.saveLoop.flush().finally(() => p.onFlushed?.(n));
  }, [p.flushNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── reload from the server (spec D3), conditional on the hash we hold ──
  const reload = useCallback(async (force: boolean) => {
    try {
      const r = await fetchDocument({ apiBase: p.apiBase, thesisId: p.thesisId, token: p.token, ifNoneMatch: force ? null : p.saveLoop.getHash() });
      if (r.status === 304) { p.onReloaded?.(p.saveLoop.getHash()); return; }
      restore.current = lastFocus.current;
      p.editorRef.current?.load(r.bytes);
      p.saveLoop.setHash(r.docHash);
      p.onReloaded?.(r.docHash);
    } catch (e) {
      console.warn("[docx] reload failed", e);
      p.onReloaded?.(p.saveLoop.getHash());
    }
  }, [p.apiBase, p.thesisId, p.token, p.saveLoop, p.onReloaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (p.reloadNonce == null || p.reloadNonce === 0) return;
    void reload(false);
  }, [p.reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a save that changed paragraph STRUCTURE, re-parse our own bytes so the
  // node ids are positional again (D7). No network: the bytes are the ones we
  // just sent. The caret is put back by the effect below.
  useEffect(() => {
    const unsub = p.saveLoop.onSaved((bytes) => {
      if (!structureChanged.current) return;
      structureChanged.current = false;
      restore.current = lastFocus.current;
      p.editorRef.current?.load(bytes);
    });
    return unsub;
  }, [p.saveLoop, p.editorRef]);

  // Put the caret back after any load() — the engine re-parses, ids are new.
  useEffect(() => {
    if (isLoading) return;
    const keep = restore.current;
    const editor = editorOf();
    if (!keep || !editor) return;
    restore.current = null;
    const m = findBlockMatch(editor, keep.index, keep.text);
    if (m) { editor.selectMatch(m); editor.scrollToBlock(m.blockId); }
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── scroll to a block index (outline drawer, modk:// links, deep link) ──
  useEffect(() => {
    const t = p.scrollToIndex;
    const editor = editorOf();
    if (!t || !editor || isLoading) return;
    const m = findBlockMatch(editor, t.index, t.text);
    if (m) editor.scrollToBlock(m.blockId);
  }, [p.scrollToIndex?.nonce, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
