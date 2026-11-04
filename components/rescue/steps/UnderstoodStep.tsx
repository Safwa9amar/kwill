import React from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { scaleFor, STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { CountUp } from "../CountUp";
import { PageCarousel } from "../PageCarousel";
import { SkeletonPage } from "../SkeletonPage";
import { SheetBody, SheetTitle } from "../ui";
import type { RescueStep } from "./index";

/** The soft outlines a Diagnose band wears: a heading orange, a figure or table green, a caption in the secondary ink. */
function bandColor(role: string, colors: { brandPrimary: string; semanticSuccess: string; textSecondary: string; borderDefault: string }): string {
  if (role === "h1") return colors.brandPrimary;
  if (role === "figure" || role === "table") return colors.semanticSuccess;
  if (role === "caption") return colors.textSecondary;
  return colors.borderDefault;
}

/**
 * Screen 6, the stage: the thesis' middle page, with its soft outlines when Diagnose has them. The outlines sit over the carousel's middle
 * slot: the middle is always centred, so an overlay the width of that page, from the top of the row, lines up with it. While the diagnosis
 * runs, the middle page is shaded in brand colour.
 */
function Stage() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const versionId = useRescueV2Store((st) => st.project?.originalVersionId ?? null);
  const phase = useRescueV2Store((st) => st.project?.phase ?? null);
  const outline = useRescueV2Store((st) => st.project?.diagnosis?.outline ?? null);
  const layout = STAGE_LAYOUT.understood;
  const midW = layout.kind === "three" ? layout.mid[0] * s : 122 * s;
  const midH = layout.kind === "three" ? layout.mid[1] * s : 170 * s;

  if (!versionId) {
    return (
      <View style={styles.stage}>
        <SkeletonPage width={84 * s} height={120 * s} />
        <SkeletonPage width={122 * s} height={170 * s} />
        <SkeletonPage width={84 * s} height={120 * s} />
      </View>
    );
  }
  const overlay = outline || phase === "diagnosing" ? (
    <View pointerEvents="none" style={[styles.overlay, { width: midW, height: midH, left: (width - midW) / 2 }]}>
      {phase === "diagnosing" ? (
        <SkeletonBlock width={midW} height={midH} radius={3} color={colors.brandWash} />
      ) : null}
      {outline?.bands.map((b, i) => (
        <View
          key={`${b.role}-${i}`}
          style={[
            styles.band,
            {
              top: `${b.topPct * 100}%`,
              height: `${b.heightPct * 100}%`,
              borderColor: bandColor(b.role, colors),
            },
          ]}
        />
      ))}
    </View>
  ) : null;

  return (
    <View style={[styles.stage, { backgroundColor: colors.rescueStageBottom }]}>
      <PageCarousel versionId={versionId} page={outline?.page ?? 1} layout={layout} overlay={overlay} />
    </View>
  );
}

/**
 * Screen 6, the sheet. What Kwill recognised comes first (chapters, figures, the format), before any judgement. Until the summary exists
 * the six numbers are skeletons, so the shape of the answer is there before the numbers are.
 */
function Sheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const phase = useRescueV2Store((s) => s.project?.phase ?? null);
  const summary = useRescueV2Store((s) => s.project?.summary ?? null);
  const waiting = useRescueV2Store((s) => s.project?.waiting ?? null);
  const progress = useRescueV2Store((s) => s.project?.progress ?? null);

  const cells: { value: number | null; label: string; mark?: string }[] = summary
    ? [
        { value: summary.pages, label: t("rescueV2.understood.pages") },
        { value: summary.chapters, label: t("rescueV2.understood.chapters") },
        { value: summary.figures, label: t("rescueV2.understood.figures") },
        { value: summary.tables, label: t("rescueV2.understood.tables") },
        { value: summary.footnotes, label: t("rescueV2.understood.footnotes") },
        { value: null, label: t("rescueV2.understood.cover"), mark: summary.hasCover ? "✓" : "—" },
      ]
    : [];

  const fraction = progress && progress.of > 0 ? Math.min(1, progress.step / progress.of) : null;

  return (
    <View>
      <SheetTitle>{t(summary ? "rescueV2.understood.title" : "rescueV2.understood.titleWorking")}</SheetTitle>
      {!summary && waiting === "brain" ? <SheetBody>{t("rescueV2.common.waitingBrain")}</SheetBody> : null}

      <View style={styles.grid}>
        {summary
          ? cells.map((c, i) => (
              <View key={i} style={[styles.cell, { backgroundColor: colors.bgSurface, borderColor: colors.borderDefault }]}>
                {c.mark !== undefined ? (
                  <Text style={[styles.num, { color: colors.semanticSuccess }]}>{c.mark}</Text>
                ) : (
                  <CountUp to={c.value ?? 0} style={[styles.num, { color: colors.textPrimary }]} />
                )}
                <Text style={[styles.label, { color: colors.textSecondary }]}>{c.label}</Text>
              </View>
            ))
          : Array.from({ length: 6 }, (_, i) => (
              <View key={i} style={[styles.cell, { backgroundColor: colors.bgSurface, borderColor: colors.borderDefault }]}>
                <SkeletonBlock width={40} height={22} radius={6} />
                <SkeletonBlock width={56} height={10} radius={5} />
              </View>
            ))}
      </View>

      {summary ? (
        <SheetBody>{t("rescueV2.understood.typeLine", { format: t(`rescueV2.understood.format.${summary.format}`) })}</SheetBody>
      ) : null}

      <View style={[styles.bar, { backgroundColor: colors.bgSurface }]}>
        {fraction === null ? (
          <SkeletonBlock width="100%" height={6} radius={3} />
        ) : (
          <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: colors.brandPrimary }]} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  overlay: { position: "absolute", top: 0 },
  band: { position: "absolute", left: 0, right: 0, borderWidth: 1.5, borderRadius: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  cell: { width: "31%", alignItems: "center", gap: 4, borderWidth: 1, borderRadius: 14, paddingVertical: 10 },
  num: { fontSize: 22, fontWeight: "800" },
  label: { fontSize: 12 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden", marginTop: 10 },
  fill: { height: 6, borderRadius: 3 },
});

export const UnderstoodStep: RescueStep = { Stage, Sheet };
