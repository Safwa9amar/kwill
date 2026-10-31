// The overlay layer's prop contract — TYPES ONLY, so both the native host
// (host/useSuggestionOverlays.ts) and the DOM side import it and nothing crosses
// into the wrong bundle. Everything here is JSON: Expo DOM props are serialized.
//
// The proposal shapes are the ones the Lexical Writer already takes
// (SuggestionInput / RangeSuggestionInput), so the native stores and their memos
// feed both surfaces unchanged; Task 32 renames that module, not these shapes.

import type { RangeSuggestionInput, SuggestionInput } from "@/components/workspace/lexical/editor-components/types";
import type { TableDiff } from "@/lib/table-diff";

export type { RangeSuggestionInput, SuggestionInput };

/** The AI table proposal (an in-place diff of an EXISTING table) — same fields as
 *  the Lexical TableProposalData, minus nothing. */
export type TableProposalInput = {
  index: number;
  originalRows: string[][];
  newRows: string[][];
  diff: TableDiff;
  thoughtMs?: number | null;
  layout?: { headerFill?: string; borders?: boolean; borderStyle?: string; borderSizePt?: number; borderColor?: string } | null;
  fills?: (string | null)[][] | null;
  textColors?: (string | null)[][] | null;
  /** The table's direction as the DTO knows it, for the preview grid. */
  rtl?: boolean;
};

export type CompletionInput = {
  text: string;
  nonce: number;
  status: "idle" | "loading" | "done" | "error";
  index?: number;
};

/**
 * What the student approved, painted over its place while the SERVER applies it
 * (the fallback when the engine could not do it locally). Shown until the reload
 * that carries the real result lands — the DOM hides it on that load — or until
 * the host withdraws it.
 */
export type ApplyingPreview =
  | { nonce: number; kind: "range"; start: number; end: number; paragraphs: string[] }
  | { nonce: number; kind: "table"; index: number; rows: string[][]; header?: boolean; rtl?: boolean };

/**
 * A range rewrite for the ENGINE to apply locally (visual-first). `firstText` /
 * `lastText` are the DTO texts of the first and last block, used to find them
 * strictly by index + text; `issuedAt` bounds how late the DOM may still act on it.
 */
export type RangeApplyRequest = {
  nonce: number;
  start: number;
  end: number;
  firstText: string;
  lastText: string;
  paragraphs: string[];
  issuedAt: number;
};
export type RangeApplyResult = { nonce: number; ok: boolean; reason?: string };

/** Every string the cards show, resolved native-side (the DOM bundle has no i18n). */
export type OverlayLabels = {
  approve: string;
  edit: string;
  again: string;
  reject: string;
  done: string;
  cancel: string;
  thinking: string;
  failed: string;
  showOriginal: string;
  hideOriginal: string;
  /** "{s}" is replaced with whole seconds. */
  thought: string;
  reasoning: string;
  apply: string;
  keep: string;
  drop: string;
  applying: string;
  insert: string;
  dismiss: string;
  imageFromSource: string;
  showCurrentChart: string;
  hideCurrentChart: string;
  working: { short: string; long: string; veryLong: string };
  table: {
    proposal: string;
    original: string;
    /** "{s}" is replaced with whole seconds. */
    thought: string;
    thinking: string;
    approve: string;
    compare: string;
    showProposal: string;
    again: string;
    reject: string;
    send: string;
    notePlaceholder: string;
    failed: string;
    retry: string;
  };
};

/** The props DocxEditorDom forwards to the overlay layer untouched. */
export type OverlayProps = {
  suggestion?: SuggestionInput | null;
  onSuggestAction?: (action: string, text?: string) => Promise<void>;
  rangeSuggestion?: RangeSuggestionInput | null;
  onRangeAction?: (action: string, text?: string) => Promise<void>;
  tableProposal?: TableProposalInput | null;
  tableLoadingIndex?: number | null;
  tableThinking?: string;
  tableErrorIndex?: number | null;
  onTableProposalAction?: (action: string, note?: string) => Promise<void>;
  completionEnabled?: boolean;
  completion?: CompletionInput | null;
  onRequestCompletion?: (ctx: { index: number; text: string }) => Promise<void>;
  /** `local` = the engine already inserted `text` at the caret; the host must not
   *  write it a second time. `paragraphText` is the paragraph as painted when the
   *  completion was asked for (whitespace-collapsed) — for the host's fallback. */
  onCommitCompletion?: (c: { index: number; text: string; local: boolean; paragraphText: string }) => Promise<void>;
  onCancelCompletion?: () => Promise<void>;
  applying?: ApplyingPreview | null;
  rangeApply?: RangeApplyRequest | null;
  onRangeApplied?: (r: RangeApplyResult) => Promise<void>;
  overlayLabels?: OverlayLabels;
  /** The brand accent (useThemeColors().brandPrimary) for the ✦ marks. */
  overlayAccent?: string;
};
