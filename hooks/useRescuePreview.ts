import { useCallback, useEffect, useState } from "react";
import { getRescuePreview, type RescuePreviewDTO } from "@/lib/rescue-v2-api";

export type PreviewStatus = "idle" | "loading" | "ready" | "failed";

type Entry = { key: string; status: Exclude<PreviewStatus, "idle"> ; data: RescuePreviewDTO | null };

/**
 * The watermarked preview of one project, read once per project. `enabled` is the project's `previewReady`: until then nothing is asked.
 * A reply for a project the student has left is dropped, and a failure is a visible state the screen can retry, never a silent blank.
 */
export function useRescuePreview(projectId: string | null, enabled: boolean) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!projectId || !enabled) return;
    let alive = true;
    setEntry({ key: projectId, status: "loading", data: null });
    getRescuePreview(projectId).then(
      (data) => { if (alive) setEntry({ key: projectId, status: "ready", data }); },
      () => { if (alive) setEntry({ key: projectId, status: "failed", data: null }); },
    );
    return () => { alive = false; };
  }, [projectId, enabled, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  // An entry for another project never answers for this one.
  const current = entry && entry.key === projectId ? entry : null;
  const status: PreviewStatus = !projectId || !enabled ? "idle" : current?.status ?? "loading";
  return { status, data: current?.status === "ready" ? current.data : null, retry };
}
