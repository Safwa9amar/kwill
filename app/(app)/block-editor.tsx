import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Keyboard,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { Send, Square } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useBottomInset, useKeyboardLift } from "@/hooks/useBottomInset";
import { useChatStore } from "@/stores/chat-store";
import { useChatThreadsStore } from "@/stores/chat-threads-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { sendMessageToAI, stopTurn } from "@/lib/ai-service";
import { getThesisDocument } from "@/lib/api";
import { BackButton } from "@/components/BackButton";
import { visualTextAlign } from "@/lib/rtl-layout";

// RTL when right-to-left characters dominate (thesis content is often Arabic and
// the `language` field is unreliable, so we detect from the text itself).
function isRtl(text: string): boolean {
  const r = (text.match(/[؀-ۿ֐-׿]/g) ?? []).length;
  const l = (text.match(/[A-Za-z]/g) ?? []).length;
  return r > l;
}

/**
 * Focused editor for a single .docx paragraph, opened from the composer's
 * "Edit block" tool. Loads the selected block's text, lets the student edit it
 * manually (Save → editDocumentParagraph) and via the AI (scoped to the block
 * index), then returns to the workspace, which refreshes on focus.
 */
export default function BlockEditorScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { thesisId, blockIndex } = useLocalSearchParams<{
    thesisId: string;
    blockIndex: string;
  }>();
  const index = Number(blockIndex);

  const isGenerating = useChatStore((s) => s.isGenerating);

  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  // Room under the AI row for the phone's navigation — buttons, gesture pill or
  // nothing — and none of it while the keyboard covers it. The lift is what
  // keeps the row ABOVE the keyboard on Android, which never resizes the window
  // for the IME under edge-to-edge; on iOS the KAV below does that job.
  const rowInset = useBottomInset(8);
  const keyboardLift = useKeyboardLift();

  // Load the paragraph's current text. Prefer the doc store (already loaded by the
  // workspace) so the editor opens instantly with no fetch; fall back to the server
  // only if the store has nothing cached for this thesis.
  const load = useCallback(async () => {
    if (!thesisId || !Number.isFinite(index)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const cached = useThesisDocStore.getState().byId[thesisId];
    if (cached?.available) {
      const block = cached.blocks.find((b) => b.index === index);
      if (block && block.kind === "paragraph") {
        setText(block.text);
        setLoading(false);
        return;
      }
    }
    try {
      const doc = await getThesisDocument(thesisId);
      if (!doc.available) {
        setNotFound(true);
        return;
      }
      const block = doc.blocks.find((b) => b.index === index);
      if (block && block.kind === "paragraph") setText(block.text);
      else setNotFound(true);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [thesisId, index]);

  useEffect(() => {
    void load();
  }, [load]);

  // After an AI turn finishes (generating true → false), reload so the AI's
  // edit to this paragraph appears in the editor.
  const prevGen = useRef(isGenerating);
  useEffect(() => {
    if (prevGen.current && !isGenerating) void load();
    prevGen.current = isGenerating;
  }, [isGenerating, load]);

  const rtl = isRtl(text);

  // Optimistic + durable save: the edited text applies to the doc store instantly
  // and returns to the workspace — the op is persisted and flushes in the
  // background (retrying offline, surviving an app kill). A server rejection is
  // surfaced by the store centrally.
  const handleSave = () => {
    if (!thesisId || !Number.isFinite(index)) return;
    void useThesisDocStore.getState().mutate(thesisId, { type: "editText", index, text });
    router.back();
  };

  const handleAskAi = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || isGenerating || !thesisId) return;
    Keyboard.dismiss();
    // Persist the current manual text first (through the store, so the workspace
    // reflects it) so the AI edits on top of it and the post-turn reload doesn't
    // discard unsaved changes. The composing gate may be holding the queue, so
    // force a flush alongside the mutate — awaiting the bare mutate would
    // deadlock (its promise only resolves when the server confirms the op).
    try {
      const store = useThesisDocStore.getState();
      const saved = store.mutate(thesisId, { type: "editText", index, text });
      void store.flushOps(thesisId);
      await saved;
    } catch {
      Alert.alert(t("blockEditor.saveError", { defaultValue: "Couldn't save. Please try again." }));
      return;
    }
    setAiPrompt("");
    const threadId = await useChatThreadsStore.getState().ensureThreadFor(thesisId);
    await sendMessageToAI(threadId, thesisId, prompt, { docBlockIndex: index });
  };

  const hasAiText = aiPrompt.trim().length > 0;
  const saveDisabled = loading || notFound;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgSurface }]} edges={[]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 14, borderBottomColor: colors.borderDefault }]}>
        <BackButton />
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          {t("blockEditor.title", { defaultValue: "Edit paragraph" })}
        </Text>
        <Pressable onPress={handleSave} disabled={saveDisabled} hitSlop={8} style={styles.saveBtn}>
          <Text style={[styles.saveText, { color: colors.brandPrimary, opacity: saveDisabled ? 0.4 : 1 }]}>
            {t("blockEditor.save", { defaultValue: "Save" })}
          </Text>
        </Pressable>
      </View>

      {/* iOS only — Android lifts the AI row by the measured IME height instead.
          Same split as chat.tsx, where the reasoning is written out. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brandPrimary} />
          </View>
        ) : notFound ? (
          <View style={styles.centered}>
            <Text style={[styles.notFound, { color: colors.textSecondary }]}>
              {t("blockEditor.notFound", { defaultValue: "This paragraph is no longer available." })}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.editorWrap}>
              <TextInput
                style={[
                  styles.editor,
                  {
                    color: colors.textPrimary,
                    backgroundColor: colors.bgCard,
                    borderColor: colors.borderDefault,
                    textAlign: visualTextAlign(rtl),
                    writingDirection: rtl ? "rtl" : "ltr",
                  },
                ]}
                value={text}
                onChangeText={setText}
                multiline
                editable={!isGenerating}
                textAlignVertical="top"
                placeholder={t("blockEditor.empty", { defaultValue: "Paragraph text…" })}
                placeholderTextColor={colors.textPlaceholder}
              />
            </View>

            {/* AI assist row */}
            <View
              style={[
                styles.aiRow,
                {
                  paddingBottom: rowInset + keyboardLift,
                  borderTopColor: colors.borderDefault,
                  backgroundColor: colors.bgPrimary,
                },
              ]}
            >
              <View style={[styles.aiInputWrap, { backgroundColor: colors.bgInput }]}>
                <TextInput
                  style={[styles.aiInput, { color: colors.textPrimary }]}
                  value={aiPrompt}
                  onChangeText={setAiPrompt}
                  editable={!isGenerating}
                  multiline
                  maxLength={2000}
                  placeholder={t("blockEditor.aiPlaceholder", {
                    defaultValue: "Ask Kwill to edit this paragraph…",
                  })}
                  placeholderTextColor={colors.textPlaceholder}
                />
                {isGenerating ? (
                  <Pressable
                    onPress={stopTurn}
                    accessibilityRole="button"
                    accessibilityLabel={t("chat.stop", { defaultValue: "Stop" })}
                    style={[styles.aiBtn, { backgroundColor: colors.semanticError }]}
                  >
                    <Square size={13} color="#FFFFFF" fill="#FFFFFF" />
                  </Pressable>
                ) : hasAiText ? (
                  <Pressable
                    onPress={handleAskAi}
                    accessibilityRole="button"
                    accessibilityLabel={t("chat.send", { defaultValue: "Send" })}
                    style={[styles.aiBtn, { backgroundColor: colors.brandPrimary }]}
                  >
                    <Send size={16} color={colors.brandOnPrimary} strokeWidth={2} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 18, fontFamily: "Inter_700Bold", textAlign: "center" },
  saveBtn: { minWidth: 48, alignItems: "flex-end", justifyContent: "center" },
  saveText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  notFound: { fontSize: 15, fontFamily: "Inter_500Medium", textAlign: "center", lineHeight: 22 },
  editorWrap: { flex: 1, padding: 16 },
  editor: {
    flex: 1,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    fontSize: 16,
    lineHeight: 26,
    fontFamily: "Inter_400Regular",
  },
  aiRow: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  aiInputWrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 22,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 6,
  },
  aiInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", maxHeight: 100, paddingVertical: 4 },
  aiBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
