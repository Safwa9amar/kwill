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
 * one place every thesis lives. A held publish opens History of its project. Every other route is unchanged.
 */
export function notifyRoute(route: string, data: RescueNotifyData | null | undefined, enabled: boolean): string {
  if (!enabled || !route.startsWith("/(app)/rescue")) return route;
  const projectId = typeof data?.projectId === "string" && data.projectId !== "" ? data.projectId : null;
  if (!projectId) return "/(app)/rescue/library";
  if (data?.event === "publishHeld") {
    return `/(app)/rescue?projectId=${encodeURIComponent(projectId)}&view=history`;
  }
  return route;
}

/** Whether a notification row is a held publish, so its words come from the app and not from the server's copy. */
export function isPublishHeld(data: RescueNotifyData | null | undefined): boolean {
  return data?.event === "publishHeld";
}
