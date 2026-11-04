import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Redirect, router, useFocusEffect, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { SafeAreaView } from "react-native-safe-area-context";
import { BackButton } from "@/components/BackButton";
import { PageImage } from "@/components/rescue/PageImage";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";
import { deleteRescueProject, listRescueProjects } from "@/lib/rescue-v2-api";
import { dayLabel, libraryChips, pillKey } from "@/lib/rescue-v2-history";
import { openThesisEditor } from "@/lib/rescue-v2-open-editor";
import { getTextDirection } from "@/lib/text-direction";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { useThesisStore } from "@/stores/thesis-store";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueProjectSummaryDTO } from "@/types/rescue-v2";
import type { Thesis } from "@/types/thesis";

/** H1, the library: every thesis the student has, with a rescue or without one. A repeat customer's second rescue starts here. */
export default function RescueLibrary() {
  if (!RESCUE_V2_ENABLED) return <Redirect href={"/(app)/chat" as Href} />;
  return <Library />;
}

/** Layout-shaped cards while the list first loads: grey blocks where the cards will be, never a spinner. */
function LibrarySkeleton() {
  const colors = useThemeColors();
  return (
    <View style={styles.skeleton}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.skeletonCard, { backgroundColor: colors.bgSurface }]} />
      ))}
    </View>
  );
}

