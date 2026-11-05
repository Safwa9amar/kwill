/**
 * Routing for a link the OS hands the app. Share → Kwill arrives as `<scheme>://expo-sharing` (expo-sharing emits it on Android and iOS).
 * Every other incoming path is returned unchanged: a relative path or a custom scheme with no host (a password reset, a payment return)
 * must reach the router as it is, so this never falls back to `/`.
 */
export function routeForIncoming(path: string): string {
  try {
    if (new URL(path).hostname === "expo-sharing") return "/rescue?share=1";
  } catch {
    // A relative path or a custom scheme with no host: not ours.
  }
  return path;
}
