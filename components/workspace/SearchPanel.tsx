import { useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { useTranslation } from "react-i18next";
import { Search, X, ChevronUp, ChevronDown, Replace, Sparkles } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { useSearchStore } from "@/stores/search-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { computeMatches, type SearchMatch } from "@/lib/search-match";
import { normalize } from "@/lib/text-normalize";
import { searchThesisSemantic, type DocBlockDTO } from "@/lib/api";
import { hSelection } from "@/lib/haptics";

/**
 * Top-pinned document search (find & replace + semantic), rendered directly
 * under the workspace header so it survives keyboard dismissal (the dock bar
 * doesn't). Exact matching is fully client-side over the in-memory blocks;
 * "Search by meaning" flushes the op queue (AI-turn rule: never query a stale
 * server doc) then hits GET /api/thesis/:id/search. Writer view only — the
 * openers close any docx/PDF preview, and opening a preview closes the panel.
 */
export function SearchPanel({ thesisId, blocks }: { thesisId: string; blocks: DocBlockDTO[] }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { flexDirection } = useRTL();

  const open = useSearchStore((s) => s.open);
  const query = useSearchStore((s) => s.query);
  const replaceOpen = useSearchStore((s) => s.replaceOpen);
  const replaceText = useSearchStore((s) => s.replaceText);
  const matchCount = useSearchStore((s) => s.matches.length);
  const capped = useSearchStore((s) => s.capped);
  const current = useSearchStore((s) => s.current);
  // Stable ref: the array element itself, not a fresh object.
  const cur = useSearchStore((s) => s.matches[s.current] ?? null);
  const semantic = useSearchStore((s) => s.semantic);
  const semanticLoading = useSearchStore((s) => s.semanticLoading);
  const semanticError = useSearchStore((s) => s.semanticError);
  const semanticIndexing = useSearchStore((s) => s.semanticIndexing);
  const previewMode = useWorkspaceStore((s) => s.previewMode);

  const inputRef = useRef<TextInput>(null);

  // Debounced recompute over the in-memory blocks. Also re-runs when the doc
  // mutates — every optimistic patch yields a fresh `blocks` array.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      const { matches, capped: c } = computeMatches(blocks, query);
      useSearchStore.getState().setMatches(matches, c);
    }, 150);
    return () => clearTimeout(id);
  }, [open, query, blocks]);

  // Focus the input on open (next frame — mount-commit focus can drop the
  // keyboard on heavy renders, same backstop pattern as DocBlock).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Writer-only v1: switching to a docx/PDF preview closes the panel.
  useEffect(() => {
    if (previewMode != null) useSearchStore.getState().close();
  }, [previewMode]);

  // Leaving the workspace unmounts the panel → drop all search state.
  useEffect(() => () => useSearchStore.getState().close(), []);

  if (!open) return null;

  const jumpTo = (i: number) => {
    const m = useSearchStore.getState().matches[i];
    if (!m) return;
    hSelection();
    useSearchStore.getState().setCurrent(i);
    useWorkspaceStore.getState().requestScrollToBlock(m.blockIndex);
  };
  const next = () => {
    const s = useSearchStore.getState();
    if (s.matches.length) jumpTo((s.current + 1) % s.matches.length);
  };
  const prev = () => {
    const s = useSearchStore.getState();
    if (s.matches.length) jumpTo((s.current - 1 + s.matches.length) % s.matches.length);
  };

  const curBlock = cur ? blocks.find((b) => b.index === cur.blockIndex) : undefined;
  const canReplace = curBlock?.kind === "paragraph";

  const replaceCurrent = () => {
    const s = useSearchStore.getState();
    const m = s.matches[s.current];
    if (!m || !curBlock || curBlock.kind !== "paragraph") return;
    // The span was computed against the last recomputed text. If the block
    // changed since (a prior replace's optimistic patch the 150ms debounce
    // hasn't re-matched yet), applying a stale span would corrupt the text —
    // bail until the recompute catches up.
    if (normalize(curBlock.text.slice(m.start, m.end)) !== normalize(query)) return;
    const text = curBlock.text.slice(0, m.start) + s.replaceText + curBlock.text.slice(m.end);
    void useThesisDocStore.getState().mutate(thesisId, { type: "editText", index: m.blockIndex, text });
    // Matches recompute from the fresh blocks; `current` stays put, so the
    // next hit slides into the same slot.
  };

  const replaceAll = () => {
    const s = useSearchStore.getState();
    // Recompute matches from the SAME blocks array we splice into. The store's
    // matchesByBlock can lag a generation behind the prop after a prior replace's
    // optimistic patch (the 150ms debounce hasn't re-matched yet); splicing those
    // stale spans into the fresh text would corrupt it. Regrouping here keeps
    // spans and text on the same generation.
    const { matches } = computeMatches(blocks, s.query);
    const byBlock: Record<number, SearchMatch[]> = {};
    for (const m of matches) (byBlock[m.blockIndex] ??= []).push(m);
    let replaced = 0;
    let blocksTouched = 0;
    let skipped = 0;
    for (const [indexStr, ms] of Object.entries(byBlock)) {
      const index = Number(indexStr);
      const block = blocks.find((b) => b.index === index);
      if (!block || block.kind !== "paragraph") {
        skipped += ms.length;
        continue;
      }
      // Splice right-to-left so earlier spans stay valid.
      let text = block.text;
      for (const m of [...ms].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, m.start) + s.replaceText + text.slice(m.end);
      }
      void useThesisDocStore.getState().mutate(thesisId, { type: "editText", index, text });
      blocksTouched += 1;
      replaced += ms.length;
    }
    Alert.alert(
      t("workspace.replaceDoneTitle", { defaultValue: "Replace all" }),
      t("workspace.replaceDone", {
        n: replaced,
        blocks: blocksTouched,
        defaultValue: "Replaced {{n}} in {{blocks}} paragraphs",
      }) +
        (skipped > 0
          ? "\n" +
            t("workspace.replaceSkipped", {
              n: skipped,
              defaultValue: "{{n}} non-editable hits skipped",
            })
          : ""),
    );
  };

  const runSemantic = async () => {
    const store = useSearchStore.getState();
    const q = store.query.trim();
    if (q.length < 2 || store.semanticLoading) return;
    store.semanticStart();
    try {
      // Composing holds edits on-device — drain the queue before querying the
      // server doc (same contract as AI turns).
      await useThesisDocStore.getState().flushOps(thesisId, { timeoutMs: 15_000 });
      const res = await searchThesisSemantic(thesisId, q);
      const s2 = useSearchStore.getState();
      // Superseded (query changed) or panel closed while in flight → drop the
      // result and release the loading flag so the button re-enables.
      if (!s2.open || s2.query.trim() !== q) {
        useSearchStore.setState({ semanticLoading: false });
        return;
      }
      s2.semanticDone(res.results, res.indexing ?? false);
    } catch (e) {
      console.warn("semantic search failed:", e);
      const s2 = useSearchStore.getState();
      if (!s2.open || s2.query.trim() !== q) {
        useSearchStore.setState({ semanticLoading: false });
        return;
      }
      s2.semanticFail();
    }
  };

  const jumpSemantic = (blockIndex: number) => {
    hSelection();
    const ws = useWorkspaceStore.getState();
    // Semantic hits have no text highlight — select the block so the landing
    // spot is visibly tinted (mirrors an outline tap).
    ws.selectBlock(blockIndex, null);
    ws.requestScrollToBlock(blockIndex);
  };

  const counter = `${matchCount === 0 ? 0 : current + 1}/${matchCount}${capped ? "+" : ""}`;
  const iconColor = (enabled: boolean) => (enabled ? colors.textPrimary : colors.textPlaceholder);

  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: colors.bgPrimary, borderBottomColor: colors.borderDefault },
      ]}
    >
      <View style={[styles.row, { flexDirection }]}>
        <Search size={16} color={colors.textPlaceholder} />
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={(v) => useSearchStore.getState().setQuery(v)}
          placeholder={t("workspace.searchPlaceholder", { defaultValue: "Find in document" })}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, { color: colors.textPrimary }]}
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={next}
        />
        <Text style={[styles.counter, { color: colors.textSecondary }]}>{counter}</Text>
        <Pressable
          onPress={prev}
          disabled={matchCount === 0}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.searchPrev", { defaultValue: "Previous match" })}
        >
          <ChevronUp size={18} color={iconColor(matchCount > 0)} />
        </Pressable>
        <Pressable
          onPress={next}
          disabled={matchCount === 0}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.searchNext", { defaultValue: "Next match" })}
        >
          <ChevronDown size={18} color={iconColor(matchCount > 0)} />
        </Pressable>
        <Pressable
          onPress={() => useSearchStore.getState().toggleReplace()}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.searchReplaceToggle", { defaultValue: "Find and replace" })}
        >
          <Replace size={16} color={replaceOpen ? colors.brandPrimary : colors.textPrimary} />
        </Pressable>
        <Pressable
          onPress={() => useSearchStore.getState().close()}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.searchClose", { defaultValue: "Close search" })}
        >
          <X size={18} color={colors.textPrimary} />
        </Pressable>
      </View>

      {replaceOpen && (
        <View style={[styles.row, { flexDirection }]}>
          <Replace size={16} color={colors.textPlaceholder} />
          <TextInput
            value={replaceText}
            onChangeText={(v) => useSearchStore.getState().setReplaceText(v)}
            placeholder={t("workspace.replacePlaceholder", { defaultValue: "Replace with" })}
            placeholderTextColor={colors.textPlaceholder}
            style={[styles.input, { color: colors.textPrimary }]}
            autoCorrect={false}
          />
          <Pressable
            onPress={replaceCurrent}
            disabled={!canReplace}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.replace", { defaultValue: "Replace" })}
            style={[
              styles.btn,
              { borderColor: colors.borderDefault, backgroundColor: colors.bgCard },
              !canReplace && styles.dim,
            ]}
          >
            <Text style={[styles.btnText, { color: colors.textPrimary }]}>
              {t("workspace.replace", { defaultValue: "Replace" })}
            </Text>
          </Pressable>
          <Pressable
            onPress={replaceAll}
            disabled={matchCount === 0}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.replaceAll", { defaultValue: "All" })}
            style={[
              styles.btn,
              { borderColor: colors.borderDefault, backgroundColor: colors.bgCard },
              matchCount === 0 && styles.dim,
            ]}
          >
            <Text style={[styles.btnText, { color: colors.textPrimary }]}>
              {t("workspace.replaceAll", { defaultValue: "All" })}
            </Text>
          </Pressable>
        </View>
      )}

      <Pressable
        onPress={() => void runSemantic()}
        disabled={semanticLoading || query.trim().length < 2}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.searchByMeaning", { defaultValue: "Search by meaning" })}
        style={[
          styles.meaningRow,
          { flexDirection, borderColor: colors.brandPrimary + "66" },
          query.trim().length < 2 && styles.dim,
        ]}
      >
        {semanticLoading ? (
          <ActivityIndicator size="small" color={colors.brandPrimary} />
        ) : (
          <Sparkles size={14} color={colors.brandPrimary} />
        )}
        <Text style={[styles.meaningText, { color: colors.brandPrimary }]}>
          {t("workspace.searchByMeaning", { defaultValue: "Search by meaning" })}
        </Text>
      </Pressable>

      {semanticError && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {t("workspace.searchMeaningError", {
            defaultValue: "Couldn't search — check your connection",
          })}
        </Text>
      )}
      {semantic != null && semantic.length === 0 && !semanticError && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {semanticIndexing
            ? t("workspace.searchIndexing", {
                defaultValue: "Preparing the search index — try again in a moment",
              })
            : t("workspace.searchMeaningEmpty", { defaultValue: "No related passages found" })}
        </Text>
      )}
      {semantic != null && semantic.length > 0 && (
        <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
          {semantic.map((h) => (
            <Pressable
              key={h.blockIndex}
              onPress={() => jumpSemantic(h.blockIndex)}
              accessibilityRole="button"
              style={[styles.resRow, { borderStartColor: colors.brandPrimary }]}
            >
              {h.headingPath ? (
                <Text
                  style={[styles.resPath, { color: colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {h.headingPath}
                </Text>
              ) : null}
              <Text style={[styles.resSnippet, { color: colors.textPrimary }]} numberOfLines={2}>
                {h.snippet}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  row: { alignItems: "center", gap: 8 },
  input: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular", paddingVertical: 4 },
  counter: { fontSize: 12, fontFamily: "Inter_600SemiBold", minWidth: 38, textAlign: "center" },
  btn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  btnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  dim: { opacity: 0.4 },
  meaningRow: {
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 8,
    paddingVertical: 6,
  },
  meaningText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  hint: { fontSize: 12, textAlign: "center", paddingVertical: 2 },
  results: { maxHeight: 220 },
  resRow: { borderStartWidth: 2, paddingHorizontal: 8, paddingVertical: 5, marginVertical: 2 },
  resPath: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  resSnippet: { fontSize: 13, fontFamily: "Inter_400Regular" },
});
