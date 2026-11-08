import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { RestoreDialog } from "@/components/rescue/RestoreDialog";
import { SheetBody, SheetTitle } from "@/components/rescue/ui";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { downloadExport } from "@/lib/download-export";
import { getVersionFile } from "@/lib/rescue-v2-api";
import { rescueFileName } from "@/lib/rescue-v2-finish";
import { dayLabel, nextVersionN, rowMetaKey, versionActions, type VersionAction } from "@/lib/rescue-v2-history";
import { openThesisEditor } from "@/lib/rescue-v2-open-editor";
import { SHEET_RADIUS, SHEET_TOP_PCT, STAGE_LAYOUT, stageRoom } from "@/lib/rescue-v2-layout";

import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { useHistoryUi } from "@/stores/rescue-history-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueVersionSummaryDTO } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

/** The badge above the pages and the page label under them, with their gaps, at the default text size (scaled by the font scale). */
const STACK_ROWS = 56;

/** The version this sheet is for: the one the overlay was opened for, else the current one. */
function useVersionId(): string | null {
  return useRescueV2Store((s) => s.nav.versionId ?? s.project?.currentVersion?.id ?? null);
}

/** H3's stage: the version's pages, swipeable like screens 7 and 15. A version that is not finished shows its meta only. */
function Stage() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pid = useRescueV2Store((s) => s.projectId);
  const vid = useVersionId();
  const version = useRescueV2Store((s) => s.versions.find((v) => v.id === vid) ?? null);
  const currentId = useRescueV2Store((s) => s.project?.currentVersion?.id ?? null);
  const count = useRescueV2Store((s) => (vid ? s.pages[vid]?.count ?? null : null));
  const page = useHistoryUi((s) => (s.key === pid && s.pageVersion === vid ? s.page : 1));
  const setPage = useHistoryUi((s) => s.setPage);
  const layout = STAGE_LAYOUT.version;
  if (!pid || !vid || !version || layout.kind !== "three") return null;
  // The stack (badge, pages, page label) sits between the status bar and the sheet's corner; the pages take what the two rows leave.
  const room = stageRoom((height * SHEET_TOP_PCT.version) / 100 + SHEET_RADIUS, insets.top, STACK_ROWS * Math.max(1, fontScale));
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

function ActionRow({ tile, color, label, busy, disabled, onPress }: {
  tile: string; color: string; label: string; busy?: boolean; disabled?: boolean; onPress: () => void;
}) {
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, { flexDirection: visualRow(isRTL), borderColor: colors.borderSubtle, opacity: disabled && !busy ? 0.5 : 1 }]}
    >
      <Text numberOfLines={1} style={[styles.tile, { color }]}>{tile}</Text>
      <Text style={[styles.actionLabel, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{label}</Text>
      {/* A directional glyph chosen by direction, never mirrored with scaleX. */}
      <Text style={[styles.chev, { color: colors.textSecondary }]}>{busy ? "…" : isRTL ? "‹" : "›"}</Text>
    </TouchableOpacity>
  );
}

/** H3's sheet, keyed by the version: a download's failure and the restore dialog never carry to another version. */
function Sheet() {
  const vid = useVersionId();
  return <VersionSheet key={vid ?? "none"} />;
}

