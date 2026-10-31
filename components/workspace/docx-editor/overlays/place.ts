// Where a floating card goes, given the block it belongs to. Pure, so the rules
// are tested rather than eyeballed (place.test.ts).
//
// Lexical showed a proposal IN the flow, in place of its paragraph, and pushed the
// rest down. An overlay cannot push anything, so the card sits OVER its block
// instead: same top, at least as tall (the original is hidden under it — the card
// carries its own "original" teaser), and a little wider than a narrow text column
// so the action pill fits on a phone.
//
// While its block is on screen the card is kept on screen too: a paragraph near the
// bottom of the viewport would otherwise put the Approve button below the fold —
// and below the LAST paragraph of the document there is nothing left to scroll.
// Once the block is fully off screen the card follows it out, so it never pins
// itself over unrelated text.

/** Clear space kept between a card and the viewport edges. */
export const CARD_EDGE = 8;
/**
 * Room left at the bottom for the native chrome that floats over the WebView (the
 * ✦ dock / floating pill). ⚠️ A guess at its height, not a measurement — the native
 * side does not report it to the WebView; adjust once seen on a device.
 */
export const CARD_BOTTOM_RESERVE = 72;
/** Narrowest a card may be (or the viewport, if narrower). */
export const CARD_MIN_WIDTH = 320;

export type Box = { left: number; top: number; width: number; minHeight: number; maxHeight: number };

export function placeCard(
  rect: { left: number; top: number; width: number; height: number },
  cardHeight: number,
  viewport: { width: number; height: number },
): Box {
  const vw = viewport.width;
  const vh = viewport.height;
  const maxWidth = Math.max(0, vw - 2 * CARD_EDGE);
  const minW = Math.min(maxWidth, CARD_MIN_WIDTH);
  let width = rect.width + 16;
  let left = rect.left - 8;
  if (width < minW) {
    left = rect.left + rect.width / 2 - minW / 2;
    width = minW;
  }
  width = Math.min(width, maxWidth);
  left = Math.min(Math.max(left, CARD_EDGE), vw - CARD_EDGE - width);

  const maxHeight = Math.max(120, vh - 2 * CARD_EDGE - CARD_BOTTOM_RESERVE);
  const minHeight = Math.min(rect.height + 12, maxHeight);
  let top = rect.top - 6;
  const blockOnScreen = rect.top + rect.height > 0 && rect.top < vh;
  if (blockOnScreen) {
    const h = Math.min(Math.max(cardHeight, minHeight), maxHeight);
    top = Math.min(top, vh - CARD_BOTTOM_RESERVE - CARD_EDGE - h);
    top = Math.max(top, CARD_EDGE);
  }
  return { left, top, width, minHeight, maxHeight };
}
