import { router } from "expo-router";
import { requireListed } from "@/lib/thesis-open-check";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useThesisStore } from "@/stores/thesis-store";

/**
 * Opens a thesis in the workspace, the way screen 15 does: the list and the current thesis first, then the working copy revalidated (every
 * index moved under a re-run, P-66), then the route. The workspace reads its params and redirects to chat without them, so the order holds.
 * `refreshTheses` swallows its own failure and answers with the list it had, so the check is on the list: a thesis that is not in it
 * throws, and nothing is pushed. The caller shows that it failed, never that it opened.
 */
export async function openThesisEditor(thesisId: string): Promise<void> {
  requireListed(await useThesisStore.getState().refreshTheses(), thesisId);
  useThesisStore.getState().setCurrentThesis(thesisId);
  void useThesisDocStore.getState().revalidate(thesisId);
  router.push({ pathname: "/(app)/thesis-workspace", params: { thesisId } });
}
