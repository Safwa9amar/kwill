import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { usePathname } from "expo-router";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";
import { consumeColdStartNotificationRoute, setPushBannerFilter } from "@/lib/push-notifications";
import { listRescueProjects } from "@/lib/rescue-v2-api";
import { goToNotified } from "@/lib/rescue-v2-navigate";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

// A route pushed twice within this window is one push: some Android versions deliver a cold-start tap to both this hook and the listener.
const DUPLICATE_WINDOW_MS = 2000;
let lastPushedRoute = "";
let lastPushedAt = 0;

function pushOnce(route: string) {
  const now = Date.now();
  if (route === lastPushedRoute && now - lastPushedAt < DUPLICATE_WINDOW_MS) return;
  lastPushedRoute = route;
  lastPushedAt = now;
  // The tap listener may route the same push too: NAVIGATE keeps one living screen where a second push stacked another.
  goToNotified(route);
}

/**
 * Where a cold start lands (plan A9 step 5, P-35): a push that launched the app, then a file shared before sign-in, then a project in
 * progress touched in the last day. Otherwise the app opens as it does today. Gated like the deep link hook: a navigation before the router
 * exists is silently dropped. Off with the release flag.
 */
export function useRescueColdStart(ready: boolean) {
  const did = useRef(false);
  // The entry route ("/", app/index.tsx) answers with a <Redirect> to the chat, which REPLACES the top of the stack. A push issued before
  // it has run is replaced by the chat: a tapped push on a killed app opened the chat instead of its screen (W8). The resume below only
  // escaped it because it waits on the network first. So nothing navigates until the app has left "/".
  const pathname = usePathname();
  const settled = ready && pathname !== "/";

  // A push for the screen the student is already on does not interrupt it (plan A9 step 4).
  useEffect(() => {
    if (!RESCUE_V2_ENABLED) return;
    setPushBannerFilter((d) => {
      const s = useRescueV2Store.getState();
      return s.screenOpen && d?.projectId === s.projectId;
    });
  }, []);

  useEffect(() => {
    if (!settled || did.current || !RESCUE_V2_ENABLED) return;
    did.current = true;
    (async () => {
      const route = consumeColdStartNotificationRoute();
      if (route) { pushOnce(route); return; }
      if (Platform.OS !== "web") {
        // A file shared before sign-in is still waiting natively. Its own try: on iOS this THROWS on any binary without A10's plugin config
        // (no ExpoShareIntoAppGroupId in Info.plist), and that must not stop the resume below.
        try {
          const Sharing = await import("expo-sharing");
          if (Sharing.getSharedPayloads().length > 0) { pushOnce("/(app)/rescue?share=1"); return; }
        } catch {
          // No share config in this binary: no payload.
        }
      }
      const { projects } = await listRescueProjects();
      const active = projects.find((p) => p.resumeOnOpen);
      if (active) pushOnce(`/(app)/rescue?projectId=${encodeURIComponent(active.id)}`);
    })().catch((err) => {
      // The resume is a convenience: the app opens where it always does, and the drawer and the card still lead to the rescue.
      console.warn("[rescue] cold-start resume failed", err);
    });
  }, [settled]);
}
