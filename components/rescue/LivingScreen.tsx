import React, { useEffect } from "react";
import { View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { RescueSkeleton } from "@/components/skeletons/RescueSkeleton";
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
  const animatedPosition = useSharedValue(0);
  useEffect(() => {
    useRescueV2Store.getState().setScreenOpen(true);
    return () => useRescueV2Store.getState().setScreenOpen(false);
  }, []);
  // The view is applied after `open` resolves, not beside it: `open` is a phase change, and a phase change clears overlays (A1),
  // so the first project load would erase it and the student would land on the result instead of the timeline. Tested from a cold load.
  useEffect(() => {
    const s = useRescueV2Store.getState();
    void s.loadConfig();
    void s.open(projectId ?? null, fixture).then(() => {
      if (view === "history") useRescueV2Store.getState().setNav({ overlay: "timeline" });
      if (view === "revisions") useRescueV2Store.getState().setNav({ overlay: "revisions" });   // the library's Redo chip
    });
  }, [projectId, fixture, view]);
  useRescueBack();                       // Android back: previous local step, else router.back()
  // The skeleton is a full page with no way out of it, so the chrome draws the close button over it: a slow first load can always be left.
  if (firstLoad) return <View style={{ flex: 1 }}><RescueSkeleton /><StageChrome screen={screen} /></View>;
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
    <View style={{ flex: 1 }}>
      <RescueStage animatedPosition={animatedPosition}><step.Stage /><StageChrome screen={screen} /></RescueStage>
      <LivingSheet screen={screen} step={step} animatedPosition={animatedPosition} />
      {share && <ShareInbox />}
    </View>
  );
}
