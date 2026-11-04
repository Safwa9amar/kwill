import { create } from "zustand";
import type { RescuePreviewDTO } from "@/lib/rescue-v2-api";

// The watermarked preview of one project at one version, shared by the stage (which shows it) and the sheet (which retries it). Both are
// rendered in different trees, so the state lives here. It belongs to one project and version: a change of either drops it.

export type PreviewStatus = "idle" | "loading" | "ready" | "failed";
export type PreviewRead = (projectId: string) => Promise<RescuePreviewDTO>;

interface PreviewViewState {
  projectId: string | null;
  versionId: string | null;
  status: PreviewStatus;
  data: RescuePreviewDTO | null;
  /** Numbers each read; a reply lands only when it is the newest read, so a late reply for a left project never shows. */
  seq: number;
  /** Starts the read for this project and version, unless it is already loading, ready or failed for them. */
  load(projectId: string, versionId: string, read: PreviewRead): void;
  /** The Retry: asks again for the project and version the state holds. */
  retry(read: PreviewRead): void;
  clear(): void;
}

export const usePreviewView = create<PreviewViewState>()((set, get) => {
  const start = (projectId: string, versionId: string, read: PreviewRead) => {
    const seq = get().seq + 1;
    set({ projectId, versionId, status: "loading", data: null, seq });
    read(projectId).then(
      (data) => { if (get().seq === seq) set({ status: "ready", data }); },
      () => { if (get().seq === seq) set({ status: "failed", data: null }); },
    );
  };

  return {
    projectId: null,
    versionId: null,
    status: "idle",
    data: null,
    seq: 0,

    load: (projectId, versionId, read) => {
      const s = get();
      if (s.projectId === projectId && s.versionId === versionId && s.status !== "idle") return;
      start(projectId, versionId, read);
    },

    retry: (read) => {
      const { projectId, versionId } = get();
      if (projectId && versionId) start(projectId, versionId, read);
    },

    clear: () => set((s) => ({ projectId: null, versionId: null, status: "idle", data: null, seq: s.seq + 1 })),
  };
});
