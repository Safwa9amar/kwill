import React, { useEffect } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { DoneBadge } from "@/components/rescue/DoneBadge";
import { PageImage } from "@/components/rescue/PageImage";
import { SheetTitle, StepList } from "@/components/rescue/ui";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { hSuccess } from "@/lib/haptics";
import { repairBar, repairEta, repairSlots, repairWindow, type RepairSlot } from "@/lib/rescue-v2-finish";
import { layoutSpring } from "@/lib/motion";
import { scaleFor, STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualTextAlign } from "@/lib/rtl-layout";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueStep } from "./index";

/** The brand outline that breathes over the newest finished page: the work still going on. Its driver is cancelled on unmount. */
function PulseOutline() {
  const colors = useThemeColors();
  const v = useSharedValue(0.35);
  useEffect(() => {
    v.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
    return () => { cancelAnimation(v); };
  }, [v]);
  const style = useAnimatedStyle(() => ({ opacity: v.value }));
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.outline, { borderColor: colors.brandPrimary }, style]} />;
}

/**
 * Screen 13, the stage. Grey pages of v0 until a page of the new version is finished; then the finished pages turn in front of the student.
 * Built from the server's state on every open: `pagesReady` and the active version are all it reads.
 */
function Stage() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const project = useRescueV2Store((st) => st.project);
  const rtl = useRescueV2Store((st) => thesisIsRtl(st.project));

  // The repair finished while this screen was up: the phase is `done` at the moment the screen goes. A repair the student left, or a
  // phase that changed under a closed app, makes no sound (the done push does its own job, Task A9).
  useEffect(() => {
    return () => {
      if (useRescueV2Store.getState().project?.phase === "done") hSuccess();
    };
  }, []);

  const v0 = project?.originalVersionId ?? null;
  const active = project?.activeVersionId ?? null;
  const ready = project?.progress?.pagesReady ?? 0;
  const total = project?.progress?.pagesTotal ?? 0;
  const layout = STAGE_LAYOUT.repairing;
  if (!v0 || layout.kind !== "three") return null;

  const hasActive = !!active && active !== v0;
  const [side, mid, third] = repairSlots(ready, hasActive);
  const [mw, mh] = [layout.mid[0] * s, layout.mid[1] * s];
  const [sw, sh] = [layout.side[0] * s, layout.side[1] * s];
  // Physical order: side, middle, third. A Right-to-left thesis reads from the right, so the order mirrors (as PageCarousel does).
  const entries: { role: "side" | "mid" | "third"; slot: RepairSlot }[] = [
    { role: "side", slot: side }, { role: "mid", slot: mid }, { role: "third", slot: third },
  ];
  const ordered = rtl ? [...entries].reverse() : entries;

  return (
    <View style={styles.stage}>
      <View style={styles.row}>
        {ordered.map(({ role, slot }) => {
          const w = role === "mid" ? mw : sw;
          const h = role === "mid" ? mh : sh;
          const vid = slot.from === "active" && active ? active : v0;
          return (
            <Animated.View key={role} layout={layoutSpring} style={{ width: w, height: h }}>
              <PageImage versionId={vid} page={slot.page} width={w} height={h} dim={slot.dim} />
              {role === "side" && slot.done ? <DoneBadge /> : null}
              {role === "mid" && slot.shimmer ? <PulseOutline /> : null}
            </Animated.View>
          );
        })}
      </View>
      {total > 0 && ready > 0 ? (
        <Text style={[styles.pageOf, { color: colors.textSecondary }]}>{t("rescueV2.common.pageOf", { page: ready, total })}</Text>
      ) : null}
    </View>
  );
}

/**
 * The sheet: the eight-part bar from the server's step (it only moves up), the step in words with the time left, and the window of steps.
 * The server's `waiting` replaces the number while the brain or Word holds the run.
 */
function Sheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const progress = useRescueV2Store((s) => s.project?.progress ?? null);
  const waiting = useRescueV2Store((s) => s.project?.waiting ?? null);
  const step = progress?.step ?? 1;
  const bar = repairBar(step);
  const rows = repairWindow(progress?.stepKey ?? null, step);
  const eta = repairEta(progress?.etaSeconds ?? null, waiting);
  const line = [
    progress ? t("rescueV2.repairing.stepOf", { n: progress.step, total: progress.of }) : null,
    eta ? t(`rescueV2.${eta.key}`, eta.params) : null,
  ].filter((x): x is string => !!x).join(" · ");

  return (
    <View>
      <SheetTitle>{t("rescueV2.repairing.title")}</SheetTitle>
      <View style={styles.bar}>
        {bar.map((state, i) => (
          <View
            key={i}
            style={[styles.seg, { backgroundColor: state === "done" ? colors.semanticSuccess : state === "current" ? colors.brandPrimary : colors.borderSubtle }]}
          />
        ))}
      </View>
      {line ? <Text style={[styles.line, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{line}</Text> : null}
      <StepList steps={rows.map((r) => ({ key: r.key, label: t(`rescueV2.repairing.steps.${r.key}`), state: r.state }))} />
    </View>
  );
}

/** The fine print: the repair goes on if the student closes the app. */
function Foot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return <Text style={[styles.fine, { color: colors.textSecondary }]}>{t("rescueV2.repairing.safe")}</Text>;
}

export const RepairingStep: RescueStep = { Stage, Sheet, Foot };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, direction: "ltr" },
  pageOf: { position: "absolute", bottom: 26, fontSize: 13, fontWeight: "700" },
  outline: { borderWidth: 2, borderRadius: 4 },
  bar: { flexDirection: "row", gap: 4, direction: "ltr", marginBottom: 10 },
  seg: { flex: 1, height: 6, borderRadius: 3 },
  line: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
  fine: { fontSize: 12, lineHeight: 17, textAlign: "center", paddingBottom: 6 },
});
