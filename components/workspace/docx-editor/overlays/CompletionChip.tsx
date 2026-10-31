// Task 16 — AI autocomplete on the docx surface (spec D11): a floating "continue…"
// chip under the line the student is writing, instead of Lexical's ghost text
// inside the paragraph (the engine has no node we could stream grey text into).
//
// The watcher mirrors the Lexical CompletionPlugin's rules: a COLLAPSED caret at
// the END of a body paragraph with at least two characters, then 600ms of quiet
// → onRequestCompletion({index, text}). Any later caret move or edit makes a
// pending or showing completion stale → onCancelCompletion. Nothing runs while
// the feature is off or another AI proposal is on screen.
//
// Accept (tap the chip) inserts the text AT THE CARET in the engine — instantly,
// and saved by the ordinary save loop — then tells the host `local: true` so the
// completion store does NOT also write it as an editText op (that would put the
// continuation in twice). If the engine refuses the insert, `local: false` hands
// the write to the store's own path.
//
// Caret and paragraph come from the engine (useEditorCaret: paragraph id + UTF-16
// offset); "at the end" and the chip's position come from the painted spans,
// which carry the paragraph id and their [data-start, data-end) model range.

import { useEffect, useRef, useState, type RefObject } from "react";
import { useEditorCaret, useEditorEvent } from "@docx-editor.dev/react";
import type { DocxEditorRef, EditorCommand } from "@docx-editor.dev/react";
import { getTextDirection } from "@/lib/text-direction";
import { ICON_CHECK, ICON_SPARK, ICON_X, Icon, keepFocus, viewportSize } from "./card-ui";
import { blockIndexOfFragmentId } from "./find-block-element";
import { subscribeLayout } from "./use-block-rect";
import type { CompletionInput, OverlayLabels } from "./types";

const IDLE_MS = 600;
// A caret that moved without the student touching anything (a reload putting the
// caret back, a programmatic selection) must not spend an AI call.
const USER_WINDOW_MS = 2500;

type Target = { index: number; text: string; paragraphId: string; offset: number };