function VersionSheet() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const vid = useVersionId();
  const project = useRescueV2Store((s) => s.project);
  const versions = useRescueV2Store((s) => s.versions);
  const loadVersions = useRescueV2Store((s) => s.loadVersions);
  const setNav = useRescueV2Store((s) => s.setNav);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<"download" | "open" | null>(null);
  const [pickCompare, setPickCompare] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // One call at a time: a tap while a download or the editor's open is in flight is refused.
  const gate = useRef(false);
  const align = { textAlign: visualTextAlign(isRTL) };

  const v: RescueVersionSummaryDTO | null = versions.find((x) => x.id === vid) ?? null;
  // The list is read when the sheet is shown: the compare picker and the restore's number both come from it.
  useEffect(() => { void loadVersions(); }, [loadVersions]);
  if (!project || !v || !vid) return null;

  const isCurrent = project.currentVersion?.id === v.id;
  const isSplitOriginal = v.kind === "original" && project.parts.length > 1;
  const thesisId = project.thesisId;
  // The current version is the one in place: it offers no restore.
  const actions = versionActions(v, isCurrent);
  const date = dayLabel(v.createdAt, i18n.language);

  const download = async (key: string, kind: "pdf" | "docx" | "part", index?: number) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(key);
    setFailed(null);
    try {
      const file = await getVersionFile(vid, kind, index);
      await downloadExport({ ...file, title: rescueFileName(kind, i18n.language, file.filename) });
    } catch {
      setFailed("download");
    } finally {
      gate.current = false;
      setBusy(null);
    }
  };

  // The current version opens as screen 15 opens it. Any other is brought back first: its restore is the one step that makes it editable.
  const open = async () => {
    if (gate.current) return;
    if (!isCurrent) { setRestoreOpen(true); return; }
    if (!thesisId) return;
    gate.current = true;
    setBusy("open");
    setFailed(null);
    try {
      await openThesisEditor(thesisId);
    } catch {
      setFailed("open");
    } finally {
      gate.current = false;
      setBusy(null);
    }
  };

  const others = versions.filter((x) => x.id !== v.id && x.status === "done");
  const has = (a: VersionAction) => actions.includes(a);
  const wordLabel = isSplitOriginal ? t("rescueV2.version.wordMerged") : t("rescueV2.version.word");

  return (
    <>
      <SheetTitle>{t(`rescueV2.timeline.triggers.${v.trigger}`, { n: v.triggerN })}</SheetTitle>
      <SheetBody>
        {v.kind === "original"
          ? t("rescueV2.timeline.originalMeta", { date })
          : t(`rescueV2.timeline.${rowMetaKey(v)}`, { date, fixes: v.fixes, count: v.changedPages ?? 0 })}
      </SheetBody>

      {has("pdf") ? (
        <ActionRow tile="PDF" color={colors.semanticError} label={t("rescueV2.version.pdf")} busy={busy === "pdf"} disabled={busy !== null} onPress={() => { void download("pdf", "pdf"); }} />
      ) : null}
      {has("word") ? (
        <ActionRow tile="DOCX" color={colors.brandPrimary} label={wordLabel} busy={busy === "docx"} disabled={busy !== null} onPress={() => { void download("docx", "docx"); }} />
      ) : null}
      {has("compare") ? (
        <ActionRow tile="⇆" color={colors.textPrimary} label={t("rescueV2.version.compare")} disabled={busy !== null} onPress={() => setPickCompare((p) => !p)} />
      ) : null}
      {pickCompare && has("compare") ? (
        <View style={styles.pick}>
          <Text style={[styles.pickTitle, { color: colors.textSecondary }, align]}>{t("rescueV2.version.pickCompare")}</Text>
          {others.map((o) => (
            <TouchableOpacity
              key={o.id}
              accessibilityRole="button"
              onPress={() => setNav({ overlay: "compare", versionId: v.id, compareWithId: o.id })}
              style={[styles.pickRow, { flexDirection: visualRow(isRTL), borderColor: colors.borderSubtle }]}
            >
              <Text style={[styles.pickText, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{o.kind === "original" ? t("rescueV2.timeline.original") : t("rescueV2.common.version", { n: o.n })}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {has("changed") ? (
        <ActionRow tile="≡" color={colors.textPrimary} label={t("rescueV2.version.changed", { count: v.fixes })} disabled={busy !== null} onPress={() => setNav({ overlay: "changed", versionId: v.id, compareWithId: null })} />
      ) : null}
      {has("open") && thesisId ? (
        <ActionRow tile="✎" color={colors.textPrimary} label={t("rescueV2.version.open")} busy={busy === "open"} disabled={busy !== null} onPress={() => { void open(); }} />
      ) : null}
      {has("restore") ? (
        <ActionRow tile="↺" color={colors.brandPrimary} label={t("rescueV2.version.restore")} disabled={busy !== null} onPress={() => setRestoreOpen(true)} />
      ) : null}

      {isSplitOriginal ? (
        <View style={styles.parts}>
          <Text style={[styles.pickTitle, { color: colors.textSecondary }, align]}>{t("rescueV2.version.partsTitle")}</Text>
          {project.parts.map((p) => (
            <TouchableOpacity
              key={p.index}
              accessibilityRole="button"
              disabled={busy !== null}
              onPress={() => { void download(`part-${p.index}`, "part", p.index); }}
              style={[styles.pickRow, { flexDirection: visualRow(isRTL), borderColor: colors.borderSubtle }]}
            >
              <Text style={[styles.pickText, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]} numberOfLines={1}>{p.filename}</Text>
              {busy === `part-${p.index}` ? <Text style={{ color: colors.textSecondary }}>…</Text> : null}
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      {failed === "download" ? <Text style={[styles.error, { color: colors.semanticError }, align]}>{t("rescueV2.result.downloadFailed")}</Text> : null}
      {failed === "open" ? <Text style={[styles.error, { color: colors.semanticError }, align]}>{t("rescueV2.result.openFailed")}</Text> : null}

      {has("restore") ? (
        <RestoreDialog
          visible={restoreOpen}
          versionId={v.id}
          versionN={v.n}
          nextN={nextVersionN(versions)}
          thesisId={thesisId}
          onClose={() => setRestoreOpen(false)}
        />
      ) : null}
    </>
  );
}

export const VersionStep: RescueStep = { Stage, Sheet, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  badge: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  label: { fontSize: 12, fontWeight: "600" },
  action: { alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
  // Wide enough for "DOCX" on one line: at 34 it broke into "DOC" over "X".
  tile: { width: 46, fontSize: 13, fontWeight: "800", textAlign: "center" },
  actionLabel: { flex: 1, fontSize: 15, fontWeight: "600" },
  chev: { fontSize: 20 },
  pick: { marginBottom: 8, paddingStart: 58 },
  parts: { marginTop: 10, marginBottom: 8 },
  pickTitle: { fontSize: 13, fontWeight: "700", marginBottom: 6 },
  pickRow: { alignItems: "center", justifyContent: "space-between", gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  pickText: { fontSize: 14, flexShrink: 1 },
  error: { fontSize: 13, lineHeight: 18, marginTop: 6 },
});
