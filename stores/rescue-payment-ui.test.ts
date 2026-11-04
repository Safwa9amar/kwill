import { beforeEach, describe, expect, it } from "vitest";
import { usePaymentUi } from "./rescue-payment-ui";

const S = () => usePaymentUi.getState();

beforeEach(() => {
  // Each test starts from nothing: no project, no lock.
  while (S().busy) S().end();
  usePaymentUi.setState({ key: null, method: null, notice: null });
});

describe("the payment lock", () => {
  it("refuses a second start while the first is in flight, so a double tap starts one payment", () => {
    S().ensure("p1");
    expect(S().begin()).toBe(true);
    expect(S().begin()).toBe(false);
    expect(S().begin()).toBe(false);
    S().end();
    expect(S().begin()).toBe(true);
    S().end();
  });

  it("keeps the lock when the student switches project, so an action still in flight cannot be doubled", () => {
    S().ensure("p1");
    expect(S().begin()).toBe(true);
    S().ensure("p2");
    expect(S().begin()).toBe(false);
    S().end();
    expect(S().begin()).toBe(true);
    S().end();
  });
});

describe("the payment view state", () => {
  it("forgets the method and the notice of another project", () => {
    S().ensure("p1");
    S().setMethod("card");
    S().setNotice("payment.cardFailed");
    S().ensure("p2");
    expect(S().method).toBeNull();
    expect(S().notice).toBeNull();
    expect(S().key).toBe("p2");
  });

  it("keeps the method when it is the same project", () => {
    S().ensure("p1");
    S().setMethod("manual");
    S().ensure("p1");
    expect(S().method).toBe("manual");
  });
});