const attrSel = (v: string) => v.replace(/["\\]/g, "\\$&");

/** What is painted of paragraph `id`: its text, where its text ends, its last line. */
function paintedParagraph(id: string): { text: string; end: number; lastLine: DOMRect | null; box: DOMRect | null } | null {
  const q = `[data-paragraph-id="${attrSel(id)}"]`;
  const frags = Array.from(document.querySelectorAll<HTMLElement>(`${q}[data-fragment-index]`));
  if (!frags.length) return null;
  let end = 0;
  let lastLine: HTMLElement | null = null;
  for (const s of Array.from(document.querySelectorAll<HTMLElement>(`${q}[data-end]`))) {
    const e = Number(s.dataset.end);
    if (Number.isFinite(e) && e >= end) { end = e; lastLine = s; }
  }
  const text = frags.map((f) => f.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
  return {
    text,
    end,
    lastLine: lastLine?.getBoundingClientRect() ?? null,
    box: frags[frags.length - 1].getBoundingClientRect(),
  };
}

export function CompletionLayer({ editorRef, enabled, suppressed, completion, labels, onRequest, onCommit, onCancel }: {
  editorRef: RefObject<DocxEditorRef | null>;
  enabled: boolean;
  suppressed: boolean;
  completion: CompletionInput | null | undefined;
  labels: OverlayLabels;
  onRequest: (ctx: { index: number; text: string }) => void;
  onCommit: (c: { index: number; text: string; local: boolean; paragraphText: string }) => void;
  onCancel: () => void;
}) {
  const caret = useEditorCaret();
  const [rev, setRev] = useState(0);
  const target = useRef<Target | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInput = useRef(0);
  // Hides the chip the moment it is used or dismissed, before the host's reset
  // arrives back over the bridge.
  const [spent, setSpent] = useState(-1);

  useEditorEvent("change", () => setRev((r) => r + 1));

  useEffect(() => {
    const stamp = () => { lastInput.current = Date.now(); };
    const evs = ["keydown", "beforeinput", "pointerdown", "touchstart"] as const;
    for (const e of evs) document.addEventListener(e, stamp, true);
    return () => { for (const e of evs) document.removeEventListener(e, stamp, true); };
  }, []);

  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // Any caret move or edit makes a pending/showing completion stale.
    if (target.current) { target.current = null; onCancel(); }
    if (!enabled || suppressed || !caret) return;
    const editor = editorRef.current?.getEditor();
    if (!editor || !editor.snapshot().selectionCollapsed) return;
    if (Date.now() - lastInput.current > USER_WINDOW_MS) return;
    const index = blockIndexOfFragmentId(caret.paragraphId);
    if (index == null) return; // a header/footnote/table-cell paragraph
    const here = { paragraphId: caret.paragraphId, offset: caret.offset };
    timer.current = setTimeout(() => {
      timer.current = null;
      const p = paintedParagraph(here.paragraphId);
      if (!p || here.offset < p.end || p.text.length < 2) return;
      target.current = { index, text: p.text, ...here };
      onRequest({ index, text: p.text });
    }, IDLE_MS);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [caret?.paragraphId, caret?.offset, rev, enabled, suppressed]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = target.current;
  const live = !!t && !!completion && !!completion.text && completion.nonce !== spent && !suppressed && enabled
    && (completion.index == null || completion.index === t.index);
  if (!live || !t || !completion) return null;

  const accept = () => {
    const text = completion.text;
    setSpent(completion.nonce);
    target.current = null; // our own insert must not read as "the caret moved"
    const editor = editorRef.current?.getEditor();
    let local = false;
    if (editor) {
      // Tapping the chip happened outside the page; put the caret back exactly
      // where the completion was asked for before inserting.
      const at = { paragraphId: t.paragraphId, offset: t.offset };
      const place = { type: "setSelection", range: { anchor: at, head: at } } as EditorCommand;
      if (editor.can(place).ok) editor.exec(place);
      const insert = { type: "insertText", text } as EditorCommand;
      if (editor.can(insert).ok) local = editor.exec(insert).ok;
    }
    onCommit({ index: t.index, text, local, paragraphText: t.text });
  };
  const dismiss = () => {
    setSpent(completion.nonce);
    target.current = null;
    onCancel();
  };
  return <Chip paragraphId={t.paragraphId} text={completion.text} labels={labels} onAccept={accept} onDismiss={dismiss} />;
}

function Chip({ paragraphId, text, labels, onAccept, onDismiss }: {
  paragraphId: string; text: string; labels: OverlayLabels; onAccept: () => void; onDismiss: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number; maxWidth: number } | null>(null);
  const rtl = getTextDirection(text, "ltr") === "rtl";
  useEffect(() => subscribeLayout(() => {
    const p = paintedParagraph(paragraphId);
    const line = p?.lastLine ?? p?.box;
    if (!p || !line || !p.box) { setPos(null); return; }
    const vw = viewportSize().width;
    const maxWidth = Math.min(vw - 16, Math.max(p.box.width, 240));
    // Aligned to the paragraph's START edge, right under its last line.
    const left = rtl ? Math.max(8, p.box.right - maxWidth) : Math.min(Math.max(8, p.box.left), vw - 8 - maxWidth);
    const next = { left, top: line.bottom + 6, maxWidth };
    setPos((prev) => (prev && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5 && prev.maxWidth === next.maxWidth ? prev : next));
  }), [paragraphId, rtl]);
  if (!pos) return null;
  return (
    <div className="kwo-chip" dir={rtl ? "rtl" : "ltr"} style={{ left: pos.left, top: pos.top, maxWidth: pos.maxWidth }}>
      <div className="kwo-chip-text" dir="auto" role="button" aria-label={labels.insert} onMouseDown={keepFocus} onClick={onAccept}>
        <b><Icon path={ICON_SPARK} size={11} /></b>{text}
      </div>
      <button type="button" className="kwo-sug-icon" title={labels.insert} aria-label={labels.insert} tabIndex={-1} onMouseDown={keepFocus} onClick={onAccept}>
        <Icon path={ICON_CHECK} size={15} />
      </button>
      <button type="button" className="kwo-sug-icon kwo-sug-danger" title={labels.dismiss} aria-label={labels.dismiss} tabIndex={-1} onMouseDown={keepFocus} onClick={onDismiss}>
        <Icon path={ICON_X} size={15} />
      </button>
    </div>
  );
}
