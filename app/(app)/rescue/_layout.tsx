import { Stack } from "expo-router";
import { useDrawerSwipeLock } from "@/hooks/useDrawerSwipeLock";

// No gestures on this stack, and the drawer's edge swipe is off here (P-36). The shell draws the way out of every step (StageChrome).
export default function RescueLayout() {
  useDrawerSwipeLock();
  return <Stack screenOptions={{ headerShown: false, animation: "none", gestureEnabled: false }} />;
}
