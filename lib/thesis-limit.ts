import { Alert } from "react-native";
import { router } from "expo-router";
import i18n from "@/lib/i18n";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { useBillingStore } from "@/stores/billing-store";
import type { ThesisAllowance } from "@/types/billing";

// The plan's thesis ceiling, and the ONE wording every door uses to explain it.
//
// A free student may hold ONE thesis. The server refuses all four creation paths
// (POST /api/thesis, /import, /combine, and the assistant's create_thesis), and
// the starting-point screen shows the reason as a card before the student picks
// anything — but an import or a combine begins by asking for their files and then
// spends tens of seconds on them, so those two ask BEFORE the picker opens.
//
// Everything here is server-first: the cached counter is only a way to answer
// fast, and a stale one is how the student got this far. Being unable to read it
// lets them THROUGH — the server still refuses, and a counter we could not load
// must never be the thing that stops somebody who is entitled.

/** What the wording needs: how many are allowed, and how many are held. */
type LimitFacts = { limit?: number | null; used?: number };

function facts(from?: LimitFacts): { limit: number; used: number } {
  const cached = useBillingStore.getState().thesisAllowance;
  const limit = from?.limit ?? cached?.limit ?? 1;
  return { limit: limit ?? 1, used: from?.used ?? cached?.used ?? limit ?? 1 };
}

/**
 * The heading. "Your free plan holds one thesis" reads as a fact about the plan;
 * "you have reached a limit" reads as a telling-off, which is the same
 * information delivered worse.
 */
export function thesisLimitTitle(from?: LimitFacts): string {
  const { limit } = facts(from);
  return limit === 1 ? i18n.t("thesisLimit.titleOne") : i18n.t("thesisLimit.title", { count: limit });
}

/**
 * The sentence under it — always naming the ways out, never only the wall.
 * On iOS "move to a plan" is a way out the app may not name (lib/purchases.ts),
 * so the wording there stops at write-on or delete.
 */
export function thesisLimitBody(from?: LimitFacts): string {
  const { limit, used } = facts(from);
  if (limit === 1) {
    return i18n.t(PURCHASES_HIDDEN ? "thesisLimit.bodyOneStatus" : "thesisLimit.bodyOne");
  }
  return i18n.t(PURCHASES_HIDDEN ? "thesisLimit.bodyStatus" : "thesisLimit.body", { used, limit });
}

/**
 * May another thesis be created? Refreshes the allowance first.
 *
 * True when there is room OR when the answer could not be determined.
 */
export async function canCreateAnotherThesis(): Promise<boolean> {
  await useBillingStore.getState().refreshQuota();
  return useBillingStore.getState().thesisAllowance?.canCreate ?? true;
}

/**
 * The same question, and it tells the student when the answer is no.
 *
 * An alert rather than a card: this is a hard stop on a tap already made, with
 * nowhere on screen for a card to live. It carries the way out — a refusal with
 * no next step is just a wall.
 *
 * Returns true when the caller may proceed.
 */
export async function guardThesisLimit(): Promise<boolean> {
  if (await canCreateAnotherThesis()) return true;
  showThesisLimitAlert();
  return false;
}

/**
 * Say it, from a refusal the server has already given.
 *
 * Used by the flows that could not ask first — the wizard's final create, an
 * import or a combine whose count moved underneath it (another device, a second
 * session). `from` is the 402 body's own counts, which outrank anything cached.
 */
export function showThesisLimitAlert(from?: LimitFacts): void {
  Alert.alert(thesisLimitTitle(from), thesisLimitBody(from), [
    { text: i18n.t("common.cancel"), style: "cancel" },
    {
      text: i18n.t(PURCHASES_HIDDEN ? "payment.myPlan" : "payment.viewPlans"),
      onPress: () => router.push("/(app)/subscription" as any),
    },
  ]);
}

/** Fold a server refusal into the store so the next tap is answered locally. */
export function rememberThesisLimit(from: LimitFacts & { plan?: string }): void {
  useBillingStore.getState().applyThesisLimit(from);
}

export type { ThesisAllowance };
