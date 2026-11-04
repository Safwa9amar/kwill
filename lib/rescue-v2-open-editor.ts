import { router } from "expo-router";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useThesisStore } from "@/stores/thesis-store";

/**
 * Opens a thesis in the workspace, the way screen 15 does: the list and the current thesis first, then the working copy revalidated (every
 * index moved under a re-run, P-66), then the route. The workspace reads its params and redirects to chat without them, so the order holds.
 * Throws when the list cannot be read; the caller shows that it failed, never that it opened.
 */
export async function openThesisEditor(thesisId: string): Promise<void> {
  await useThesisStore.getState().refreshTheses();
  useThesisStore.getState().setCurrentThesis(thesisId);
  void useThesisDocStore.getState().revalidate(thesisId);
  router.push({ pathname: "/(app)/thesis-workspace", params: { thesisId } });
}
