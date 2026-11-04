import { useCallback } from "react";
import { BackHandler } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { ackVersion } from "@/lib/rescue-v2-api";
import { backFor, screenFor } from "@/lib/rescue-v2-screen";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

/** The acknowledgement in flight: a second tap while it is out does nothing (the server answers once). */
let acking = false;

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
    if (versionId && !acking) {
      acking = true;
      void s.apply(() => ackVersion(versionId)).finally(() => { acking = false; });
    }
    return true;
  }
  s.setNav(r);
  return true;
}

/**
 * Android back, for the living screen. iOS has no hardware back; StageChrome draws the way out there. Registered through the focus effect,
 * so it is only live while /rescue is the focused route: a back press on a screen pushed over it belongs to that screen.
 */
export function useRescueBack() {
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", rescueBack);
    return () => sub.remove();
  }, []));
}
