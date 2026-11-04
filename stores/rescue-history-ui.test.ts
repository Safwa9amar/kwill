import { beforeEach, describe, expect, it } from "vitest";
import { useHistoryUi } from "./rescue-history-ui";

const s = () => useHistoryUi.getState();

describe("rescue history UI", () => {
  beforeEach(() => s().reset());

  it("keeps a selection for the project it was made in", () => {
    s().select("p1", "v2");
    expect(s().key).toBe("p1");
    expect(s().selected).toBe("v2");
  });

  it("starts clean when a different project writes", () => {
    s().select("p1", "v2");
    s().setPage("p1", "v2", 7);
    s().setImpact("p1", "ok", null);
    s().select("p2", "v9");
    expect(s().key).toBe("p2");
    expect(s().selected).toBe("v9");
    expect(s().pageVersion).toBeNull();
    expect(s().page).toBe(1);
    expect(s().impact.state).toBe("loading");
  });

  it("starts the pager at the first page when the pair changes", () => {
    s().setComparePage("p1", "a|b", 4);
    expect(s().comparePage).toBe(4);
    s().setComparePair("p1", "c|d");
    expect(s().comparePair).toBe("c|d");
    expect(s().comparePage).toBe(0);
  });

  it("holds one compare reply under its own slot", () => {
    s().setCompare("p1", "a|b|0", "ok", null);
    expect(s().compare.slot).toBe("a|b|0");
    s().setCompare("p1", "a|b|1", "loading", null);
    expect(s().compare.slot).toBe("a|b|1");
    expect(s().compare.state).toBe("loading");
  });
});
