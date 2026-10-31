// The pieces every overlay card is built from, ported from the Lexical inline
// suggestion (components/workspace/lexical/blockLexical.tsx — SuggestionView,
// RangeSuggestionView, ProposalDiffTable) so the student sees the same card on
// both surfaces. DOM-only: imported from the 'use dom' tree, never from native.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useWorkingClock } from "@/hooks/useWorkingClock";
import { formatElapsed } from "@/lib/thinking";
import { getTextDirection, type TextDirection } from "@/lib/text-direction";
import { placeCard } from "./place";
import { useBlockRect, useRangeRect } from "./use-block-rect";
import type { OverlayLabels } from "./types";

// Inline SVG glyphs (lucide geometry) — a WebView font tofus bare ✓/✕ characters.
export const ICON_CHECK = "M20 6 9 17l-5-5";
export const ICON_X = "M18 6 6 18|M6 6l12 12";
export const ICON_PENCIL = "M12 20h9|M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z";
export const ICON_AGAIN = "M23 4v6h-6|M20.49 15a9 9 0 1 1-2.12-9.36L23 10";
export const ICON_SPARK = "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z";

export function Icon({ path, size }: { path: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      {path.split("|").map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** English fallbacks, only for a host that forgot to pass labels. */
export const LABELS_EN: OverlayLabels = {
  approve: "Approve", edit: "Edit", again: "Again", reject: "Reject", done: "Done", cancel: "Cancel",
  thinking: "Thinking…", failed: "Couldn't generate a suggestion.", showOriginal: "Show original text",
  hideOriginal: "Hide original text", thought: "Thought for {s}s", reasoning: "Reasoning", apply: "Apply",
  keep: "Keep this paragraph", drop: "Drop this paragraph", applying: "Applying…", insert: "Insert",
  dismiss: "Close", imageFromSource: "Image from your attached file",
  showCurrentChart: "Tap to see the current chart",
  hideCurrentChart: "Showing the current chart — tap to see the proposal",
  working: {
    short: "Working on it…",
    long: "Still working — this can take a while. Please wait.",
    veryLong: "Still working on a long task — please keep waiting.",
  },
  table: {
    proposal: "AI suggestion", original: "Original — before changes", thought: "Thought for {s}s",
    thinking: "Thinking…", approve: "Approve", compare: "Compare", showProposal: "Proposal", again: "Again",
    reject: "Reject", send: "Send", notePlaceholder: "Note for the retry…", failed: "Suggestion failed", retry: "Retry",
  },
};

/** "Thought for {s}s" with the whole seconds filled in (at least 1). */
export function thoughtFor(template: string, ms: number): string {
  return template.replace("{s}", String(Math.max(1, Math.round(ms / 1000))));
}

/** The card's own direction, from its CONTENT — never the app locale, never the
 *  thesis language field (unreliable; see thesis-language-rtl). */
export function contentDir(...texts: (string | undefined)[]): TextDirection {
  return getTextDirection(texts.filter(Boolean).join(" "), "ltr");
}

/**
 * Taps on a card must not move focus into the editor (WKWebView then scrolls the
 * caret's page into view) — mousedown is cancelled on every button. A click still fires.
 */
export const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

export function PillButton({ primary, danger, icon, label, disabled, onPress }: {
  primary?: boolean; danger?: boolean; icon: string; label: string; disabled?: boolean; onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={primary ? "kwo-sug-approve" : "kwo-sug-icon" + (danger ? " kwo-sug-danger" : "")}
      title={label}
      aria-label={label}
      tabIndex={-1}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onPress}
    >
      <Icon path={icon} size={primary ? 15 : 16} />
      {primary ? <span>{label}</span> : null}
    </button>
  );
}

export function ActionPill({ children }: { children: ReactNode }) {
  return <div className="kwo-sug-pill"><div className="kwo-sug-pillrow">{children}</div></div>;
}

export function ThinkingPill({ label }: { label: string }) {
  return (
    <ActionPill>
      <div className="kwo-sug-think"><Icon path={ICON_SPARK} size={13} /><span>{label}</span></div>
    </ActionPill>
  );
}

export function InstructionChip({ text }: { text: string }) {
  return (
    <div className="kwo-sug-chip" dir="auto">
      <Icon path={ICON_SPARK} size={12} />
      <span>{text}</span>
    </div>
  );
}

/** The collapsible "Thought for Xs" trace — nothing at all when the model gave none. */
export function Trace({ reasoning, reasoningMs, labels }: { reasoning: string; reasoningMs?: number; labels: OverlayLabels }) {
  if (!reasoning.trim()) return null;
  return (
    <details className="kwo-sug-trace">
      <summary>{reasoningMs ? thoughtFor(labels.thought, reasoningMs) : labels.reasoning}</summary>
      <div className="kwo-sug-trace-body" dir="auto">{reasoning}</div>
    </details>
  );
}

/** The "still working" line + a live m:ss, once a request has gone quiet (shared clock
 *  with the chat's note, hooks/useWorkingClock). */
export function WorkingNote({ active, stream, labels }: { active: boolean; stream: string; labels: OverlayLabels }) {
  const clock = useWorkingClock({ active, stream });
  if (!clock) return null;
  return (
    <div className="kwo-working" dir="auto">
      <span>{labels.working[clock.stage]}</span>
      {/* Digits stay LTR in every locale so the clock never reorders in Arabic. */}
      <span dir="ltr">{formatElapsed(clock.elapsedMs)}</span>
    </div>
  );
}

export function viewportSize(): { width: number; height: number } {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return { width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight };
}

/** What a card sits on: one block, or a run of blocks (start..end inclusive). */
export type Anchor = { kind: "block"; index: number } | { kind: "range"; start: number; end: number };

/** The live rect of an anchor (null while nothing of it is painted). */
export function useAnchorRect(a: Anchor | null): DOMRect | null {
  const block = useBlockRect(a?.kind === "block" ? a.index : null);
  const range = useRangeRect(a?.kind === "range" ? a.start : null, a?.kind === "range" ? a.end : null);
  return a?.kind === "block" ? block : a?.kind === "range" ? range : null;
}

/**
 * The positioned shell of a card: placed over its anchor by placeCard (place.ts),
 * kept on screen while its block is, and hidden outright while the block is not
 * painted. It measures its own height (the clamp needs it) with a ResizeObserver,
 * so a streaming proposal that grows re-places itself.
 *
 * ⚠️ The rect changes on every scroll frame, which is why the rect hook lives HERE
 * and not in the card: the card's content arrives as children built from its own
 * props, so a scroll re-renders this shell only — not the word diff inside it.
 */
export function FloatingCard({ anchor, dir, className, children }: {
  anchor: Anchor; dir: TextDirection; className?: string; children: ReactNode;
}) {
  const rect = useAnchorRect(anchor);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    setHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [rect != null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rect) return null;
  const box = placeCard(rect, height, viewportSize());
  return (
    <div
      ref={ref}
      className={"kwo-card" + (className ? " " + className : "")}
      dir={dir}
      style={{ left: box.left, top: box.top, width: box.width, minHeight: box.minHeight, maxHeight: box.maxHeight }}
    >
      {children}
    </div>
  );
}

/**
 * Reject: play the drop-away motion the native and Lexical cards play, THEN tell the
 * host. Fine for a reject — what the card uncovers is the untouched original, which
 * is exactly what stays.
 */
export function useLeaving(): ["" | "reject", (then: () => void) => void] {
  const [leaving, setLeaving] = useState<"" | "reject">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const leave = (then: () => void) => {
    if (leaving) return;
    setLeaving("reject");
    timer.current = setTimeout(() => {
      then();
      // Still mounted later means the host kept the proposal: give the card back.
      timer.current = setTimeout(() => setLeaving(""), 1200);
    }, 170);
  };
  return [leaving, leave];
}

/**
 * Approve is the opposite case, and the reason it does NOT animate out: fading the
 * card would uncover the OLD text for the length of the animation plus a bridge
 * round trip — the student would watch their paragraph revert before the new one
 * lands. Instead the card collapses at once into the bare result (no chip, no pill)
 * and tells the host immediately; it stays until the host drops the proposal, by
 * which time the engine is showing the same thing underneath.
 *
 * `resetKey` changing (the proposal went to "error", a new one arrived) — or the
 * host simply keeping the proposal for `holdMs` (it refused: "syncing, try again")
 * — hands the full card back.
 */
export function useApplied(resetKey: unknown, holdMs = 1500): [boolean, (then: () => void) => void] {
  const [applied, setApplied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setApplied(false); }, [resetKey]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const apply = (then: () => void) => {
    if (applied) return;
    setApplied(true);
    then();
    if (holdMs > 0) timer.current = setTimeout(() => setApplied(false), holdMs);
  };
  return [applied, apply];
}
