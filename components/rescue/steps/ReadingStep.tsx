import React, { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { deleteRescueProject, deleteUploadVersion } from "@/lib/rescue-v2-api";
import { lostUploadTarget } from "@/lib/rescue-v2-lost-upload";
import { scaleFor, STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { PageCarousel } from "../PageCarousel";
import { SkeletonPage } from "../SkeletonPage";
import { SheetTitle, StepList, type StepItem } from "../ui";
import type { RescueStep } from "./index";

const MB = 1024 * 1024;

/** Word's answer is minutes away at most; under a minute reads as "soon", anything longer in whole minutes. */
function etaText(t: (k: string, o?: Record<string, unknown>) => string, seconds: number | null): string | undefined {
  if (seconds === null) return undefined;
  if (seconds < 60) return t("rescueV2.common.etaSoon");
  return t("rescueV2.common.etaMinutes", { minutes: Math.ceil(seconds / 60) });
}

/**
 * Screen 3, the top half. Until a page is ready (and while Word converts, when no page exists yet) the stage is three skeletons: a page
 * never arrives as a blank spinner. Once pages land, the last ready page is the middle one and its successor is a skeleton.
 */
function Stage() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const versionId = useRescueV2Store((st) => st.project?.originalVersionId ?? null);
  const pagesReady = useRescueV2Store((st) => st.project?.progress?.pagesReady ?? 0);
  const pagesTotal = useRescueV2Store((st) => st.project?.progress?.pagesTotal ?? 0);
  const layout = STAGE_LAYOUT.reading;

  if (!versionId || pagesReady === 0 || layout.kind !== "three") {
    return (
      <View style={styles.stage}>
        <SkeletonPage width={84 * s} height={120 * s} />
        <SkeletonPage width={122 * s} height={170 * s} />
        <SkeletonPage width={84 * s} height={120 * s} />
      </View>
    );
  }
  return (
    <View style={[styles.stage, { backgroundColor: colors.rescueStageBottom }]}>
      <PageCarousel versionId={versionId} page={Math.max(1, pagesReady)} layout={layout} />
      {pagesTotal > 0 ? (
        <Text style={[styles.label, { color: colors.textSecondary }]}>
          {t("rescueV2.common.pageOf", { page: pagesReady, total: pagesTotal })}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Screen 3, the sheet. The bar is the upload's fraction while the file goes up, and the pages' share while they are read. While Word
 * converts, `pagesTotal` is 0 and the bar shimmers instead of showing a made-up percentage.
 *
 * A cold start can lose the upload (`phase='uploading'` with no `upload` in memory): the student is told, and can choose the file again.
 * A first upload repeats from v0 (deleting the project); a re-run deletes only its own version (`lostUploadTarget`).
 */
function Sheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const phase = useRescueV2Store((s) => s.project?.phase ?? null);
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  const parts = useRescueV2Store((s) => s.project?.parts ?? EMPTY_PARTS);
  const upload = useRescueV2Store((s) => s.upload);
  const progress = useRescueV2Store((s) => s.project?.progress ?? null);
  const waiting = useRescueV2Store((s) => s.project?.waiting ?? null);
  const reset = useRescueV2Store((s) => s.reset);

  const apply = useRescueV2Store((s) => s.apply);
  const [lostPending, setLostPending] = useState(false);
  const [lostFailed, setLostFailed] = useState(false);
  const gate = useRef(false);

  const uploading = phase === "uploading";
  const lost = uploading && upload === null;
  const fileName = upload?.fileName ?? parts[0]?.filename ?? "";
  const bytes = upload?.sizeBytes ?? parts.reduce((n, p) => n + p.sizeBytes, 0);
  const pagesReady = progress?.pagesReady ?? 0;
  const pagesTotal = progress?.pagesTotal ?? 0;
  const reading = phase === "reading";
  const converting = reading && pagesTotal === 0;
  const splitReading = reading && parts.length > 1;
  const understanding = progress?.stepKey === "understand";

  let fraction: number | null = null;
  if (uploading) fraction = upload?.fraction ?? 0;
  else if (reading && pagesTotal > 0) fraction = pagesReady / pagesTotal;

  const steps: StepItem[] = [
    { key: "upload", label: t("rescueV2.reading.stepUpload"), state: uploading ? "current" : "done" },
  ];
  if (splitReading) {
    steps.push({ key: "merge", label: t("rescueV2.reading.merging"), state: converting ? "current" : "done" });
  }
  steps.push({
    key: "read",
    label: t("rescueV2.reading.stepRead"),
    state: converting ? "pending" : understanding ? "done" : reading ? "current" : "pending",
    eta: converting ? undefined : etaText(t, progress?.etaSeconds ?? null),
  });
  steps.push({ key: "understand", label: t("rescueV2.reading.stepUnderstand"), state: understanding ? "current" : "pending" });

  const retryLost = async () => {
    const cur = useRescueV2Store.getState().project;
    if (gate.current || !cur) return;
    gate.current = true;
    setLostPending(true);
    setLostFailed(false);
    try {
      // Only what this upload made goes: a first upload deletes the project, a re-run deletes its own version and keeps every finished one.
      const target = lostUploadTarget(cur);
      if (target.kind === "project") {
        await deleteRescueProject(target.projectId);
        reset();
      } else if (target.kind === "version") {
        // The store lands the project the server answers with, so the student is back on the last good version. A failure is on the shell's line, with its Retry.
        await apply(() => deleteUploadVersion(target.versionId));
      } else {
        setLostFailed(true);
      }
    } catch {
      setLostFailed(true);
    } finally {
      gate.current = false;
      setLostPending(false);
    }
  };

  return (
    <View>
      <SheetTitle>{t("rescueV2.reading.title")}</SheetTitle>

      <View style={[styles.file, { backgroundColor: colors.bgSurface, borderColor: colors.borderDefault }]}>
        <View style={[styles.docx, { backgroundColor: colors.brandWash }]}>
          <Text style={[styles.docxText, { color: colors.brandPrimary }]}>DOCX</Text>
        </View>
        <View style={styles.fileText}>
          <Text numberOfLines={1} style={[styles.fileName, { color: colors.textPrimary }]}>{fileName}</Text>
          <Text style={[styles.fileSize, { color: colors.textSecondary }]}>{t("rescueV2.reading.fileSize", { mb: (bytes / MB).toFixed(1) })}</Text>
        </View>
      </View>

      {lost ? (
        <View>
          <Text style={[styles.lost, { color: colors.textPrimary }]}>{t("rescueV2.reading.uploadLost")}</Text>
          {lostFailed ? <Text style={[styles.lost, { color: colors.semanticError }]}>{t("rescueV2.common.somethingWrong")}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: lostPending }}
            disabled={lostPending || !id}
            onPress={() => { void retryLost(); }}
            style={[styles.cta, { backgroundColor: colors.brandPrimary, opacity: lostPending ? 0.5 : 1 }]}
          >
            <Text style={[styles.ctaText, { color: colors.bgCard }]}>{t("rescueV2.reading.uploadAgain")}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.bar, { backgroundColor: colors.bgSurface }]}>
        {fraction === null ? (
          <SkeletonBlock width="100%" height={6} radius={3} />
        ) : (
          <View style={[styles.fill, { width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`, backgroundColor: colors.brandPrimary }]} />
        )}
      </View>

      <StepList steps={steps} />
      {converting ? <Text style={[styles.note, { color: colors.textSecondary }]}>{t("rescueV2.reading.converting")}</Text> : null}
      {waiting === "converter" ? <Text style={[styles.note, { color: colors.textSecondary }]}>{t("rescueV2.common.waitingWord")}</Text> : null}
    </View>
  );
}

const EMPTY_PARTS: never[] = [];

const styles = StyleSheet.create({
  stage: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  label: { position: "absolute", bottom: 4, fontSize: 12 },
  file: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 12 },
  docx: { width: 40, height: 48, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  docxText: { fontSize: 11, fontWeight: "800" },
  fileText: { flex: 1, gap: 2 },
  fileName: { fontSize: 15, fontWeight: "700" },
  fileSize: { fontSize: 12 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden", marginBottom: 14 },
  fill: { height: 6, borderRadius: 3 },
  note: { fontSize: 13, lineHeight: 18, marginTop: 6 },
  lost: { fontSize: 14, lineHeight: 20, marginBottom: 10 },
  cta: { height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  ctaText: { fontSize: 15, fontWeight: "800" },
});

export const ReadingStep: RescueStep = { Stage, Sheet };
