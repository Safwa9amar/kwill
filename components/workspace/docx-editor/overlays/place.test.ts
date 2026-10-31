import { describe, it, expect } from "vitest";
import { CARD_BOTTOM_RESERVE, CARD_EDGE, placeCard } from "./place";

const vp = { width: 390, height: 800 };

describe("placeCard", () => {
  it("sits over its block, a little wider, at least as tall", () => {
    const b = placeCard({ left: 30, top: 200, width: 330, height: 90 }, 150, vp);
    expect(b.top).toBe(194);
    expect(b.left).toBe(22);
    expect(b.width).toBe(346);
    expect(b.minHeight).toBe(102);
  });

  it("widens a narrow column to the minimum, centred, inside the viewport", () => {
    const b = placeCard({ left: 100, top: 100, width: 150, height: 40 }, 100, vp);
    expect(b.width).toBe(320);
    expect(b.left).toBe(100 + 75 - 160);
    const edge = placeCard({ left: 0, top: 100, width: 150, height: 40 }, 100, vp);
    expect(edge.left).toBe(CARD_EDGE);
  });

  it("never exceeds the viewport width", () => {
    const b = placeCard({ left: -50, top: 100, width: 600, height: 40 }, 100, vp);
    expect(b.width).toBe(vp.width - 2 * CARD_EDGE);
    expect(b.left).toBe(CARD_EDGE);
  });

  it("lifts a card whose block is low on screen so its buttons stay reachable", () => {
    const b = placeCard({ left: 60, top: 700, width: 280, height: 40 }, 260, vp);
    expect(b.top + 260).toBeLessThanOrEqual(vp.height - CARD_BOTTOM_RESERVE - CARD_EDGE);
  });

  it("never lifts it above the top edge, even when taller than the room", () => {
    const b = placeCard({ left: 60, top: 300, width: 280, height: 40 }, 5000, vp);
    expect(b.top).toBe(CARD_EDGE);
    expect(b.maxHeight).toBe(vp.height - 2 * CARD_EDGE - CARD_BOTTOM_RESERVE);
  });

  it("follows its block off screen instead of pinning itself over other text", () => {
    expect(placeCard({ left: 60, top: -400, width: 280, height: 100 }, 200, vp).top).toBe(-406);
    expect(placeCard({ left: 60, top: 900, width: 280, height: 100 }, 200, vp).top).toBe(894);
  });

  it("caps the cover height at the max height (min-height would win in CSS)", () => {
    const b = placeCard({ left: 60, top: 10, width: 280, height: 3000 }, 100, vp);
    expect(b.minHeight).toBe(b.maxHeight);
  });
});
