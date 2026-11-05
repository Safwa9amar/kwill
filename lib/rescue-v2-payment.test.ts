import { describe, expect, it } from "vitest";
import type { RescueEntitlementDTO } from "@/types/rescue-v2";
import { ALLOWANCE_USED, checkoutRefusal, methodsFor, paymentNoteKey, paymentReturn, paymentView } from "./rescue-v2-payment";

type State = RescueEntitlementDTO["purchase"]["state"];
const base = { ios: false, forSale: true, manualEnabled: true, cardEnabled: true };

describe("paymentView on iOS", () => {
  it("is status only in every state, so no price, method or buy word reaches the sheet", () => {
    const states: State[] = ["none", "refunded", "pending_card", "pending_manual", "rejected_manual", "paid", "refund_due"];
    for (const state of states) {
      expect(paymentView({ ...base, ios: true, state }), state).toEqual({ kind: "status" });
    }
  });
});

describe("paymentView on Android", () => {
  it("offers the purchase to a student with no purchase, and to one buying again after a refund", () => {
    for (const state of ["none", "refunded"] as State[]) {
      expect(paymentView({ ...base, state })).toEqual({ kind: "offer", methods: ["manual", "card"], defaultMethod: "manual" });
    }
  });

  it("offers only the methods the server enables, manual first", () => {
    expect(paymentView({ ...base, state: "none", cardEnabled: false })).toEqual({ kind: "offer", methods: ["manual"], defaultMethod: "manual" });
    expect(paymentView({ ...base, state: "none", manualEnabled: false })).toEqual({ kind: "offer", methods: ["card"], defaultMethod: "card" });
  });

  it("shows not-for-sale, with no CTA, when the price is off or no method is open", () => {
    expect(paymentView({ ...base, state: "none", forSale: false })).toEqual({ kind: "notForSale" });
    expect(paymentView({ ...base, state: "none", manualEnabled: false, cardEnabled: false })).toEqual({ kind: "notForSale" });
  });

  it("says under review, with no CTA, for a manual transfer waiting on staff", () => {
    expect(paymentView({ ...base, state: "pending_manual" })).toEqual({ kind: "underReview" });
  });

  it("offers try-again after a rejected transfer when a method is open", () => {
    expect(paymentView({ ...base, state: "rejected_manual" })).toEqual({ kind: "rejected", cta: true, defaultMethod: "manual" });
    expect(paymentView({ ...base, state: "rejected_manual", manualEnabled: false, cardEnabled: false })).toEqual({ kind: "rejected", cta: false, defaultMethod: null });
  });

  it("offers the card again while a card checkout is open: the server answers with the same open URL, so no second charge", () => {
    expect(paymentView({ ...base, state: "pending_card" })).toEqual({ kind: "offer", methods: ["manual", "card"], defaultMethod: "manual" });
    expect(paymentView({ ...base, state: "pending_card", forSale: false })).toEqual({ kind: "notForSale" });
  });

  it("confirms a paid payment that is not granted yet, with no CTA", () => {
    expect(paymentView({ ...base, state: "paid" })).toEqual({ kind: "confirming" });
  });

  it("states a refund due, with no CTA", () => {
    expect(paymentView({ ...base, state: "refund_due" })).toEqual({ kind: "refundDue" });
  });
});

describe("methodsFor", () => {
  it("lists manual then card, each only when enabled", () => {
    expect(methodsFor({ manualEnabled: true, cardEnabled: true })).toEqual(["manual", "card"]);
    expect(methodsFor({ manualEnabled: false, cardEnabled: true })).toEqual(["card"]);
    expect(methodsFor({ manualEnabled: false, cardEnabled: false })).toEqual([]);
  });
});

describe("paymentNoteKey", () => {
  it("says the subscriber line when the continue was refused for another reason, or was not refused", () => {
    expect(paymentNoteKey({ ios: false, refusal: null })).toBe("rescueV2.payment.subscriber");
    expect(paymentNoteKey({ ios: false, refusal: "rescue_payment_required" })).toBe("rescueV2.payment.subscriber");
  });

  it("says this month's plan repairs are used, and not the subscriber line, after rescue_allowance_used (P-58)", () => {
    expect(paymentNoteKey({ ios: false, refusal: ALLOWANCE_USED })).toBe("rescueV2.payment.allowanceUsed");
    expect(ALLOWANCE_USED).toBe("rescue_allowance_used");
  });

  it("says nothing about money on iOS, whatever the refusal", () => {
    expect(paymentNoteKey({ ios: true, refusal: null })).toBeNull();
    expect(paymentNoteKey({ ios: true, refusal: ALLOWANCE_USED })).toBeNull();
  });
});

describe("checkoutRefusal", () => {
  it("says a payment being confirmed, a price off, or a plan that covers the repair, and refreshes the rest", () => {
    expect(checkoutRefusal("rescue_payment_pending")).toEqual({ notice: "payment.confirming" });
    expect(checkoutRefusal("rescue_not_for_sale")).toEqual({ notice: "payment.notForSale" });
    expect(checkoutRefusal("rescue_included_by_plan")).toEqual({ notice: "codes.rescue_included_by_plan" });
    for (const code of ["rescue_transfer_pending", "rescue_transfer_approved", "rescue_already_entitled"]) {
      expect(checkoutRefusal(code), code).toEqual({ notice: null });
    }
  });

  it("leaves any other code to the generic failure", () => {
    expect(checkoutRefusal("rescue_too_large")).toBeNull();
  });
});

describe("paymentReturn", () => {
  const P = "11111111-2222-3333-4444-555555555555";
  it("reads the server's success return for this project as paid", () => {
    expect(paymentReturn(`kwill://payment-success?rescue=${P}`, P)).toBe("paid");
  });

  it("reads the cancel return (payment-failed) as unfinished, never paid", () => {
    expect(paymentReturn(`kwill://payment-failed?rescue=${P}`, P)).toBe("unfinished");
    expect(paymentReturn("kwill://payment-failed", P)).toBe("unfinished");
  });

  it("ignores a return that names another project", () => {
    expect(paymentReturn("kwill://payment-success?rescue=other-id", P)).toBe("other");
  });
});
