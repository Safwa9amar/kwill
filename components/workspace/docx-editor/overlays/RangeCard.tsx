// Task 15 — the RANGE rewrite (2+ blocks → a passage of however many paragraphs
// the content needs), as ONE card over the union of blocks start..end.
//
// A port of the Lexical RangeSuggestionView: one row per proposed paragraph with a
// keep/drop toggle, the original passage as a teaser, Apply (N) / Again / Reject.
//
// Apply is visual-first. The card turns AT ONCE into the kept paragraphs under an
// "Applying…" line and stays like that until the host drops the range — it never
// fades out over the old passage. Behind it the store tries the engine first (the
// passage is replaced locally, the save loop carries the bytes — see
// overlays/apply-range.ts); only if that is refused does the server apply it, and
// then the host paints the same preview (ApplyingPreview) until the reload lands.
// A failure on either path puts the card back with the error.

import { useEffect, useState } from "react";
import {
  ActionPill, FloatingCard, ICON_AGAIN, ICON_CHECK, ICON_SPARK, ICON_X, Icon, InstructionChip, PillButton,
  ThinkingPill, Trace, WorkingNote, contentDir, keepFocus, useApplied, useLeaving,
} from "./card-ui";
import type { OverlayLabels, RangeSuggestionInput } from "./types";

/** The passage split the way the store splits it on approve (blank lines). */
export function splitPassage(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

/** The kept paragraphs as they will read once applied, with the "Applying…" line. */
export function ApplyingBody({ paragraphs, label }: { paragraphs: string[]; label: string }) {
  return (
    <>
      <div className="kwo-applying-label"><Icon path={ICON_SPARK} size={12} /><span>{label}</span></div>
      <div className="kwo-sug-passage">
        {paragraphs.map((p, i) => <div key={i} className="kwo-sug-proposed kwo-sug-ppara" dir="auto">{p}</div>)}
      </div>
    </>
  );
}

export function RangeCard({ range, labels, onAction }: {
  range: RangeSuggestionInput;
  labels: OverlayLabels;
  onAction: (action: string, text?: string) => void;
}) {
  const [peek, setPeek] = useState(false);
  const [leaving, leave] = useLeaving();
  // holdMs 0: the server path can take seconds, and only the host knows when it is
  // over — it drops the range (success) or flips it to "error" (resets this).
  const [applied, markApplied] = useApplied(range.status, 0);
  const [keptOnApply, setKeptOnApply] = useState<string[]>([]);
  // The paragraphs the student DROPPED; a fresh proposal (stream / Again) starts all-kept.
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  useEffect(() => { setDropped(new Set()); }, [range.proposed]);

  const loading = range.status === "loading";
  const err = range.status === "error";
  const paras = splitPassage(range.proposed);
  const kept = paras.filter((_, i) => !dropped.has(i));
  const dir = contentDir(range.proposed, range.original, range.instruction);
  const anchor = { kind: "range" as const, start: range.start, end: range.end };
  const rootCls = leaving ? "kwo-leaving-" + leaving : undefined;

  const approve = () => {
    if (!kept.length) return;
    setKeptOnApply(kept);
    markApplied(() => onAction("approve", kept.join("\n\n")));
  };
  const reject = () => leave(() => onAction("reject"));
  const again = () => onAction("again");
  const toggleDrop = (i: number) =>
    setDropped((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const head = (
    <>
      <InstructionChip text={range.instruction} />
      <Trace reasoning={range.reasoning} reasoningMs={range.reasoningMs} labels={labels} />
    </>
  );

  if (applied && !err) {
    return (
      <FloatingCard anchor={anchor} dir={dir}>
        <div className="kwo-applying-inner">
          <ApplyingBody paragraphs={keptOnApply} label={labels.applying} />
        </div>
      </FloatingCard>
    );
  }

  if (loading) {
    return (
      <FloatingCard anchor={anchor} dir={dir}>
        {head}
        <div className="kwo-sug-proposed kwo-sug-loading" dir="auto">{range.proposed || range.original}</div>
        <WorkingNote active stream={range.reasoning + range.proposed} labels={labels} />
        <ThinkingPill label={labels.thinking} />
      </FloatingCard>
    );
  }

  if (err) {
    return (
      <FloatingCard anchor={anchor} dir={dir} className={rootCls}>
        {head}
        <div className="kwo-sug-passage">
          {splitPassage(range.original).map((p, i) => <div key={i} className="kwo-sug-proposed kwo-sug-ppara" dir="auto">{p}</div>)}
        </div>
        <div className="kwo-sug-err" dir="auto">{labels.failed}</div>
        <ActionPill>
          <PillButton primary icon={ICON_AGAIN} label={labels.again} onPress={again} />
          <PillButton danger icon={ICON_X} label={labels.reject} onPress={reject} />
        </ActionPill>
      </FloatingCard>
    );
  }

  const applyLabel = dropped.size ? `${labels.apply} ${kept.length}` : labels.apply;
  return (
    <FloatingCard anchor={anchor} dir={dir} className={rootCls}>
      {head}
      <div className="kwo-sug-passage">
        {paras.map((p, i) => {
          const isDropped = dropped.has(i);
          return (
            <div key={i} className="kwo-sug-prow">
              <div className={"kwo-sug-proposed kwo-sug-ppara" + (isDropped ? " kwo-sug-dropped" : "")} dir="auto">{p}</div>
              <button
                type="button"
                className={"kwo-sug-toggle" + (isDropped ? " on" : "")}
                title={isDropped ? labels.keep : labels.drop}
                aria-label={isDropped ? labels.keep : labels.drop}
                tabIndex={-1}
                onMouseDown={keepFocus}
                onClick={() => toggleDrop(i)}
              >
                <Icon path={ICON_X} size={15} />
              </button>
            </div>
          );
        })}
      </div>
      {range.original.trim() ? (
        <div
          className="kwo-sug-teaser"
          role="button"
          aria-label={peek ? labels.hideOriginal : labels.showOriginal}
          onMouseDown={keepFocus}
          onClick={() => setPeek((v) => !v)}
        >
          <div className={"kwo-sug-teaser-txt" + (peek ? "" : " kwo-sug-clamp")} dir="auto">{range.original}</div>
        </div>
      ) : null}
      <ActionPill>
        <PillButton primary icon={ICON_CHECK} label={applyLabel} disabled={!kept.length} onPress={approve} />
        <PillButton icon={ICON_AGAIN} label={labels.again} onPress={again} />
        <PillButton danger icon={ICON_X} label={labels.reject} onPress={reject} />
      </ActionPill>
    </FloatingCard>
  );
}
