import { describe, expect, it } from "vitest";
import { maybeImagePaste } from "./paste-image";

const none = { types: [], fileTypes: [], html: "", plain: "" };

describe("maybeImagePaste", () => {
  it("treats an empty payload as a maybe (WebKit hides pasted pictures)", () => {
    expect(maybeImagePaste(none)).toBe(true);
  });
  it("takes an image type or an image file", () => {
    expect(maybeImagePaste({ ...none, types: ["image/png"] })).toBe(true);
    expect(maybeImagePaste({ ...none, types: ["Files"], fileTypes: ["image/jpeg"] })).toBe(true);
  });
  it("takes HTML that is only an <img>", () => {
    expect(maybeImagePaste({ ...none, types: ["text/html"], html: '<meta charset="utf-8"><img src="blob:x">' })).toBe(true);
  });
  it("leaves a text paste to the engine", () => {
    expect(maybeImagePaste({ ...none, types: ["text/plain"], plain: "hello" })).toBe(false);
    expect(maybeImagePaste({ ...none, types: ["text/html"], html: "<p>مرحبا</p>" })).toBe(false);
    expect(maybeImagePaste({ ...none, types: ["text/html", "text/plain"], html: '<p>a <img src="x"> b</p>', plain: "a b" })).toBe(false);
  });
});
