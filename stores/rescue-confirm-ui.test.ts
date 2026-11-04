import { beforeEach, describe, expect, it } from "vitest";
import { useConfirmUi } from "./rescue-confirm-ui";

// One call in flight per project. A hung call on one project must not disable another project's buttons, so `busy` is for the open project
// only. `begin` and `end` keep their signatures: the callers are many, and they end their own call in a `finally`.

const S = () => useConfirmUi.getState();

beforeEach(() => {
  useConfirmUi.setState({ key: null, busy: false, calls: [] });
});

describe("busy is per project", () => {
  it("a call in flight on A leaves B's buttons enabled, and B may start its own call", () => {
    S().ensure("A");
    expect(S().begin()).toBe(true);
    expect(S().busy).toBe(true);

    S().ensure("B");
    expect(S().busy).toBe(false);
    expect(S().begin()).toBe(true);
    S().end();
    expect(S().busy).toBe(false);
  });

  it("a second call on the same project is refused while one is in flight", () => {
    S().ensure("A");
    expect(S().begin()).toBe(true);
    expect(S().begin()).toBe(false);
    S().end();
    expect(S().busy).toBe(false);
    expect(S().begin()).toBe(true);
  });

  it("coming back to A, its lock is still held until its call ends", () => {
    S().ensure("A");
    S().begin();
    S().ensure("B");
    S().ensure("A");
    expect(S().busy).toBe(true);
    S().end();
    expect(S().busy).toBe(false);
  });

  it("when B's call ends first, A is still busy, and frees once A's call ends", () => {
    S().ensure("A");
    S().begin();
    S().ensure("B");
    S().begin();
    S().end();
    S().ensure("A");
    expect(S().busy).toBe(true);
    S().end();
    expect(S().busy).toBe(false);
    expect(S().begin()).toBe(true);
  });

  it("an end with no call in flight does nothing", () => {
    S().ensure("A");
    S().end();
    expect(S().busy).toBe(false);
    expect(S().begin()).toBe(true);
  });
});
