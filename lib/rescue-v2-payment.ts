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
    // A pending card row is never retried from the app: a second checkout while the first can still be paid is a double charge.
    // The server turns the row to `none` after 15 minutes (P-51), and the offer returns then.
    case "pending_card":
    case "paid":
      return { kind: "confirming" };
    case "refund_due":
      return { kind: "refundDue" };
  }
}
