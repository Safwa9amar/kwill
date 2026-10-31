import { create } from "zustand";
import {
  proposeBlockEditStream,
  proposeBlockFillStream,
  proposeRangeRewriteStream,
  applyThesisRangeReplace,
  parseFillReply,
  type SuggestAction,
} from "@/lib/thesis-suggest";
import {
  chromeOp,
  generateChromeModel,
  fetchThesisSourceImage,
  suggestThesisChart,
  updateThesisChart,
  type HfPreview,
  type ThesisChartPatch,
} from "@/lib/api";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { type ThesisOp } from "@/lib/thesis-ops";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { decideProposal } from "@/lib/tasks-api";
import i18n from "@/lib/i18n";

// The block kind the caller asks a suggestion for — decides the initial action
// (image → caption, else rewrite); the server's [[MODK_ACTION]] header confirms it.
type SuggestKind = "paragraph" | "image" | "chart";

// Localised label shown at the top of the inline card so the student sees WHAT the
// approval will do ("Rewrite" vs "Add caption").
function actionLabel(action: SuggestAction): string {
  if (action === "setCaption") return i18n.t("suggestion.actionCaption", { defaultValue: "Add caption" });
  if (action === "insertTable") return i18n.t("suggestion.actionInsertTable", { defaultValue: "Insert table" });
  if (action === "insertSourceImage") return i18n.t("suggestion.actionInsertImage", { defaultValue: "Insert image" });
  if (action === "setChart") return i18n.t("suggestion.actionEditChart", { defaultValue: "Edit chart" });
  return i18n.t("suggestion.actionRewrite", { defaultValue: "Rewrite" });
}

// Per-block pending AI suggestion: the student asks the AI to rewrite a single
// paragraph, the proposal appears INLINE on that block (see InlineSuggestion),
// and nothing is applied until they approve. Keyed by engine block index.
//
// The doc mutation (approve) is routed through the durable op queue via
// useThesisDocStore.mutate({ type: "editText" }) so it flushes / reconciles like
// any other manual edit. Removing a key always builds a NEW byIndex object
// (immutable update) so subscribers re-render.

type Status = "loading" | "ready" | "error";

export interface PendingSuggestion {
  index: number;
  original: string;
  proposed: string;
  instruction: string;
  status: Status;
  // Which unified action the approval applies: "rewrite" (paragraph), "setCaption"
  // (figure), or "insertTable" (a new table filling an empty paragraph). Initialised
  // from the requested block kind / fill result; `approve` dispatches on it.
  action: SuggestAction;
  // Localised label for `action`, rendered at the top of the inline card.
  label: string;
  /**
   * Set when this card came from a scheduled task's proposal rather than a live
   * ask. Approve/reject then also tell the server what the student decided —
   * without it the row would sit "pending" for ever and the Needs-you band
   * would never clear.
   */
  proposalId?: string;
  /** The run that produced it, for the stepper's count. */
  runId?: string;
  // action "insertTable": the proposed table grid (rendered as a preview in the
  // inline card; applied via the insertTable op on approve). Absent for text/caption.
  proposedRows?: string[][];
  // action "insertTable": row 0 is a header / right-to-left table — carried to the op.
  tableHeader?: boolean;
  tableRtl?: boolean;
  // action "insertSourceImage": a real figure copied out of one of the student's
  // uploaded sources. The bytes are already fetched when the card goes ready — the
  // SAME bytes are previewed and then inserted, so approving cannot land a different
  // picture than the one shown. Applied via the insertImage op.
  image?: {
    sourceId: string;
    /** The figure's block index inside the SOURCE document (not the thesis). */
    sourceImageIndex: number;
    /** base64, no data: prefix — what the insertImage op carries. */
    data: string;
    format: string;
    /** Display size in the source (px); the server clamps the on-page width. */
    width?: number;
    height?: number;
    /** Self-contained preview URI for the card (same bytes as `data`). */
    dataUri: string;
  };
  // action "setChart": a NATIVE Word chart edit. `patch` is the exact change the
  // server rendered `svg` from, so approving applies precisely what was previewed;
  // `svg` is the PROPOSED chart (the current one keeps rendering underneath as the
  // peek). Applied through the chart endpoint, not the op queue — a chart edit is
  // POSITIONAL-SAFE and its result is server-rendered, so there is nothing to
  // reconcile optimistically.
  chart?: {
    patch: ThesisChartPatch;
    svg: string;
    /** The chart's own SVG before the change — the "peek at the original" side. */
    originalSvg?: string;
  };
  // A ready-but-unfulfillable ask (the model's kind "none", e.g. "no image in your
  // attached files matches that"): shown on the error card INSTEAD of the generic
  // "couldn't generate" line, because the reason is the useful part.
  errorText?: string;
  // The model's reasoning ("thinking"), streamed live while `loading` and shown
  // in the collapsible ThinkingTrace on the inline card. Empty when the model
  // emits none (a short rewrite often does) — the card then just shows the spinner.
  reasoning: string;
  // How long the model spent reasoning, in ms — powers the "Thought for Xs" chip
  // once the suggestion is ready. Undefined when there was no reasoning.
  reasoningMs?: number;
}

