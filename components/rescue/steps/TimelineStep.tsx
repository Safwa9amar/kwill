import React, { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Lock } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { SheetTitle } from "@/components/rescue/ui";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { dayLabel, railItems, rowMetaKey, type RailItem } from "@/lib/rescue-v2-history";
import { SHEET_RADIUS, SHEET_TOP_PCT, STAGE_LAYOUT, stageRoom } from "@/lib/rescue-v2-layout";

import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { useHistoryUi } from "@/stores/rescue-history-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueVersionSummaryDTO } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

/** The badge above the pages and the page label under them, with their gaps. */
const STACK_ROWS = 56;

/** The version the timeline previews: the one the student tapped, else the current one. */
function useSelectedId(): string | null {
  const pid = useRescueV2Store((s) => s.projectId);
  const current = useRescueV2Store((s) => s.project?.currentVersion?.id ?? null);
  const selected = useHistoryUi((s) => (s.key === pid ? s.selected : null));
  return selected ?? current;
}

/**
 * H2, the stage: the selected version's pages, interactive, with its page label (D-18: every version is viewable). A version that is not
 * finished has no pages to swipe, so it shows its meta line only.
 */
function Stage() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pid = useRescueV2Store((s) => s.projectId);
  const vid = useSelectedId();
  const version = useRescueV2Store((s) => s.versions.find((v) => v.id === vid) ?? null);
  const currentId = useRescueV2Store((s) => s.project?.currentVersion?.id ?? null);
  const count = useRescueV2Store((s) => (vid ? s.pages[vid]?.count ?? null : null));
  const page = useHistoryUi((s) => (s.key === pid && s.pageVersion === vid ? s.page : 1));
  const setPage = useHistoryUi((s) => s.setPage);
  const layout = STAGE_LAYOUT.timeline;
  if (!pid || !vid || !version || layout.kind !== "three") return null;
  // The stack (badge, pages, page label) sits between the status bar and the sheet's corner; the pages take what the two rows leave.
  const room = stageRoom((height * SHEET_TOP_PCT.timeline) / 100 + SHEET_RADIUS, insets.top, STACK_ROWS);
  const date = dayLabel(version.createdAt, i18n.language);
  // The original is not a numbered version to the student: its badge names it, as its row does.
  const badge = version.kind === "original"
    ? t("rescueV2.timeline.original")
    : version.id === currentId
      ? t("rescueV2.timeline.badgeCurrent", { n: version.n })
      : t("rescueV2.timeline.badge", { n: version.n, date });
  return (
    <View style={[styles.stage, { paddingTop: insets.top + 4, paddingBottom: SHEET_RADIUS + 4 }]}>
      <View style={[styles.badge, { backgroundColor: colors.textPrimary }]}>
        <Text style={[styles.badgeText, { color: colors.bgCard }]}>{badge}</Text>
      </View>
      {version.status === "done" ? (
        <>
          <PageCarousel versionId={vid} page={page} layout={layout} room={room} interactive onChange={(p) => setPage(pid, vid, p)} />
          {count ? <Text style={[styles.label, { color: colors.textSecondary }]}>{t("rescueV2.common.pageOf", { page, total: count })}</Text> : null}
        </>
      ) : (
        <Text style={[styles.label, { color: colors.textSecondary }]}>
          {t(`rescueV2.timeline.${rowMetaKey(version)}`, { date, fixes: version.fixes, count: version.changedPages ?? 0 })}
        </Text>
      )}
    </View>
  );
}

