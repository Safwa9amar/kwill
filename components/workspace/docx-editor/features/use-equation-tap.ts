// Task 17: a tapped equation → the native EquationSheet, opened on THAT equation.
//
// The engine owns the press (it selects the equation; its own popover is switched
// off by the host with `popups={{ equation: false }}`), so this only LISTENS — a
// capture-phase click on the document, which fires for a tap and not for a drag.
// The payload is `{ index, ordinal }`; the host looks the equation up in the DTO
// (`blocks[index].math[ordinal]`) so no MathML/LaTeX has to cross the bridge.

import { useEffect, useRef } from "react";
import { EQUATION_SELECTOR, equationTarget } from "../bridge/equation-target";

function attrUp(el: Element, name: string): string | null {
  return el.getAttribute(name) ?? el.closest(`[${name}]`)?.getAttribute(name) ?? null;
}

export function useEquationTap(onTap: ((payload: string) => void) | undefined): void {
  const ref = useRef(onTap);
  ref.current = onTap;
  const enabled = !!onTap;
  useEffect(() => {
    if (!enabled) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest(EQUATION_SELECTOR);
      if (!el) return;
      const paragraphId = attrUp(el, "data-paragraph-id");
      const startAttr = attrUp(el, "data-start");
      const siblingStarts = paragraphId
        ? Array.from(document.querySelectorAll(EQUATION_SELECTOR))
            .filter((x) => attrUp(x, "data-paragraph-id") === paragraphId)
            .map((x) => Number(attrUp(x, "data-start")))
            .filter(Number.isFinite)
        : [];
      const t = equationTarget({
        sourceNodeId: el.getAttribute("data-docx-equation"),
        paragraphId,
        start: startAttr != null && Number.isFinite(Number(startAttr)) ? Number(startAttr) : null,
        siblingStarts,
      });
      if (t) ref.current?.(JSON.stringify(t));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [enabled]);
}
