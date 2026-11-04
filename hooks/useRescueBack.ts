import { useEffect } from "react";
import { BackHandler } from "react-native";
import { router } from "expo-router";
import { ackVersion } from "@/lib/rescue-v2-api";
import { backFor, screenFor } from "@/lib/rescue-v2-screen";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

/**
 * The one way back out of a step: the BackPill and Android's back both call it. A local step first (backFor), else leave the route.
 * Returns false only when there is nowhere to go, so the OS takes the back press.
 */
export function rescueBack(): boolean {
  const s = useRescueV2Store.getState();
  const r = backFor(screenFor(s.project, s.nav), s.nav, s.project);
  if (r === null) {
    if (!router.canGoBack()) return false;
    router.back();
    return true;
  }
  if (r === "ack") {
    // not_same_thesis: the version is acknowledged on the server; the phase then falls to `done` and the screen to `result`.
    const versionId = s.project?.failure?.versionId;
    if (versionId) void s.apply(() => ackVersion(versionId));
    return true;
  }
  s.setNav(r);
  return true;
}

/** Android back, for the living screen. iOS has no hardware back; StageChrome draws the way out there. */
export function useRescueBack() {
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", rescueBack);
    return () => sub.remove();
  }, []);
}
