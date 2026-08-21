import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, Alert, Keyboard, Platform, Text, Pressable } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import GorhomBottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  Paperclip,
  ListTree,
  Download,
  RotateCcw,
  Brain,
  SquarePen,
  Trash2,
  FileStack,
  X,
  Undo2,
} from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useChatStore } from "@/stores/chat-store";
import { useChatThreadsStore } from "@/stores/chat-threads-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { sendMessageToAI, regenerateLastResponse, approvePendingAction, declinePendingAction } from "@/lib/ai-service";
import { type DocBlockDTO, restoreThesisHistory } from "@/lib/api";
import { ComposerThinking } from "./ComposerThinking";
import { deriveThinkingMs } from "@/lib/thinking";
import { ComposerInput } from "./ComposerInput";
import { ComposerQuickActions } from "./ComposerQuickActions";
import { useComposerSuggestions } from "@/hooks/useComposerSuggestions";
import { ComposerToolsTray, type ToolItem } from "./ComposerToolsTray";
import { ComposerAsk } from "./ComposerAsk";
import { ComposerConfirm } from "./ComposerConfirm";
import { ComposerModeToggle } from "./ComposerModeToggle";
import { ComposerEditTools } from "./ComposerEditTools";
import { ComposerRibbon } from "./ribbon/ComposerRibbon";
import { ChatModeChip } from "@/components/chat/ChatModeChip";
import { ChatModeSheet } from "@/components/chat/ChatModeSheet";
import { DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/chat-modes";
import { visualRow } from "@/lib/rtl-layout";

/** Height of the collapsed peek (the doc area pads its bottom by this). */
export const COMPOSER_COLLAPSED_HEIGHT = 250;
/** Expanded snap point as a fraction of the container height. Shared with the
 *  workspace screen so the document's bottom spacing tracks the sheet height. */
export const COMPOSER_EXPANDED_FRACTION = 0.62;
/** gorhom's default handle above the content (4px indicator + 2×10px padding);
 *  the keyboard-docked position must include it so the content clears the keyboard. */
const SHEET_HANDLE_HEIGHT = 24;

interface Props {
  thesisId: string;
  isLiveDoc: boolean;
  rtl: boolean;
  /** gorhom writes the sheet's live top-edge Y here so the document area can
   *  reserve exactly the height the sheet covers, at any position. */
  animatedPosition?: SharedValue<number>;
  /** Live-.docx block model (empty for legacy docs) — powers the Edit-mode tools. */
  blocks: DocBlockDTO[];
  /** Live-doc only; undefined disables the Export tool. */
  downloadUrl?: string;
  /** Underlying document id (live-doc only); undefined disables Edit block. */
  documentId?: string;
  onOpenSources: () => void;
  onOpenOutline: () => void;
  onExport: () => void;
  /** Called after a bulk block edit (delete / start-on-new-page) rewrites the .docx. */
  onAfterBulkEdit: () => void;
}

export function WorkspaceComposerSheet({
  thesisId,
  isLiveDoc,
  rtl,
  animatedPosition,
  blocks,
  downloadUrl,
  documentId,
  onOpenSources,
  onOpenOutline,
  onExport,
  onAfterBulkEdit,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const sheetRef = useRef<React.ComponentRef<typeof GorhomBottomSheet>>(null);

  // Select primitives / the stored array individually (object/array literals
  // built INSIDE a selector loop the render; `selectedBlocks` is a stored ref).
  const selectedBlocks = useWorkspaceStore((s) => s.selectedBlocks);
  const multiSelect = useWorkspaceStore((s) => s.multiSelect);
  const thinkingEnabled = useWorkspaceStore((s) => s.thinkingEnabled);
  const composerMode = useWorkspaceStore((s) => s.composerMode);
  const composerOpen = useWorkspaceStore((s) => s.composerOpen);
  const inlineEditing = useWorkspaceStore((s) => s.inlineEditing);

  // Derived selection in document order: indices to act on, and the combined text
  // of the selected blocks (used as the AI focus and the chip preview).
  const ordered = useMemo(
    () => [...selectedBlocks].sort((a, b) => a.index - b.index),
    [selectedBlocks],
  );
  const indices = useMemo(() => ordered.map((b) => b.index), [ordered]);
  const combinedSelection = useMemo(() => {
    const parts = ordered.map((b) => b.text).filter((t) => t && t.trim());
    if (!parts.length) return undefined;
    // Cap before it leaves the device: the server's prompt truncates anyway, so a
    // big multi-selection shouldn't waste bandwidth on every request.
    const joined = parts.join("\n\n");
    return joined.length > 6000 ? joined.slice(0, 6000) + "…" : joined;
  }, [ordered]);
  const count = selectedBlocks.length;

  // Edit mode's formatting tools act on the selected PARAGRAPH blocks (one or many).
  // Resolve them from the doc model in document order, dropping non-paragraph
  // selections (tables/images) so a style tap never targets them. [] → the hint.
  const editSelection = useMemo(() => {
    if (!ordered.length) return [] as Extract<DocBlockDTO, { kind: "paragraph" }>[];
    const byIndex = new Map(blocks.map((b) => [b.index, b]));
    return ordered
      .map((s) => byIndex.get(s.index))
      .filter((b): b is Extract<DocBlockDTO, { kind: "paragraph" }> => !!b && b.kind === "paragraph");
  }, [ordered, blocks]);

  // Selection payload for the ribbon dispatcher: index + text + heading level.
  const ribbonSelection = useMemo(
    () =>
      ordered.map((b) => {
        const doc = blocks.find((x) => x.index === b.index);
        const level = doc && doc.kind === "paragraph" ? doc.level ?? 0 : 0;
        return { index: b.index, text: b.text, level };
      }),
    [ordered, blocks],
  );

  // The conversation this thesis is currently in — resolved once (per thesis) via
  // ensureThreadFor. The message store, the AI turn runners and the API calls key
  // off THIS, never `thesisId` — that stays reserved for the outline sync and the
  // undo checkpoint (docChanges below), which are per-document, not per-thread.
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    useChatThreadsStore
      .getState()
      .ensureThreadFor(thesisId)
      .then((id) => {
        if (!cancelled) setThreadId(id);
      });
    return () => {
      cancelled = true;
    };
  }, [thesisId]);
  // Resolves the thread for a send, reusing the mount-resolved id when it's
  // already there rather than re-awaiting ensureThreadFor's (cheap, but not
  // free) cache check on every keystroke's send.
  const resolveThreadId = useCallback(async () => {
    if (threadId) return threadId;
    const id = await useChatThreadsStore.getState().ensureThreadFor(thesisId);
    setThreadId(id);
    return id;
  }, [threadId, thesisId]);

  // ——— The conversation's mode (Ask / Plan / Assist / Agent) ———
  // A different axis from `composerMode` (AI ⇄ Edit) above, which picks which
  // composer you are looking at. This one picks how the assistant works, and it
  // belongs to the THREAD — so it is read from the threads store, as a PRIMITIVE
  // (a selector returning a fresh object literal loops the render).
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  // Held here only until `threadId` resolves — see chat.tsx for the same seam.
  const [draftMode, setDraftMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);
  const storedMode = useChatThreadsStore((s) => (threadId ? s.modes[threadId] : undefined));
  const chatMode: ChatMode = threadId ? storedMode ?? DEFAULT_CHAT_MODE : draftMode;
  const pickMode = (m: ChatMode) => {
    setDraftMode(m);
    if (threadId) useChatThreadsStore.getState().setMode(threadId, m);
  };

  const isGenerating = useChatStore((s) => s.isGenerating);
  const generatingPhase = useChatStore((s) => s.generatingPhase);
  const pendingAsk = useChatStore((s) => s.pendingAsk);
  const pendingConfirm = useChatStore((s) => s.pendingConfirm);
  const aiDocChanges = useChatStore((s) => s.docChanges[thesisId] ?? null);
  // Reasoning to surface: the live streaming message once tokens arrive, else the
  // most recent assistant message that produced reasoning (kept reviewable until
  // the next turn). During a new turn's pre-stream gap (generating, but no stream
  // yet) show nothing rather than the PREVIOUS turn's reasoning. Both selectors
  // return primitives so the composer re-renders only when the value changes (no
  // fresh-object selector loop).
  const thinking = useChatStore((s) => {
    const list = s.messages[threadId ?? ""];
    if (!list) return "";
    if (s.streamingId) return list.find((m) => m.id === s.streamingId)?.thinking ?? "";
    if (s.isGenerating) return ""; // new turn starting → don't fall back to the last turn
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "assistant" && list[i].thinking) return list[i].thinking ?? "";
    }
    return "";
  });
  const thinkingMs = useChatStore((s) => {
    const list = s.messages[threadId ?? ""];
    if (!list) return undefined;
    let msg: (typeof list)[number] | undefined;
    if (s.streamingId) {
      msg = list.find((m) => m.id === s.streamingId);
    } else if (s.isGenerating) {
      return undefined; // pre-stream gap of a new turn
    } else {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "assistant" && list[i].thinking) {
          msg = list[i];
          break;
        }
      }
    }
    return msg ? deriveThinkingMs(msg) : undefined;
  });

  const [inputText, setInputText] = useState("");

  // ——— Keyboard docking ———
  // Keyboard CLEARANCE is owned by the workspace screen's KeyboardAvoidingView:
  // it shrinks the sheet's whole container above the keyboard, so the container
  // bottom is always the keyboard's top edge. This sheet only handles the
  // COMPACT presentation: while one of its own inputs has the keyboard up,
  // everything except that input surface is hidden and the detents collapse to
  // [handle + compact content], docking the input right on the keyboard.
  // gorhom's own keyboard handling is deliberately inert (it would fight this):
  // none of the composer's inputs are registered BottomSheetTextInputs (gorhom
  // ignores keyboard events from unregistered inputs) and keyboardBlurBehavior
  // is "none".
  const inputFocused = useWorkspaceStore((s) => s.composerInputFocused);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // Sheet content height from onLayout. Reset on the keyboard's FIRST show event
  // so the docking waits for the COMPACT layout pass instead of docking at the
  // stale full-composer height. Follow-up show events (keyboard height changes,
  // emoji panel) keep the measured compact height so re-docking works.
  const [contentHeight, setContentHeight] = useState(0);
  const keyboardVisibleRef = useRef(false);
  const docked = keyboardVisible && inputFocused;

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => {
        if (!keyboardVisibleRef.current) setContentHeight(0);
        keyboardVisibleRef.current = true;
        setKeyboardVisible(true);
      },
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => {
        keyboardVisibleRef.current = false;
        setKeyboardVisible(false);
      },
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const markInputFocused = useCallback(
    () => useWorkspaceStore.getState().setComposerInputFocused(true),
    [],
  );
  const markInputBlurred = useCallback(
    () => useWorkspaceStore.getState().setComposerInputFocused(false),
    [],
  );

  // AI-generated quick-action chips — only while the AI-mode composer is showing
  // them (open, not in Edit mode, and not while an ask sheet is open). Falls back to
  // the static presets whenever the list is empty (offline / fresh thesis / failure).
  const { suggestions } = useComposerSuggestions(thesisId, {
    enabled: composerOpen && composerMode === "ai" && !pendingAsk,
    selectedBlocks,
    threadId,
  });

  // The sheet's detents. While docked, detent 0 becomes [handle + compact
  // content] — the input sitting right on the keyboard, whose top edge IS the
  // container bottom thanks to the screen's KeyboardAvoidingView. The dock must
  // be a real detent (a raw snapToPosition records nextIndex -1 — "closed" — and
  // the completion callbacks made the accidental-close guard yank the sheet
  // back behind the keyboard). Detent 1 stays the expanded point in BOTH lists
  // so the list NEVER changes length: gorhom keeps its detents in a UI-thread
  // derived value that lags this prop by a frame, and a snapToIndex(1) issued in
  // the same commit the list shrank to one entry throws the out-of-range
  // invariant (crashed on send: blur → undock → expand-while-generating snap).
  const snapPoints = useMemo(() => {
    const expanded = `${COMPOSER_EXPANDED_FRACTION * 100}%`;
    if (docked && contentHeight > 0) {
      return [SHEET_HANDLE_HEIGHT + contentHeight, expanded];
    }
    return [COMPOSER_COLLAPSED_HEIGHT, expanded];
  }, [docked, contentHeight]);

  // AI activity forces the composer visible so its progress/question is seen even
  // if the user had closed the sheet via the header toggle.
  useEffect(() => {
    if (isGenerating || pendingAsk) useWorkspaceStore.getState().setComposerOpen(true);
  }, [isGenerating, pendingAsk]);

  // Single source of truth for the sheet's detent: closed when toggled off;
  // otherwise expanded while the AI works / asks, and collapsed to the peek when
  // idle so the updated document is visible again. Driving it off `composerOpen`
  // (not just the generation flags) means a view-mode switch can't strand it.
  // While docked the keyboard effect below owns the position; when docking ends
  // this re-runs (docked is a dep) and restores the proper detent.
  useEffect(() => {
    if (inlineEditing) {
      // A paragraph is being inline-edited — get the sheet out of the editor's way.
      sheetRef.current?.close();
    } else if (!composerOpen) {
      sheetRef.current?.close();
    } else if (docked) {
      return;
    } else if (isGenerating || pendingAsk) {
      sheetRef.current?.snapToIndex(1);
    } else {
      sheetRef.current?.snapToIndex(0);
    }
  }, [composerOpen, isGenerating, pendingAsk, docked, inlineEditing]);

  // Keyboard docking: detent 0 above becomes the docked position; gorhom's
  // snap-point-change reaction animates onto it by itself when the sheet was at
  // index 0. The explicit snap covers docking that starts from index 1
  // (expanded, e.g. answering an ask) — the reaction would keep the sheet at the
  // unchanged detent 1. Re-runs when the compact content resizes (multiline
  // growth) to keep the input hugging the keyboard.
  useEffect(() => {
    if (!docked || contentHeight === 0) return;
    sheetRef.current?.snapToIndex(0);
  }, [docked, contentHeight]);

  // A legacy (non-live) doc has no editable blocks — never let it get stuck in
  // Edit mode (the toggle is hidden there, so the user couldn't switch back).
  useEffect(() => {
    if (!isLiveDoc && composerMode === "edit") useWorkspaceStore.getState().setComposerMode("ai");
  }, [isLiveDoc, composerMode]);

  // Focus chip: one tapped block, a multi-selection count, or the whole memoir.
  const hasSelection = count > 0;
  const firstText = selectedBlocks[0]?.text?.replace(/\s+/g, " ").trim() ?? "";
  let chipLabel = t("workspace.wholeMemoir", { defaultValue: "Whole memoir" });
  if (count === 1) {
    chipLabel = `✎ ${firstText ? firstText.slice(0, 40) : t("workspace.selectedBlock", { defaultValue: "Selected section" })}`;
  } else if (count > 1) {
    chipLabel = `✎ ${t("workspace.nSelected", { count, defaultValue: `${count} selected` })}`;
  }

  // The AI focus payload for the current selection: combined text + every index
  // (and a single index for back-compat). Empty when nothing is selected.
  const focusOpts = {
    selection: combinedSelection,
    docBlockIndex: indices.length ? indices[0] : null,
    docBlockIndices: indices.length > 1 ? indices : undefined,
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isGenerating) return;
    setInputText("");
    Keyboard.dismiss();
    const tid = await resolveThreadId();
    // The thread may have only just resolved, so commit whatever was picked while
    // there was none to key it on before the turn that carries it opens.
    useChatThreadsStore.getState().setMode(tid, chatMode);
    await sendMessageToAI(tid, thesisId, text, { ...focusOpts, mode: chatMode });
  };

  const handleAnswer = async (answer: string) => {
    useChatStore.getState().setPendingAsk(null);
    const tid = await resolveThreadId();
    void sendMessageToAI(tid, thesisId, answer, focusOpts);
  };

  // The user always has the right to walk away from a question unanswered —
  // the ask lives only in memory, so clearing it is the whole dismissal.
  const handleDismissAsk = () => {
    useChatStore.getState().setPendingAsk(null);
  };

  // Approve / decline a gated destructive AI action. These call dedicated
  // endpoints (NOT a chat message) that run — or discard — the server-stored args.
  const handleApprove = async () => {
    if (!pendingConfirm) return;
    const tid = await resolveThreadId();
    void approvePendingAction(tid, thesisId, pendingConfirm.actionId);
  };
  const handleDecline = async () => {
    if (!pendingConfirm) return;
    const tid = await resolveThreadId();
    void declinePendingAction(tid, thesisId, pendingConfirm.actionId);
  };
  const handleRegenerate = async () => {
    const tid = await resolveThreadId();
    void regenerateLastResponse(tid, thesisId);
  };

  // One-tap revert of everything the last AI turn changed (its checkpoint snapshot).
  const handleUndoAiChanges = () => {
    if (!aiDocChanges) return;
    useChatStore.getState().setDocChanges(thesisId, null);
    void restoreThesisHistory(thesisId, aiDocChanges.checkpointSeq)
      .then((res) =>
        useThesisDocStore.getState().applyRestoredDoc(thesisId, res.document, { canUndo: res.canUndo, canRedo: res.canRedo }),
      )
      .catch(() => useChatStore.getState().setDocChanges(thesisId, aiDocChanges)); // restore the chip on failure
  };

  // AI-bridge target: fill the composer input with the instruction and switch to AI
  // mode + expand, matching the quick-action "fill, don't send" behavior.
  const handleRibbonAiAction = (instruction: string) => {
    useWorkspaceStore.getState().setComposerMode("ai");
    setInputText(instruction);
    useWorkspaceStore.getState().setComposerOpen(true);
    sheetRef.current?.snapToIndex(1);
  };

  // Bulk actions on the multi-selection. Delete is destructive → confirm first.
  // Both go through the durable op queue: the blocks update instantly (optimistic),
  // the op is persisted and flushed in the background, and the store reconciles /
  // surfaces a rejection centrally — no spinner, no wait.
  const handleBulkDelete = () => {
    if (!indices.length) return;
    Alert.alert(
      t("workspace.deleteSelectedTitle", { defaultValue: "Delete selected blocks?" }),
      t("workspace.deleteSelectedBody", { count, defaultValue: `Remove ${count} block(s) from the document? You can undo this from History.` }),
      [
        { text: t("common.cancel", { defaultValue: "Cancel" }), style: "cancel" },
        {
          text: t("common.delete", { defaultValue: "Delete" }),
          style: "destructive",
          onPress: () => {
            void useThesisDocStore.getState().mutate(thesisId, { type: "deleteBlocks", indices });
            useWorkspaceStore.getState().clearSelection();
          },
        },
      ],
    );
  };

  const handleBulkNewPage = () => {
    if (!indices.length) return;
    void useThesisDocStore.getState().mutate(thesisId, { type: "startOnNewPage", indices });
    useWorkspaceStore.getState().clearSelection();
  };

  const tools: ToolItem[] = [
    { key: "sources", label: t("composer.tools.sources"), icon: Paperclip, onPress: onOpenSources },
    { key: "outline", label: t("composer.tools.outline"), icon: ListTree, onPress: onOpenOutline },
    { key: "export", label: t("composer.tools.export"), icon: Download, onPress: onExport, disabled: !downloadUrl },
    { key: "regenerate", label: t("composer.tools.regenerate"), icon: RotateCcw, onPress: () => void handleRegenerate(), disabled: isGenerating },
    { key: "thinking", label: t("composer.tools.thinking"), icon: Brain, active: thinkingEnabled, onPress: () => useWorkspaceStore.getState().setThinkingEnabled(!thinkingEnabled) },
    {
      key: "editBlock",
      label: t("composer.tools.editBlock"),
      icon: SquarePen,
      // Single-block editor — only meaningful when exactly one block is selected.
      disabled: !documentId || count !== 1,
      onPress: () => {
        if (documentId && count === 1) {
          router.push({
            pathname: "/(app)/block-editor",
            params: { thesisId, blockIndex: String(selectedBlocks[0].index) },
          });
        }
      },
    },
  ];

  return (
    <>
    <GorhomBottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      // MUST stay false (gorhom defaults it to true): dynamic sizing injects an
      // extra content-height detent and re-sorts the detent list on every content
      // change. Going compact for keyboard docking would then shrink that detent
      // to ~120px and gorhom's snap-point-change reaction would re-target the
      // sheet onto it — dropping the whole composer behind the keyboard. It also
      // silently shifts what snapToIndex(0/1) means.
      enableDynamicSizing={false}
      animatedPosition={animatedPosition}
      enablePanDownToClose={false}
      onChange={(index) => {
        // Guard against gorhom snapping the sheet shut on a layout re-measure
        // (happens when the sibling view swaps on a view-mode change). If it
        // collapsed to closed while we still intend it open, restore the peek.
        // An intentional toggle-close sets composerOpen=false FIRST, so this
        // won't fight it.
        if (
          index === -1 &&
          useWorkspaceStore.getState().composerOpen &&
          !useWorkspaceStore.getState().inlineEditing
        ) {
          requestAnimationFrame(() => sheetRef.current?.snapToIndex(0));
        }
      }}
      // Keyboard handling is manual (see the docking effect above): gorhom's show
      // reaction only fires for registered BottomSheetTextInputs (the composer
      // deliberately has none) and blur restore is off — otherwise both would
      // fight the docked position.
      keyboardBlurBehavior="none"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{ backgroundColor: colors.bgPrimary }}
      handleIndicatorStyle={{ backgroundColor: colors.textPlaceholder }}
      style={styles.sheetShadow}
    >
      <BottomSheetView>
        {/* Measured for keyboard docking: while docked only the active input
            surface stays visible, and the sheet is positioned so exactly this
            content (plus the handle) shows above the keyboard. The padding lives
            on this View so the measurement includes it. */}
        <View
          style={styles.content}
          onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}
        >
        {/* Focus chip */}
        {!docked && (
        <View style={[styles.chipRow, { flexDirection: visualRow(rtl) }]}>
          <View style={[styles.chip, { backgroundColor: colors.brandPrimaryLight + "22" }]}>
            <Text style={[styles.chipText, { color: colors.brandPrimary }]} numberOfLines={1}>
              {chipLabel}
            </Text>
            {hasSelection && (
              <Pressable
                onPress={() => useWorkspaceStore.getState().clearSelection()}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t("common.clear", { defaultValue: "Clear" })}
              >
                <X size={13} color={colors.brandPrimary} strokeWidth={2.2} />
              </Pressable>
            )}
          </View>
        </View>
        )}

        {/* AI ⇄ Edit mode toggle — only meaningful on a live .docx — and BESIDE
            it, never inside it, the conversation's mode. The two are different
            questions: the toggle picks which composer this is, the chip picks
            how the assistant works. The chip shows on a legacy doc too, where
            the toggle has nothing to offer. */}
        {!docked && (
          <View style={[styles.modeRow, { flexDirection: visualRow(rtl) }]}>
            {isLiveDoc && (
              // The toggle carries its own marginBottom (it used to be the whole
              // row); cancel it here so the chip centres on the toggle rather
              // than on the toggle-plus-gap.
              <View style={styles.modeToggleWrap}>
                <ComposerModeToggle
                  mode={composerMode}
                  onChange={(m) => useWorkspaceStore.getState().setComposerMode(m)}
                  aiLabel={t("composer.modeAi", { defaultValue: "AI" })}
                  editLabel={t("composer.modeEdit", { defaultValue: "Edit" })}
                  rtl={rtl}
                />
              </View>
            )}
            <ChatModeChip
              mode={chatMode}
              onPress={() => setModeSheetOpen(true)}
              rtl={rtl}
              disabled={isGenerating}
            />
          </View>
        )}

        {/* Bulk actions — only while building a multi-selection on a live .docx. */}
        {!docked && isLiveDoc && multiSelect && count > 0 && (
          <View style={[styles.bulkRow, { flexDirection: visualRow(rtl) }]}>
            <Pressable
              onPress={handleBulkNewPage}
              style={[styles.bulkBtn, { borderColor: colors.borderDefault }]}
              accessibilityRole="button"
            >
              <FileStack size={15} color={colors.textPrimary} strokeWidth={2} />
              <Text style={[styles.bulkText, { color: colors.textPrimary }]} numberOfLines={1}>
                {t("workspace.startOnNewPage", { count, defaultValue: "New page" })}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleBulkDelete}
              style={[styles.bulkBtn, { borderColor: colors.semanticError + "55", backgroundColor: colors.semanticError + "12" }]}
              accessibilityRole="button"
            >
              <Trash2 size={15} color={colors.semanticError} strokeWidth={2} />
              <Text style={[styles.bulkText, { color: colors.semanticError }]} numberOfLines={1}>
                {t("workspace.deleteSelected", { count, defaultValue: `Delete ${count}` })}
              </Text>
            </Pressable>
          </View>
        )}

        {/* One-tap revert of everything the last AI turn changed to the doc. */}
        {!docked && aiDocChanges && !isGenerating && !pendingConfirm && (
          <Pressable
            onPress={handleUndoAiChanges}
            style={[
              styles.bulkBtn,
              { borderColor: colors.brandPrimary + "55", backgroundColor: colors.brandPrimary + "12", alignSelf: rtl ? "flex-end" : "flex-start" },
            ]}
            accessibilityRole="button"
          >
            <Undo2 size={15} color={colors.brandPrimary} strokeWidth={2} />
            <Text style={[styles.bulkText, { color: colors.brandPrimary }]} numberOfLines={1}>
              {t("workspace.undoAiChanges", { defaultValue: "Undo Kwill's changes" })}
            </Text>
          </Pressable>
        )}

        {pendingConfirm ? (
          /* A destructive AI action is waiting for approval — it replaces the
             input surface (Approve/Cancel), like the ask does. */
          <ComposerConfirm
            confirm={pendingConfirm}
            onApprove={handleApprove}
            onCancel={handleDecline}
            rtl={rtl}
          />
        ) : pendingAsk ? (
          /* The ask IS the input surface — it stays whole while docked (the
             student needs the question + options while typing an answer). */
          <ComposerAsk
            ask={pendingAsk}
            onAnswer={handleAnswer}
            onDismiss={handleDismissAsk}
            rtl={rtl}
            onInputFocus={markInputFocused}
            onInputBlur={markInputBlurred}
          />
        ) : (
          <>
            {composerMode === "edit" && isLiveDoc ? (
              <ComposerRibbon
                thesisId={thesisId}
                blocks={blocks}
                selection={ribbonSelection}
                onAfterEdit={onAfterBulkEdit}
                onAiAction={handleRibbonAiAction}
                homeSlot={
                  <ComposerEditTools
                    thesisId={thesisId}
                    selection={editSelection}
                    blockCount={blocks.length}
                    hint={t("composer.edit.selectHint", { defaultValue: "Select a paragraph to edit." })}
                    styleLabels={{ normal: t("composer.edit.normal", { defaultValue: "Normal" }) }}
                    rtl={rtl}
                  />
                }
              />
            ) : (
              <>
                {!docked && (
                  <>
                    <ComposerThinking
                      isGenerating={isGenerating}
                      reasoning={isGenerating && generatingPhase === "thinking"}
                      thinking={thinking}
                      durationMs={thinkingMs}
                      statusReady={t("composer.status.ready")}
                      rtl={rtl}
                    />
                    <View style={styles.inputSpacer} />
                  </>
                )}
                <ComposerInput
                  value={inputText}
                  onChangeText={setInputText}
                  onSend={handleSend}
                  onStop={() => useChatStore.getState().stopGenerating()}
                  onMicPress={() => Alert.alert(t("composer.voiceComingSoon"))}
                  onFocus={markInputFocused}
                  onBlur={markInputBlurred}
                  isGenerating={isGenerating}
                  placeholder={t("workspace.askPlaceholder", { defaultValue: "Ask Kwill to write or edit…" })}
                  sendLabel={t("chat.send", { defaultValue: "Send" })}
                  stopLabel={t("chat.stop", { defaultValue: "Stop" })}
                  micLabel={t("composer.micLabel", { defaultValue: "Voice input" })}
                />
                {!docked && (
                  <>
                    <View style={styles.quickActionsSpacer} />
                    <ComposerQuickActions
                      suggestions={suggestions}
                      onPreset={(prompt) => {
                        setInputText(prompt);
                        sheetRef.current?.snapToIndex(1);
                      }}
                    />
                  </>
                )}
              </>
            )}
            {!docked && <ComposerToolsTray label={t("composer.toolsLabel")} tools={tools} />}
          </>
        )}
        </View>
      </BottomSheetView>
    </GorhomBottomSheet>

      {/* The mode picker, a SIBLING of this sheet rather than a child of it: it
          is a gorhom modal of its own, and nesting one inside a BottomSheet puts
          it under that sheet's internal gesture context for no reason. Unmounted
          while closed (see ChatModeSheet) — a gorhom modal left mounted-but-
          hidden stops answering present(). */}
      <ChatModeSheet
        open={modeSheetOpen}
        mode={chatMode}
        rtl={rtl}
        onSelect={pickMode}
        onClose={() => setModeSheetOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  sheetShadow: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 12,
  },
  content: { paddingHorizontal: 14, paddingTop: 2, paddingBottom: 8 },
  chipRow: { marginBottom: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "85%",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 14,
  },
  chipText: { flexShrink: 1, fontSize: 12, fontFamily: "Inter_500Medium" },
  modeRow: { alignItems: "center", gap: 8, marginBottom: 8 },
  modeToggleWrap: { flex: 1, marginBottom: -8 },
  inputSpacer: { height: 8 },
  quickActionsSpacer: { height: 12 },
  bulkRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  bulkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  bulkText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
});
