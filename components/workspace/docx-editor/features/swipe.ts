// Fast sideways fling over plain text → open the structure drawer (Task 26) —
// the recogniser, pure. A port of the Lexical surface's DrawerSwipePlugin with
// its thresholds unchanged (they were tuned on devices); what changes is only
// what counts as "not plain text" on the docx engine's painted pages.
//
// Detected IN the WebView because only it knows what the finger started on:
// tables and pictures own sideways gestures (column resize, scroll, crop), so a
// fling there is not ours. A slow horizontal drag stays a text selection; the
// fling must be brisk, clearly horizontal and toward the drawer's side.

/** What a fling must not start on — the engine's table and drawing markup. */
export const SWIPE_EXCLUDE = [
  "[data-table-id]", ".docx-table-cell", ".docx-table-row",
  "[data-drawing-node-id]", ".docx-drawing-image", ".docx-drawing-image-frame",
  "img", "svg", "table",
].join(", ");

export type SwipeRecogniser = {
  start(x: number, y: number, t: number, touches: number, excluded: boolean): void;
  /** True when this move opened the drawer. */
  move(x: number, y: number, t: number): boolean;
  /** True when this lift opened the drawer (a flick too fast to emit moves). */
  end(x: number, y: number, t: number): boolean;
};

export function createSwipeRecogniser(o: { rtl: () => boolean; onOpen: () => void }): SwipeRecogniser {
  let sx = 0, sy = 0, st = 0, armed = false, fired = false;
  // Open direction follows the APP language — matching the edge-swipe side: an
  // Arabic UI opens with a right→left flick, fr/en with a left→right one.
  const towardOpen = (dx: number) => (o.rtl() ? -dx : dx);
  const fire = () => { fired = true; armed = false; o.onOpen(); return true; };
  return {
    start(x, y, t, touches, excluded) {
      fired = false;
      armed = touches === 1 && !excluded;
      sx = x; sy = y; st = t;
    },
    // Recognised MID-GESTURE, so the drawer starts sliding under the finger
    // rather than after it lifts — the bridge hop costs enough on its own.
    move(x, y, t) {
      if (!armed || fired) return false;
      const dx = x - sx;
      const dy = y - sy;
      // The reader is scrolling the document — this gesture is not ours.
      if (Math.abs(dy) > 20 && Math.abs(dy) >= Math.abs(dx)) { armed = false; return false; }
      const dt = t - st || 1;
      return towardOpen(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 400 ? fire() : false;
    },
    end(x, y, t) {
      if (!armed || fired) return false;
      armed = false;
      const dx = x - sx;
      const dy = y - sy;
      const dt = t - st || 1;
      const v = Math.abs(dx) / dt; // px per ms
      return towardOpen(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6 && v > 0.5 && dt < 400 ? fire() : false;
    },
  };
}
