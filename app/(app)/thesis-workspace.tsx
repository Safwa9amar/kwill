import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RunningBanner } from "@/components/tasks/RunningBanner";
import { ProposalStepper } from "@/components/workspace/ProposalStepper";
import { useTasksStore } from "@/stores/tasks-store";
import { TASKS_ENABLED } from "@/lib/tasks-enabled";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  InteractionManager,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useFocusEffect, useRouter, Redirect } from "expo-router";
import * as Device from "expo-device";
import { useTranslation } from "react-i18next";
import { Undo2, Redo2, X } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useThesisStore } from "@/stores/thesis-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useRibbonStore } from "@/stores/ribbon-store";
import { useChatStore } from "@/stores/chat-store";
import { useChatHead } from "@/stores/chat-head-store";
import { useOutlineStore } from "@/stores/outline-store";
import { useNavDrawerStore } from "@/stores/nav-drawer-store";
import { useSuggestionStore } from "@/stores/suggestion-store";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { WordDocxView, type DocTapBlock } from "@/components/workspace/WordDocxView";
import { OnlyOfficeView } from "@/components/workspace/OnlyOfficeView";
import { PdfView } from "@/components/workspace/PdfView";
import { DocBlock } from "@/components/workspace/DocBlock";
import { PaperPage } from "@/components/workspace/PaperPage";
import { DocSkeleton } from "@/components/workspace/DocSkeleton";
import { BlockComposer, BLOCK_COMPOSER_MIN_INSET } from "@/components/workspace/BlockComposer";
import { FloatingPill } from "@/components/workspace/FloatingPill";
import { PreviewButton, PreviewBar } from "@/components/workspace/WorkspacePreview";
import { SearchPanel } from "@/components/workspace/SearchPanel";
import { ZoomFromOrigin, useZoomCollapse } from "@/components/ZoomFromOrigin";
import { countWords } from "@/lib/word-count";
import { MilestoneToast } from "@/components/workspace/MilestoneToast";
import { OutlineReorderable } from "@/components/workspace/OutlineReorderable";
import { WorkspaceLexicalView } from "@/components/workspace/WorkspaceLexicalView";
import { NavOverlay } from "@/components/workspace/NavOverlay";
import { SourcesSheet } from "@/components/workspace/SourcesSheet";
import { HistorySheet } from "@/components/workspace/HistorySheet";
import {
  getThesisEditorConfig,
  getThesisPdf,
  deleteThesisPdf,
  undoThesisHistory,
  redoThesisHistory,
  type DocBlockDTO,
  type EditorConfigDTO,
  type ThesisPdfDTO,
} from "@/lib/api";

// Ink colors retained by the workspace stylesheet.
const INK = "#1A1A1A";
const MUTED = "#777777";

// Round word-count milestones celebrated (once each) as the student writes.
const WORD_MILESTONES = [500, 1000, 2500, 5000, 10000];

// Flat text of a block for tap→index matching in the docx-preview fallback view.
function blockTapText(b: DocBlockDTO): string {
  if (b.kind === "paragraph") return b.text;
  if (b.kind === "table") return b.rows.map((r) => r.join(" ")).join(" ");
  if (b.kind === "image") return b.caption ?? "";
  return "";
}

/**
 * The read-only preview (the eye button → Word / PDF) is OFF for now.
 *
 * One constant rather than deleted code, because it is coming back: the button
 * was only the way IN, and everything behind it keeps costing whether or not
 * anyone can open it — the Word layer mounts a hidden OnlyOffice WebView as soon
 * as the screen settles, and the PDF layer warms itself with a server-side
 * conversion on every new document version. So the flag gates the entry points
 * AND the work: the header button, the in-preview bar, both layers, the PDF
 * warm, and the editor-config fetch that exists only to feed them.
 *
 * The Writer (previewMode === null) is unaffected — it is the layer that is
 * always active anyway.
 */
const PREVIEW_ENABLED: boolean = false;

