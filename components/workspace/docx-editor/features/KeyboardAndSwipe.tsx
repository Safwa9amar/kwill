// Two touch behaviours the Lexical surface had (Task 26), on the docx engine's
// pages. Rendered inside <DocxEditor> beside the Bridge.
//
// Keyboard mode: with the workspace's keyboard toggle OFF, `inputmode="none"` on
// the engine's contenteditable root, so a tap still places the caret and selects
// a block (the bubble tools show) while the OS keyboard stays closed — no
// focus/blur fight. ON → "text". The native bubble/pill inputs are separate
// views, so this never touches the AI Ask field. (KeyboardModePlugin's rule.)
//
// Drawer swipe: a brisk sideways fling over plain text opens the structure
// drawer (features/swipe.ts — DrawerSwipePlugin's recogniser, same thresholds).

import { useEffect, useRef } from "react";
import { createSwipeRecogniser, SWIPE_EXCLUDE } from "./swipe";

// ⚠️ The root is the engine's `.docx-pages` div (it sets contentEditable on it);
// the generic selector is only a fallback in case that class is renamed.
const ROOT = ".docx-pages[contenteditable]";
const VIEWPORT = ".docx-editor-one-surface__viewport";

export function KeyboardAndSwipe(p: {
  keyboardActive: boolean;
  onSwipeOpenDrawer: (() => void) | undefined;
  appRtl: boolean;
}) {
  const latest = useRef(p);
  latest.current = p;

  // ── keyboard mode ──
  useEffect(() => {
    const want = p.keyboardActive ? "text" : "none";
    const apply = (): boolean => {
      const root = document.querySelector<HTMLElement>(ROOT) ?? document.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!root) return false;
      if (root.getAttribute("inputmode") !== want) root.setAttribute("inputmode", want);
      return true;
    };
    // The root appears only once the engine has opened the document; keep
    // looking until it does (bounded — the touch hook below covers the rest).
    let raf = 0;
    let tries = 0;
    const seek = () => { if (!apply() && ++tries < 600) raf = requestAnimationFrame(seek); };
    seek();
    // A load() can rebuild the root without telling anyone; re-assert on the
    // touch that precedes every focus, which is the moment the keyboard decides.
    const opts = { capture: true, passive: true } as const;
    const onTouch = () => { apply(); };
    document.addEventListener("touchstart", onTouch, opts);
    document.addEventListener("pointerdown", onTouch, opts);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("touchstart", onTouch, true);
      document.removeEventListener("pointerdown", onTouch, true);
    };
  }, [p.keyboardActive]);

  // ── drawer swipe ──
  useEffect(() => {
    const r = createSwipeRecogniser({
      rtl: () => latest.current.appRtl,
      onOpen: () => {
        window.getSelection?.()?.removeAllRanges?.(); // a fling is not a selection
        latest.current.onSwipeOpenDrawer?.();
      },
    });
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const el = e.target instanceof Element ? e.target : null;
      // Pages only — and never a table or a picture, which own sideways gestures.
      const onPages = !document.querySelector(VIEWPORT) || !!el?.closest(VIEWPORT);
      r.start(t?.clientX ?? 0, t?.clientY ?? 0, Date.now(), e.touches.length, !latest.current.onSwipeOpenDrawer || !onPages || !!el?.closest(SWIPE_EXCLUDE));
    };
    const onMove = (e: TouchEvent) => { const t = e.touches[0]; if (t) r.move(t.clientX, t.clientY, Date.now()); };
    const onEnd = (e: TouchEvent) => { const t = e.changedTouches[0]; if (t) r.end(t.clientX, t.clientY, Date.now()); };
    const opts = { passive: true } as const;
    document.addEventListener("touchstart", onStart, opts);
    document.addEventListener("touchmove", onMove, opts);
    document.addEventListener("touchend", onEnd, opts);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    };
  }, []);

  return null;
}
