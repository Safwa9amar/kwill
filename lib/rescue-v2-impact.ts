import { getImpact } from "@/lib/rescue-v2-api";
import { useHistoryUi } from "@/stores/rescue-history-ui";

// What the saved choices would redo, read from the server. Shared by the edit-and-redo sheet and the restore dialog, so both show the same
// answer and both wait on the same read.

let impactSeq = 0;

/**
 * Reads the impact for `pid`. The reading is marked loading first, so a CTA waits for the reply. The last request wins; a reply for a project
 * that is no longer open (`isLive` false) is dropped.
 */
export async function loadImpact(pid: string, isLive: () => boolean): Promise<void> {
  const seq = ++impactSeq;
  if (isLive()) {
    const h = useHistoryUi.getState();
    h.setImpact(pid, "loading", h.key === pid ? h.impact.value : null);
  }
  try {
    const value = await getImpact(pid);
    if (seq === impactSeq && isLive()) useHistoryUi.getState().setImpact(pid, "ok", value);
  } catch {
    if (seq === impactSeq && isLive()) useHistoryUi.getState().setImpact(pid, "failed", null);
  }
}
