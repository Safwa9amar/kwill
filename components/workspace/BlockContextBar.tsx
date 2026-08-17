import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { View, Pressable, StyleSheet, Alert, Dimensions, Keyboard } from "react-native";
import type { ScrollView as RNScrollView, StyleProp, ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
// Tool rows use gesture-handler's ScrollView so they scroll even when nested inside
// the reorderable list (RN's ScrollView loses the pan to the list's gesture handler).
import { ScrollView } from "react-native-gesture-handler";
import { ChevronsDownUp, ListChecks, ListTree, Sparkles, X } from "lucide-react-native";
import { AddBlockTaskSheet } from "@/components/tasks/AddBlockTaskSheet";
import { useTasksStore } from "@/stores/tasks-store";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useNavDrawerStore } from "@/stores/nav-drawer-store";
import { useSearchStore } from "@/stores/search-store";
import { useToolbarStore, resolveToolbarKind, ownsCategory, isWidePanel } from "@/stores/toolbar-store";
import { pickAndInsertImage } from "@/lib/insert-image";
import { pasteImageFromClipboard } from "@/lib/paste-image";
import type { DocBlockDTO } from "@/lib/api";
import { hWarn } from "@/lib/haptics";
import { chipOut, layoutSpring, pillIn, pillOutUnlessHandoff, rowIn, rowOutUnlessHandoff, SPRING_SOFT } from "@/lib/motion";
import { isPillHandoff, shouldGlow } from "@/lib/pill-handoff";
import type { FormatChange, ParaRun } from "@/lib/thesis-ops";
import { AnimatedChip } from "./AnimatedChip";
import { PictureCropModal } from "./PictureCropModal";
import { TOOLBARS, ToolbarProvider, CHIP, toolStyles, type ToolbarCtx, type ChromeSelection, type ParagraphBlock, type Align } from "./bubble-tools";
import { visualRow } from "@/lib/rtl-layout";
import { TASKS_ENABLED } from "@/lib/tasks-enabled";

// ── Vertical (column) form geometry ──
// Shared with FloatingPill, which sizes + clamps the drag host from these: one chip
// wide plus the strip's padding, and a worst-case total height (lead chip + the
// capped tool scroller + separator + ✦ Ask AI + Outline + gaps) so a tall column can
// never be dragged off the bottom of the screen.
export const VERTICAL_PILL_W = CHIP + 16;
const VERTICAL_TOOLS_MAX_H = 220;
export const VERTICAL_PILL_MAX_H = VERTICAL_TOOLS_MAX_H + CHIP * 3 + 60;
// A category's options fly out BESIDE the strip (never above it — the strip already
// fills the screen's usable middle). Icon-only sets stay one chip wide; the
// header/footer panels carry an instruction input and template cards and need a real
// card's width, capped so the pair still fits the narrowest phone.
const VERTICAL_PANEL_GAP = 8;
const VERTICAL_PANEL_W = VERTICAL_PILL_W;
// 284 leaves 272 of inner width — enough for the template list's own minWidth: 260.
const VERTICAL_PANEL_WIDE_W = Math.min(284, Dimensions.get("window").width - VERTICAL_PILL_W - 24);
// The wide (header/footer) panels carry an input, a compiled preview and template
// cards — they get a taller cap than a column of option chips does.
const VERTICAL_PANEL_WIDE_MAX_H = 360;

// engine "both" == UI "justify"
const alignFromDoc = (a: string | null): Align | null => (a === "both" ? "justify" : (a as Align | null));

/** One-shot ring pulse behind ✦ Ask AI — once per NEW selection target, deduped across
 *  pill remounts (handoffs, keyboard open/close) via shouldGlow. Deliberately not an
 *  infinite loop (battery). `trigger` = the selection identity string. */
function AskAIGlow({ trigger, color }: { trigger: string; color: string }) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0);
  useEffect(() => {
    if (!shouldGlow(trigger)) return;
    scale.value = 1;
    opacity.value = 0.5;
    scale.value = withSpring(1.3, SPRING_SOFT);
    opacity.value = withTiming(0, { duration: 500 });
  }, [trigger, scale, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ scale: scale.value }] }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: CHIP / 2, backgroundColor: color }, style]}
    />
  );
}

