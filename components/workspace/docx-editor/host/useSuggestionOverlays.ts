// The native half of the docx Writer's AI surfaces (Phase 2, Tasks 14–16): the
// stores' state as DocxEditorDom props, and the cards' actions back into the stores.
// WorkspaceDocxView spreads the result onto <DocxEditorDom>; the DOM side is
// docx-editor/overlays/.
//
// The suggestion / range / completion / table memos and handlers are
// WorkspaceLexicalView's, ported as they are, minus what only Lexical needed:
// `requestSkipReseed` (there is no reseed here — the engine applies an edit itself
// or reloads bytes) and the reseed-on-reject (showing a card never touched the
// document, so rejecting one has nothing to restore).
//
// Two things are new, both for the "visual first" rule — the student sees the
// result the moment they approve, never the old text while a server works:
//   - applyRange, registered on lexical-editor-store: suggestion-store.approveRange
//     calls it first, and the range is rewritten IN THE ENGINE (overlays/apply-range.ts);
//   - `applying`: when a result has to come from the server after all (a refused
//     local range apply, a table proposal), the result is painted over its place
//     until the reload that carries it lands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useAutocompleteAllowed } from "@/lib/autocomplete-policy";
import { applyThesisOps } from "@/lib/api";
import { diffToOps, layoutDelta } from "@/lib/table-diff";
import { applyOpToDoc } from "@/lib/thesis-ops";
import { useCompletionStore } from "@/stores/completion-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useSuggestionStore } from "@/stores/suggestion-store";
import { useTableSuggestionStore } from "@/stores/table-suggestion-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { APPLYING_MAX_MS, RANGE_APPLY_WAIT_MS } from "../overlays/timing";
import type {
  ApplyingPreview, OverlayLabels, OverlayProps, RangeApplyRequest, RangeApplyResult, TableProposalInput,
} from "../overlays/types";

// A pending source-figure PREVIEW crosses the bridge only up to this size (same
// budget as the Lexical Writer); past it the card shows a placeholder and approve
// is unaffected — the bytes the op inserts stay native.
const SUG_IMAGE_PREVIEW_BUDGET = 2 * 1024 * 1024;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type ApplyingInput =
  | { kind: "range"; start: number; end: number; paragraphs: string[] }
  | { kind: "table"; index: number; rows: string[][]; header?: boolean; rtl?: boolean };