// A DYNAMIC range rewrite: the student selects 2+ blocks and asks the AI to rewrite
// the whole passage. Unlike a per-block suggestion (1:1 editText), the model returns
// a passage that may be ONE big paragraph or SEVERAL — the count follows the content.
// The proposal appears inline over the selected range (see the Lexical
// RangeSuggestionNode); approve replaces blocks [start..end] with the split
// paragraphs via the server's replace-range endpoint. Only ONE range suggestion is
// active at a time (you rewrite one selection).
export interface RangeSuggestion {
  start: number; // first block index of the range
  end: number; // last block index of the range (inclusive)
  indices: number[]; // the exact selected indices sent to the rewrite endpoint
  // The original blocks (text + block type) — kept so a serialize/flush while the
  // proposal is showing can restore them, and so reject rebuilds them in place.
  originalBlocks: { text: string; type: string }[];
  original: string; // combined original text (paragraphs joined by \n\n) for the diff
  proposed: string; // the streamed combined proposed passage
  instruction: string;
  status: Status;
  reasoning: string;
  reasoningMs?: number;
}

// A chrome-band AI proposal (header/footer). The student asks the ✦ to change a
// running header/footer; the AI drafts a full MODEL — grounded on the section's
// content, the current header/footer, and the university's own Studio templates —
// shown as a faithful compiled PREVIEW on the band's bubble; approve applies the
// model via chromeOp (full OOXML fidelity, not flat text). Only ONE chrome
// proposal is active at a time.
export interface ChromeSuggestion {
  index: number; // a block index inside the target section (the band's index)
  kind: "top" | "bottom"; // header vs footer
  original: string;
  // Legacy flat-text field — unused by the model-based flow (kept only so an
  // in-flight/empty state never needs an `undefined` check); the PREVIEW (below)
  // is what actually renders.
  proposed: string;
  instruction: string;
  status: Status;
  reasoning: string;
  reasoningMs?: number;
  // The generated model — opaque to the app, sent back verbatim on approve.
  model?: Record<string, unknown>;
  // The faithful compiled preview (segments/fields/tables) for the ready state.
  preview?: HfPreview;
}

// paragraph level (0 body, 1-3 heading) → the Lexical block type used to rebuild it.
function levelToType(level?: number): string {
  return level && level >= 1 && level <= 3 ? `h${level}` : "paragraph";
}

