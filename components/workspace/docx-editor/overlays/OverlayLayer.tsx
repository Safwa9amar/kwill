// Task 13 — the overlay layer: every AI surface of the docx Writer, drawn OVER the
// painted document rather than inside it.
//
// Lexical rendered these as decorator nodes in its tree; here the document is never
// mutated to show a proposal. That is the point: a card cannot be saved, cannot
// mark the document dirty, and cannot make a reload wait for it — the whole
// "a pending proposal suppresses reseed/save" class of guards does not exist.
//
// Mounted as a child of <DocxEditor> (beside the Bridge) so the engine hooks
// resolve, and PORTALED into its own container on <body>, `position: fixed` cards
// placed on block rects from use-block-rect.ts — the web ChartLayer's technique.
//
// Also the DOM half of two host contracts:
//   - rangeApply → onRangeApplied: replace a range IN THE ENGINE (apply-range.ts),
//     the visual-first path of a range rewrite's Apply;
//   - applying: the result of a server-path apply, shown until the reload carrying
//     it lands (the first document load after it appeared), so the student never
//     watches the old text come back in between.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useEditorEvent } from "@docx-editor.dev/react";
import type { DocxEditorRef } from "@docx-editor.dev/react";
import { brand } from "@/constants/colors";
import { applyRangeLocally } from "./apply-range";
import { FloatingCard, ICON_SPARK, Icon, LABELS_EN, contentDir } from "./card-ui";
import { CompletionLayer } from "./CompletionChip";
import { OVERLAY_CSS } from "./overlay-css";
import { createPortal } from "./portal";
import { ApplyingBody, RangeCard } from "./RangeCard";
import { SuggestionCard, TablePreview } from "./SuggestionCard";
import { TableErrorStrip, TableLoadingOverlay, TableProposalCard } from "./TableProposalCard";
import { RANGE_APPLY_TTL_MS } from "./timing";
import { OVERLAY_ATTR } from "./use-block-rect";
import type { ApplyingPreview as ApplyingPreviewInput, OverlayLabels, OverlayProps } from "./types";

// Events that must not travel past the overlay to the engine's document-level
// listeners: a key typed into a card's textarea is not a key typed into the page.
// ⚠️ Stopped on the overlay CONTAINER, after React (which listens on that same
// portal container) has dispatched them — stopping any lower would starve React.
const CONTAINED_EVENTS = [
  "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "touchstart", "touchend",
  "keydown", "keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut", "contextmenu",
  "focusin", "focusout",
] as const;

/** "#F59433" → [245,148,51] (null when it is not a 6-digit hex). */
function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ApplyingPreview({ applying, gone, labels }: { applying: ApplyingPreviewInput; gone: boolean; labels: OverlayLabels }) {
  const cls = "kwo-still" + (gone ? " kwo-gone" : "");
  if (applying.kind === "range") {
    return (
      <FloatingCard anchor={{ kind: "range", start: applying.start, end: applying.end }} dir={contentDir(...applying.paragraphs)} className={cls}>
        <div className="kwo-applying-inner"><ApplyingBody paragraphs={applying.paragraphs} label={labels.applying} /></div>
      </FloatingCard>
    );
  }
  const rtl = applying.rtl != null ? applying.rtl : contentDir(...applying.rows.flat()) === "rtl";
  return (
    <FloatingCard anchor={{ kind: "block", index: applying.index }} dir={rtl ? "rtl" : "ltr"} className={cls}>
      <div className="kwo-applying-inner">
        <div className="kwo-applying-label"><Icon path={ICON_SPARK} size={12} /><span>{labels.applying}</span></div>
        <TablePreview rows={applying.rows} header={!!applying.header} rtl={rtl} />
      </div>
    </FloatingCard>
  );
}

