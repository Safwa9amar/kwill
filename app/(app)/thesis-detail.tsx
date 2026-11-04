import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useThesisStore } from "@/stores/thesis-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { getThesis, getThesisOutline, type OutlineDTO } from "@/lib/api";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";
import { listRescueProjects } from "@/lib/rescue-v2-api";
import { spineColorForIndex } from "@/lib/thesis-book";
import { BackButton } from "@/components/BackButton";
import { ThesisBookCover } from "@/components/thesis/ThesisBookCover";
import { ThesisStatStrip } from "@/components/thesis/ThesisStatStrip";
import { SectionRow } from "@/components/thesis/SectionRow";
import { ThesisActionBar } from "@/components/thesis/ThesisActionBar";
import { ThesisHeaderMenu } from "@/components/thesis/ThesisHeaderMenu";
import { ThesisDetailSkeleton } from "@/components/skeletons/ThesisDetailSkeleton";
import type { Thesis, ThesisStatus } from "@/types/thesis";

// getThesis() returns the thesis row (no structure — that lives in the .docx).
function normalize(raw: any): Thesis {
  return {
    id: raw.id,
    title: raw.title,
    templateId: raw.templateId ?? undefined,
    language: raw.language ?? "fr",
    status: (raw.status ?? "active") as ThesisStatus,
    progress: raw.progress ?? 0,
    wordCount: raw.wordCount ?? 0,
    pageCount: raw.pageCount ?? 0,
    frontMatter: raw.frontMatter ?? undefined,
    resume: raw.resume ?? undefined,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

export default function ThesisDetailScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const { thesisId } = useLocalSearchParams<{ thesisId: string }>();

  const [thesis, setThesis] = useState<Thesis | null>(null);
  const [outline, setOutline] = useState<OutlineDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // The thesis' rescue project, when it has one (the History row). A failed lookup leaves the row out: nothing else on this screen waits on it.
  const [rescueProjectId, setRescueProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!RESCUE_V2_ENABLED || !thesisId) return;
    let alive = true;
    listRescueProjects().then(
      (r) => { if (alive) setRescueProjectId(r.projects.find((p) => p.thesisId === thesisId)?.id ?? null); },
      () => { if (alive) setRescueProjectId(null); },
    );
    return () => { alive = false; };
  }, [thesisId]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        if (!thesisId) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        try {
          const [data, outlineData] = await Promise.all([
            getThesis(thesisId),
            getThesisOutline(thesisId).catch(() => null),
          ]);
          if (!active) return;
          const normalized = normalize(data);
          setThesis(normalized);
          setOutline(outlineData);
          useThesisStore.setState((state) => ({
            theses: [normalized, ...state.theses.filter((th) => th.id !== normalized.id)],
          }));
        } catch {
          if (active) setNotFound(true);
        }
        if (active) setLoading(false);
      })();
      return () => {
        active = false;
      };
    }, [thesisId])
  );

  const openChat = () => {
    if (!thesis) return;
    useThesisStore.getState().setCurrentThesis(thesis.id);
    // dismissTo, not push: chat is the app's root screen, so pushing put a
    // SECOND chat on top of the one already down there — both mounted, both
    // presenting their own sheet for the same pending question.
    router.dismissTo("/(app)/chat" as any);
  };

  const openWorkspace = () => {
    if (!thesis) return;
    useThesisStore.getState().setCurrentThesis(thesis.id);
    router.push({ pathname: "/(app)/thesis-workspace", params: { thesisId: thesis.id } });
  };

  // Navigate the live-docx workspace to a specific engine block (section heading
  // or chapter). `blockIndex` comes from the outline.
  const openBlock = (blockIndex: number, title: string) => {
    if (!thesis) return;
    useThesisStore.getState().setCurrentThesis(thesis.id);
    useWorkspaceStore.getState().selectBlock(blockIndex, title ?? "");
    router.push({
      pathname: "/(app)/thesis-workspace",
      params: { thesisId: thesis.id, blockIndex: String(blockIndex) },
    });
  };

  const onRenamed = (title: string) => {
    setThesis((prev) => (prev ? { ...prev, title } : prev));
    const base = useThesisStore.getState().theses.find((th) => th.id === thesisId);
    if (base) useThesisStore.getState().upsertThesis({ ...base, title });
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
        <View style={styles.topBar}>
          <BackButton />
          <Text style={[styles.topTitle, { color: colors.textPrimary }]}>{t("thesis.thesisDetails")}</Text>
          <View style={{ width: 40 }} />
        </View>
        <ScrollView contentContainerStyle={styles.skeletonScroll} scrollEnabled={false}>
          <ThesisDetailSkeleton />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (notFound || !thesis) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
        <View style={styles.topBar}>
          <BackButton />
          <Text style={[styles.topTitle, { color: colors.textPrimary }]}>{t("thesis.thesisDetails")}</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centered}>
          <Text style={{ color: colors.textSecondary }}>{t("thesis.noThesesFound")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const liveOutline = outline?.available ? outline : null;
  const outlineSections = liveOutline
    ? liveOutline.sections.map((s) => ({ index: s.index, title: s.title, chapters: s.chapters }))
    : [];

  const sectionCount = liveOutline ? liveOutline.sectionCount : 0;
  const chapterCount = liveOutline ? liveOutline.chapterCount : 0;
  const wordCount = liveOutline ? liveOutline.wordCount : thesis.wordCount || 0;
  const progress = Math.max(0, Math.min(100, Math.round(thesis.progress || 0)));
  const resumeHint = progress > 0 ? t("thesis.resumeKeepGoing") : t("thesis.resumeJustBegun");

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
        <View style={styles.topBar}>
          <BackButton />
          <Text style={[styles.topTitle, { color: colors.textPrimary }]} numberOfLines={1}>
            {t("thesis.thesisDetails")}
          </Text>
          <ThesisHeaderMenu thesis={thesis} onRenamed={onRenamed} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <ThesisBookCover
            title={thesis.title}
            progress={progress}
            wordCount={wordCount}
            resumeHint={resumeHint}
          />

          <ThesisStatStrip sections={sectionCount} chapters={chapterCount} words={wordCount} />

          {rescueProjectId ? (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => router.push({ pathname: "/(app)/rescue", params: { projectId: rescueProjectId, view: "history" } })}
              style={[styles.rescueRow, { backgroundColor: colors.brandWash }]}
            >
              <Text style={[styles.rescueRowText, { color: colors.brandPrimary }]}>{t("rescueV2.library.history")}</Text>
            </TouchableOpacity>
          ) : null}

          {sectionCount === 0 ? (
            <View style={[styles.emptyChapters, { backgroundColor: colors.bgSurface }]}>
              <Text style={[styles.emptyChaptersText, { color: colors.textSecondary }]}>
                {t("thesis.noChapters")}
              </Text>
            </View>
          ) : (
            outlineSections.map((sec, i) => (
              <SectionRow
                key={`${sec.index}-${i}`}
                ordinal={i + 1}
                sectionIndex={sec.index}
                title={sec.title}
                chapters={sec.chapters}
                spineColor={spineColorForIndex(i, colors)}
                onOpenBlock={openBlock}
              />
            ))
          )}
        </ScrollView>

        <ThesisActionBar onOpenWorkspace={openWorkspace} onChat={openChat} />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14, gap: 12 },
  topTitle: { flex: 1, fontSize: 18, fontFamily: "Inter_700Bold", textAlign: "center" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  skeletonScroll: { paddingBottom: 120 },
  content: { padding: 20, gap: 18, paddingBottom: 120 },
  sectionTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  emptyChapters: { borderRadius: 12, padding: 24, alignItems: "center" },
  emptyChaptersText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  rescueRow: { borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  rescueRowText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
