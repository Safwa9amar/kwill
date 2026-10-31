// Task 14 — the inline AI proposal for ONE block, as a card over that block.
//
// A port of the Lexical SuggestionView (blockLexical.tsx), state for state: the
// instruction chip, the "Thought for Xs" trace, the proposal AS the paragraph with
// a green logical-edge bar and word-level add-marks, the original as an expandable
// teaser (del-marks when open), and the floating pill — Approve / Edit / Again /
// Reject. Every action kind the suggestion store produces has its own body:
// rewrite / caption / text fill (word diff), insertTable (grid preview),
// insertSourceImage (the figure), setChart (the proposed chart, peek at the current).
//
// The card only TALKS: every button is `onAction(...)` to the native store, which
// owns the decision. Approve there is `thesis-doc-store.mutate(op)`, which on this
// surface executes in the engine first (W1) — so the edit shows without a round
// trip. Reject / Again never touch the document, and neither does showing the card:
// nothing here mutates the engine, so a proposal can never be saved by accident.

import { useMemo, useState, type JSX } from "react";
import { diffWords, type DiffSegment } from "@/lib/word-diff";
import {
  ActionPill, FloatingCard, ICON_AGAIN, ICON_CHECK, ICON_PENCIL, ICON_X, InstructionChip, PillButton,
  ThinkingPill, Trace, WorkingNote, contentDir, keepFocus, useApplied, useLeaving,
} from "./card-ui";
import type { OverlayLabels, SuggestionInput } from "./types";

const FIGURE_STYLE = { maxWidth: "100%", maxHeight: "320px", borderRadius: "6px", display: "block", margin: "8px auto" } as const;
const PLACEHOLDER = { padding: "16px", textAlign: "center", color: "#8A94A4", background: "#F6F8FA", borderRadius: "8px", fontSize: "13px" } as const;

/** A word-diff run in the proposal (add) or the teaser (del); same text stays plain. */
function Segs({ segs, kind }: { segs: DiffSegment[]; kind: "add" | "del" }) {
  const drop = kind === "add" ? "del" : "add";
  return (
    <>
      {segs.filter((s) => s.kind !== drop).map((s, k) =>
        s.kind === kind
          ? <span key={k} className={kind === "add" ? "kwo-sug-add" : "kwo-sug-del"}>{s.text + " "}</span>
          : <span key={k}>{s.text + " "}</span>,
      )}
    </>
  );
}

