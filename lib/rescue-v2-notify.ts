/**
 * Where a rescue notification's tap goes (plan §1.8, Task S13). Pure: the callers pass the route and the data the push or the bell row
 * carries. With the release flag off, a route is never changed.
 */

export interface RescueNotifyData {
  route?: unknown;
  projectId?: unknown;
  /** The rescue event, when the server sends it. A `publishHeld` opens History, so the student can choose the version. */
  event?: unknown;
}

/**
 * The route a notification opens. A rescue notice with no project (a refund for a project since deleted) opens the library, which is the
 * one place every thesis lives. A held publish opens History of its project, a rejected payment its payment screen. Every other route is
 * unchanged, except a pre-drawer "/(tabs)/…" route, which opens its "(app)" screen whatever the flag.
 */
export function notifyRoute(route: string, data: RescueNotifyData | null | undefined, enabled: boolean): string {
  // The server still names the chat by its pre-drawer path ("/(tabs)/chat"), and old rows keep it. No "(tabs)" group exists any more:
  // every screen lives under "(app)", so a tap on such a push opened the not-found screen.
  if (route.startsWith("/(tabs)/")) return `/(app)/${route.slice("/(tabs)/".length)}`;
  if (!enabled || !route.startsWith("/(app)/rescue")) return route;
  const projectId = typeof data?.projectId === "string" && data.projectId !== "" ? data.projectId : null;
  if (!projectId) return "/(app)/rescue/library";
  if (data?.event === "publishHeld") {
    return `/(app)/rescue?projectId=${encodeURIComponent(projectId)}&view=history`;
  }
  // A rejected payment opens screen 9, where the reason is (W3, W8): the project is still `diagnosed`, which alone opens screen 6.
  if (data?.event === "paymentRejected") {
    return `/(app)/rescue?projectId=${encodeURIComponent(projectId)}&view=payment`;
  }
  return route;
}

/** Whether a notification row is a held publish, so its words come from the app and not from the server's copy. */
export function isPublishHeld(data: RescueNotifyData | null | undefined): boolean {
  return data?.event === "publishHeld";
}

/**
 * The project a route or deep link opens on the living screen (`/(app)/rescue?projectId=…`, `kwill://rescue?projectId=…`), with its
 * `view`, or null for anything else (the library included). Used to re-read a project that is ALREADY open: the screen's params do not
 * change, so its open effect never fires again, and a staff decision stayed off screen until the app went to the background.
 */
export function rescueRouteTarget(route: string | null | undefined): { projectId: string; view?: string } | null {
  if (typeof route !== "string") return null;
  const q = route.indexOf("?");
  const path = (q < 0 ? route : route.slice(0, q)).replace(/\/+$/, "");
  if (!/(^|[/:])rescue$/.test(path)) return null;
  const params: Record<string, string> = {};
  for (const pair of (q < 0 ? "" : route.slice(q + 1)).split("#")[0].split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    try { params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")); } catch { /* a malformed pair is skipped */ }
  }
  const projectId = params.projectId;
  if (!projectId) return null;
  return params.view ? { projectId, view: params.view } : { projectId };
}
