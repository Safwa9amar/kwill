import { describe, expect, it } from "vitest";
import { requireListed } from "./thesis-open-check";

// Opening a thesis in the workspace needs the thesis in the list the app just read. The refresh swallows its own failure and returns the list
// it had, so a thesis that is not in that list cannot be opened from here.

describe("requireListed", () => {
  it("passes when the thesis is in the list", () => {
    expect(() => requireListed([{ id: "A" }, { id: "B" }], "B")).not.toThrow();
  });

  it("throws when the thesis is not in the list, so nothing is pushed", () => {
    expect(() => requireListed([{ id: "A" }], "B")).toThrow("thesis-not-listed");
  });

  it("throws for an empty list", () => {
    expect(() => requireListed([], "A")).toThrow("thesis-not-listed");
  });
});
