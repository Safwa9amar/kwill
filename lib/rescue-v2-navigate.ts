import { router } from "expo-router";
import { rescueRouteTarget } from "./rescue-v2-notify";

/**
 * Goes to a route a push or a cold start names. A rescue project's route NAVIGATEs: with the living screen already on top, the stack
 * keeps that one screen and gives it the new params, where a push laid a second living screen over it (both read one store, and the one
 * left under it showed the other's project). Anywhere else, NAVIGATE pushes as before. Every other route is pushed, unchanged.
 */
export function goToNotified(to: string): void {
  if (rescueRouteTarget(to)) router.navigate(to as never);
  else router.push(to as never);
}
