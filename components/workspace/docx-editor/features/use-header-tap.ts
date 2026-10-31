// Running headers and footers on a touch screen: one tap opens one for editing (the
// way a double-click does with a mouse), and a tap on the body closes it again.
//
// ⚠️ The engine's page pointer handler begins `if (pointerType === "touch") return;`
// (core 2.21.1), and header/footer ENTRY and EXIT both live in that handler — so on a
// phone a running header could not be entered at all (a double tap only showed the
// "Double-click to edit header" hint), and once in, tapping the body left the
// student stranded in header mode with only the iOS edit menu (simulator, 10-31).
// Lexical opened the header on one tap.
//
// Entry forwards the tap to that same handler as a MOUSE double press at the same
// point, so the engine resolves the exact part (rId + page) with its own logic —
// nothing about sections or variants is re-derived here. Exit is the public
// `exitHeaderFooter` command.

import { useEffect, type RefObject } from "react";
import type { DocxEditorRef, EditorCommand } from "@docx-editor.dev/react";

const HF = "[data-docx-hf]";

export function useHeaderTap(editorRef: RefObject<DocxEditorRef | null>): void {
  useEffect(() => {
    let forwarding = false;
    const onTouchEnd = (e: TouchEvent) => {
      if (forwarding || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const target = document.elementFromPoint(t.clientX, t.clientY);
      // Only taps on the pages: our overlays and cards own theirs.
      if (!target?.closest("[data-page-index]")) return;
      const editor = editorRef.current?.getEditor() ?? null;
      const open = editor?.getHeaderFooterState()?.editing ?? null;
      const hf = target.closest(HF);
      const kind = hf?.getAttribute("data-docx-hf");

      if (open && (!hf || kind !== open)) {
        // A tap on the body (or on the other band) leaves the open story; on the
        // other band the engine is then asked to enter that one, below.
        try {
          editor!.exec({ type: "exitHeaderFooter" } as unknown as EditorCommand);
        } catch {
          /* already out — nothing to do */
        }
        if (!hf) return;
      } else if (!hf || open) {
        return; // a body tap with nothing open, or a tap inside the open band
      }

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
          target.dispatchEvent(new PointerEvent("pointerdown", { ...init, detail }));
          target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, detail }));
        }
      } finally {
        forwarding = false;
      }
    };
    window.addEventListener("touchend", onTouchEnd, true);
    return () => window.removeEventListener("touchend", onTouchEnd, true);
  }, [editorRef]);
}