/** One version's row on the rail: a dot on the line, its trigger, its meta, and a chevron into the version's sheet. */
function VersionRow({ v, isCurrent, selected, onTap, onOpen }: {
  v: RescueVersionSummaryDTO; isCurrent: boolean; selected: boolean; onTap: () => void; onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const isOriginal = v.kind === "original";
  const date = dayLabel(v.createdAt, i18n.language);
  const title = isOriginal
    ? t("rescueV2.timeline.original")
    : t(`rescueV2.timeline.triggers.${v.trigger}`, { n: v.triggerN });
  const meta = isOriginal
    ? t("rescueV2.timeline.originalMeta", { date })
    : t(`rescueV2.timeline.${rowMetaKey(v)}`, { date, fixes: v.fixes, count: v.changedPages ?? 0 });
  return (
    <View style={[styles.row, { flexDirection: visualRow(isRTL), backgroundColor: selected ? colors.bgSurface : "transparent" }]}>
      <View style={styles.railCol}>
        <View style={[styles.line, { backgroundColor: colors.borderDefault }]} />
        <View style={[styles.dot, { backgroundColor: isOriginal ? colors.bgCard : isCurrent ? colors.brandPrimary : colors.textSecondary, borderColor: colors.textSecondary }]} />
      </View>
      <TouchableOpacity accessibilityRole="button" onPress={onTap} style={styles.body}>
        <View style={[styles.titleLine, { flexDirection: visualRow(isRTL) }]}>
          {/* An icon, not the emoji: the emoji drew as a missing-glyph box on iOS. */}
          {isOriginal ? <Lock size={13} color={colors.textSecondary} strokeWidth={2.4} /> : null}
          <Text style={[styles.title, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]} numberOfLines={1}>{title}</Text>
          {isCurrent ? <Text style={[styles.tag, { backgroundColor: colors.brandWash, color: colors.brandPrimary }]}>{t("rescueV2.timeline.current")}</Text> : null}
          {isOriginal ? <Text style={[styles.tag, { backgroundColor: colors.bgSurface, color: colors.textSecondary }]}>{t("rescueV2.timeline.originalKept")}</Text> : null}
        </View>
        <Text style={[styles.meta, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{meta}</Text>
      </TouchableOpacity>
      {isOriginal ? null : (
        <TouchableOpacity accessibilityRole="button" onPress={onOpen} hitSlop={10} style={styles.chevron}>
          {/* A directional glyph chosen by direction, never mirrored with scaleX. */}
          <Text style={[styles.chevronText, { color: colors.textSecondary }]}>{isRTL ? "‹" : "›"}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/** A grey editor step: edits made in the Kwill editor between versions, or not yet absorbed by one. */
function EditRow({ changedBlocks }: { changedBlocks: number | null }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return (
    <View style={[styles.row, { flexDirection: visualRow(isRTL) }]}>
      <View style={styles.railCol}>
        <View style={[styles.line, { backgroundColor: colors.borderDefault }]} />
        <View style={[styles.dotSmall, { backgroundColor: colors.borderDefault }]} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.edit, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>
          {changedBlocks !== null ? t("rescueV2.timeline.editedBlocks", { count: changedBlocks }) : t("rescueV2.timeline.edited")}
        </Text>
      </View>
    </View>
  );
}

/** H2's sheet: the rail, newest first, the original pinned last. Tapping a version previews it; a second tap, or the chevron, opens its sheet. */
function Sheet() {
  const pid = useRescueV2Store((s) => s.projectId);
  return <TimelineSheet key={pid ?? "none"} />;
}

function TimelineSheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const pid = useRescueV2Store((s) => s.projectId);
  const currentId = useRescueV2Store((s) => s.project?.currentVersion?.id ?? null);
  const versions = useRescueV2Store((s) => s.versions);
  const edited = useRescueV2Store((s) => s.edited);
  const loadVersions = useRescueV2Store((s) => s.loadVersions);
  const setNav = useRescueV2Store((s) => s.setNav);
  const selectedId = useSelectedId();
  const select = useHistoryUi((s) => s.select);

  // The compare pair and the version of a sheet belong to the sheet that set them: the timeline needs neither, so a later Changed or Result
  // never inherits a stale version from an earlier visit.
  useEffect(() => { setNav({ versionId: null, compareWithId: null }); }, [setNav]);
  useEffect(() => { void loadVersions(); }, [pid, loadVersions]);

  if (!pid) return null;
  const rows = railItems(versions, edited);
  // Layout-shaped while the list loads: grey bars where the rail will be, never a spinner.
  if (versions.length === 0) {
    return (
      <>
        <SheetTitle>{t("rescueV2.timeline.title")}</SheetTitle>
        {[0.9, 0.7, 0.8].map((w, i) => (
          <View key={i} style={[styles.placeholder, { width: `${w * 100}%`, backgroundColor: colors.bgSurface }]} />
        ))}
      </>
    );
  }
  const open = (id: string) => setNav({ overlay: "version", versionId: id, compareWithId: null });
  return (
    <>
      <SheetTitle>{t("rescueV2.timeline.title")}</SheetTitle>
      {rows.map((item: RailItem) => item.kind === "edit" ? (
        <EditRow key={item.key} changedBlocks={item.changedBlocks} />
      ) : (
        <VersionRow
          key={item.key}
          v={item.version}
          isCurrent={item.version.id === currentId}
          selected={item.version.id === selectedId}
          onTap={() => {
            if (!pid) return;
            if (item.version.id === selectedId) open(item.version.id);
            else select(pid, item.version.id);
          }}
          onOpen={() => open(item.version.id)}
        />
      ))}
    </>
  );
}

/** The one CTA: the edit-and-redo screen, where the saved choices are changed. Fine print only where Android may show a price. */
function Foot() {
  const pid = useRescueV2Store((s) => s.projectId);
  return <TimelineFoot key={pid ?? "none"} />;
}

function TimelineFoot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const project = useRescueV2Store((s) => s.project);
  const setNav = useRescueV2Store((s) => s.setNav);
  if (!project) return null;
  return (
    <View style={styles.foot}>
      <Button title={t("rescueV2.timeline.cta")} onPress={() => setNav({ overlay: "edit_rerun" })} />
      {PURCHASES_HIDDEN ? null : <Text style={[styles.fine, { color: colors.textSecondary }]}>{t("rescueV2.timeline.fine")}</Text>}
    </View>
  );
}

export const TimelineStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  badge: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  label: { fontSize: 12, fontWeight: "600" },
  placeholder: { height: 14, borderRadius: 7, marginBottom: 12 },
  row: { alignItems: "stretch", gap: 10, borderRadius: 14, paddingVertical: 6 },
  railCol: { width: 16, alignItems: "center" },
  line: { position: "absolute", top: 0, bottom: 0, width: 2, left: 7 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, marginTop: 10 },
  dotSmall: { width: 8, height: 8, borderRadius: 4, marginTop: 10 },
  body: { flex: 1, paddingVertical: 4, gap: 2 },
  titleLine: { alignItems: "center", gap: 8, flexWrap: "wrap" },
  title: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  tag: { fontSize: 11, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden" },
  meta: { fontSize: 12, lineHeight: 17 },
  edit: { fontSize: 12, lineHeight: 17, fontStyle: "italic", paddingVertical: 2 },
  chevron: { alignSelf: "center", paddingHorizontal: 4 },
  chevronText: { fontSize: 22, fontWeight: "600" },
  foot: { gap: 8, paddingBottom: 10 },
  fine: { fontSize: 12, textAlign: "center" },
});