interface SuggestionState {
  byIndex: Record<number, PendingSuggestion>;
  // The single active range rewrite (multi-block dynamic proposal), or null.
  range: RangeSuggestion | null;
  // Block index whose suggestion was JUST approved — the returning DocBlock
  // reads this to play a one-shot green settle flash, then clears it.
  justApplied: number | null;
  // Kick off a proposal for `index`: mark loading, call the server, then set the
  // proposed text (ready) or mark error. `original` is kept from the arg. `kind`
  // (default "paragraph") picks the initial action so an image asks for a caption.
  request: (thesisId: string, index: number, original: string, instruction: string, kind?: SuggestKind) => Promise<void>;
  // Fill an EMPTY paragraph: the model decides text-vs-table (POST /fill/stream) and
  // this produces EITHER a text proposal (action "rewrite") or a table proposal
  // (action "insertTable", carrying proposedRows). Shown in the same inline card.
  requestFill: (thesisId: string, index: number, instruction: string) => Promise<void>;
  // Propose an edit to the NATIVE Word chart at `index`. The server renders the
  // preview from a COPY of the chart part, so the document is untouched until
  // approve. Produces action "setChart".
  requestChart: (thesisId: string, index: number, instruction: string) => Promise<void>;
  // Apply a ready suggestion via the doc op queue, dispatching by action
  // (rewrite → editText, setCaption → setCaption), then drop it.
  approve: (thesisId: string, index: number) => void;
  // Dismiss a suggestion without applying it.
  reject: (index: number) => void;
  // Re-run the proposal with the stored original + instruction.
  again: (thesisId: string, index: number) => Promise<void>;
  // Edit the proposed text in place (inline editing of the suggestion).
  setProposed: (index: number, text: string) => void;
  // ── Range rewrite (multi-block dynamic) ──
  // Kick off a range rewrite for the selected `blocks` (2+): stream the proposed
  // passage, then set it ready / error. Replaces any prior range suggestion.
  requestRange: (
    thesisId: string,
    blocks: { index: number; text: string; level?: number }[],
    instruction: string,
  ) => Promise<void>;
  // Apply the ready range rewrite: replace blocks [start..end] via the server with
  // the KEPT paragraphs (`keptText`, blank-line separated — the ones the student
  // didn't drop; defaults to the whole proposal), then reconcile the doc + clear.
  approveRange: (thesisId: string, keptText?: string) => Promise<void>;
  // Dismiss the range rewrite without applying it.
  rejectRange: () => void;
  // Re-run the range rewrite with the stored originals + instruction.
  againRange: (thesisId: string) => Promise<void>;
  // Edit the proposed passage in place before approving.
  setRangeProposed: (text: string) => void;
  // ── Chrome band (header/footer) AI proposal ──
  chrome: ChromeSuggestion | null;
  // Kick off a header/footer proposal: stream thinking + proposed text, then ready/error.
  requestChrome: (thesisId: string, index: number, kind: "top" | "bottom", original: string, instruction: string) => Promise<void>;
  // Apply the ready chrome proposal via chromeOp (setHeaderText / setFooter), then clear.
  approveChrome: (thesisId: string) => void;
  // Dismiss the chrome proposal without applying it.
  rejectChrome: () => void;
  // Re-run the chrome proposal with the stored kind + instruction.
  againChrome: (thesisId: string) => Promise<void>;
  // Clear the settle-flash marker (called by the flash animation when done).
  clearApplied: () => void;
  // Drop every pending suggestion (e.g. leaving the workspace).
  clear: () => void;
}

// Immutable delete: returns a new byIndex without `index` (or the same map when
// the key is absent, so no needless re-render).
function without(byIndex: Record<number, PendingSuggestion>, index: number): Record<number, PendingSuggestion> {
  if (!(index in byIndex)) return byIndex;
  const next = { ...byIndex };
  delete next[index];
  return next;
}

// Guards approveRange against a double tap (module-level: the store holds JSON only).
let rangeApplyInFlight = false;

