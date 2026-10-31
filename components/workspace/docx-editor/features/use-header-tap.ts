// A tap on a running header or footer opens it for editing, the way a double-click
// does with a mouse.
//
// ⚠️ The engine's page pointer handler begins `if (pointerType === "touch") return;`
// (core 2.21.1), and header/footer ENTRY lives in that handler — so on a phone a
// running header could not be entered at all: one tap did nothing, a double tap
// only showed the "Double-click to edit header" hint (simulator, 10-31). Lexical
// opened the header on one tap.
//
// The fix forwards the tap to that same handler as a MOUSE double press at the same
// point, so the engine resolves the exact header part (by its rId and page) with its
// own logic — nothing about sections or variants is re-derived here. Taps inside a
// header already being edited are left alone (the caret moves as usual).

import { useEffect } from "react";

const HF = "[data-docx-hf]";

export function useHeaderTap(): void {
  useEffect(() => {
    let forwarding = false;
    const onTouchEnd = (e: TouchEvent) => {
      if (forwarding || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const target = document.elementFromPoint(t.clientX, t.clientY);
      const hf = target?.closest(HF);
      // Already editing this story: the engine's own selection handling owns it.
      if (!hf || hf.closest("[data-docx-hf-active], .docx-hf-active")) return;
      forwarding = true;
      try {
        const init: PointerEventInit = {
          bubbles: true, cancelable: true, composed: true,
          pointerType: "mouse", isPrimary: true, button: 0, buttons: 1,
          clientX: t.clientX, clientY: t.clientY,
        };
        // The engine enters a header on a click count ≥ 2 (its own press counter):
        // a mouse DOUBLE press, the second one carrying detail 2.
        for (const detail of [1, 2]) {
          target!.dispatchEvent(new PointerEvent("pointerdown", { ...init, detail }));
          target!.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, detail }));
        }
      } finally {
        forwarding = false;
      }
    };
    window.addEventListener("touchend", onTouchEnd, true);
    return () => window.removeEventListener("touchend", onTouchEnd, true);
  }, []);
}
