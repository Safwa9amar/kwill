// Task 15 — the AI TABLE proposal (an edit of an EXISTING table), as a card over
// the table's painted rect, plus the two states around it: a request in flight
// (the table dims under a veil, the live thinking shows beside it) and a failed
// request (an error strip with Retry).
//
// The diff is a port of the Lexical ProposalDiffTable (blockLexical.tsx) and reads
// the SAME precomputed TableDiff (lib/table-diff.ts) the approve turns into tableOps
// — what the student sees is what gets applied. Added rows/cols green, edited cells
// amber with the struck old value inside, removed rows/cols as red struck ghosts at
// their mapped positions; Compare shows the plain original; Again takes a note.
//
// Approve goes to the host (the /ops tableOp batch, then a reload). The card turns
// at once into the new grid under "Applying…" and the host swaps in the same
// preview (ApplyingPreview) in the same render it drops the proposal, so the old
// table never shows in between.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  FloatingCard, ICON_SPARK, Icon, WorkingNote, contentDir, useAnchorRect, useApplied, viewportSize,
} from "./card-ui";
import { TablePreview } from "./SuggestionCard";
import type { OverlayLabels, TableProposalInput } from "./types";

const DIFF_ADD_BG = "#dcfce7";
const DIFF_EDIT_BG = "#fef3c7";
const DIFF_DEL_BG = "#fee2e2";
const CELL_MAX_WIDTH = "220px";

// OOXML border style → CSS (best-effort) — the Lexical cellBorderCss rule, verbatim.
const BORDER_CSS: Record<string, string> = { single: "solid", thick: "solid", double: "double", dashed: "dashed", dotted: "dotted" };
function borderCss(style: string, pt: number, color: string): string {
  const px = Math.max(1, Math.round(style === "thick" ? Math.max(2, pt) : pt));
  return `${px}px ${BORDER_CSS[style] ?? "solid"} ${color}`;
}

function PillBtn({ label, tone, onPress }: { label: string; tone?: "ok" | "no"; onPress: () => void }) {
  return (
    <button
      type="button"
      className={"kwo-pillbtn" + (tone ? " " + tone : "")}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {label}
    </button>
  );
}

/** The ✦ chip heading the proposal; a disclosure for the trace when one exists. */
function AIChip({ label, open, onToggle }: { label: string; open?: boolean; onToggle?: () => void }) {
  if (!onToggle) return <div className="kwo-aichip">{`✦ ${label}`}</div>;
  return (
    <button type="button" className="kwo-aichip" onMouseDown={(e) => e.preventDefault()} onClick={onToggle}>
      {`✦ ${label} ${open ? "▾" : "▸"}`}
    </button>
  );
}

function TraceBox({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [text]);
  return <div ref={ref} className="kwo-tracebox" dir="auto">{text}</div>;
}

/** Live reasoning while the model works — collapsed to the chip, tap to expand. */
function ThinkingPanel({ text, labels }: { text: string; labels: OverlayLabels }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "2px 0" }}>
      <AIChip label={labels.table.thinking} open={open} onToggle={text ? () => setOpen((v) => !v) : undefined} />
      {open && text ? <TraceBox text={text} /> : null}
      <WorkingNote active stream={text} labels={labels} />
    </div>
  );
}