export const useSuggestionStore = create<SuggestionState>((set, get) => ({
  byIndex: {},
  range: null,
  chrome: null,
  justApplied: null,

  request: async (thesisId, index, original, instruction, kind = "paragraph") => {
    // A chart has its own proposal flow (a JSON patch + a rendered preview), not a
    // text rewrite — hand off rather than ask the paragraph endpoint for prose.
    if (kind === "chart") return get().requestChart(thesisId, index, instruction);
    const initialAction: SuggestAction = kind === "image" ? "setCaption" : "rewrite";
    set((s) => ({
      byIndex: {
        ...s.byIndex,
        [index]: {
          index, original, instruction, proposed: "", status: "loading", reasoning: "",
          action: initialAction, label: actionLabel(initialAction),
        },
      },
    }));
    // Accumulated locally; the store only holds the live reasoning (for the trace)
    // and, at the end, the final rewrite. Timing runs from the first reasoning
    // token to the first answer token → "Thought for Xs".
    let reasoning = "";
    let proposed = "";
    let reasoningStart = 0;
    let reasoningMs: number | undefined;
    // This request is still the one on `index` (not rejected / superseded by a
    // newer instruction while in flight).
    const isMine = (cur: PendingSuggestion | undefined) =>
      !!cur && cur.status === "loading" && cur.instruction === instruction;
    try {
      await proposeBlockEditStream(thesisId, index, instruction, {
        onAction: (action) => {
          // The server confirms which action this is; update the label so the card
          // shows it. (Initial action from `kind` already covers the common case.)
          set((s) => {
            const cur = s.byIndex[index];
            if (!isMine(cur) || cur!.action === action) return {};
            return { byIndex: { ...s.byIndex, [index]: { ...cur!, action, label: actionLabel(action) } } };
          });
        },
        onReasoning: (delta) => {
          if (!reasoningStart) reasoningStart = Date.now();
          reasoning += delta;
          set((s) => {
            const cur = s.byIndex[index];
            if (!isMine(cur)) return {};
            return { byIndex: { ...s.byIndex, [index]: { ...cur!, reasoning } } };
          });
        },
        onProposed: (delta) => {
          // First answer token → reasoning is done; freeze its duration.
          if (reasoningStart && reasoningMs == null) reasoningMs = Date.now() - reasoningStart;
          proposed += delta;
        },
      });
      if (reasoningStart && reasoningMs == null) reasoningMs = Date.now() - reasoningStart;
      const finalText = proposed.trim();
      set((s) => {
        const cur = s.byIndex[index];
        if (!isMine(cur)) return {};
        // An empty rewrite (the model only "thought") or an UNCHANGED one (the
        // model returned the text verbatim) is an error, not a ready suggestion
        // — a "suggestion" with zero visible change would still offer an
        // Approve that pushes a no-op edit through the op queue.
        if (!finalText || finalText === cur!.original)
          return { byIndex: { ...s.byIndex, [index]: { ...cur!, reasoning, reasoningMs, status: "error" } } };
        return { byIndex: { ...s.byIndex, [index]: { ...cur!, proposed: finalText, reasoning, reasoningMs, status: "ready" } } };
      });
    } catch {
      set((s) => {
        const cur = s.byIndex[index];
        if (!cur || cur.status !== "loading") return {};
        return { byIndex: { ...s.byIndex, [index]: { ...cur, status: "error" } } };
      });
    }
  },

  requestFill: async (thesisId, index, instruction) => {
    // Empty paragraph → the model decides text-vs-table. Start as a "rewrite"-shaped
    // loading card (same "Thinking…" UX); the parsed JSON below sets the real action.
    // `original` is "" (the paragraph is empty) so the ready-gate never mistakes a
    // valid fill for an unchanged rewrite.
    set((s) => ({
      byIndex: {
        ...s.byIndex,
        [index]: {
          index, original: "", instruction, proposed: "", status: "loading", reasoning: "",
          action: "rewrite", label: actionLabel("rewrite"),
        },
      },
    }));
    let reasoning = "";
    let jsonBuf = "";
    let reasoningStart = 0;
    let reasoningMs: number | undefined;
    const isMine = (cur: PendingSuggestion | undefined) =>
      !!cur && cur.status === "loading" && cur.instruction === instruction;
    try {
      await proposeBlockFillStream(thesisId, index, instruction, {
        onReasoning: (delta) => {
          if (!reasoningStart) reasoningStart = Date.now();
          reasoning += delta;
          set((s) => {
            const cur = s.byIndex[index];
            if (!isMine(cur)) return {};
            return { byIndex: { ...s.byIndex, [index]: { ...cur!, reasoning } } };
          });
        },
        onProposed: (delta) => {
          if (reasoningStart && reasoningMs == null) reasoningMs = Date.now() - reasoningStart;
          jsonBuf += delta; // accumulate the JSON answer; parsed once at the end
        },
      });
      if (reasoningStart && reasoningMs == null) reasoningMs = Date.now() - reasoningStart;
      const fill = parseFillReply(jsonBuf);
      // A figure proposal names a source image; fetch those bytes BEFORE going ready
      // so the card previews the actual picture (and holds the exact bytes approve
      // will insert). A failed fetch is an error card, not a silent text fallback.
      let image: PendingSuggestion["image"] | undefined;
      if (fill?.kind === "image") {
        try {
          const got = await fetchThesisSourceImage(thesisId, fill.sourceId, fill.imageIndex);
          image = {
            sourceId: fill.sourceId,
            sourceImageIndex: fill.imageIndex,
            data: got.data,
            format: got.format,
            ...(got.width > 0 ? { width: got.width } : {}),
            ...(got.height > 0 ? { height: got.height } : {}),
            dataUri: `data:${got.mime || `image/${got.format}`};base64,${got.data}`,
          };
        } catch {
          image = undefined;
        }
      }
      set((s) => {
        const cur = s.byIndex[index];
        if (!isMine(cur)) return {};
        // Unparseable / empty → error card (mirrors an empty rewrite).
        if (!fill) return { byIndex: { ...s.byIndex, [index]: { ...cur!, reasoning, reasoningMs, status: "error" } } };
        // The model says it can't be done (no matching figure in the attachments):
        // surface its reason instead of writing prose the student didn't ask for.
        if (fill.kind === "none")
          return { byIndex: { ...s.byIndex, [index]: { ...cur!, reasoning, reasoningMs, errorText: fill.message, status: "error" } } };
        if (fill.kind === "image") {
          if (!image)
            return {
              byIndex: {
                ...s.byIndex,
                [index]: {
                  ...cur!, reasoning, reasoningMs, status: "error",
                  errorText: i18n.t("suggestion.imageFetchFailed", { defaultValue: "Couldn’t read that image from your attached file." }),
                },
              },
            };
          return {
            byIndex: {
              ...s.byIndex,
              [index]: { ...cur!, action: "insertSourceImage", label: actionLabel("insertSourceImage"), image, reasoning, reasoningMs, status: "ready" },
            },
          };
        }
        const next: PendingSuggestion =
          fill.kind === "table"
            ? { ...cur!, action: "insertTable", label: actionLabel("insertTable"), proposedRows: fill.rows, tableHeader: fill.header, tableRtl: fill.rtl, reasoning, reasoningMs, status: "ready" }
            : { ...cur!, action: "rewrite", label: actionLabel("rewrite"), proposed: fill.text.trim(), reasoning, reasoningMs, status: "ready" };
        return { byIndex: { ...s.byIndex, [index]: next } };
      });
    } catch {
      set((s) => {
        const cur = s.byIndex[index];
        if (!cur || cur.status !== "loading") return {};
        return { byIndex: { ...s.byIndex, [index]: { ...cur, status: "error" } } };
      });
    }
  },

  requestChart: async (thesisId, index, instruction) => {
    // The chart currently on the block — kept so the card can peek at the original
    // and so a reject leaves nothing behind.
    const doc = useThesisDocStore.getState().byId[thesisId];
    const block = doc?.available ? doc.blocks[index] : undefined;
    const originalSvg = block?.kind === "image" ? block.svg : undefined;
    set((s) => ({
      byIndex: {
        ...s.byIndex,
        [index]: {
          index, original: "", instruction, proposed: "", status: "loading", reasoning: "",
          action: "setChart", label: actionLabel("setChart"),
        },
      },
    }));
    try {
      const res = await suggestThesisChart(thesisId, index, instruction);
      set((s) => {
        const cur = s.byIndex[index];
        if (!cur) return s; // rejected while in flight
        // Nothing to change is a RESULT, not a failure: show the model's reason on
        // the error card instead of a proposal identical to what is already there.
        if (res.nothingToDo || !res.patch || !res.svg) {
          return {
            byIndex: {
              ...s.byIndex,
              [index]: {
                ...cur,
                status: "error",
                errorText: res.summary || i18n.t("suggestion.chartNoChange", { defaultValue: "Nothing to change on this chart." }),
              },
            },
          };
        }
        return {
          byIndex: {
            ...s.byIndex,
            [index]: {
              ...cur,
              status: "ready",
              proposed: res.summary ?? "",
              chart: { patch: res.patch, svg: res.svg, ...(originalSvg ? { originalSvg } : null) },
            },
          },
        };
      });
    } catch (e: any) {
      set((s) => {
        const cur = s.byIndex[index];
        return cur
          ? { byIndex: { ...s.byIndex, [index]: { ...cur, status: "error", errorText: e?.message } } }
          : s;
      });
    }
  },

  approve: (thesisId, index) => {
    const cur = get().byIndex[index];
    if (!cur || cur.status !== "ready") return;
    // A task proposal is decided server-side too. Fire-and-forget on purpose:
    // the document edit below must not wait on a round trip, and a lost status
    // update only means the card can reappear — never that the wrong text lands.
    if (cur.proposalId) void decideProposal(cur.proposalId, "accept").catch(() => {});
    // Dispatch by action: a paragraph rewrite → editText; a figure caption →
    // setCaption; a filled empty paragraph → insertTable (inserts a real Word table
    // so it occupies this block) or insertImage (embeds the figure copied from the
    // student's source, `afterIndex` = the block before so it lands ON this line and
    // the empty paragraph stays as the trailing spacer). All flow through the durable
    // op queue so they flush / reconcile like any other manual edit.
    // A chart edit is not an op: it is POSITIONAL-SAFE and its result is rendered
    // server-side, so it applies through the chart endpoint and the echoed document
    // is the truth. The patch applied is the one the preview was rendered from.
    if (cur.action === "setChart" && cur.chart) {
      const { patch, svg } = cur.chart;
      // LOCAL-FIRST, like every other edit here: paint the approved chart NOW from
      // the SVG the preview was rendered from, then send. Waiting for the round trip
      // left the OLD chart on screen for the whole request, which read as a failed
      // approve. There is nothing to guess — the server re-renders the same patch
      // with the same renderer, so the echo reconciles to identical bytes.
      useThesisDocStore.getState().applyChartSvgLocal(thesisId, index, svg);
      set((s) => ({ byIndex: without(s.byIndex, index), justApplied: index }));
      void (async () => {
        try {
          const res = await updateThesisChart(thesisId, index, patch);
          if (res.document) useThesisDocStore.getState().setDoc(thesisId, res.document);
          else await useThesisDocStore.getState().revalidate(thesisId);
        } catch {
          // The document never changed server-side, so the optimistic paint is now a
          // lie — revalidate puts the real chart back rather than leaving it.
          void useThesisDocStore.getState().revalidate(thesisId);
        }
      })();
      return;
    }
    let op: ThesisOp;
    if (cur.action === "setCaption") op = { type: "setCaption", index, caption: cur.proposed } as const;
    else if (cur.action === "insertTable" && cur.proposedRows?.length)
      op = { type: "insertTable", index, rows: cur.proposedRows, header: cur.tableHeader, rtl: cur.tableRtl } as const;
    else if (cur.action === "insertSourceImage" && cur.image)
      op = {
        type: "insertImage",
        afterIndex: index - 1,
        data: cur.image.data,
        format: cur.image.format,
        ...(cur.image.width ? { width: cur.image.width } : {}),
        ...(cur.image.height ? { height: cur.image.height } : {}),
      } as const;
    else op = { type: "editText", index, text: cur.proposed } as const;
    void useThesisDocStore.getState().mutate(thesisId, op);
    set((s) => ({ byIndex: without(s.byIndex, index), justApplied: index }));
  },

  reject: (index) => {
    const cur = get().byIndex[index];
    if (cur?.proposalId) void decideProposal(cur.proposalId, "reject").catch(() => {});
    set((s) => ({ byIndex: without(s.byIndex, index) }));
  },

  again: async (thesisId, index) => {
    const cur = get().byIndex[index];
    if (!cur) return;
    // A filled empty paragraph (table / source-figure proposal, or a text fill of a
    // still-empty line) re-runs through the fill flow; a figure caption re-asks as an
    // image; else rewrite.
    if (cur.action === "insertTable" || cur.action === "insertSourceImage" || !cur.original.trim()) {
      await get().requestFill(thesisId, index, cur.instruction);
      return;
    }
    if (cur.action === "setChart") {
      await get().requestChart(thesisId, index, cur.instruction);
      return;
    }
    const kind: SuggestKind = cur.action === "setCaption" ? "image" : "paragraph";
    await get().request(thesisId, index, cur.original, cur.instruction, kind);
  },

  setProposed: (index, text) =>
    set((s) => {
      const cur = s.byIndex[index];
      if (!cur) return {};
      return { byIndex: { ...s.byIndex, [index]: { ...cur, proposed: text } } };
    }),

  // ── Range rewrite (multi-block dynamic) ──
  requestRange: async (thesisId, blocks, instruction) => {
    const sorted = [...blocks].sort((a, b) => a.index - b.index);
    const indices = sorted.map((b) => b.index);
    const start = indices[0];
    const end = indices[indices.length - 1];
    const originalBlocks = sorted.map((b) => ({ text: b.text, type: levelToType(b.level) }));
    const original = sorted.map((b) => b.text).join("\n\n");
    set({
      range: { start, end, indices, originalBlocks, original, proposed: "", instruction, status: "loading", reasoning: "" },
    });

    let reasoning = "";
    let proposed = "";
    let reasoningStart = 0;
    let reasoningMs: number | undefined;
    // Still the live request on this same range + instruction (not superseded).
    const isMine = () => {
      const r = get().range;
      return !!r && r.status === "loading" && r.instruction === instruction && r.start === start && r.end === end;
    };
    try {
      await proposeRangeRewriteStream(thesisId, indices, instruction, {
        onReasoning: (delta) => {
          if (!reasoningStart) reasoningStart = Date.now();
          reasoning += delta;
          set((s) => (isMine() && s.range ? { range: { ...s.range, reasoning } } : {}));
        },
        onProposed: (delta) => {
          if (reasoningStart && reasoningMs == null) reasoningMs = Date.now() - reasoningStart;
          proposed += delta;
          set((s) => (isMine() && s.range ? { range: { ...s.range, proposed } } : {}));
        },
      });
      if (reasoningStart && reasoningMs == null) reasoningMs = Date.now() - reasoningStart;
      const finalText = proposed.trim();
      set((s) => {
        if (!isMine() || !s.range) return {};
        // Empty (only-thinking) or unchanged passage → error, not a no-op proposal.
        if (!finalText || finalText === s.range.original.trim())
          return { range: { ...s.range, reasoning, reasoningMs, status: "error" } };
        return { range: { ...s.range, proposed: finalText, reasoning, reasoningMs, status: "ready" } };
      });
    } catch {
      set((s) => (s.range && s.range.status === "loading" ? { range: { ...s.range, status: "error" } } : {}));
    }
  },

  approveRange: async (thesisId, keptText) => {
    const r = get().range;
    if (!r || r.status !== "ready") return;
    // One apply per proposal: a second tap while the first is in flight would
    // replace the range twice (the second time over the first's result).
    if (rangeApplyInFlight) return;
    // The kept paragraphs (blank-line separated) — dropped ones are already excluded
    // by the caller; fall back to the whole proposal when no explicit set is passed.
    const paragraphs = (keptText ?? r.proposed).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (!paragraphs.length) return;
    rangeApplyInFlight = true;
    // VISUAL FIRST: the docx Writer replaces the range in its own engine — the
    // student sees the passage at once and the save loop carries the bytes — so
    // there is nothing left for the server to do. Registered only by that surface;
    // false means it was refused and NOTHING changed, so the server path below is
    // still the right (and only) writer.
    const local = useLexicalEditorStore.getState().applyRange;
    if (local && (await local(thesisId, r.start, r.end, paragraphs).catch(() => false))) {
      rangeApplyInFlight = false;
      set({ range: null });
      return;
    }
    // Apply on the server FIRST — keep the proposal node up during the call so the
    // editor's auto-save stays suppressed and NOTHING settles in place (an in-place
    // settle fired a spurious save that raced the reseed and reverted the change).
    // Then clear the range AND publish the echoed doc TOGETHER, so the sync layer
    // reseeds the editor to server truth in ONE write. Only clear on a real document
    // (a reseed is what removes the node), else surface the error on the card.
    try {
      const res = await applyThesisRangeReplace(thesisId, r.start, r.end, paragraphs);
      if (res.document) {
        set({ range: null });
        // Force the editor to reseed to this applied doc even if a debounced typing
        // save is pending — otherwise that save fires against a stale baseline and
        // reverts the change (the reported revert bug).
        useLexicalEditorStore.getState().requestForceReseed();
        useThesisDocStore.getState().setDoc(thesisId, res.document);
      } else {
        set((s) => (s.range ? { range: { ...s.range, status: "error" } } : {}));
      }
    } catch {
      set((s) => (s.range ? { range: { ...s.range, status: "error" } } : {}));
    }
    rangeApplyInFlight = false;
  },

  rejectRange: () => set({ range: null }),

  againRange: async (thesisId) => {
    const r = get().range;
    if (!r) return;
    const blocks = r.originalBlocks.map((b, i) => ({
      index: r.indices[i],
      text: b.text,
      level: b.type === "h1" ? 1 : b.type === "h2" ? 2 : b.type === "h3" ? 3 : 0,
    }));
    await get().requestRange(thesisId, blocks, r.instruction);
  },

  setRangeProposed: (text) => set((s) => (s.range ? { range: { ...s.range, proposed: text } } : {})),

  requestChrome: async (thesisId, index, kind, original, instruction) => {
    set({ chrome: { index, kind, original, proposed: "", instruction, status: "loading", reasoning: "" } });
    const isMine = (c: ChromeSuggestion | null) =>
      !!c && c.status === "loading" && c.index === index && c.instruction === instruction;
    try {
      const { model, preview } = await generateChromeModel(thesisId, index, kind, instruction);
      set((s) => (isMine(s.chrome) ? { chrome: { ...s.chrome!, model, preview, status: "ready" } } : {}));
    } catch {
      set((s) => (s.chrome && s.chrome.status === "loading" ? { chrome: { ...s.chrome, status: "error" } } : {}));
    }
  },

  approveChrome: (thesisId) => {
    const cur = get().chrome;
    if (!cur || cur.status !== "ready" || !cur.model) return;
    const region = cur.kind === "top" ? "header" : "footer";
    void (async () => {
      try {
        const res = await chromeOp(thesisId, { op: "applyModel", index: cur.index, model: cur.model!, region });
        if (res.document) useThesisDocStore.getState().setDoc(thesisId, res.document);
      } catch {
        /* dropped regardless; error surfaced by the doc store's own retry paths */
      }
    })();
    set({ chrome: null });
  },

  rejectChrome: () => set({ chrome: null }),

  againChrome: async (thesisId) => {
    const cur = get().chrome;
    if (!cur) return;
    await get().requestChrome(thesisId, cur.index, cur.kind, cur.original, cur.instruction);
  },

  clearApplied: () => set({ justApplied: null }),

  clear: () => set({ byIndex: {}, range: null, chrome: null, justApplied: null }),
}));