export function useSuggestionOverlays({ thesisId, active, onNotice }: {
  thesisId: string;
  active: boolean;
  /** One-line, transient message for the student (the surface's banner). */
  onNotice: (message: string) => void;
}): OverlayProps {
  const { t } = useTranslation();
  const colors = useThemeColors();

  // ── what is being applied by the server right now (painted over its place) ──
  const [applying, setApplying] = useState<ApplyingPreview | null>(null);
  const applyingSeq = useRef(0);
  const showApplying = useCallback((p: ApplyingInput) => {
    setApplying({ ...p, nonce: ++applyingSeq.current } as ApplyingPreview);
  }, []);
  // The DOM fades it on the reload; this only guarantees it never outlives a
  // reload that did not come.
  useEffect(() => {
    if (!applying) return;
    const n = applying.nonce;
    const timer = setTimeout(() => setApplying((cur) => (cur?.nonce === n ? null : cur)), APPLYING_MAX_MS);
    return () => clearTimeout(timer);
  }, [applying]);

  // ── inline suggestion (one block) — WorkspaceLexicalView's memo ──
  // Select the STABLE byIndex ref (a fresh-object selector loops) and derive in useMemo.
  const byIndex = useSuggestionStore((s) => s.byIndex);
  const range = useSuggestionStore((s) => s.range);
  const suggestion = useMemo(() => {
    const keys = Object.keys(byIndex);
    if (!keys.length) return null;
    const idx = Number(keys[0]);
    const p = byIndex[idx];
    return {
      index: idx,
      original: p.original,
      proposed: p.proposed,
      status: p.status as string,
      instruction: p.instruction,
      label: p.label,
      reasoning: p.reasoning,
      reasoningMs: p.reasoningMs,
      action: p.action as string,
      proposedRows: p.proposedRows,
      tableHeader: p.tableHeader,
      tableRtl: p.tableRtl,
      hasImage: !!p.image,
      imageDataUri:
        p.image && p.image.dataUri.length <= SUG_IMAGE_PREVIEW_BUDGET ? p.image.dataUri : undefined,
      imageWidth: p.image?.width,
      imageHeight: p.image?.height,
      chartSvg: p.chart?.svg,
      chartOriginalSvg: p.chart?.originalSvg,
      errorText: p.errorText,
    };
  }, [byIndex]);

  // Approve → the store's approve, which is thesis-doc-store.mutate(op): executed in
  // the engine first on this surface, so the edit shows without a round trip.
  const onSuggestAction = useCallback(async (action: string, text?: string) => {
    const store = useSuggestionStore.getState();
    const keys = Object.keys(store.byIndex);
    if (!keys.length) return;
    const idx = Number(keys[0]);
    if (action === "approve") store.approve(thesisId, idx);
    else if (action === "again") void store.again(thesisId, idx);
    else if (action === "edit") { if (text) store.setProposed(idx, text); }
    else store.reject(idx);
  }, [thesisId]);

  // ── range rewrite ──
  const rangeSuggestion = useMemo(() => {
    if (!range) return null;
    return {
      start: range.start,
      end: range.end,
      originalBlocks: range.originalBlocks,
      original: range.original,
      proposed: range.proposed,
      status: range.status as string,
      instruction: range.instruction,
      reasoning: range.reasoning,
      reasoningMs: range.reasoningMs,
    };
  }, [range]);

  const onRangeAction = useCallback(async (action: string, text?: string) => {
    const store = useSuggestionStore.getState();
    if (!store.range) return;
    if (action === "approve") void store.approveRange(thesisId, text);
    else if (action === "again") void store.againRange(thesisId);
    else if (action === "edit") { if (text) store.setRangeProposed(text); }
    else store.rejectRange(); // the document was never touched — nothing to restore
  }, [thesisId]);

  // A failed server apply hands the card back with its error; the preview goes.
  useEffect(() => {
    if (range?.status === "error") setApplying((cur) => (cur?.kind === "range" ? null : cur));
  }, [range?.status]);

  // The engine half of approveRange (registered below): ask the DOM to replace the
  // range, wait for its answer. Only a run of PLAIN paragraphs qualifies — a table
  // or figure inside the range, or a range the model no longer has, is the server's.
  const [rangeApply, setRangeApply] = useState<RangeApplyRequest | null>(null);
  const rangeWaiters = useRef(new Map<number, (ok: boolean) => void>());
  const rangeSeq = useRef(0);
  const askEngine = useCallback((start: number, end: number, paragraphs: string[]): Promise<boolean> => {
    const d = useThesisDocStore.getState().byId[thesisId];
    const blocks = d?.available ? d.blocks : null;
    const slice = blocks ? blocks.slice(start, end + 1) : [];
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!blocks || slice.length !== end - start + 1 || slice.some((b) => b.kind !== "paragraph")) return Promise.resolve(false);
    if (first?.kind !== "paragraph" || last?.kind !== "paragraph") return Promise.resolve(false);
    const nonce = ++rangeSeq.current;
    return new Promise<boolean>((resolve) => {
      rangeWaiters.current.set(nonce, resolve);
      setRangeApply({ nonce, start, end, firstText: first.text, lastText: last.text, paragraphs, issuedAt: Date.now() });
      // ⚠️ Paired with the DOM's TTL (overlays/timing.ts): past this the passage goes
      // to the server, so the DOM must never still act on this request.
      setTimeout(() => {
        const w = rangeWaiters.current.get(nonce);
        if (w) { rangeWaiters.current.delete(nonce); w(false); }
        setRangeApply((cur) => (cur?.nonce === nonce ? null : cur));
      }, RANGE_APPLY_WAIT_MS);
    });
  }, [thesisId]);
  const onRangeApplied = useCallback(async (r: RangeApplyResult) => {
    const w = rangeWaiters.current.get(r.nonce);
    if (w) { rangeWaiters.current.delete(r.nonce); w(r.ok); }
    // Answered: stop carrying a passage across the bridge on every later render.
    setRangeApply((cur) => (cur?.nonce === r.nonce ? null : cur));
  }, []);
  const applyRange = useCallback(async (tid: string, start: number, end: number, paragraphs: string[]): Promise<boolean> => {
    if (tid !== thesisId) return false;
    const ok = await askEngine(start, end, paragraphs);
    if (!ok) {
      // The server applies it next: paint the result NOW and keep it until the
      // reload. Flush first — the server rewrites the stored bytes, and typing still
      // in the debounce window would otherwise be refused as stale on its next save.
      showApplying({ kind: "range", start, end, paragraphs });
      await useLexicalEditorStore.getState().flushEdits?.();
    }
    return ok;
  }, [thesisId, askEngine, showApplying]);
  useEffect(() => {
    useLexicalEditorStore.getState().registerApplyRange(applyRange);
    return () => useLexicalEditorStore.getState().registerApplyRange(null);
  }, [applyRange]);

  // ── completion (D11: a chip under the caret) ──
  const completionEnabled = useAutocompleteAllowed();
  const compIndex = useCompletionStore((s) => s.index);
  const compText = useCompletionStore((s) => s.text);
  const compStatus = useCompletionStore((s) => s.status);
  const compNonce = useCompletionStore((s) => s.nonce);
  const completion = useMemo(
    () => (compIndex >= 0 ? { text: compText, nonce: compNonce, status: compStatus, index: compIndex } : null),
    [compIndex, compText, compStatus, compNonce],
  );
  const onRequestCompletion = useCallback(async (ctx: { index: number; text: string }) => {
    void useCompletionStore.getState().request(thesisId, ctx.index, ctx.text);
  }, [thesisId]);
  const onCommitCompletion = useCallback(async (c: { index: number; text: string; local: boolean; paragraphText: string }) => {
    const store = useCompletionStore.getState();
    if (c.local) { store.accept(thesisId, c.index, c.text, { appliedLocally: true }); return; }
    // The engine refused the insert. The store's own path writes the WHOLE paragraph,
    // so it is only safe while the model's text is the one on screen — otherwise it
    // would drop the student's unsaved typing in that paragraph. Else: let it go.
    const d = useThesisDocStore.getState().byId[thesisId];
    const b = d?.available ? d.blocks[c.index] : undefined;
    if (b?.kind === "paragraph" && norm(b.text) === norm(c.paragraphText)) store.accept(thesisId, c.index, b.text + c.text);
    else store.cancel();
  }, [thesisId]);
  const onCancelCompletion = useCallback(async () => { useCompletionStore.getState().cancel(); }, []);
  // Turning the setting off, or leaving the Writer, clears a pending/showing one.
  useEffect(() => { if (!completionEnabled) useCompletionStore.getState().cancel(); }, [completionEnabled]);
  useEffect(() => { if (!active) useCompletionStore.getState().cancel(); }, [active]);

  // ── table proposal (diff of an existing table) — WorkspaceLexicalView's ──
  const tblProposal = useTableSuggestionStore((s) => s.proposal);
  const tblLoadingIndex = useTableSuggestionStore((s) => s.loadingIndex);
  const tblThinking = useTableSuggestionStore((s) => s.thinking);
  const tblErrorIndex = useTableSuggestionStore((s) => s.errorIndex);
  const tableProposal = useMemo<TableProposalInput | null>(
    () =>
      tblProposal && tblProposal.thesisId === thesisId
        ? {
            index: tblProposal.index,
            originalRows: tblProposal.originalRows,
            newRows: tblProposal.newRows,
            diff: tblProposal.diff,
            thoughtMs: tblProposal.thoughtMs,
            layout: tblProposal.layout
              ? {
                  headerFill: tblProposal.layout.headerFill,
                  borders: tblProposal.layout.borders,
                  borderStyle: tblProposal.layout.borderStyle,
                  borderSizePt: tblProposal.layout.borderSizePt,
                  borderColor: tblProposal.layout.borderColor,
                }
              : null,
            fills: tblProposal.fills ?? null,
            textColors: tblProposal.textColors ?? null,
            rtl: (tblProposal.layout?.direction ?? tblProposal.originalLayout.direction) === "rtl",
          }
        : null,
    [tblProposal, thesisId],
  );

  const onTableProposalAction = useCallback(async (action: string, note?: string) => {
    const store = useTableSuggestionStore.getState();
    const p = store.proposal;
    if (action === "again") { void store.again(note); return; }
    if (action === "retry") { void store.retry(); return; }
    if (action === "reject" || !p || p.thesisId !== thesisId) { store.clear(); return; }
    if (action !== "approve") return;
    const docStore = useThesisDocStore.getState();
    // Positional ops must land after any queued durable ops — refuse instead of
    // interleaving (same rule as the bubble's silent table sync).
    if ((docStore.pending[thesisId] ?? 0) > 0) { onNotice("Syncing — try again in a moment"); return; }
    const delta = layoutDelta(
      { align: p.originalLayout.align, direction: p.originalLayout.direction, header: p.originalLayout.header },
      p.layout,
    );
    const ops = diffToOps(p.index, p.originalRows, p.newRows, p.diff, delta, p.fills, p.textColors);
    if (!ops) { store.clear(); onNotice("Proposal too large to apply"); return; }
    if (ops.length === 0) { store.clear(); return; }
    // Visual first: the approved grid replaces the card in THIS render (the card is
    // already showing it), and stays painted over the table until the reload.
    showApplying({
      kind: "table",
      index: p.index,
      rows: p.newRows,
      header: p.layout?.headerRow ?? p.originalLayout.header,
      rtl: (p.layout?.direction ?? p.originalLayout.direction) === "rtl",
    });
    store.clear();
    try {
      // The server rewrites the stored bytes: typing still in the debounce window
      // must reach it first, or its next save is refused as stale.
      await useLexicalEditorStore.getState().flushEdits?.();
      // The block model follows at once (outline, indices); the echo reconciles.
      const cur = docStore.byId[thesisId];
      if (cur?.available) {
        let optimistic = cur;
        for (const op of ops) optimistic = applyOpToDoc(optimistic, op);
        docStore.setDoc(thesisId, optimistic);
      }
      const res = await applyThesisOps(thesisId, ops);
      // A new docHash → WorkspaceDocxView reloads the bytes → the DOM drops the preview.
      if (res.document) docStore.setDoc(thesisId, res.document);
      void docStore.refreshHistoryState(thesisId);
    } catch {
      setApplying((cur) => (cur?.kind === "table" ? null : cur));
      void docStore.revalidate(thesisId);
    }
  }, [thesisId, onNotice, showApplying]);

  // Any doc change that alters the target table (an outside edit, undo, an AI turn)
  // silently drops the proposal — its diff no longer applies.
  const doc = useThesisDocStore((s) => s.byId[thesisId]);
  useEffect(() => {
    const p = useTableSuggestionStore.getState().proposal;
    if (!p || p.thesisId !== thesisId || !doc?.available) return;
    const b = doc.blocks[p.index];
    const same =
      b?.kind === "table" &&
      JSON.stringify(b.rows.map((r) => r.map((c) => c.trim()))) ===
        JSON.stringify(p.originalRows.map((r) => r.map((c) => c.trim())));
    if (!same) useTableSuggestionStore.getState().clear();
  }, [doc, thesisId]);

  // ── every string the cards show (the DOM bundle has no i18n instance) ──
  const overlayLabels = useMemo<OverlayLabels>(() => ({
    approve: t("suggestion.approve", { defaultValue: "Approve" }),
    edit: t("suggestion.edit", { defaultValue: "Edit" }),
    again: t("suggestion.again", { defaultValue: "Again" }),
    reject: t("suggestion.reject", { defaultValue: "Reject" }),
    done: t("suggestion.done", { defaultValue: "Done" }),
    cancel: t("suggestion.cancel", { defaultValue: "Cancel" }),
    thinking: t("suggestion.thinking", { defaultValue: "Thinking…" }),
    failed: t("suggestion.failed", { defaultValue: "Couldn't generate a suggestion." }),
    showOriginal: t("suggestion.showOriginal", { defaultValue: "Show original text" }),
    hideOriginal: t("suggestion.hideOriginal", { defaultValue: "Hide original text" }),
    thought: t("tableAI.thought", { defaultValue: "Thought for {s}s" }),
    reasoning: t("suggestion.reasoning", { defaultValue: "Reasoning" }),
    apply: t("common.apply", { defaultValue: "Apply" }),
    keep: t("suggestion.keepParagraph", { defaultValue: "Keep this paragraph" }),
    drop: t("suggestion.dropParagraph", { defaultValue: "Drop this paragraph" }),
    applying: t("suggestion.applying", { defaultValue: "Applying…" }),
    insert: t("dockBar.insert", { defaultValue: "Insert" }),
    dismiss: t("common.close", { defaultValue: "Close" }),
    imageFromSource: t("suggestion.imageFromSource", { defaultValue: "Image from your attached file" }),
    showCurrentChart: t("suggestion.showCurrentChart", { defaultValue: "Tap to see the current chart" }),
    hideCurrentChart: t("suggestion.hideCurrentChart", { defaultValue: "Showing the current chart — tap to see the proposal" }),
    working: {
      short: t("working.short", { defaultValue: "Working on it…" }),
      long: t("working.long", { defaultValue: "Still working — this can take a while. Please wait." }),
      veryLong: t("working.veryLong", { defaultValue: "Still working on a long task — please keep waiting." }),
    },
    table: {
      proposal: t("tableAI.proposal", { defaultValue: "AI suggestion" }),
      original: t("tableAI.original", { defaultValue: "Original — before changes" }),
      thought: t("tableAI.thought", { defaultValue: "Thought for {s}s" }),
      thinking: t("tableAI.thinking", { defaultValue: "Thinking…" }),
      approve: t("tableAI.approve", { defaultValue: "Approve" }),
      compare: t("tableAI.compare", { defaultValue: "Compare" }),
      showProposal: t("tableAI.showProposal", { defaultValue: "Proposal" }),
      again: t("tableAI.again", { defaultValue: "Again" }),
      reject: t("tableAI.reject", { defaultValue: "Reject" }),
      send: t("tableAI.send", { defaultValue: "Send" }),
      notePlaceholder: t("tableAI.notePlaceholder", { defaultValue: "Note for the retry…" }),
      failed: t("tableAI.failed", { defaultValue: "Suggestion failed" }),
      retry: t("tableAI.retry", { defaultValue: "Retry" }),
    },
  }), [t]);

  return {
    suggestion,
    onSuggestAction,
    rangeSuggestion,
    onRangeAction,
    tableProposal,
    tableLoadingIndex: tblLoadingIndex,
    tableThinking: tblThinking,
    tableErrorIndex: tblErrorIndex,
    onTableProposalAction,
    completionEnabled,
    completion,
    onRequestCompletion,
    onCommitCompletion,
    onCancelCompletion,
    applying,
    rangeApply,
    onRangeApplied,
    overlayLabels,
    overlayAccent: colors.brandPrimary,
  };
}