export function OverlayLayer({ editorRef, ...p }: OverlayProps & { editorRef: RefObject<DocxEditorRef | null> }) {
  const labels = p.overlayLabels ?? LABELS_EN;

  // Our own container on <body>: cards are fixed-positioned, and mutations under
  // OVERLAY_ATTR never trigger a re-measure (use-block-rect.ts).
  const host = useMemo(() => {
    const el = document.createElement("div");
    el.setAttribute(OVERLAY_ATTR, "");
    el.className = "kwo-layer";
    return el;
  }, []);
  useLayoutEffect(() => {
    document.body.appendChild(host);
    const contain = (e: Event) => e.stopPropagation();
    for (const t of CONTAINED_EVENTS) host.addEventListener(t, contain);
    return () => {
      for (const t of CONTAINED_EVENTS) host.removeEventListener(t, contain);
      host.remove();
    };
  }, [host]);
  useLayoutEffect(() => {
    const accent = p.overlayAccent ?? brand.primary;
    const c = rgb(accent);
    host.style.setProperty("--kwo-accent", accent);
    // Ink on the white page: the accent itself is too light to read (orange on
    // white is ~2.3:1), so the chip text is the accent pulled toward black — in JS,
    // not color-mix(), which older WebViews reject outright.
    host.style.setProperty("--kwo-accent-ink", c ? `rgb(${c.map((v) => Math.round(v * 0.78)).join(",")})` : brand.primaryDeep);
    host.style.setProperty("--kwo-accent-wash", c ? `rgba(${c.join(",")},.12)` : "#FEF3E6");
  }, [host, p.overlayAccent]);

  // ── visual-first range rewrite: execute it in the engine ──
  const seenApply = useRef(-1);
  useEffect(() => {
    const req = p.rangeApply;
    if (!req || req.nonce === seenApply.current) return;
    seenApply.current = req.nonce;
    const reply = (ok: boolean, reason?: string) => void p.onRangeApplied?.({ nonce: req.nonce, ok, reason });
    // See timing.ts: past the TTL the host may already have sent this to the server.
    if (Date.now() - req.issuedAt > RANGE_APPLY_TTL_MS) { reply(false, "request expired"); return; }
    const editor = editorRef.current?.getEditor();
    if (!editor) { reply(false, "no editor"); return; }
    let out: ReturnType<typeof applyRangeLocally>;
    try { out = applyRangeLocally(editor, req); } catch (e) { out = { ok: false, reason: String((e as Error)?.message ?? e) }; }
    if (!out.ok) console.warn("[docx] local range apply refused → server path:", out.reason);
    reply(out.ok, out.ok ? undefined : out.reason);
  }, [p.rangeApply?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── the server-path preview: hide it once the reload carrying the result lands ──
  // A load() emits a `change` that names no blocks; a student's edit names the ones
  // it touched. ⚠️ So the Bridge's own re-parse after a structural save also counts —
  // harmless (the preview fades a little early), and it cannot happen without a
  // save the student made in the meantime.
  const applyingRef = useRef(p.applying);
  applyingRef.current = p.applying;
  const [settled, setSettled] = useState(-1);
  useEditorEvent("change", (change) => {
    const a = applyingRef.current;
    if (!a) return;
    if ((change.created?.length ?? 0) + (change.deleted?.length ?? 0) + (change.dirty?.length ?? 0) > 0) return;
    const n = a.nonce;
    // Two frames: the load is parsed before it is painted.
    requestAnimationFrame(() => requestAnimationFrame(() => setSettled(n)));
  });

  const sug = p.suggestion;
  const range = p.rangeSuggestion;
  const table = p.tableProposal;
  const tableLoading = p.tableLoadingIndex ?? null;
  const tableError = p.tableErrorIndex ?? null;
  const applying = p.applying;
  // A range card already showing "Applying…" is the same picture; never draw two.
  const showApplying = !!applying && !(applying.kind === "range" && range);

  return createPortal(
    <>
      <style>{OVERLAY_CSS}</style>
      {sug ? (
        <SuggestionCard
          key={`${sug.index}|${sug.instruction}`}
          sug={sug}
          labels={labels}
          onAction={(a, t) => void p.onSuggestAction?.(a, t)}
        />
      ) : null}
      {range ? (
        <RangeCard
          key={`${range.start}-${range.end}|${range.instruction}`}
          range={range}
          labels={labels}
          onAction={(a, t) => void p.onRangeAction?.(a, t)}
        />
      ) : null}
      {table ? (
        <TableProposalCard
          key={table.index}
          proposal={table}
          loading={tableLoading === table.index}
          thinking={p.tableThinking ?? ""}
          labels={labels}
          onAction={(a, n) => void p.onTableProposalAction?.(a, n)}
        />
      ) : tableLoading != null ? (
        <TableLoadingOverlay index={tableLoading} thinking={p.tableThinking ?? ""} labels={labels} />
      ) : tableError != null ? (
        <TableErrorStrip index={tableError} labels={labels} onAction={(a) => void p.onTableProposalAction?.(a)} />
      ) : null}
      {showApplying && applying ? (
        <ApplyingPreview key={applying.nonce} applying={applying} gone={settled === applying.nonce} labels={labels} />
      ) : null}
      <CompletionLayer
        editorRef={editorRef}
        enabled={!!p.completionEnabled}
        suppressed={!!sug || !!range || !!table || tableLoading != null}
        completion={p.completion}
        labels={labels}
        onRequest={(c) => void p.onRequestCompletion?.(c)}
        onCommit={(c) => void p.onCommitCompletion?.(c)}
        onCancel={() => void p.onCancelCompletion?.()}
      />
    </>,
    host,
  );
}
