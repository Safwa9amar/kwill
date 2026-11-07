import React, { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { RescueSkeleton } from "@/components/skeletons/RescueSkeleton";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescuePolling } from "@/hooks/useRescuePolling";
import { useRescueBack } from "@/hooks/useRescueBack";
import type { RescuePhase } from "@/types/rescue-v2";
import { useRescueScreen, useRescueV2Store } from "@/stores/rescue-v2-store";
import { RESCUE_STEPS } from "./steps";
import { FailureStep } from "./steps/FailureStep";
import { LivingSheet } from "./LivingSheet";
import { RescueStage } from "./RescueStage";
import { ShareInbox } from "./ShareInbox";
import { StageChrome } from "./StageChrome";

interface Props {
  projectId?: string;
  view?: string;
  share?: boolean;
  fixture?: RescuePhase;
}

/** The one screen of the rescue: the student's pages fill the top, one sheet below changes per step, nothing navigates between steps. */
export function LivingScreen({ projectId, view, share, fixture }: Props) {
  useRescuePolling();
  const screen = useRescueScreen();
  const firstLoad = useRescueV2Store((s) => s.firstLoad);
  const openFailed = useRescueV2Store((s) => s.openFailed);
  const colors = useThemeColors();
  const animatedPosition = useSharedValue(0);
  useEffect(() => {
    useRescueV2Store.getState().setScreenOpen(true);
    return () => useRescueV2Store.getState().setScreenOpen(false);
  }, []);
  // `view` (the library's Redo or History chip) is applied by `open` once the project has landed, after the phase change that would clear it (A1),
  // so a Retry of a failed open lands on the same view.
  useEffect(() => {
    const s = useRescueV2Store.getState();
    void s.loadConfig();
    void s.open(projectId ?? null, fixture, view);
  }, [projectId, fixture, view]);
  useRescueBack();                       // Android back: previous local step, else router.back()
  // The skeleton is a full page with no way out of it, so the chrome draws the close button over it: a slow first load can always be left.
  if (firstLoad) return <View style={{ flex: 1 }}><RescueSkeleton /><StageChrome screen={screen} /></View>;
  // A project that could not be read is not a new rescue: it never falls through to the upload screen (the start).
  if (openFailed) return <View style={{ flex: 1 }}><OpenFailed /><StageChrome screen={screen} /></View>;
  if (screen === "failure") {
    // A full page with no sheet. The chrome still draws the way out.
    return (
      <View style={{ flex: 1 }}>
        <FailureStep />
        <StageChrome screen={screen} />
      </View>
    );
  }
  const step = RESCUE_STEPS[screen];
  return (
    // The stage's colour under everything: the sheet's scaled corner is taller than the stage's overlap, and in dark mode a light root
    // showed through as a wedge at each top corner.
    <View style={{ flex: 1, backgroundColor: colors.rescueStageBottom }}>
      <RescueStage animatedPosition={animatedPosition}><step.Stage /><StageChrome screen={screen} /></RescueStage>
      <LivingSheet screen={screen} step={step} animatedPosition={animatedPosition} />
      {share && <ShareInbox />}
    </View>
  );
}

/** The failed state of an open that found no project: one calm line and Retry. Retry repeats the open with the view it was asked for. */
function OpenFailed() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const retryLast = useRescueV2Store((s) => s.retryLast);
  return (
    // Its own page colour: nothing is drawn under it, and the navigator's default is light, which left the line white on light grey in dark mode.
    <View style={[styles.failed, { backgroundColor: colors.bgPrimary }]}>
      <Text style={[styles.failedText, { color: colors.textPrimary }]}>{t("rescueV2.common.openFailed")}</Text>
      <Button title={t("rescueV2.common.retry")} onPress={() => { void retryLast(); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  failed: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  failedText: { fontSize: 15, lineHeight: 22, textAlign: "center" },
});
