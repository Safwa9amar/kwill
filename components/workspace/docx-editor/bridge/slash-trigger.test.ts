import { describe, expect, it } from "vitest";
import { slashQuery } from "./slash-trigger";

describe("slashQuery", () => {
  it("opens on a bare slash at the start of the text", () => {
    expect(slashQuery("/")).toEqual({ query: "", start: 0 });
  });
  it("carries the query typed after the slash", () => {
    expect(slashQuery("Intro /tab")).toEqual({ query: "tab", start: 6 });
    expect(slashQuery("مقدمة /جدول")).toEqual({ query: "جدول", start: 6 });
  });
  it("is not a command inside a word or after a space in the query", () => {
    expect(slashQuery("and/or")).toBeNull();
    expect(slashQuery("/fig ure")).toBeNull();
    expect(slashQuery("a//b")).toBeNull();
  });
  it("closes once the caret leaves the slash run", () => {
    expect(slashQuery("/h2 ")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});