export function TablePreview({ rows, header, rtl }: { rows: string[][]; header: boolean; rtl: boolean }) {
  return (
    <div className="kwo-tblscroll">
      <table dir={rtl ? "rtl" : "ltr"} style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => {
                const isHeader = header && ri === 0;
                const style = {
                  border: "1px solid #c8c8d0", padding: "4px 8px", maxWidth: "220px", textAlign: "start" as const,
                  ...(isHeader ? { backgroundColor: "#f0f0f3", fontWeight: 600 } : null),
                };
                return isHeader
                  ? <th key={ci} style={style} dir="auto">{cell}</th>
                  : <td key={ci} style={style} dir="auto">{cell}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function svgUri(svg: string): string {
  // As an <img> data URI, so server-made chart markup never meets the page DOM.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function SuggestionCard({ sug, labels, onAction }: {
  sug: SuggestionInput;
  labels: OverlayLabels;
  onAction: (action: string, text?: string) => void;
}) {
  const [peek, setPeek] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [leaving, leave] = useLeaving();
  const [applied, markApplied] = useApplied(sug.status + sug.proposed);
  const loading = sug.status === "loading";
  const err = sug.status === "error";
  const ready = sug.status === "ready";
  const dir = contentDir(sug.proposed, sug.original, sug.instruction);
  // Memoised: the card re-renders while a stream lands, and diffWords is O(n·m).
  const segs = useMemo(() => (ready ? diffWords(sug.original, sug.proposed) : []), [ready, sug.original, sug.proposed]);
  const hasMarks = segs.some((s) => s.kind === "same");

  const approve = () => markApplied(() => onAction("approve"));
  const reject = () => leave(() => onAction("reject"));
  const again = () => onAction("again");
  const rootCls = leaving ? "kwo-leaving-" + leaving : undefined;
  const anchor = { kind: "block" as const, index: sug.index };
  const head = (
    <>
      <InstructionChip text={sug.instruction} />
      <Trace reasoning={sug.reasoning} reasoningMs={sug.reasoningMs} labels={labels} />
    </>
  );

  // The body of a STRUCTURED proposal (no text to edit, no original to diff):
  // a figure from an attached source, a native chart edit, a new table.
  let structured: JSX.Element | null = null;
  if (ready && sug.action === "insertSourceImage" && sug.hasImage) {
    const style = sug.imageWidth && sug.imageHeight
      ? { ...FIGURE_STYLE, width: `${sug.imageWidth}px`, aspectRatio: `${sug.imageWidth} / ${sug.imageHeight}`, objectFit: "contain" as const }
      : FIGURE_STYLE;
    structured = sug.imageDataUri
      ? <div className="kwo-sug-proposed"><img src={sug.imageDataUri} style={style} alt="" /></div>
      // Too big to cross the bridge for a preview; the proposal itself is fine.
      : <div style={PLACEHOLDER}>{labels.imageFromSource}</div>;
  } else if (ready && sug.action === "setChart" && sug.chartSvg) {
    const svg = peek && sug.chartOriginalSvg ? sug.chartOriginalSvg : sug.chartSvg;
    structured = <div className="kwo-sug-proposed"><img src={svgUri(svg)} style={FIGURE_STYLE} alt="" /></div>;
  } else if (ready && sug.action === "insertTable" && sug.proposedRows?.length) {
    structured = <TablePreview rows={sug.proposedRows} header={!!sug.tableHeader} rtl={!!sug.tableRtl} />;
  }

  // Approved: the bare result, until the host drops the proposal (see useApplied).
  if (ready && applied) {
    return (
      <FloatingCard anchor={anchor} dir={dir}>
        {structured ?? <div className="kwo-sug-proposed" dir="auto">{sug.proposed}</div>}
      </FloatingCard>
    );
  }

  if (ready && editing) {
    return (
      <FloatingCard anchor={anchor} dir={dir}>
        <InstructionChip text={sug.instruction} />
        <textarea
          className="kwo-sug-edit"
          dir="auto"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <ActionPill>
          <PillButton primary icon={ICON_CHECK} label={labels.done} onPress={() => {
            const t = draft.trim();
            if (t) onAction("edit", t);
            setEditing(false);
          }} />
          <PillButton icon={ICON_X} label={labels.cancel} onPress={() => setEditing(false)} />
        </ActionPill>
      </FloatingCard>
    );
  }

  if (loading) {
    return (
      <FloatingCard anchor={anchor} dir={dir}>
        {head}
        <div className="kwo-sug-proposed kwo-sug-loading" dir="auto">{sug.proposed || sug.original}</div>
        <WorkingNote active stream={sug.reasoning + sug.proposed} labels={labels} />
        <ThinkingPill label={labels.thinking} />
      </FloatingCard>
    );
  }

  if (err) {
    return (
      <FloatingCard anchor={anchor} dir={dir} className={rootCls}>
        {head}
        {sug.original ? <div className="kwo-sug-proposed" dir="auto">{sug.original}</div> : null}
        {/* The model's own reason when it has one ("no figure in your attached files
            matches that") — far more useful than the generic line. */}
        <div className="kwo-sug-err" dir="auto">{sug.errorText || labels.failed}</div>
        <ActionPill>
          <PillButton primary icon={ICON_AGAIN} label={labels.again} onPress={again} />
          <PillButton danger icon={ICON_X} label={labels.reject} onPress={reject} />
        </ActionPill>
      </FloatingCard>
    );
  }

  if (structured) {
    return (
      <FloatingCard anchor={anchor} dir={dir} className={rootCls}>
        {head}
        {structured}
        {sug.action === "setChart" && sug.proposed.trim()
          ? <div className="kwo-sug-teaser-txt" dir="auto">{sug.proposed}</div>
          : null}
        {sug.action === "setChart" && sug.chartOriginalSvg ? (
          <div className="kwo-sug-teaser" role="button" onMouseDown={keepFocus} onClick={() => setPeek((v) => !v)}>
            <div className="kwo-sug-teaser-txt" dir="auto">{peek ? labels.hideCurrentChart : labels.showCurrentChart}</div>
          </div>
        ) : null}
        <ActionPill>
          <PillButton primary icon={ICON_CHECK} label={labels.approve} onPress={approve} />
          <PillButton icon={ICON_AGAIN} label={labels.again} onPress={again} />
          <PillButton danger icon={ICON_X} label={labels.reject} onPress={reject} />
        </ActionPill>
      </FloatingCard>
    );
  }

  return (
    <FloatingCard anchor={anchor} dir={dir} className={rootCls}>
      {head}
      <div className="kwo-sug-proposed" dir="auto">
        {hasMarks ? <Segs segs={segs} kind="add" /> : sug.proposed}
      </div>
      {sug.original.trim() ? (
        <div
          className="kwo-sug-teaser"
          role="button"
          aria-label={peek ? labels.hideOriginal : labels.showOriginal}
          onMouseDown={keepFocus}
          onClick={() => setPeek((v) => !v)}
        >
          <div className={"kwo-sug-teaser-txt" + (peek ? "" : " kwo-sug-clamp")} dir="auto">
            {peek && hasMarks ? <Segs segs={segs} kind="del" /> : sug.original}
          </div>
        </div>
      ) : null}
      <ActionPill>
        <PillButton primary icon={ICON_CHECK} label={labels.approve} onPress={approve} />
        <PillButton icon={ICON_PENCIL} label={labels.edit} onPress={() => { setDraft(sug.proposed); setEditing(true); }} />
        <PillButton icon={ICON_AGAIN} label={labels.again} onPress={again} />
        <PillButton danger icon={ICON_X} label={labels.reject} onPress={reject} />
      </ActionPill>
    </FloatingCard>
  );
}
