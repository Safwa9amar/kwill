import { routeForIncoming } from "@/lib/rescue-v2-share";

// expo-router calls this for every incoming link, including the share intent. See lib/rescue-v2-share.ts.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return routeForIncoming(path);
}
