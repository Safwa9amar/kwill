import type { RescueEntitlementDTO } from "@/types/rescue-v2";

// The decision behind screen 9 (the payment), as pure data so it can be tested under node. The component renders what this says and
// never decides for itself: on iOS everything is status, and every money word is one of these branches.

export type PaymentMethod = "manual" | "card";
type PurchaseState = RescueEntitlementDTO["purchase"]["state"];

/** Where the browser returns after a card payment (the same scheme subscription.tsx uses). */
export const RESCUE_RETURN_SCHEME = "kwill://payment";

/** How long to re-read the project after a card payment comes back: the webhook grants, and races the browser. */
export const GRANT_POLL_MS = [0, 600, 1500, 3000, 5000, 8000];

/** The methods the server has open, manual first. */
export function methodsFor(c: { manualEnabled: boolean; cardEnabled: boolean }): PaymentMethod[] {
  const out: PaymentMethod[] = [];
  if (c.manualEnabled) out.push("manual");
  if (c.cardEnabled) out.push("card");
  return out;
}

export type PaymentView =
  | { kind: "status" }
  | { kind: "offer"; methods: PaymentMethod[]; defaultMethod: PaymentMethod }
  | { kind: "notForSale" }
  | { kind: "underReview" }
  | { kind: "rejected"; cta: boolean; defaultMethod: PaymentMethod | null }
  | { kind: "confirming" }
  | { kind: "refundDue" };

/**
 * What the payment sheet shows. iOS is status only, whatever the purchase state (App Store 3.1.1, P-23). On Android a student with no
 * purchase is offered the rescue when it is for sale and at least one method is open; otherwise the sheet says it is not for sale.
 */
export function paymentView(input: {
  ios: boolean;
  state: PurchaseState;
  forSale: boolean;
  manualEnabled: boolean;
  cardEnabled: boolean;
}): PaymentView {
  if (input.ios) return { kind: "status" };
  const methods = methodsFor(input);
  const defaultMethod = methods[0] ?? null;
  switch (input.state) {
    case "none":
    case "refunded":
      if (!input.forSale || methods.length === 0) return { kind: "notForSale" };
      return { kind: "offer", methods, defaultMethod: methods[0] };
    case "pending_manual":
      return { kind: "underReview" };
    case "rejected_manual":
      return { kind: "rejected", cta: defaultMethod !== null, defaultMethod };
    // A card checkout still open is offered again: the server answers a second checkout with the same open URL (S14), so it is not a second
    // charge. A paid row is being granted, so it is confirmed, never offered.
    case "pending_card":
      if (!input.forSale || methods.length === 0) return { kind: "notForSale" };
      return { kind: "offer", methods, defaultMethod: methods[0] };
    case "paid":
      return { kind: "confirming" };
    case "refund_due":
      return { kind: "refundDue" };
  }
}

/** The 402 a plan's included rescues answer with once they are spent this month (P-58). */
export const ALLOWANCE_USED = "rescue_allowance_used";

/**
 * The fine line under the payment CTA. A subscriber whose included repairs are spent is told so, not that the repair is in their plan. The
 * refusal is the code the continue answered with (null when it was not refused). Nothing about money on iOS.
 */
export function paymentNoteKey(input: { ios: boolean; refusal: string | null }): "rescueV2.payment.subscriber" | "rescueV2.payment.allowanceUsed" | null {
  if (input.ios) return null;
  return input.refusal === ALLOWANCE_USED ? "rescueV2.payment.allowanceUsed" : "rescueV2.payment.subscriber";
}

/** The line a refused checkout earns. Null means the refresh alone says it (the sheet re-reads its own state). */
export type CheckoutNotice = "payment.confirming" | "payment.notForSale" | "codes.rescue_included_by_plan";

/**
 * What a refused card checkout (a 409 from the server's checkout) means for the sheet, by its `code` (S14). A code not listed here is the
 * generic failure, so the caller shows that.
 */
export function checkoutRefusal(code: string): { notice: CheckoutNotice | null } | null {
  switch (code) {
    case "rescue_payment_pending": return { notice: "payment.confirming" };
    case "rescue_not_for_sale": return { notice: "payment.notForSale" };
    case "rescue_included_by_plan": return { notice: "codes.rescue_included_by_plan" };
    case "rescue_transfer_pending": case "rescue_transfer_approved": case "rescue_already_entitled": return { notice: null };
    default: return null;
  }
}

/**
 * Where the browser came back to, for this project. The server's return page sends `kwill://payment-success?rescue=<id>` or
 * `kwill://payment-failed?rescue=<id>` (the cancel). A return that names another project is `other`, so it is not this project's answer.
 */
export function paymentReturn(url: string, projectId: string): "paid" | "unfinished" | "other" {
  const rescue = /[?&]rescue=([^&#]+)/.exec(url)?.[1];
  if (rescue !== undefined && decodeURIComponent(rescue) !== projectId) return "other";
  return /payment-success/.test(url) ? "paid" : "unfinished";
}