/** Saving-in-flight dot: gentle repeat pulse; the loop dies with the unmount. */
function PulsingDot({ color }: { color: string }) {
  const v = useSharedValue(0.4);
  useEffect(() => {
    v.value = withRepeat(withSequence(withTiming(1, { duration: 600 }), withTiming(0.4, { duration: 600 })), -1, false);
  }, [v]);
  const style = useAnimatedStyle(() => ({ opacity: v.value, transform: [{ scale: 0.7 + v.value * 0.5 }] }));
  return <Animated.View style={[styles.savingDot, { backgroundColor: color }, style]} />;
}

interface Props {
  thesisId: string;
  rtl: boolean;
  /** Selected PARAGRAPH blocks (in doc order) — the target of style/align/direction/
   *  clear/move/image. Empty when the selection is a table/image → those tools disable. */
  paragraphSelection: ParagraphBlock[];
  /** The SOLE selected block of ANY kind (null unless exactly one is selected). */
  selectedBlock?: DocBlockDTO | null;
  /** Every selected block index (paragraph or not) — the target of Delete. */
  selectedIndices: number[];
  count: number;
  blockCount: number;
  /** Keyboard up → the full-width bar docked above the keyboard; down → floating pill. */
  keyboardOpen: boolean;
  /** Scope pill text (shown in the full-width form for AI targeting). */
  scopeLabel: string;
  onAskAI: () => void;
  bottomInset: number;
  /** Column form only (Settings → Toolbar layout = Vertical): the total width the strip
   *  + its open fly-out panel currently need. FloatingPill sizes and re-clamps its drag
   *  host from this — it cannot measure the content itself, since the host is what
   *  constrains it. Never called in the horizontal forms. */
  onColumnWidth?: (w: number) => void;
  /** Column form only: which PHYSICAL side of the strip a category's options fly out on.
   *  The host decides it from where the strip is resting — a panel always opens toward
   *  the screen's centre, or it would be off-screen (see FloatingPill's `panelLeft`).
   *  Defaults to the reading side of the document, the pre-drag behaviour. */
  panelLeft?: boolean;
  /** When set (floating overlay only), the compact pill shows a leading collapse
   *  chevron that calls this. The keyboard-docked bar never passes it. */
  onCollapse?: () => void;
  blocks?: DocBlockDTO[];
  /** When set, the selection is a Word chrome band (running header / footer / section
   *  break) rather than a block. */
  chrome?: ChromeSelection | null;
}

/**
 * The SHELL around the bubble toolbars. It owns everything that is the same whatever
 * is selected — the pill surface and its two forms, the entrance/morph animations, the
 * pinned ✦ Ask AI + Outline, the saving dot, the crop modal — and nothing about any
 * individual toolset.
 *
 * WHICH toolbar to draw comes from `stores/toolbar-store` (resolveToolbarKind), and the
 * toolbars themselves live one-per-file in `bubble-tools/`. The shell hands them the
 * current selection and the shared actions through ToolbarProvider, then renders the
 * registry's <Tools/> inside its scroller and <Panel/> in its expansion slot.
 *
 * Three forms:
 *   • keyboard open → a full-width BAR docked on the keyboard (always the full toolset);
 *   • keyboard closed, horizontal → a compact floating PILL that morphs to a full card;
 *   • keyboard closed, vertical → a narrow COLUMN strip whose panels fly out sideways.
 */