function Library() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const theses = useThesisStore((s) => s.theses);
  const [projects, setProjects] = useState<RescueProjectSummaryDTO[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Both lists are read on every focus, so a project started or deleted elsewhere shows at once. The first load shows a skeleton; a
  // refresh keeps what is on screen.
  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [res] = await Promise.all([listRescueProjects(), useThesisStore.getState().refreshTheses()]);
      setProjects(res.projects);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // No rescue and no thesis at all: there is nothing to list, so the library is the start screen.
  const empty = projects !== null && projects.length === 0 && theses.length === 0;
  useEffect(() => {
    if (empty) router.replace("/(app)/rescue");
  }, [empty]);

  const openRoute = (params: { projectId: string; view?: "history" | "revisions" }) => {
    router.push({ pathname: "/(app)/rescue", params });
  };

  const newRescue = () => {
    useRescueV2Store.getState().reset();
    router.push("/(app)/rescue");
  };

  const openThesis = async (key: string, thesisId: string) => {
    if (busyId) return;
    setBusyId(key);
    setActionError(false);
    try {
      await openThesisEditor(thesisId);
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setActionError(false);
    try {
      await deleteRescueProject(id);
      setProjects((ps) => (ps ? ps.filter((p) => p.id !== id) : ps));
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  };

  // A long press on a check that can be deleted asks first. The file and the check are gone for good.
  const askDelete = (p: RescueProjectSummaryDTO) => {
    Alert.alert(t("rescueV2.library.delete"), t("rescueV2.library.deleteConfirm"), [
      { text: t("rescueV2.common.cancel"), style: "cancel" },
      { text: t("rescueV2.library.delete"), style: "destructive", onPress: () => { void remove(p.id); } },
    ]);
  };

  const headerRow = (
    <View style={[styles.header, { flexDirection: visualRow(isRTL) }]}>
      <BackButton />
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescueV2.library.title")}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={t("rescueV2.library.new")} hitSlop={10} onPress={newRescue} style={[styles.plus, { backgroundColor: colors.brandWash }]}>
        <Text style={[styles.plusText, { color: colors.brandPrimary }]}>＋</Text>
      </TouchableOpacity>
    </View>
  );

  if (empty) return <SafeAreaView style={[styles.screen, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>{headerRow}</SafeAreaView>;

  const projectThesisIds = new Set((projects ?? []).map((p) => p.thesisId).filter((x): x is string => !!x));
  const draftTheses = theses.filter((th) => !projectThesisIds.has(th.id));

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      {headerRow}
      {actionError ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: colors.semanticError, textAlign: visualTextAlign(isRTL) }]}>{t("rescueV2.common.somethingWrong")}</Text>
      ) : null}
      {projects === null ? (
        loadFailed ? (
          <View style={styles.failed}>
            <Text style={[styles.error, { color: colors.semanticError }]}>{t("rescueV2.common.somethingWrong")}</Text>
            <Button title={t("rescueV2.common.retry")} variant="secondary" onPress={() => { void load(); }} />
          </View>
        ) : (
          <LibrarySkeleton />
        )
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {loadFailed ? (
            <TouchableOpacity accessibilityRole="button" onPress={() => { void load(); }} hitSlop={8}>
              <Text style={[styles.error, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
            </TouchableOpacity>
          ) : null}
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              p={p}
              anyBusy={busyId !== null}
              onHistory={() => openRoute({ projectId: p.id, view: "history" })}
              onOpen={p.thesisId ? () => { void openThesis(`open-${p.id}`, p.thesisId ?? ""); } : null}
              onRedo={() => openRoute({ projectId: p.id, view: "revisions" })}
              onContinue={() => openRoute({ projectId: p.id })}
              onDelete={p.canDelete ? () => askDelete(p) : null}
            />
          ))}
          {draftTheses.map((th) => (
            <DraftCard
              key={th.id}
              thesis={th}
              anyBusy={busyId !== null}
              onOpen={() => { void openThesis(`draft-${th.id}`, th.id); }}
            />
          ))}
          <Text style={[styles.hint, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{t("rescueV2.library.hint")}</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/** One rescue. Its cover page on the left, its state and the chips that fit its phase beside it. */
function ProjectCard({ p, anyBusy, onHistory, onOpen, onRedo, onContinue, onDelete }: {
  p: RescueProjectSummaryDTO;
  anyBusy: boolean;
  onHistory: () => void;
  onOpen: (() => void) | null;
  onRedo: () => void;
  onContinue: () => void;
  onDelete: (() => void) | null;
}) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const chips = libraryChips(p);
  const pill = pillKey(p.phase);
  const dir = getTextDirection(p.title);
  const meta = p.currentVersionN !== null && p.currentVersionAt
    ? t("rescueV2.library.versionMeta", { n: p.currentVersionN, date: dayLabel(p.currentVersionAt, i18n.language) })
    : t("rescueV2.library.draftMeta", { date: dayLabel(p.updatedAt, i18n.language) });
  const pillTone = pill === "ready" ? colors.successWash : pill === "failed" ? colors.semanticError : colors.brandWash;
  const pillColor = pill === "ready" ? colors.semanticSuccess : pill === "failed" ? colors.bgCard : colors.brandPrimary;
  return (
    // A long press is the only gesture on the card: the chips inside are the actions.
    <Pressable
      disabled={!onDelete}
      onLongPress={onDelete ?? undefined}
      delayLongPress={450}
      style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault, flexDirection: visualRow(isRTL) }]}
    >
      <View style={[styles.page, { backgroundColor: colors.rescuePaper }]}>
        {p.coverPageVersionId ? <PageImage versionId={p.coverPageVersionId} page={1} width={56} height={78} /> : null}
      </View>
      <View style={styles.cardMain}>
        <Text numberOfLines={2} style={[styles.cardTitle, { color: colors.textPrimary, writingDirection: dir, textAlign: visualTextAlign(dir === "rtl") }]}>{p.title}</Text>
        <Text style={[styles.meta, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{meta}</Text>
        <View style={[styles.pillRow, { flexDirection: visualRow(isRTL) }]}>
          <View style={[styles.pill, { backgroundColor: pillTone }]}>
            <Text style={[styles.pillText, { color: pillColor }]}>{t(`rescueV2.library.${pill}`)}</Text>
          </View>
        </View>
        <View style={[styles.chips, { flexDirection: visualRow(isRTL) }]}>
          {chips.history ? <Chip label={t("rescueV2.library.history")} wash disabled={anyBusy} onPress={onHistory} /> : null}
          {onOpen && chips.open ? <Chip label={t("rescueV2.library.open")} disabled={anyBusy} onPress={onOpen} /> : null}
          {chips.rerun ? <Chip label={t("rescueV2.library.rerun")} disabled={anyBusy} onPress={onRedo} /> : null}
          {chips.continue ? <Chip label={t("rescueV2.library.continue")} wash disabled={anyBusy} onPress={onContinue} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

/** A thesis with no rescue: a plain card and its one chip. */
function DraftCard({ thesis, anyBusy, onOpen }: { thesis: Thesis; anyBusy: boolean; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const dir = getTextDirection(thesis.title);
  return (
    <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault, flexDirection: visualRow(isRTL) }]}>
      <View style={styles.cardMain}>
        <Text numberOfLines={2} style={[styles.cardTitle, { color: colors.textPrimary, writingDirection: dir, textAlign: visualTextAlign(dir === "rtl") }]}>{thesis.title}</Text>
        <Text style={[styles.meta, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>
          {t("rescueV2.library.draftMeta", { date: dayLabel(thesis.updatedAt, i18n.language) })}
        </Text>
        <View style={[styles.chips, { flexDirection: visualRow(isRTL) }]}>
          <Chip label={t("rescueV2.library.open")} disabled={anyBusy} onPress={onOpen} />
        </View>
      </View>
    </View>
  );
}

function Chip({ label, wash, disabled, onPress }: { label: string; wash?: boolean; disabled: boolean; onPress: () => void }) {
  const colors = useThemeColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={[styles.chip, { backgroundColor: wash ? colors.brandWash : colors.bgSurface, borderColor: wash ? colors.brandWash : colors.borderDefault, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={[styles.chipText, { color: wash ? colors.brandPrimary : colors.textPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  plus: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  plusText: { fontSize: 22, fontWeight: "700" },
  list: { padding: 16, gap: 12, paddingBottom: 40 },
  skeleton: { padding: 16, gap: 12 },
  skeletonCard: { height: 110, borderRadius: 18 },
  failed: { padding: 16, gap: 12 },
  error: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginBottom: 6 },
  card: { borderWidth: 1, borderRadius: 18, padding: 12, gap: 12, alignItems: "flex-start" },
  page: { width: 56, height: 78, borderRadius: 3, overflow: "hidden" },
  cardMain: { flex: 1, gap: 4 },
  cardTitle: { fontSize: 15, fontWeight: "700", lineHeight: 21 },
  meta: { fontSize: 12, lineHeight: 17 },
  pillRow: { marginTop: 2 },
  pill: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "700" },
  chips: { flexWrap: "wrap", gap: 8, marginTop: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: "700" },
  hint: { fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 8 },
});