export default function ThesisWorkspaceScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { thesisId, blockIndex } = useLocalSearchParams<{ thesisId: string; blockIndex?: string }>();

  const thesis = useThesisStore((s) => s.theses.find((th) => th.id === thesisId));
  // NOTE: this screen deliberately does NOT subscribe to `selectedBlocks`. A tap to
  // select/edit a block must not re-render the whole workspace tree (two WebView
  // layers + the reorderable list) — that re-render storm was what delayed inline
  // edit mode by seconds. The Word view reads the selection from the store itself;
  // the outline's blocks react per-block via their own primitive selectors.
  // Drives the live block refresh below: while a turn is generating the AI
  // commits .docx edits mid-turn, so we re-fetch the document to show them.
  const isGenerating = useChatStore((s) => s.isGenerating);
  // Pending "scroll the active doc view to this block" request (set by the outline
  // navigator / a cold deep-link). Passed to whichever doc layer is on top.
  const scrollTarget = useWorkspaceStore((s) => s.scrollTarget);
  // The composer (BlockComposer) measures itself and writes its rendered height
  // here; the document area reserves exactly that many px at the bottom so content
  // always clears whichever composer surface is up — the idle AI bar, the floating
  // block pill, or the keyboard-docked bar. The parent's KeyboardAvoidingView
  // already lifts the composer above the keyboard, so this is a plain height.
  const composerInset = useSharedValue(BLOCK_COMPOSER_MIN_INSET);

  // Live-.docx document model, owned by the thesis-doc store so it can be
  // hydrated from the on-device cache (instant open) and edited optimistically.
  // `undefined` while loading; `available:false` once we know the thesis is
  // legacy → fall back to the section render.
  const doc = useThesisDocStore((s) => s.byId[thesisId]);

  // Monotonic reload token, bumped by the store only when the server .docx bytes
  // actually change (a real reconcile — never on an optimistic edit). Appended to
  // the Word view's URL so the docx-preview WebView reliably re-fetches after an
  // edit — the signed download URL can be byte-identical across two fetches in the
  // same second, so relying on it alone leaves a manual edit invisible.
  const docTick = useThesisDocStore((s) => s.tick[thesisId] ?? 0);
  // Bumped when the durable edit queue fully flushes — the .docx bytes (and thus
  // the OnlyOffice document.key / PDF render) changed on the server.
  const drainTick = useThesisDocStore((s) => s.drainTick[thesisId] ?? 0);

  // Undo/redo availability + queue-pending count, for the header history buttons.
  // Select primitives individually (never an object literal — see the store note
  // atop this file's other selectors).
  const canUndo = useThesisDocStore((s) => s.history[thesisId]?.canUndo ?? false);
  const canRedo = useThesisDocStore((s) => s.history[thesisId]?.canRedo ?? false);
  const pendingOps = useThesisDocStore((s) => s.pending[thesisId] ?? 0);
  // Depth of the LOCAL undo/redo stacks (on-device, instant, no network) —
  // available precisely while edits are queued locally, which is when the
  // server restore is unavailable. Together the buttons always have a path.
  const localUndo = useThesisDocStore((s) => s.localUndo[thesisId] ?? 0);
  const localRedo = useThesisDocStore((s) => s.localRedo[thesisId] ?? 0);

  // OnlyOffice editor config for the live-docx view. `undefined` while loading;
  // `{ enabled:false }` when the Document Server isn't configured (or the fetch
  // failed) → fall back to the docx-preview WordDocxView. When enabled it carries
  // the signed DocEditor config (its `document.key` bumps after each AI turn).
  const [editorCfg, setEditorCfg] = useState<EditorConfigDTO | undefined>(undefined);

  // PDF render of the live .docx (OnlyOffice-converted, fetched lazily only when
  // the user opens the PDF view). `undefined` while (re)converting; the DTO's
  // `available:false` carries why (no Document Server / conversion failed).
  const [pdfDoc, setPdfDoc] = useState<ThesisPdfDTO | undefined>(undefined);

  const previewMode = useWorkspaceStore((s) => s.previewMode);

  // Nav-perf (#5): the workspace pushes with a slide animation, and the hidden
  // Word-fidelity layer (OnlyOffice / docx-preview WebView) otherwise boots at the
  // same moment as the Lexical Writer during that slide — two heavy WebViews at
  // once, which reads as a multi-second stall. Defer the hidden layer until
  // interactions finish (or immediately if the user switches to the docx view).
  // The active Lexical layer still mounts right away.
  const [heavyReady, setHeavyReady] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setHeavyReady(true));
    return () => task.cancel();
  }, []);

  // A scheduled run can be editing this thesis while the student is in here.
  // Check once on mount, then poll ONLY while one is live — and refetch the
  // document the moment one finishes, so they see the result without pulling.
  const liveRunId = useTasksStore((s) => s.liveRunId);

  // Bring any waiting proposals onto the page once the document is HERE, and
  // again whenever a run finishes — that is exactly when new ones appear.
  //
  // Gated on the document, not on mount: a proposal can only be matched to a
  // paragraph that exists, so hydrating early found nothing and voided the lot.
  // A boolean selector is safe to subscribe to — it flips once, on load.
  //
  // ⚠️ Both effects are gated on TASKS_ENABLED — the feature is off (see
  // lib/tasks-enabled.ts) and the poll below is a network round-trip every 20
  // seconds for runs the student can no longer start.
  const docReady = useThesisDocStore((s) => !!s.byId[thesisId ?? ""]?.available);
  useEffect(() => {
    if (!TASKS_ENABLED || !thesisId || !docReady) return;
    void useTasksStore.getState().hydrateProposals(thesisId);
  }, [thesisId, liveRunId, docReady]);
  useEffect(() => {
    if (!TASKS_ENABLED || !thesisId) return;
    let cancelled = false;
    const tick = async () => {
      const justFinished = await useTasksStore.getState().watchLive(thesisId);
      if (justFinished && !cancelled) void useThesisDocStore.getState().revalidate(thesisId);
    };
    void tick();
    const id = setInterval(tick, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [thesisId]);

  // The Writer is opened FROM the conversation now — the chip under an assistant
  // answer, and the drawer's thesis list — and it slides up out of it (see
  // FROM_CHAT in app/(app)/_layout.tsx). So the leading control is a CLOSE, not a
  // back arrow: it puts the document down and returns to where it was picked up.
  //
  // `canGoBack` is the honest test. Land here from a deep link, or from a screen
  // that replaced itself into the Writer (import, combine), and there is nothing
  // below to pop — the chat is where "closed" means, so go there directly rather
  // than leaving a dead button.
  const router = useRouter();
  // Collapse back into the chip that opened this, THEN pop. On a Writer reached
  // from anywhere else (a thesis card, an import that replaced itself into it)
  // there is nothing registered and the callback runs straight through, so this
  // is a plain close there.
  const { collapse } = useZoomCollapse();
  const closeWorkspace = useCallback(() => {
    collapse(() => {
      if (router.canGoBack()) router.back();
      else router.replace("/(app)/chat" as any);
    });
  }, [collapse, router]);


  // Screen top-bar collapse (#6): a manual toggle from the ✦ dock hides the top bar
  // (back / title / undo-redo / ⋯) to give the writer more vertical space. Animate
  // the bar row's height→0 + fade; the safe-area notch spacer stays. Height is
  // measured once while shown so the collapse has a concrete target. (This is the
  // manual "toggle the header" control from issue #6; scroll-driven auto-hide is a
  // separate device-tuned follow-up — the WebView scroll signal is unreliable.)
  const headerVisible = useWorkspaceStore((s) => s.headerVisible);
  // chromeVisible is the scroll-driven flag (hide on scroll down, show on scroll up /
  // near top) shared with the bottom dock; headerVisible is the manual ✦-dock toggle.
  // The top bar is shown only when BOTH agree.
  const chromeVisible = useWorkspaceStore((s) => s.chromeVisible);
  const headerShown = headerVisible && chromeVisible;
  const headerH = useSharedValue(0);
  const headerProgress = useSharedValue(1);
  useEffect(() => {
    headerProgress.value = withTiming(headerShown ? 1 : 0, { duration: 220 });
  }, [headerShown, headerProgress]);
  const headerCollapseStyle = useAnimatedStyle(() => ({
    height: headerH.value > 0 ? headerH.value * headerProgress.value : undefined,
    opacity: headerProgress.value,
    overflow: "hidden",
  }));
  const measureHeaderBar = (h: number) => {
    if (headerVisible && h > 0 && headerH.value === 0) headerH.value = h;
  };

  // The three live-.docx views stay mounted at once (see the layered doc area), so
  // switching keeps each view's scroll. The PDF is the exception: its render is a
  // costly server conversion, so its layer is mounted LAZILY on first open and then
  // kept warm. These refs track that lifecycle — delete the server render only on
  // screen-leave (not on every switch) and re-convert only when the doc changes.
  const [pdfMounted, setPdfMounted] = useState(false);
  const pdfMountedRef = useRef(false);
  const pdfConvertedRef = useRef(false);
  const pdfVersionRef = useRef<string | undefined>(undefined);

  // Mark this thesis current and pull the freshest copy from the server.
  useEffect(() => {
    if (!thesisId) return;
    useThesisStore.getState().setCurrentThesis(thesisId);
    // The writer is the app's root surface — remember which document to reopen on
    // the next launch (see useProtectedRoute in app/_layout.tsx).
    useSettingsStore.getState().setLastThesisId(thesisId);
    useThesisStore.getState().refreshThesis(thesisId);
    useWorkspaceStore.getState().setThesis(thesisId);
    return () => {
      // Leaving the workspace → drop the transient PDF render if it was ever
      // converted this session (its layer now stays mounted across preview switches,
      // so keying on the current previewMode would leak it when leaving from another
      // preview).
      if (pdfMountedRef.current) {
        void deleteThesisPdf(thesisId).catch(() => {});
      }
      useWorkspaceStore.getState().reset();
      useFloatingPillStore.getState().reset();
      useRibbonStore.getState().reset();
      // Drop every pending inline suggestion: byIndex is keyed by BARE block
      // index (no thesis scoping), so a stale entry would overlay — and its
      // Approve would OVERWRITE — the same-index paragraph of the NEXT thesis.
      useSuggestionStore.getState().clear();
      // Clear an unanswered ask and make sure the outline push-drawer is closed on
      // leave, so neither ghosts open on the chat screen (both are app-global).
      useChatStore.getState().setPendingAsk(null);
      useChatHead.getState().close();
      useNavDrawerStore.getState().closeDrawer();
    };
  }, [thesisId]);

  // Revalidate the live-.docx block model from the server (best-effort — the store
  // keeps the last-known doc on failure). Used after an AI turn and after bulk
  // edits; the store also revalidates on focus (see below). Manual edits reconcile
  // themselves via the store's optimistic `mutate`, so they don't call this.
  const refreshDoc = useCallback(async () => {
    if (!thesisId) return;
    await useThesisDocStore.getState().revalidate(thesisId);
  }, [thesisId]);

  // Fetch the OnlyOffice editor config (only meaningful for live docs). On any
  // failure we fall back to docx-preview by marking the editor disabled.
  const refreshEditorCfg = useCallback(async () => {
    // Nothing reads the editor config while the preview is off: it feeds the
    // OnlyOffice layer and the PDF's version key, and both are unreachable.
    if (!PREVIEW_ENABLED) return;
    if (!thesisId) return;
    try {
      setEditorCfg(await getThesisEditorConfig(thesisId));
    } catch {
      setEditorCfg({ enabled: false });
    }
  }, [thesisId]);

  // Undo/redo are server-side restores. Disabled while queue ops are pending
  // (positional indices would replay against the restored doc) and during an AI
  // turn. Applies via the store's full-reconcile path (tick + drainTick).
  const [historyBusy, setHistoryBusy] = useState(false);
  // Document history sheet — opened via long-press on the header Undo button
  // (avoids a 6th header button). Conditionally mounted per the app's gorhom rule.
  const [historyOpen, setHistoryOpen] = useState(false);
  const runHistory = useCallback(
    async (kind: "undo" | "redo") => {
      if (!thesisId || historyBusy) return;
      // Local-first, three tiers (mirrors GlobalDockBar): (1) the Lexical
      // Writer's in-editor history — instant, offline, covers typing + in-editor
      // formatting; (2) the on-device op queue; (3) the server snapshot restore,
      // now only for steps from before this editing session.
      const lex = useLexicalEditorStore.getState();
      if (lex.active && (kind === "undo" ? lex.canUndo : lex.canRedo)) {
        // Don't step Lexical history over an inline AI proposal — undo would
        // unravel the proposal nodes. Ignore the tap.
        const sug = useSuggestionStore.getState();
        if (sug.range || Object.keys(sug.byIndex).length > 0) return;
        lex.dispatch(kind);
        return;
      }
      const store = useThesisDocStore.getState();
      if (kind === "undo" ? store.undoLocal(thesisId) : store.redoLocal(thesisId)) return;
      // Server restore requires a clean queue (applyRestoredDoc contract): with ops
      // still flushing, restoring would race the in-flight echo. The local path
      // above already handled everything undoable mid-flight — just bail.
      if ((store.pending[thesisId] ?? 0) > 0) return;
      setHistoryBusy(true);
      try {
        const res = kind === "undo" ? await undoThesisHistory(thesisId) : await redoThesisHistory(thesisId);
        useThesisDocStore.getState().applyRestoredDoc(thesisId, res.document, { canUndo: res.canUndo, canRedo: res.canRedo });
      } catch (e: any) {
        Alert.alert(t("workspace.historyFailed", { defaultValue: "Couldn't restore the document" }), e?.message ?? "");
      } finally {
        setHistoryBusy(false);
      }
    },
    [thesisId, historyBusy, t],
  );
  // Enabled when a LOCAL step exists — the Writer's in-editor history or the op
  // queue (instant, works mid-compose/offline) — or, once the queue is flushed,
  // when the server history has a step.
  const lexActive = useLexicalEditorStore((s) => s.active);
  const lexCanUndo = useLexicalEditorStore((s) => s.canUndo);
  const lexCanRedo = useLexicalEditorStore((s) => s.canRedo);
  const undoReady = !historyBusy && !isGenerating && ((lexActive && lexCanUndo) || localUndo > 0 || (canUndo && pendingOps === 0));
  const redoReady = !historyBusy && !isGenerating && ((lexActive && lexCanRedo) || localRedo > 0 || (canRedo && pendingOps === 0));

  // Convert + fetch the PDF render. Clears to `undefined` first so the view shows
  // a spinner while the Document Server (re)renders. Only called when the PDF
  // view is open (see the effect below) — conversion is too costly to prefetch.
  const refreshPdf = useCallback(async () => {
    if (!thesisId) return;
    setPdfDoc(undefined);
    try {
      setPdfDoc(await getThesisPdf(thesisId));
    } catch {
      setPdfDoc({ available: false, reason: "failed" });
    }
  }, [thesisId]);

  // Load the document model + editor config on focus. `load` paints instantly from
  // the on-device cache, replays any unsent edit ops, then revalidates from the
  // server in the background — so reopening a thesis (and returning from the block
  // editor) shows content with no spinner while the fresh copy loads behind it.
  useFocusEffect(
    useCallback(() => {
      if (thesisId) void useThesisDocStore.getState().load(thesisId);
      void refreshEditorCfg();
      if (thesisId) void useThesisDocStore.getState().refreshHistoryState(thesisId);
      // The workspace stays mounted under a pushed screen, so "is the writer
      // on top?" has to be tracked by focus, not by mount. See the store note.
      useWorkspaceStore.getState().setScreenFocused(true);
      return () => useWorkspaceStore.getState().setScreenFocused(false);
    }, [thesisId, refreshEditorCfg]),
  );

  // When the durable edit queue fully drains, the .docx bytes changed on the
  // server → re-fetch the editor config so the OnlyOffice layer (document.key)
  // and the PDF view (keyed on it) reload the fresh bytes. The outline view
  // already reconciled from the flush response.
  useEffect(() => {
    if (drainTick === 0) return;
    void refreshEditorCfg();
    if (thesisId) void useThesisDocStore.getState().refreshHistoryState(thesisId);
    // A manual edit changed the .docx → the headings may have too. Re-sync the
    // outline cache so the navigator sheet stays accurate without fetching on open.
    if (thesisId) void useOutlineStore.getState().sync(thesisId);
  }, [drainTick, refreshEditorCfg, thesisId]);

  const liveDoc = doc?.available ? doc : null;
  const isLiveDoc = !!liveDoc;

  // Tap-target list for the Word view: each engine block → its flat text, so a
  // tapped paragraph/table maps back to its block index for AI targeting.
  const tapBlocks = useMemo<DocTapBlock[]>(
    () => (liveDoc ? liveDoc.blocks.map((b) => ({ index: b.index, text: blockTapText(b) })) : []),
    [liveDoc],
  );

  // Deep-link target: when opened from the detail screen's outline, pre-select
  // the tapped heading's block so the docx-preview view highlights/scrolls to it,
  // and so the AI composer sends its text as the focus. The callers navigate here
  // with the heading text already in the store, so NEVER clobber an existing
  // non-empty selection (doing so dropped the heading text from the AI request).
  // For a cold deep-link with no pre-set text, resolve it from the loaded doc.
  useEffect(() => {
    if (blockIndex == null) return;
    const idx = Number(blockIndex);
    if (!Number.isFinite(idx)) return;
    const store = useWorkspaceStore.getState();
    const existing = store.selectedBlocks.find((b) => b.index === idx);
    if (existing?.text) return;
    const resolved = tapBlocks.find((b) => b.index === idx)?.text ?? existing?.text ?? "";
    store.selectBlock(idx, resolved);
  }, [blockIndex, tapBlocks]);

  // Was this screen opened ON a block (a reference tapped in a chat answer, a
  // heading tapped in the details outline) rather than opened plainly? The Writer
  // needs to know: an explicit destination outranks the saved reading position.
  const deepLinkBlock = useMemo(() => {
    if (blockIndex == null) return null;
    const n = Number(blockIndex);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }, [blockIndex]);

  // Cold deep-link (opened from the chat tab / detail outline with a blockIndex):
  // once the document has loaded, ask the active doc layer to scroll to it. Fires
  // once per blockIndex value — not on every tapBlocks change. In-workspace outline
  // taps set the scroll request directly (no navigation), so they skip this.
  const coldScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (blockIndex == null || !isLiveDoc) return;
    if (coldScrolledRef.current === blockIndex) return;
    const idx = Number(blockIndex);
    if (!Number.isFinite(idx)) return;
    coldScrolledRef.current = blockIndex;
    useWorkspaceStore.getState().requestScrollToBlock(idx);
  }, [blockIndex, isLiveDoc]);

  // A navigation jump raises `navigating` (the NavOverlay covers the doc). Once the
  // instant scroll + layout settle, drop the cover and flash the landed heading so
  // the reader's eye finds it. Keyed on the scroll nonce → one run per jump.
  useEffect(() => {
    if (!scrollTarget) return;
    const id = setTimeout(() => {
      const ws = useWorkspaceStore.getState();
      ws.setNavigating(false);
      ws.flashBlock(scrollTarget.index);
    }, 480);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget?.nonce]);

  // Entering the thesis → sync the Thesis Structure outline into the cache once the
  // live doc is loaded and idle, so the navigator sheet later opens INSTANTLY from
  // cache (no fetch on open). Once per thesis; heading changes re-sync below.
  const outlineWarmedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLiveDoc || !thesisId) return;
    if (isGenerating || pendingOps > 0) return;
    if (outlineWarmedRef.current === thesisId) return;
    const id = setTimeout(() => {
      outlineWarmedRef.current = thesisId;
      void useOutlineStore.getState().sync(thesisId);
    }, 1500);
    return () => clearTimeout(id);
  }, [isLiveDoc, thesisId, isGenerating, pendingOps]);

  // Base text direction for rendering. The thesis `language` field is unreliable
  // (imports default to "fr" even for Arabic docs), so detect from the actual
  // block content — RTL when right-to-left characters dominate. Drives both the
  // docx-preview container direction and the outline view's block fallback.
  const docRtl = useMemo(() => {
    if (!liveDoc) return false;
    const RTL = /[֐-ࣿיִ-﻿]/;
    const LTR = /[A-Za-z]/;
    let r = 0;
    let l = 0;
    for (const b of liveDoc.blocks) {
      const text = b.kind === "paragraph" ? b.text : b.kind === "table" ? b.rows.flat().join(" ") : "";
      for (const ch of text) {
        if (RTL.test(ch)) r++;
        else if (LTR.test(ch)) l++;
      }
      if (r + l > 3000) break;
    }
    return r > l;
  }, [liveDoc]);

  // Live word count (paragraph prose only). Drives the milestone celebrations.
  const wordCount = useMemo(() => (liveDoc ? countWords(liveDoc.blocks) : 0), [liveDoc]);

  // Word-count milestone celebrations. `celebratedRef` holds the highest
  // threshold already accounted for this session; the toast fires once per newly
  // crossed threshold. A short grace window after (re)load absorbs the initial
  // hydrate→revalidate settle so opening a long thesis never fires a celebration —
  // only real growth (typing or an AI turn) during the session does.
  const celebratedRef = useRef<number | null>(null);
  const settledRef = useRef(false);
  const [milestone, setMilestone] = useState<number | null>(null);
  useEffect(() => {
    celebratedRef.current = null;
    settledRef.current = false;
    setMilestone(null);
    const id = setTimeout(() => {
      settledRef.current = true;
    }, 3000);
    return () => clearTimeout(id);
  }, [thesisId]);
  useEffect(() => {
    if (!isLiveDoc) return;
    const passed = WORD_MILESTONES.filter((m) => wordCount >= m).pop() ?? 0;
    // Grace window / first measurement → set the baseline silently.
    if (!settledRef.current || celebratedRef.current === null) {
      celebratedRef.current = Math.max(celebratedRef.current ?? 0, passed);
      return;
    }
    const crossed = WORD_MILESTONES.filter((m) => m > (celebratedRef.current ?? 0) && wordCount >= m);
    if (crossed.length > 0) {
      const top = crossed[crossed.length - 1];
      celebratedRef.current = top;
      setMilestone(top);
    }
  }, [wordCount, isLiveDoc]);

  // Refresh the document when a turn finishes (generating true → false): the AI
  // committed its block edits to the .docx during the turn, so re-fetching gives
  // a fresh signed url → the Word view reloads with the updated document.
  const prevGenerating = useRef(isGenerating);
  useEffect(() => {
    if (prevGenerating.current && !isGenerating && isLiveDoc) {
      void refreshDoc();
      // New .docx bytes → the server returns a config with a bumped document.key,
      // which remounts the OnlyOffice editor onto the updated document.
      void refreshEditorCfg();
      if (thesisId) void useThesisDocStore.getState().refreshHistoryState(thesisId);
      // The AI likely changed headings/structure → re-sync the outline cache so the
      // navigator sheet reflects the turn without fetching on open.
      if (thesisId) void useOutlineStore.getState().sync(thesisId);
    }
    prevGenerating.current = isGenerating;
  }, [isGenerating, isLiveDoc, refreshDoc, refreshEditorCfg, thesisId]);

  // Document-version token: the OnlyOffice config's document.key bumps only when
  // the .docx actually changes (it's derived from updatedAt). Keying the PDF
  // fetch on it re-converts after a real edit but not on incidental refreshes.
  const docVersionKey = editorCfg?.enabled ? editorCfg.config?.document?.key : undefined;

  // Mount the PDF layer + (re)convert its render for the current doc version.
  // Idempotent per version: converts on first call and after a REAL document
  // change (docVersionKey) only — a mere re-entry keeps the warm render (and its
  // scroll). Mounting the (hidden) layer also arms the screen-leave cleanup that
  // deletes the ephemeral server render, so a background warm can't leak it.
  const ensurePdfForVersion = useCallback(() => {
    if (!isLiveDoc) return;
    if (!pdfMountedRef.current) {
      pdfMountedRef.current = true;
      setPdfMounted(true);
    }
    if (pdfConvertedRef.current && pdfVersionRef.current === docVersionKey) return;
    pdfConvertedRef.current = true;
    pdfVersionRef.current = docVersionKey;
    void refreshPdf();
  }, [isLiveDoc, docVersionKey, refreshPdf]);

  // Opening the PDF view converts immediately (keep its scroll on re-entry).
  useEffect(() => {
    if (previewMode !== "pdf") return;
    ensurePdfForVersion();
  }, [previewMode, ensurePdfForVersion]);

  // Warm the PDF in the BACKGROUND so tapping Preview → PDF opens instantly
  // instead of spinning through a server conversion. Runs once the doc is loaded
  // and idle — not while generating, not while manual edits are still queued (the
  // version key is stale until they drain), and only when a real Document Server
  // render is possible (docVersionKey defined). Debounced ~2.5s after load / an
  // edit settling and guarded on the version key, so it converts at most once per
  // real doc version — the same server cost as the user opening it, front-loaded.
  useEffect(() => {
    if (!PREVIEW_ENABLED) return; // nothing can open it — don't pay for the conversion
    if (!isLiveDoc || previewMode === "pdf") return;
    if (isGenerating || pendingOps > 0) return;
    if (docVersionKey === undefined) return;
    if (pdfConvertedRef.current && pdfVersionRef.current === docVersionKey) return;
    const id = setTimeout(() => ensurePdfForVersion(), 2500);
    return () => clearTimeout(id);
  }, [isLiveDoc, previewMode, isGenerating, pendingOps, docVersionKey, ensurePdfForVersion]);

  // No thesis asked for at all. There is nothing to write in, so send the
  // student to chat — which works perfectly well without a document and offers
  // to attach or start one.
  //
  // This used to render a "Start writing" screen whose three actions (New
  // thesis, Import, Templates) were the drawer's own entries, down to the same
  // locale keys — a second front door onto the same three doors.
  if (!thesisId) return <Redirect href={"/(app)/chat" as any} />;

  // Loading: no thesis yet (refreshThesis still in flight).
  if (!thesis) {
    return (
      <ZoomFromOrigin backdropColor={colors.bgSurface}>
      <SafeAreaView
        style={[styles.container, { backgroundColor: colors.bgSurface }]}
        edges={[]}
      >
        <View style={[styles.topBar, { paddingTop: insets.top + 14 }]}>
          {/* The same close pill the loaded header has, in the same place, so
              nothing moves the moment the document arrives. The history pill is
              absent because there is no document to have a history yet. */}
          <ClosePill onPress={closeWorkspace} colors={colors} label={t("common.close", { defaultValue: "Close" })} />
          <View style={styles.topSpacer} />
        </View>
        <DocSkeleton />
      </SafeAreaView>
      </ZoomFromOrigin>
    );
  }

  return (
    // The screen grows out of the chip that opened it and collapses back into it
    // on close (see components/ZoomFromOrigin). bgSurface, not the paper's white:
    // what fills the frame around the growing content should be the app's ground,
    // so the page reads as arriving ON something rather than unfolding out of it.
    <ZoomFromOrigin backdropColor={colors.bgSurface}>
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.bgSurface }]}
      edges={[]}
    >
      {/* Keyboard clearance for the composer.
          • iOS: the keyboard OVERLAYS content, so KAV must lift the region with
            `padding` — the container shrinks and the absolute dock lands above it.
          • Android: edge-to-edge already resizes the window/root for the IME
            (softwareKeyboardLayoutMode "resize" → adjustResize), which shrinks this
            container on its own → the absolute dock rides up for free. Using
            behavior="height" HERE stacked a SECOND keyboard-height inset on top of
            that OS resize, reserving the keyboard's height twice and stranding a gap
            under the document. So KAV is a NO-OP on Android (behavior undefined),
            matching the other Lexical editor screens (lexical-roundtrip/writeback). */}
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.container}>
      {/* The status-bar strip, and ONLY the status-bar strip, keeps a fill. It is
          painted in the theme's own colour so the OS clock and icons — which
          ThemeProvider styles from the theme, light text on dark and dark on
          light — stay legible over it. The paper below it is white in both
          themes, so letting the document run all the way up would leave the clock
          white-on-white every night. */}
      <View style={{ height: insets.top, backgroundColor: colors.bgSurface }} />

      {/* Everything else floats. The bar has no fill of its own: the two pills sit
          straight on the page and the document scrolls behind them, which is the
          whole point of a screen whose subject is the document. `box-none` on the
          host and the row so only the pills themselves take a touch — the paper
          between and around them stays tappable and scrollable.

          Still the collapsible bar from #6: the ✦ dock's manual toggle and the
          scroll-driven auto-hide both fade it out. Being out of the flow now, that
          fade no longer moves the page a pixel. */}
      <View style={[styles.headerHost, { top: insets.top }]} pointerEvents="box-none">
        <Animated.View
          style={headerCollapseStyle}
          onLayout={(e) => measureHeaderBar(e.nativeEvent.layout.height)}
          pointerEvents="box-none"
        >
        {/* TWO PILLS over the page, and nothing else.

            The thesis title is gone from here: this screen shows one document and
            only ever shows that one, so naming it at the top of every page spent
            the widest line on the page restating what the page already is. The
            title still names the conversation this was opened from, which is
            where a student actually needs to be told which thesis they are in.

            What is left is grouped by what it does. Leaving is one round button
            at the leading edge; the two history controls are one pill at the
            trailing edge, together because undo and redo are a pair and reading
            them as two loose glyphs is what made the old bar look like a toolbar
            with a hole in the middle. */}
        <View style={styles.topBar} pointerEvents="box-none">
          <ClosePill onPress={closeWorkspace} colors={colors} label={t("common.close", { defaultValue: "Close" })} />
          <View style={styles.topSpacer} pointerEvents="none" />
          {/* Undo / redo: server-side history restores. Disabled while queue ops are
              pending (positional indices would replay against the restored doc) or
              while an AI turn is running. */}
          {liveDoc && (
            <View
              style={[
                styles.pill,
                { backgroundColor: colors.bgPrimary, borderColor: colors.borderDefault },
              ]}
            >
              <Pressable
                onPress={() => void runHistory("undo")}
                onLongPress={() => {
                  if (pendingOps === 0) setHistoryOpen(true);
                }}
                delayLongPress={400}
                disabled={!undoReady}
                accessibilityRole="button"
                accessibilityLabel={t("workspace.undo", { defaultValue: "Undo" })}
                style={styles.pillBtn}
              >
                <Undo2 size={20} color={undoReady ? colors.textPrimary : colors.textPlaceholder} />
              </Pressable>
              <Pressable
                onPress={() => void runHistory("redo")}
                disabled={!redoReady}
                accessibilityRole="button"
                accessibilityLabel={t("workspace.redo", { defaultValue: "Redo" })}
                style={styles.pillBtn}
              >
                <Redo2 size={20} color={redoReady ? colors.textPrimary : colors.textPlaceholder} />
              </Pressable>
            </View>
          )}
          {/* Read-only preview (Word / PDF), live docs only — editing is the Writer.
              Switched off for now; see PREVIEW_ENABLED atop this file. */}
          {PREVIEW_ENABLED && liveDoc && <PreviewButton />}
        </View>
        </Animated.View>

      </View>

      {/* The scheduled-run banner used to sit here — a "Working…" strip under the
          header while a run edits this thesis. It is off the Writer now: this
          screen is the page and nothing else, and a status bar pinned across the
          top of it was the last thing between the pills and the paper. The run is
          still visible where it is actionable — Tasks, and the ✦ dock's working
          note — and it never blocked editing here anyway.

          To put it back: `{liveRunId ? <RunningBanner /> : null}`. */}

      {/* In-preview toolbar (Word/PDF/close). Renders nothing while writing. */}
      {PREVIEW_ENABLED && liveDoc && <PreviewBar />}

      {/* White base so the composer's reserved bottom clearance (and the small top
          gap above the paper) render as paper, not the dark app background. */}
      <Animated.View style={[{ flex: 1, backgroundColor: "#FFFFFF" }]}>
        {doc === undefined ? (
          /* Document model not resolved yet — avoid flashing the legacy render
             (migrated theses can still have section rows) before we know mode.
             Show a paper-style skeleton so loading reads as a document, not a
             blank spinner. */
          <DocSkeleton />
        ) : liveDoc ? (
          /* All three live-.docx views stay MOUNTED at once, stacked as absolute
             layers; only the active one is on top + interactive (the others sit
             behind at opacity 0). Switching views therefore never unmounts a view,
             so each keeps its own scroll position — crucially including the
             OnlyOffice editor, whose in-canvas scroll we can't otherwise read or
             restore. Each layer refreshes after an edit on its own (OnlyOffice via
             a bumped document.key, docx-preview via a silent in-place refresh —
             double-buffered, keeps scroll, no reload — and PDF via a
             re-convert). The wrapper is a normal flex child so it honours the
             animated paddingBottom (reserved for the composer sheet); the absolute
             layers then fill exactly that reserved box. */
          <View style={styles.layerHost}>
            {/* Word-fidelity layer: prefer the OnlyOffice Docs editor (HTML5-canvas,
                OOXML-native → Word-level fidelity); fall back to docx-preview when
                the Document Server isn't configured. Tap-to-target lives in
                WordDocxView (tapping a paragraph/table selects it); OnlyOffice is
                view-only for now — the composer still works (the AI targets blocks
                via find). OnlyOffice only on REAL devices: its heavy WASM/JS editor
                crashes the iOS Simulator's WebContent process (and is unreliable in
                emulators), so simulators/emulators fall back to docx-preview. */}
            {PREVIEW_ENABLED && (
            <View
              style={[styles.docLayer, previewMode === "docx" ? styles.layerActive : styles.layerHidden]}
              pointerEvents={previewMode === "docx" ? "auto" : "none"}
            >
              {!(heavyReady || previewMode === "docx")
                ? null /* #5: defer the hidden Word-layer WebView past the nav slide */
                : editorCfg === undefined ? (
                <View style={styles.centered}>
                  <ActivityIndicator size="large" color={colors.brandPrimary} />
                </View>
              ) : editorCfg.enabled && Device.isDevice ? (
                <OnlyOfficeView
                  documentServerUrl={editorCfg.documentServerUrl}
                  config={editorCfg.config}
                />
              ) : (
                <WordDocxView
                  url={`${liveDoc.downloadUrl}${liveDoc.downloadUrl.includes("?") ? "&" : "?"}_v=${docTick}`}
                  thesisId={thesisId}
                  blocks={tapBlocks}
                  scrollTarget={scrollTarget}
                  rtl={docRtl}
                  onSelect={(index, text) => {
                    // Tap: toggle in multi mode, else single-select (replace).
                    const ws = useWorkspaceStore.getState();
                    if (ws.multiSelect) ws.toggleBlock(index, text);
                    else ws.selectBlock(index, text);
                  }}
                  onLongPress={(index, text) =>
                    useWorkspaceStore.getState().addToSelection(index, text)
                  }
                  editable={false}
                  onEditCommit={(index, text) =>
                    void useThesisDocStore.getState().mutate(thesisId, { type: "editText", index, text })
                  }
                  // Backspace-at-offset-0 merge (dispatched by the WebView Backspace handler).
                  onMerge={(prevIndex, curIndex, mergedText) => {
                    const store = useThesisDocStore.getState();
                    void store.mutate(thesisId, { type: "editText", index: prevIndex, text: mergedText });
                    void store.mutate(thesisId, { type: "deleteBlocks", indices: [curIndex] });
                  }}
                  onSplit={(index, before, after) =>
                    void useThesisDocStore
                      .getState()
                      .mutate(thesisId, { type: "splitParagraph", index, before, after })
                  }
                  onEditActiveChange={(active) => useWorkspaceStore.getState().setInlineEditing(active)}
                />
              )}
            </View>
            )}

            {/* Outline layer: the same .docx blocks as lightweight editable text on
                white "paper" — native render (no WebView). Tap a block to select it
                for the AI; long-press the grip handle to drag-reorder it. Reads
                liveDoc.blocks (already in the DTO), so no extra fetch. */}
            <View
              style={[styles.docLayer, previewMode === null ? styles.layerActive : styles.layerHidden]}
              pointerEvents={previewMode === null ? "auto" : "none"}
            >
              {/* Lexical is now THE Writer editing surface (replaces the native
                  OutlineReorderable). Saves via the batch /ops endpoint. Legacy
                  tools (bubble/pill/outline/auto-scroll/inline-AI) are being
                  re-bridged onto Lexical one at a time — for now it carries its
                  own working formatting pill. */}
              <WorkspaceLexicalView
                thesisId={thesisId}
                blocks={liveDoc.blocks}
                rtl={docRtl}
                active={previewMode === null}
                deepLinkBlock={deepLinkBlock}
              />
            </View>

            {/* PDF layer: the OnlyOffice-rendered PDF of the live .docx in a WebView
                (PDF.js). Read-only deliverable preview; works on simulator too
                (conversion is server-side). Mounted lazily on first open, then kept
                warm so returning preserves its scroll; re-converts only after a real
                edit (see the effect above). */}
            {PREVIEW_ENABLED && (pdfMounted || previewMode === "pdf") && (
              <View
                style={[styles.docLayer, previewMode === "pdf" ? styles.layerActive : styles.layerHidden]}
                pointerEvents={previewMode === "pdf" ? "auto" : "none"}
              >
                {pdfDoc === undefined ? (
                  <View style={styles.centered}>
                    <ActivityIndicator size="large" color={colors.brandPrimary} />
                  </View>
                ) : pdfDoc.available ? (
                  <PdfView url={pdfDoc.url} />
                ) : (
                  <View style={styles.centered}>
                    <Text style={styles.emptyText}>
                      {pdfDoc.reason === "failed"
                        ? t("workspace.pdfFailed", { defaultValue: "Couldn't generate the PDF. Please try again." })
                        : t("workspace.pdfUnavailable", { defaultValue: "PDF preview isn't available for this document." })}
                    </Text>
                  </View>
                )}
              </View>
            )}

          </View>
        ) : (
          /* Unseeded thesis (no live .docx yet). Structure lives in the document,
             so there's nothing to render until it's seeded — ask the AI to start. */
          <View style={styles.centered}>
            <Text style={styles.emptyText}>
              {t("workspace.empty", { defaultValue: "No content yet." })}
            </Text>
            <Text style={styles.emptyHint}>
              {t("workspace.emptyHint", {
                defaultValue: "Ask Kwill in the composer to draft your first section ✨",
              })}
            </Text>
          </View>
        )}
        {/* Masks a heading-navigation jump: covers the doc while it scrolls
            instantly to the target, then fades out to reveal it (which flashes). */}
        <NavOverlay />
      </Animated.View>

      {/* The AI's docked gate (approve/cancel, or a question to answer) — and only
          that. Nothing docks while the AI is idle: the global document tools open
          as a root push drawer from the ✦ bubble's ⋮⋮ drop target, and block
          formatting lives in the bubble itself. */}
      <BlockComposer thesisId={thesisId} rtl={docRtl} insetValue={composerInset} />

      {/* Document search (find/replace + semantic), docked ON TOP OF THE KEYBOARD.
          It used to hang under the header, which put it at the opposite end of the
          screen from the keys typing into it — and hid the matches it was finding
          behind the keyboard in between.

          Mounted HERE, inside the KeyboardAvoidingView, for that to work: on iOS
          the KAV shrinks this container so a bottom-docked bar clears the keys on
          its own, and on Android (where the KAV is a no-op — see the note on it)
          the panel lifts itself by the measured height. It draws its own fill,
          unlike everything else on this screen, because a find field over running
          text is unreadable. Renders nothing at all while search is closed. */}
      {liveDoc && <SearchPanel thesisId={thesisId} blocks={liveDoc.blocks} />}
        </View>
      </KeyboardAvoidingView>

      {/* Persistent floating formatting pill — draggable screen overlay; closes
          only by drag-to-X. Replaces the old inline per-block pill. */}
      {thesisId && (
        <FloatingPill thesisId={thesisId} rtl={docRtl} blocks={liveDoc?.blocks ?? []} />
      )}

      {/* Word-count milestone celebration — floats over everything, never blocks
          touches; keyed on the count so each crossing replays the animation. */}
      {milestone != null && (
        <View pointerEvents="box-none" style={[styles.milestoneHost, { top: insets.top + 64 }]}>
          <MilestoneToast key={milestone} count={milestone} onDone={() => setMilestone(null)} />
        </View>
      )}

      {/* Sources sheet — self-hides when closed (conditional unmount). */}
      <SourcesSheet thesisId={thesisId} />

      {/* Document history sheet — long-press the header Undo button to open.
          Conditionally mounted so it self-presents on mount / dismisses on unmount. */}
      {historyOpen && thesisId && (
        <HistorySheet thesisId={thesisId} onClose={() => setHistoryOpen(false)} />
      )}

      {/* Counts the scheduled run's proposals down and jumps to the next.
          Renders nothing when there are none. */}
      <ProposalStepper
        onJump={(index) => {
          const doc = useThesisDocStore.getState().byId[thesisId];
          const text = doc && doc.available ? (doc.blocks[index] as { text?: string })?.text ?? "" : "";
          const ws = useWorkspaceStore.getState();
          // Select tints the landing spot; the scroll is what actually takes the
          // student there. Selecting alone left the pill looking inert — the
          // proposal was often pages away, and they had to go find it by hand.
          ws.selectBlock(index, text);
          ws.requestScrollToBlock(index);
        }}
      />
    </SafeAreaView>
    </ZoomFromOrigin>
  );
}