export function BlockContextBar({
  thesisId,
  rtl,
  paragraphSelection,
  selectedBlock,
  selectedIndices,
  count,
  blockCount,
  keyboardOpen,
  scopeLabel,
  onAskAI,
  bottomInset,
  onColumnWidth,
  panelLeft,
  onCollapse,
  blocks,
  chrome,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const saving = useThesisDocStore((s) => (s.pending[thesisId] ?? 0) > 0);

  // ── Orientation (Settings → "Toolbar layout") ──
  // "vertical" turns the floating pill into a narrow side COLUMN of chips: the tools
  // scroll top→bottom, ✦ Ask AI pins at the bottom, and a category's options fly out
  // sideways — so the toolbar never lies across the line being edited. Every kind takes
  // part, chrome bands included. The one exclusion is structural: the keyboard-DOCKED
  // bar is a full-width strip resting on the keyboard, where a column has nowhere to go.
  const toolbarOrientation = useSettingsStore((s) => s.toolbarOrientation);
  const vertical = toolbarOrientation === "vertical" && !keyboardOpen;

  // ── Toolbar state (stores/toolbar-store) ──
  const expanded = useToolbarStore((s) => s.expanded);
  const category = useToolbarStore((s) => s.category);
  const cropIndex = useToolbarStore((s) => s.cropIndex);
  /** The complete toolset rather than the curated compact one. */
  const full = keyboardOpen || expanded;

  // Live Lexical block format — a caret inside a list resolves to the list toolbar, and
  // formatting reads the REAL editor selection rather than the (laggy) DTO.
  const lexActive = useLexicalEditorStore((s) => s.active);
  const lexFmt = useLexicalEditorStore((s) => s.format);

  // THE SWITCH. Resolved synchronously so a selection change never renders one frame of
  // the previous toolbar; the store is then pointed at the same target in a LAYOUT
  // effect (before paint) so its entry rules — which panel opens — land in the same
  // commit. FloatingPill resolves the collapsed bubble's icon through the same function.
  const kind = resolveToolbarKind({ block: selectedBlock, listType: lexActive ? lexFmt.blockType : null, chrome, count });
  const targetKey = chrome ? `${chrome.kind}:${chrome.index}` : selectedIndices.join(",");
  useLayoutEffect(() => {
    useToolbarStore.getState().syncTarget({ kind, key: targetKey });
  }, [kind, targetKey]);
  useEffect(() => {
    useToolbarStore.getState().setKeyboardOpen(keyboardOpen);
  }, [keyboardOpen]);
  // Per-MOUNT state: (+) More, the table delete-pick mode and an open crop modal all
  // used to be component state and died with the toolbar. They live in the store now
  // (the tools and their panel are separate components and have to share them), so the
  // shell restores that lifetime by hand — otherwise a re-opened bubble would come back
  // in whatever mode it was left in.
  useEffect(() => {
    const store = useToolbarStore.getState();
    return () => {
      store.closeMore();
      store.setDelPick(null);
      store.setCropIndex(null);
    };
  }, []);

  // Body text and headings share ONE full toolset (a heading IS a paragraph with a
  // level), so in the wide form they resolve to the same module — the tool row doesn't
  // remount, and its stagger doesn't replay, when the caret moves between them.
  const toolsetKind = full && kind === "heading" ? "text" : kind;
  const { Tools } = TOOLBARS[toolsetKind];
  const { Panel } = TOOLBARS[kind];
  // A stale category can survive one frame between the render and the layout effect —
  // gate on ownership so the shell never asks a toolbar to render a panel it doesn't
  // have. Also drives the column form's width math, which must agree with what shows.
  const panelOpen = category != null && Panel != null && ownsCategory(kind, category);

  // ── Column form: strip + (optional) fly-out panel side by side ──
  // A panel whose options are WORDS ("Same as previous section", "Percent") needs the
  // wide fly-out; the glyph panels stay one chip wide. isWidePanel is the single rule —
  // useChipKit shapes the options from the same call, so the width and its contents
  // always agree.
  const wideCat = isWidePanel(category);
  const columnPanelW = wideCat ? VERTICAL_PANEL_WIDE_W : VERTICAL_PANEL_W;
  // Which way the options fly out. The host measures the strip against the screen and
  // answers; without one (nobody else mounts the column form today) fall back to the
  // document's reading side, where the strip used to be assumed to sit.
  const flyoutLeft = panelLeft ?? !rtl;
  const columnW = !vertical
    ? 0
    : panelOpen
      ? VERTICAL_PILL_W + VERTICAL_PANEL_GAP + columnPanelW
      : VERTICAL_PILL_W;
  useEffect(() => {
    if (vertical) onColumnWidth?.(columnW);
  }, [vertical, columnW, onColumnWidth]);

  // ── Selection derivations shared by every toolbar ──
  const canFormat = paragraphSelection.length > 0;
  const paraIndices = paragraphSelection.map((b) => b.index);
  const single = paragraphSelection.length === 1 ? paragraphSelection[0] : null;
  const soleIndex = selectedBlock ? selectedBlock.index : null;
  const soleText =
    selectedBlock?.kind === "paragraph"
      ? selectedBlock.text
      : selectedBlock?.kind === "image"
        ? (selectedBlock.caption ?? "")
        : "";
  const canUp = soleIndex != null && soleIndex > 0;
  const canDown = soleIndex != null && soleIndex < blockCount - 1;

  // Heading levels go one deeper than the document actually uses, so the next level is
  // always reachable but the list never runs to H6 for a two-level thesis.
  const deepestHeadingLevel = useMemo(() => {
    if (!blocks) return 2;
    let max = 0;
    for (const b of blocks) if (b.kind === "paragraph" && b.level > max) max = b.level;
    return max;
  }, [blocks]);
  const headingLevels = useMemo(
    () => Array.from({ length: Math.min(6, deepestHeadingLevel + 1) }, (_, i) => i + 1),
    [deepestHeadingLevel],
  );
  const styleLevels = useMemo(() => [0, ...headingLevels], [headingLevels]);

  // ── Shared actions ──
  // Lexical active → dispatch a whole-block `blockFormat` command into the editor
  // (mirrors the server's whole-paragraph format op), persisted by its batched
  // auto-sync. Otherwise (legacy composer) → the durable op queue.
  const apply = (changes: FormatChange) => {
    if (!paraIndices.length) return;
    if (lexActive) {
      useLexicalEditorStore.getState().dispatch("blockFormat", JSON.stringify({ indices: paraIndices, changes }));
      return;
    }
    void useThesisDocStore.getState().mutate(thesisId, { type: "format", indices: paraIndices, changes });
  };

  const move = (dir: "up" | "down") => {
    if (soleIndex == null) return;
    const from = soleIndex;
    const to = dir === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= blockCount) return;
    useWorkspaceStore.getState().selectBlock(to, soleText);
    void useThesisDocStore.getState().mutate(thesisId, { type: "move", from, to });
  };

  const del = () => {
    if (!selectedIndices.length) return;
    Alert.alert(
      t("workspace.deleteSelectedTitle", { defaultValue: "Delete selected blocks?" }),
      t("workspace.deleteSelectedBody", { count, defaultValue: `Remove ${count} block(s) from the document? You can undo this from History.` }),
      [
        { text: t("common.cancel", { defaultValue: "Cancel" }), style: "cancel" },
        {
          text: t("common.delete", { defaultValue: "Delete" }),
          style: "destructive",
          onPress: () => {
            hWarn();
            void useThesisDocStore.getState().mutate(thesisId, { type: "deleteBlocks", indices: selectedIndices });
            useWorkspaceStore.getState().clearSelection();
          },
        },
      ],
    );
  };

  /** Open the top-pinned document search (Writer-only → close any preview first). */
  const openSearch = () => {
    Keyboard.dismiss();
    const ws = useWorkspaceStore.getState();
    if (ws.previewMode != null) ws.closePreview();
    useSearchStore.getState().openSearch();
  };

  const pickImage = () => {
    if (!single) return;
    void pickAndInsertImage(thesisId, single.index);
  };

  const pasteImage = () => {
    if (!single) return;
    void pasteImageFromClipboard(thesisId, single.index);
  };

  // ── Format active-state helpers ──
  // With Lexical live these reflect the REAL editor selection (reported into its
  // store), so the highlights match what the caret actually sits in.
  const allLevel = (l: number) =>
    lexActive
      ? l === 0
        ? lexFmt.blockType === "paragraph" || lexFmt.blockType === "quote"
        : lexFmt.blockType === "h" + l
      : canFormat && paragraphSelection.every((b) => b.level === l);
  const allAlign = (v: Align) =>
    lexActive ? lexFmt.alignment === v : canFormat && paragraphSelection.every((b) => alignFromDoc(b.alignment) === v);
  const allDirection = (v: "rtl" | "ltr") =>
    lexActive ? (lexFmt.isRTL ? "rtl" : "ltr") === v : canFormat && paragraphSelection.every((b) => b.direction === v);
  // The paragraph DTO carries `runs?` (server-emitted) but the app's DocBlockDTO type
  // doesn't declare it — read it defensively via cast. A mark is "on" only when EVERY
  // run of EVERY selected paragraph carries it, so a partially-marked selection reads
  // off and the toggle sets it everywhere.
  const runsOf = (b: ParagraphBlock): ParaRun[] | undefined => (b as { runs?: ParaRun[] }).runs;
  const allMark = (on: (r: ParaRun) => boolean) =>
    canFormat &&
    paragraphSelection.every((b) => {
      const runs = runsOf(b);
      return !!runs && runs.length > 0 && runs.every(on);
    });
  const allBold = lexActive ? lexFmt.bold : allMark((r) => !!r.bold);
  const allItalic = lexActive ? lexFmt.italic : allMark((r) => !!r.italic);
  const allUnderline = lexActive ? lexFmt.underline : allMark((r) => !!r.underline);
  // Lexical doesn't report per-selection colour, so the swatch ring is legacy-only.
  const colorActive = (hex: string) =>
    lexActive ? false : allMark((r) => (r.color ?? "").toUpperCase() === hex.toUpperCase());

  const ctx: ToolbarCtx = {
    thesisId,
    rtl,
    vertical,
    blocks,
    blockCount,
    paragraphSelection,
    selectedBlock: selectedBlock ?? null,
    selectedIndices,
    count,
    chrome: chrome ?? null,
    canFormat,
    single,
    soleIndex,
    paraIndices,
    canUp,
    canDown,
    styleLevels,
    headingLevels,
    lexActive,
    lexFmt,
    allLevel,
    allAlign,
    allDirection,
    allBold,
    allItalic,
    allUnderline,
    colorActive,
    apply,
    move,
    del,
    openSearch,
    pickImage,
    pasteImage,
  };

  // Morphing toolsets keeps the ScrollView instance alive — snap back to the start so a
  // long toolset scrolled right can't leave a short one stranded past its own content.
  // Only one of the three tool scrollers is mounted at a time, so they share one ref.
  const toolsScrollRef = useRef<RNScrollView>(null);
  useEffect(() => {
    toolsScrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
  }, [toolsetKind]);

  // A header/footer band already has its OWN dedicated ✦ (the smart, section-grounded
  // generate panel) — the generic pinned Ask-AI would be a second, redundant sparkle
  // right next to it. Hidden for exactly those two bands; every other kind keeps it.
  const isHfBand = chrome?.kind === "top" || chrome?.kind === "bottom";
  // A selected picture is not something the generic ✦ can act on — it would open the
  // dock scoped to a block with no text to work with. The chip stays in place (dropping
  // it would reshuffle the strip on every figure tap) but reads and behaves as disabled:
  // dimmed to the same 0.4 as a disabled tool chip, no press, no attention glow.
  const askDisabled = kind === "image";
  const AskAI = isHfBand ? null : (
    <Pressable
      onPress={onAskAI}
      disabled={askDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: askDisabled }}
      accessibilityLabel={t("blockBar.askAi", { defaultValue: "Ask Kwill" })}
      style={[styles.askBtn, { backgroundColor: colors.brandPrimary }, askDisabled && toolStyles.chipDim]}
    >
      {askDisabled ? null : <AskAIGlow trigger={selectedIndices.join(",")} color={colors.brandPrimary} />}
      <Sparkles size={18} color={colors.brandOnPrimary} strokeWidth={2.2} />
    </Pressable>
  );

  // Pinned beside ✦ Ask AI so the outline is always one tap away (never scrolled off
  // with the formatting tools). The drawer dismisses the keyboard itself on open.
  // openView — NOT openDrawer: the panel hosts two views and opens on "app" (the global
  // command list) by default, so a plain open landed the student on the command index
  // and made them tap through to the structure this button is named for.
  const OutlineBtn = (
    <Pressable
      onPress={() => {
        Keyboard.dismiss();
        useNavDrawerStore.getState().openView("outline");
      }}
      accessibilityRole="button"
      accessibilityLabel={t("workspace.outline", { defaultValue: "Outline" })}
      style={[styles.pinnedChip, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
    >
      <ListTree size={18} color={colors.textPrimary} strokeWidth={2} />
    </Pressable>
  );

  // "Add as task" — the one-tap path from a paragraph the student is looking at
  // into Up next. Pinned beside the outline button so it is never scrolled off
  // with the formatting tools. Hidden for a header/footer band and for a
  // picture, for the same reasons the pinned sparkle is: neither has a
  // paragraph to act on.
  // ⚠️ `TASKS_ENABLED` first — the whole feature is off (see lib/tasks-enabled.ts),
  // which takes the ☑ chip out of every toolbar that renders `TaskBtn` and the
  // sheet with it, in one place rather than at four call sites.
  const canTask = TASKS_ENABLED && !isHfBand && selectedBlock?.kind === "paragraph";
  const taskSnippet = selectedBlock?.kind === "paragraph" ? selectedBlock.text : "";
  const TaskBtn = canTask ? (
    <Pressable
      onPress={() => useBottomSheet.getState().openSheet("task-from-block")}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.addFromBlock")}
      style={[styles.pinnedChip, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
    >
      <ListChecks size={18} color={colors.textPrimary} strokeWidth={2} />
    </Pressable>
  ) : null;

  // Adding is the ONLY thing this sheet does — it never navigates, so the
  // student stays on the paragraph they were reading.
  const taskSheet = canTask ? (
    <AddBlockTaskSheet
      snippet={taskSnippet}
      onAdd={({ request, mode }) => {
        void (async () => {
          const store = useTasksStore.getState();
          // The Tasks screen may never have been opened, so there is no draft
          // run loaded yet — load it first, then add.
          if (store.thesisId !== thesisId) await store.load(thesisId);
          await useTasksStore.getState().add({
            kind: "custom_block_task",
            params: { request, snippet: taskSnippet },
            // Index AND snippet: the index is a hint, the text is the identity,
            // because the document may move before the run fires.
            target: { anchor: { index: selectedBlock!.index, snippet: taskSnippet } },
            mode,
          });
        })();
      }}
    />
  ) : null;

  // Interactive crop for the selected figure. Self-contained <Modal> (portals to root)
  // so it renders correctly from any form. On commit it uploads and we revalidate.
  const cropModal = (
    <PictureCropModal
      thesisId={thesisId}
      blockIndex={cropIndex}
      onClose={() => useToolbarStore.getState().setCropIndex(null)}
      onDone={() => void useThesisDocStore.getState().revalidate(thesisId)}
    />
  );

  // Keyed by toolset so a KIND change crossfades the chips (old row fades via chipOut,
  // the new one staggers in) — the smart-pill morph.
  const toolRow = (keyPrefix: string, style: StyleProp<ViewStyle>) => (
    <Animated.View key={keyPrefix + toolsetKind} exiting={chipOut} style={style}>
      <Tools full={full} />
    </Animated.View>
  );

  const expansion = !panelOpen || !Panel ? null : (
    <Animated.View
      key={"exp-" + category}
      entering={rowIn}
      exiting={rowOutUnlessHandoff}
      style={[
        styles.expansion,
        vertical && [
          styles.expansionV,
          { width: columnPanelW, maxHeight: wideCat ? VERTICAL_PANEL_WIDE_MAX_H : VERTICAL_TOOLS_MAX_H },
        ],
        { backgroundColor: colors.bgSurface, borderColor: colors.borderSubtle },
      ]}
    >
      {/* Column layout: the options stack and scroll vertically inside the fly-out (a
          long set — the 8 colour swatches, a 20-row table picker — would otherwise run
          off the top of the screen). */}
      <ScrollView
        horizontal={!vertical}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={
          vertical ? styles.expansionColumn : [styles.expansionRow, { flexDirection: visualRow(rtl) }]
        }
      >
        {/* Keyed by TARGET so a panel holding a draft — the header/footer ✦ input and
            its template picker — starts clean on a different band, while the wrapper
            (keyed by category) stays put so the entrance animation doesn't replay. */}
        <Panel key={targetKey} />
      </ScrollView>
    </Animated.View>
  );

  // ── Layout ──
  return (
    <ToolbarProvider value={ctx}>
      {keyboardOpen ? (
        // Docked on the keyboard: instant swap BY DESIGN — animating it fights the OS
        // keyboard animation and timing differs iOS vs Android (see the animations spec).
        <View style={[styles.fullWrap, { backgroundColor: colors.bgPrimary, borderTopColor: colors.borderSubtle, paddingBottom: 6 }]}>
          {/* Must stay the FIRST child in every layout branch — the same tree position
              keeps the expansion panel mounted across form switches (no spurious
              re-entering). */}
          {expansion}
          <View style={[styles.fullRow, { flexDirection: visualRow(rtl) }]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              style={styles.fullScroll}
              ref={toolsScrollRef}
              contentContainerStyle={[styles.fullTools, { flexDirection: visualRow(rtl) }]}
            >
              {toolRow("dock-", [styles.toolsRowInner, { flexDirection: visualRow(rtl) }])}
            </ScrollView>
            {AskAI}
            {OutlineBtn}
            {TaskBtn}
          </View>
          {saving ? <PulsingDot color={colors.brandPrimary} /> : null}
          {cropModal}
          {taskSheet}
        </View>
      ) : (
        <View
          style={[
            styles.pillWrap,
            // Column form: strip and fly-out panel sit SIDE BY SIDE, and the panel must
            // open toward the screen's CENTRE or it lands off the edge — so the side is
            // the HOST's call (it knows where the strip was dragged to), not the
            // document's direction. `expansion` is the first child, so: "row" puts it
            // left of the strip, "row-reverse" right of it.
            // PHYSICAL, not visualRow(): the drag host forces `direction: "ltr"` on this
            // whole subtree (see FloatingPill's styles.host), so RN's RTL row mirroring
            // never reaches here and there is nothing to counter-flip.
            vertical && [styles.pillWrapV, { flexDirection: flyoutLeft ? "row" : "row-reverse" }],
          ]}
          pointerEvents="box-none"
        >
          {expansion}
          <Animated.View
            // Block→block selection handoff: skip entrance/exit so the pill MOVES to the
            // new block instead of hiding and reappearing.
            entering={isPillHandoff() ? undefined : pillIn}
            exiting={pillOutUnlessHandoff}
            layout={layoutSpring}
            style={
              vertical
                ? [styles.pillColumn, { backgroundColor: colors.bgPrimary, borderColor: colors.borderSubtle }]
                : full
                  ? [styles.fullCard, { backgroundColor: colors.bgPrimary, borderColor: colors.borderSubtle }]
                  : [styles.pill, { backgroundColor: colors.bgPrimary, borderColor: colors.borderSubtle, flexDirection: visualRow(rtl) }]
            }
          >
            {vertical ? (
              // Column form: ONE narrow strip for both the compact and full sets — they
              // differ only by which chips are in the scroller, so there's no pill⇄card
              // morph here. Top→bottom: leading control (collapse / close), the scrolling
              // tools, then the pinned ✦ Ask AI + Outline at the thumb end. No RTL flip:
              // a column reads top→bottom in every language.
              <>
                {full ? (
                  <ShellChip Icon={X} label={t("common.close", { defaultValue: "Close" })} onPress={() => useToolbarStore.getState().closeMore()} />
                ) : onCollapse ? (
                  <ShellChip Icon={ChevronsDownUp} label={t("blockBar.collapse", { defaultValue: "Collapse" })} onPress={onCollapse} />
                ) : null}
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="always"
                  style={styles.columnScroll}
                  ref={toolsScrollRef}
                  contentContainerStyle={styles.columnTools}
                >
                  {toolRow("col-", styles.columnTools)}
                </ScrollView>
                <View style={[styles.sepV, { backgroundColor: colors.borderSubtle }]} />
                {AskAI}
                {OutlineBtn}
                {TaskBtn}
              </>
            ) : full ? (
              <View style={[styles.fullRow, { flexDirection: visualRow(rtl) }]}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="always"
                  style={styles.fullScroll}
                  ref={toolsScrollRef}
                  contentContainerStyle={[styles.fullTools, { flexDirection: visualRow(rtl) }]}
                >
                  {toolRow("full-", [styles.toolsRowInner, { flexDirection: visualRow(rtl) }])}
                  {/* Static collapse control — outside the keyed row so toolset morphs
                      don't tear it down. */}
                  <ShellChip Icon={X} label={t("common.close", { defaultValue: "Close" })} onPress={() => useToolbarStore.getState().closeMore()} enterIndex={13} />
                </ScrollView>
                {AskAI}
                {OutlineBtn}
                {TaskBtn}
              </View>
            ) : (
              <>
                {onCollapse ? (
                  <ShellChip Icon={ChevronsDownUp} label={t("blockBar.collapse", { defaultValue: "Collapse" })} onPress={onCollapse} />
                ) : null}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="always"
                  style={styles.pillScroll}
                  ref={toolsScrollRef}
                  contentContainerStyle={[styles.pillToolsRow, { flexDirection: visualRow(rtl) }]}
                >
                  {toolRow("tools-", [styles.toolsRowInner, { flexDirection: visualRow(rtl) }])}
                </ScrollView>
                <View style={[styles.sep, { backgroundColor: colors.borderSubtle }]} />
                {AskAI}
                {OutlineBtn}
                {TaskBtn}
              </>
            )}
            {full && saving ? <PulsingDot color={colors.brandPrimary} /> : null}
          </Animated.View>
          {cropModal}
          {taskSheet}
        </View>
      )}
    </ToolbarProvider>
  );
}

/** The shell's own chips (collapse the pill / close the full card). Same chip look and
 *  press spring as a tool chip, but owned here: they're static controls that must
 *  survive a toolset morph, so they sit OUTSIDE the keyed tool row. Declared at module
 *  scope so its type is stable and it never remounts on a parent re-render. */
function ShellChip({
  Icon,
  label,
  onPress,
  enterIndex,
}: {
  Icon: typeof X;
  label: string;
  onPress: () => void;
  enterIndex?: number;
}) {
  const colors = useThemeColors();
  return (
    <AnimatedChip
      onPress={onPress}
      accessibilityLabel={label}
      enterIndex={enterIndex}
      style={[toolStyles.chip, { borderColor: colors.borderDefault, backgroundColor: colors.bgCard }]}
    >
      <Icon size={17} color={colors.textPrimary} strokeWidth={2} />
    </AnimatedChip>
  );
}

const styles = StyleSheet.create({
  // Floating pill (anchored under the block; tools scroll, ✦ Ask AI pinned so it never clips).
  pillWrap: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2, alignItems: "center" },
  // Column form: no side padding — the strip + panel fill the host exactly (its width
  // comes from onColumnWidth), and padding here would push them past the host bounds,
  // where Android drops their touches. Top-aligned so the panel's first option lines up
  // with the strip's first chip.
  pillWrapV: { paddingHorizontal: 0, alignItems: "flex-start", gap: VERTICAL_PANEL_GAP },
  pill: {
    alignSelf: "center",
    maxWidth: "100%",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  pillScroll: { flexShrink: 1 },
  pillToolsRow: { alignItems: "center", gap: 6 },

  // Vertical form: a one-chip-wide strip. Same surface language as `pill` (radius,
  // hairline border, shadow) — only the axis changes.
  pillColumn: {
    alignSelf: "center",
    width: VERTICAL_PILL_W,
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  // Capped so a long toolset (tables, images) scrolls inside the strip instead of
  // growing past the screen; flexShrink lets a short one hug its content.
  columnScroll: { flexShrink: 1, maxHeight: VERTICAL_TOOLS_MAX_H },
  columnTools: { alignItems: "center", gap: 6 },

  // Full-width docked bar (keyboard open) — sits flush on the keyboard.
  fullWrap: {
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 10,
  },
  // Expanded pill inline (keyboard closed) — the morph target of the compact pill.
  fullCard: {
    alignSelf: "stretch",
    marginTop: 2,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  fullRow: { alignItems: "center", gap: 8 },
  fullScroll: { flex: 1 },
  fullTools: { alignItems: "center", gap: 6, paddingHorizontal: 2 },
  // Keyed morphing tool row inside the ScrollViews (row styles live on the
  // contentContainerStyle; this only lays out the chips within the keyed view).
  toolsRowInner: { alignItems: "center", gap: 6 },

  shellChip: {
    width: CHIP,
    height: CHIP,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  sep: { width: StyleSheet.hairlineWidth, height: 22, marginHorizontal: 2 },
  sepV: { height: StyleSheet.hairlineWidth, width: 22, marginVertical: 2 },

  askBtn: {
    width: CHIP,
    height: CHIP,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: CHIP / 2,
  },
  // Pinned Outline button beside Ask AI — round to pair with it, but bordered/secondary
  // (not brand-filled) so ✦ Ask AI stays the primary action.
  pinnedChip: {
    width: CHIP,
    height: CHIP,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: CHIP / 2,
    borderWidth: 1,
  },

  // Category expansion panel
  expansion: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 6,
    marginBottom: 8,
    alignSelf: "stretch",
  },
  expansionRow: { alignItems: "center", gap: 6 },
  // Column form: the options fly out beside the strip (width set inline — one chip wide
  // for icon sets, a card's width for the header/footer panels) with its own scroll cap.
  // No bottom margin: the gap to the strip is horizontal here, from pillWrapV.
  expansionV: { alignSelf: "flex-start", marginBottom: 0 },
  expansionColumn: { alignItems: "center", gap: 6 },

  savingDot: { position: "absolute", top: 4, right: 8, width: 6, height: 6, borderRadius: 3 },
});
