import { create } from "zustand";
import type { PaymentMethod } from "@/lib/rescue-v2-payment";

// The money actions of one project: the method the student picked, the line under the CTA, and the in-flight lock. The lock is set
// synchronously by `begin`, so a second tap in the same frame is refused: a double tap must never start a second payment.

export type PaymentNotice = "payment.cardNotFinished" | "payment.cardFailed";

interface PaymentUiState {
  key: string | null;
  method: PaymentMethod | null;
  notice: PaymentNotice | null;
  busy: boolean;
  /** Starts clean for a different project. The lock is never cleared here: an action in flight still ends itself. */
  ensure(key: string): void;
  setMethod(method: PaymentMethod): void;
  setNotice(notice: PaymentNotice | null): void;
  /** True when the action may start; false while another one is in flight. */
  begin(): boolean;
  end(): void;
}

export const usePaymentUi = create<PaymentUiState>()((set, get) => ({
  key: null,
  method: null,
  notice: null,
  busy: false,

  ensure: (key) => {
    if (get().key === key) return;
    set({ key, method: null, notice: null });
  },

  setMethod: (method) => set({ method }),
  setNotice: (notice) => set({ notice }),

  begin: () => {
    if (get().busy) return false;
    set({ busy: true });
    return true;
  },

  end: () => set({ busy: false }),
}));
