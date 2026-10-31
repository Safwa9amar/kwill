import { describe, it, expect, vi } from "vitest";
import { createSwipeRecogniser } from "./swipe";

function make(rtl = false) {
  const onOpen = vi.fn();
  return { r: createSwipeRecogniser({ rtl: () => rtl, onOpen }), onOpen };
}

describe("createSwipeRecogniser", () => {
  it("opens mid-gesture on a brisk, clearly horizontal fling toward the drawer (LTR: left→right)", () => {
    const { r, onOpen } = make();
    r.start(10, 100, 0, 1, false);
    expect(r.move(40, 102, 50)).toBe(false);
    expect(r.move(80, 104, 120)).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(r.move(120, 104, 150)).toBe(false); // once per gesture
    expect(r.end(130, 104, 160)).toBe(false);
  });
  it("RTL opens with a right→left fling and ignores the other way", () => {
    const rtl = make(true);
    rtl.r.start(300, 100, 0, 1, false);
    expect(rtl.r.move(220, 100, 100)).toBe(true);
    const wrongWay = make(true);
    wrongWay.r.start(10, 100, 0, 1, false);
    expect(wrongWay.r.move(90, 100, 100)).toBe(false);
  });
  it("a vertical scroll disarms it", () => {
    const { r, onOpen } = make();
    r.start(10, 100, 0, 1, false);
    r.move(15, 130, 40); // reading, not flinging
    r.move(120, 130, 90);
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("a slow drag is a text selection, not a fling", () => {
    const { r, onOpen } = make();
    r.start(10, 100, 0, 1, false);
    r.move(100, 100, 600);
    expect(r.end(120, 100, 700)).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("a flick too fast to emit moves is caught on lift", () => {
    const { r, onOpen } = make();
    r.start(10, 100, 0, 1, false);
    expect(r.end(100, 105, 90)).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("never starts on a table or picture, nor with two fingers", () => {
    const excluded = make();
    excluded.r.start(10, 100, 0, 1, true);
    expect(excluded.r.move(120, 100, 80)).toBe(false);
    const pinch = make();
    pinch.r.start(10, 100, 0, 2, false);
    expect(pinch.r.end(120, 100, 80)).toBe(false);
  });
});
