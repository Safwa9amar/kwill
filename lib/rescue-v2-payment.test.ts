import { describe, expect, it } from "vitest";
import type { RescueEntitlementDTO } from "@/types/rescue-v2";
import { ALLOWANCE_USED, methodsFor, paymentNoteKey, paymentView } from "./rescue-v2-payment";

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

  it("keeps confirming while a card payment is pending, with no retry: a second checkout could be paid as well", () => {
    expect(paymentView({ ...base, state: "pending_card" })).toEqual({ kind: "confirming" });
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
