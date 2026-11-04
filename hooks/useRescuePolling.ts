import { useEffect } from "react";
import { AppState } from "react-native";
import { needsPolling } from "@/lib/rescue-v2-screen";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

// One poll at a time, across every mount: a request slower than the 3 s tick must not stack a second poll behind it (its reply could land late).
let pollInFlight = false;

// Polls the open project every 3 s while a run is going on, in the foreground only (P-13). No SSE.
export function useRescuePolling() {
  const polling = useRescueV2Store((s) => needsPolling(s.project));
  const refresh = useRescueV2Store((s) => s.refresh);
  // Re-read on every return: a run may have finished, or a payment landed, while the app slept. Never re-POST anything.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void refresh(); });
    return () => sub.remove();
  }, [refresh]);
  useEffect(() => {
    if (!polling) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = () => {
      if (pollInFlight) return;
      pollInFlight = true;
      void refresh().finally(() => { pollInFlight = false; });
    };
    const start = () => { if (!timer) timer = setInterval(poll, 3000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", (s) => (s === "active" ? start() : stop()));
    return () => { stop(); sub.remove(); };
  }, [polling, refresh]);
}