function DiffGrid({ proposal, dir }: { proposal: TableProposalInput; dir: "rtl" | "ltr" }) {
  const { originalRows, newRows, diff } = proposal;
  const edited = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of diff.editedCells) m.set(`${e.r},${e.c}`, e.oldText);
    return m;
  }, [diff]);
  // Interleave ghost (removed) rows at their mapped positions among the new rows.
  const rowEntries = useMemo(() => {
    const entries: ({ kind: "new"; r: number } | { kind: "ghost"; oldR: number })[] =
      newRows.map((_, r) => ({ kind: "new" as const, r }));
    for (const oldR of [...diff.removedRows].sort((a, b) => a - b)) {
      let pos = entries.length;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.kind === "new") {
          const m = diff.rowMap[e.r];
          if (m != null && m > oldR) { pos = i; break; }
        }
      }
      entries.splice(pos, 0, { kind: "ghost", oldR });
    }
    return entries;
  }, [newRows, diff]);

  // The PROPOSED borders preview on every cell (default grid otherwise).
  const pl = proposal.layout;
  const border = pl?.borders === false
    ? "none"
    : pl?.borderStyle || pl?.borderSizePt || pl?.borderColor
      ? borderCss(pl.borderStyle ?? "single", pl.borderSizePt ?? 0.5, `#${(pl.borderColor ?? "000000").replace("#", "")}`)
      : "1px solid #c8c8d0";
  const base: CSSProperties = { border, padding: "4px 8px", maxWidth: CELL_MAX_WIDTH };
  const ghost: CSSProperties = { ...base, backgroundColor: DIFF_DEL_BG, color: "#b91c1c", textDecoration: "line-through" };

  return (
    <div className="kwo-tblscroll">
      <table dir={dir} style={{ borderCollapse: "collapse", fontSize: "13px", margin: "6px 0", width: "max-content", minWidth: "100%" }}>
        <tbody>
          {rowEntries.map((entry) => {
            if (entry.kind === "ghost") {
              return (
                <tr key={`g${entry.oldR}`}>
                  {(originalRows[entry.oldR] ?? []).map((cell, ci) => <td key={ci} style={ghost} dir="auto">{cell}</td>)}
                </tr>
              );
            }
            const r = entry.r;
            const rowAdded = diff.rowMap[r] == null;
            const oldR = diff.rowMap[r];
            return (
              <tr key={r}>
                {(newRows[r] ?? []).map((cell, c) => {
                  const colAdded = diff.colMap[c] == null;
                  const oldText = edited.get(`${r},${c}`);
                  // The proposed COLOUR is the point of a "colour the header" ask, so it
                  // shows even where the text did not change.
                  const fill = proposal.fills?.[r]?.[c] ?? (r === 0 && pl?.headerFill ? pl.headerFill : null);
                  const ink = proposal.textColors?.[r]?.[c] ?? null;
                  const style: CSSProperties = { ...base };
                  if (fill) style.backgroundColor = `#${fill.replace("#", "")}`;
                  if (ink) style.color = `#${ink.replace("#", "")}`;
                  if (rowAdded || colAdded) style.backgroundColor = DIFF_ADD_BG;
                  else if (oldText !== undefined) style.backgroundColor = DIFF_EDIT_BG;
                  return (
                    <td key={c} style={style} dir="auto">
                      {oldText !== undefined && !rowAdded && !colAdded ? (
                        <>
                          <span style={{ display: "block", fontSize: "10px", color: "#b91c1c", textDecoration: "line-through" }}>{oldText}</span>
                          {cell}
                        </>
                      ) : cell}
                    </td>
                  );
                })}
                {/* Removed columns as ghosts at the row's end, from the mapped old row. */}
                {diff.removedCols.map((oc) => (
                  <td key={`gc${oc}`} style={ghost} dir="auto">{oldR != null ? (originalRows[oldR]?.[oc] ?? "") : ""}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PlainGrid({ rows, dir }: { rows: string[][]; dir: "rtl" | "ltr" }) {
  return (
    <div className="kwo-tblscroll">
      <table dir={dir} style={{ borderCollapse: "collapse", fontSize: "13px", margin: "6px 0", width: "max-content", minWidth: "100%" }}>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={{ border: "1px solid #c8c8d0", padding: "4px 8px", maxWidth: CELL_MAX_WIDTH }} dir="auto">{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableProposalCard({ proposal, loading, thinking, labels, onAction }: {
  proposal: TableProposalInput;
  /** An "Again" is in flight: the current proposal stays, dimmed, with live thinking. */
  loading: boolean;
  thinking: string;
  labels: OverlayLabels;
  onAction: (action: "approve" | "reject" | "again" | "retry", note?: string) => void;
}) {
  const L = labels.table;
  const [compare, setCompare] = useState(false);
  const [againOpen, setAgainOpen] = useState(false);
  const [note, setNote] = useState("");
  const [traceOpen, setTraceOpen] = useState(false);
  // ⚠️ Keyed on VALUES: every prop object arrives freshly parsed from the bridge on
  // each host render, so an object key would reset this on any unrelated update.
  const [applied, markApplied] = useApplied(`${proposal.index}|${proposal.thoughtMs ?? ""}|${proposal.newRows.length}`);
  // The table's own direction when the DTO knows it, else from its content.
  const dir: "rtl" | "ltr" = proposal.rtl != null ? (proposal.rtl ? "rtl" : "ltr") : contentDir(...proposal.newRows.flat());
  const anchor = { kind: "block" as const, index: proposal.index };

  if (applied) {
    return (
      <FloatingCard anchor={anchor} dir={dir}>
        <div className="kwo-applying-inner">
          <div className="kwo-applying-label"><Icon path={ICON_SPARK} size={12} /><span>{labels.applying}</span></div>
          <TablePreview rows={proposal.newRows} header={false} rtl={dir === "rtl"} />
        </div>
      </FloatingCard>
    );
  }

  const chipLabel = compare
    ? L.original
    : proposal.thoughtMs != null ? L.thought.replace("{s}", String(Math.max(1, Math.round(proposal.thoughtMs / 1000)))) : L.proposal;
  const sendAgain = () => { setAgainOpen(false); onAction("again", note); };

  return (
    <FloatingCard anchor={anchor} dir={dir}>
      <div className={loading ? "kwo-tbl-loading" : undefined}>
        <AIChip
          label={chipLabel}
          open={traceOpen}
          onToggle={thinking && !compare ? () => setTraceOpen((v) => !v) : undefined}
        />
        {traceOpen && thinking && !compare ? <TraceBox text={thinking} /> : null}
        {compare ? <PlainGrid rows={proposal.originalRows} dir={dir} /> : <DiffGrid proposal={proposal} dir={dir} />}
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", margin: "4px 0 8px" }}>
          <PillBtn label={`✓ ${L.approve}`} tone="ok" onPress={() => markApplied(() => onAction("approve"))} />
          <PillBtn label={`⇄ ${compare ? L.showProposal : L.compare}`} onPress={() => setCompare((v) => !v)} />
          <PillBtn label={`↻ ${L.again}`} onPress={() => setAgainOpen((v) => !v)} />
          <PillBtn label={`✕ ${L.reject}`} tone="no" onPress={() => onAction("reject")} />
        </div>
        {againOpen ? (
          <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
            <input
              value={note}
              placeholder={L.notePlaceholder}
              dir="auto"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendAgain(); } }}
              style={{ flex: 1, border: "1px solid #d4d4dc", borderRadius: "8px", padding: "5px 10px", fontSize: "12.5px", minWidth: 0 }}
            />
            <PillBtn label={L.send} tone="ok" onPress={sendAgain} />
          </div>
        ) : null}
      </div>
      {loading ? <ThinkingPanel text={thinking} labels={labels} /> : null}
    </FloatingCard>
  );
}

/**
 * A strip just ABOVE a block (or over its top edge when there is no room above),
 * for the table's "thinking" and "failed" states — Lexical drew both in the flow
 * right next to the table; an overlay has to place them.
 */
function EdgeStrip({ index, className, children }: { index: number; className: string; children: ReactNode }) {
  const rect = useAnchorRect({ kind: "block", index });
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => { if (ref.current) setH(ref.current.offsetHeight); });
  if (!rect) return null;
  const vw = viewportSize().width;
  const width = Math.min(vw - 16, Math.max(rect.width, 280));
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), vw - 8 - width);
  const above = rect.top - h - 6;
  const top = above >= 8 ? above : rect.top + 4;
  return <div ref={ref} className={className} style={{ left, top, width }}>{children}</div>;
}

/** A table request in flight with no proposal yet: the real table dims under a
 *  pulsing veil, and the live thinking shows above it. */
export function TableLoadingOverlay({ index, thinking, labels }: { index: number; thinking: string; labels: OverlayLabels }) {
  const rect = useAnchorRect({ kind: "block", index });
  return (
    <>
      {rect ? <div className="kwo-veil" style={{ left: rect.left - 2, top: rect.top - 2, width: rect.width + 4, height: rect.height + 4 }} /> : null}
      <EdgeStrip index={index} className="kwo-card">
        <ThinkingPanel text={thinking} labels={labels} />
      </EdgeStrip>
    </>
  );
}

/** The last table request failed: say so on the table, with Retry and dismiss. */
export function TableErrorStrip({ index, labels, onAction }: {
  index: number; labels: OverlayLabels; onAction: (action: "retry" | "reject") => void;
}) {
  return (
    <EdgeStrip index={index} className="kwo-strip">
      <span style={{ fontSize: "12px", color: "#b91c1c", flex: 1 }} dir="auto">{`⚠ ${labels.table.failed}`}</span>
      <PillBtn label={`↻ ${labels.table.retry}`} onPress={() => onAction("retry")} />
      <PillBtn label="✕" tone="no" onPress={() => onAction("reject")} />
    </EdgeStrip>
  );
}
