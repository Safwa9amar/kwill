import React from "react";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { SegSwitch } from "@/components/rescue/SegSwitch";
import { SweepFade } from "@/components/rescue/SweepFade";
import { SkeletonPage } from "@/components/rescue/SkeletonPage";
import { Pill, SheetBody, SheetTitle } from "@/components/rescue/ui";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescuePreview } from "@/hooks/useRescuePreview";
import { STAGE_LAYOUT, scaleFor } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueStep } from "./index";
import { ContinueFoot } from "./DiagnosisStep";

/** A paper with nothing on it: the third slot, and the middle when the thesis has no chapter page. Never a skeleton. */
function BlankPaper({ width, height }: { width: number; height: number }) {
  const colors = useThemeColors();
  return <View style={[styles.paper, { width, height, backgroundColor: colors.rescuePaper }]} />;
}

function Stage() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const project = useRescueV2Store((st) => st.project);
  const setNav = useRescueV2Store((st) => st.setNav);
  const preview = useRescuePreview(project?.id ?? null, !!project?.previewReady);
  const rtl = thesisIsRtl(project);
  const layout = STAGE_LAYOUT.preview;
  if (layout.kind !== "three") return null;
  const [mw, mh] = [layout.mid[0] * s, layout.mid[1] * s];
  const [sw, sh] = [layout.side[0] * s, layout.side[1] * s];

  // Slots in reading order: the cover, the chapter, then a blank paper. An Arabic thesis reads right to left, so the order is reversed,
  // the same rule PageCarousel uses.
  const ready = preview.status === "ready" && preview.data;
  const cover = ready && preview.data ? (
    <SweepFade before={preview.data.cover.beforeUrl} after={preview.data.cover.afterUrl} width={sw} height={sh} on rtl={rtl} />
  ) : preview.status === "loading" ? <SkeletonPage width={sw} height={sh} /> : <BlankPaper width={sw} height={sh} />;
  const chapterData = ready && preview.data ? preview.data.chapter : null;
  const chapter = chapterData ? (
    <SweepFade before={chapterData.beforeUrl} after={chapterData.afterUrl} width={mw} height={mh} on rtl={rtl} />
  ) : preview.status === "loading" ? <SkeletonPage width={mw} height={mh} /> : <BlankPaper width={mw} height={mh} />;
  const slots = rtl ? [{ key: "blank", node: <BlankPaper width={sw} height={sh} /> }, { key: "chapter", node: chapter }, { key: "cover", node: cover }]
    : [{ key: "cover", node: cover }, { key: "chapter", node: chapter }, { key: "blank", node: <BlankPaper width={sw} height={sh} /> }];

  return (
    <View style={[styles.stage, { paddingTop: insets.top + 12 }]}>
      <SegSwitch
        options={[
          { key: "before", label: t("rescueV2.diagnosis.before") },
          { key: "after", label: t("rescueV2.diagnosis.after") },
        ]}
        value="after"
        onChange={(k) => setNav({ diagnosisTab: k })}
      />
      <View style={styles.middle}>
        <View style={[styles.row, { direction: "ltr" }]}>
          {slots.map((sl) => <View key={sl.key}>{sl.node}</View>)}
        </View>
      </View>
    </View>
  );
}

function Sheet() {
  const { t } = useTranslation();
  const project = useRescueV2Store((st) => st.project);
  const preview = useRescuePreview(project?.id ?? null, !!project?.previewReady);
  const colors = useThemeColors();

  if (!project?.previewReady) {
    return <SheetBody>{t("rescueV2.preview.unavailable")}</SheetBody>;
  }
  if (preview.status === "failed") {
    return (
      <>
        <SheetTitle>{t("rescueV2.preview.title")}</SheetTitle>
        <SheetBody>{t("rescueV2.preview.unavailable")}</SheetBody>
        <TouchableOpacity accessibilityRole="button" onPress={preview.retry} hitSlop={8}>
          <Text style={[styles.retry, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      </>
    );
  }
  const coverOnly = preview.status === "ready" && preview.data !== null && preview.data.chapter === null;
  return (
    <>
      <SheetTitle>{t("rescueV2.preview.title")}</SheetTitle>
      <SheetBody>{t(coverOnly ? "rescueV2.preview.bodyCoverOnly" : "rescueV2.preview.body")}</SheetBody>
      <Pill label={t("rescueV2.preview.pill")} />
    </>
  );
}

export const PreviewStep: RescueStep = { Stage, Sheet, Foot: ContinueFoot };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center" },
  middle: { flex: 1, justifyContent: "center", alignItems: "center", width: "100%" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  paper: { borderRadius: 3, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 3 },
  retry: { fontSize: 14, fontWeight: "700", marginBottom: 12 },
});