/**
 * The leading control: put this document down and go back to where it was picked
 * up. Round rather than the trailing pill's stadium, so the two never read as one
 * split control — they do different things and sit at opposite ends.
 */
function ClosePill({
  onPress,
  colors,
  label,
}: {
  onPress: () => void;
  colors: ReturnType<typeof useThemeColors>;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        styles.pill,
        styles.pillRound,
        { backgroundColor: colors.bgPrimary, borderColor: colors.borderDefault },
      ]}
    >
      <X size={20} color={colors.textPrimary} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Out of the flow entirely, so the page runs under it and the bar's collapse
  // costs the document no reflow. `elevation` as well as `zIndex`: on Android
  // touch dispatch follows elevation, so a zIndex-only bar paints above the page
  // and still loses the tap to it.
  headerHost: { position: "absolute", left: 0, right: 0, zIndex: 20, elevation: 20 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  // The two pills are pushed to opposite ends by this rather than by
  // space-between, so a third control (the preview button) can still join the
  // trailing end without the leading one drifting inwards.
  topSpacer: { flex: 1 },
  // Lifted off the page: bgPrimary is LIGHTER than the header's own bgSurface in
  // the light theme and darker in the dark one, so the hairline is what makes it
  // read as a control in both — never the fill alone.
  pill: {
    flexDirection: "row",
    alignItems: "center",
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
  },
  pillRound: { width: 38, justifyContent: "center", paddingHorizontal: 0 },
  // 34 wide inside a 38 pill: the touch target fills the pill's height, so no
  // hitSlop is needed and two adjacent taps can't miss between them.
  pillBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  // Full-width, centered overlay host for the milestone toast (top offset applied
  // inline from the safe-area inset). box-none so only the pill itself is a target.
  milestoneHost: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 100 },
  // Each live-doc view is an absolute layer filling the doc area; they overlap so
  // switching only toggles which is on top + interactive (all stay mounted → each
  // keeps its scroll). Inactive layers sit behind at opacity 0 (the active layer is
  // opaque/full-bleed, so it fully covers them).
  layerHost: { flex: 1 },
  docLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  layerActive: { opacity: 1, zIndex: 1 },
  layerHidden: { opacity: 0, zIndex: 0 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  content: { paddingBottom: 40 },
  outlineContent: { paddingVertical: 8 },

  // Title page
  titleUniversity: {
    color: INK,
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  titleMuted: {
    color: MUTED,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 2,
  },
  titleMain: {
    color: INK,
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    lineHeight: 29,
  },
  titleMeta: {
    color: INK,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
    marginTop: 4,
  },
  titleSpacer: { height: 28 },

  // Résumé / generic page heading
  pageHeading: {
    color: INK,
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    marginBottom: 10,
  },
  keywords: {
    color: MUTED,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    marginTop: 12,
  },

  // Section divider (centered)
  sectionTitleCenter: {
    color: INK,
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  sectionKindCenter: {
    color: MUTED,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
    marginTop: 8,
  },

  // Section with content (left-aligned)
  sectionTitleLeft: {
    color: INK,
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  sectionKindLeft: {
    color: MUTED,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    marginTop: 4,
  },
  contentSpacer: { height: 10 },

  // Empty state
  emptyText: {
    color: MUTED,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
  },
  emptyHint: {
    color: MUTED,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 8,
    paddingHorizontal: 32,
    lineHeight: 19,
  },
});
