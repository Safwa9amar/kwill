import { useCallback, useEffect } from "react";
import { getRescuePreview } from "@/lib/rescue-v2-api";
import { usePreviewView, type PreviewStatus } from "@/stores/rescue-preview-view";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

export type { PreviewStatus };

/**
 * The watermarked preview of one project at its working version, read once per project and version and shared by every screen that shows it
 * (the stage and the sheet), so a Retry in one reaches the other. `enabled` is the project's `previewReady`: until then nothing is asked.
 * A reply for a project or version the student has left is dropped; a failure is a visible state the sheet can retry, never a silent blank.
 */
export function useRescuePreview(projectId: string | null, enabled: boolean) {
  const working = useRescueV2Store((s) => s.project?.activeVersionId ?? s.project?.originalVersionId ?? null);
  const pid = projectId && enabled && working ? projectId : null;
  const vid = pid ? working : null;

  useEffect(() => {
    if (!pid || !vid) { usePreviewView.getState().clear(); return; }
    usePreviewView.getState().load(pid, vid, getRescuePreview);
  }, [pid, vid]);

  // The state only answers for the project and version it holds: another one reads as loading until its own read lands.
  const status = usePreviewView((s) => (!pid ? "idle" : s.projectId === pid && s.versionId === vid ? s.status : "loading"));
  const data = usePreviewView((s) => (pid && s.projectId === pid && s.versionId === vid && s.status === "ready" ? s.data : null));
  const retry = useCallback(() => { usePreviewView.getState().retry(getRescuePreview); }, []);

  return { status, data, retry };
}
