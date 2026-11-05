import { describe, expect, it } from "vitest";
import { isPublishHeld, notifyRoute } from "./rescue-v2-notify";

describe("notifyRoute", () => {
  it("opens History of the project for a held publish", () => {
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1", event: "publishHeld" }, true))
      .toBe("/(app)/rescue?projectId=p1&view=history");
  });

  it("keeps every other rescue route as it is", () => {
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1", event: "done" }, true)).toBe("/(app)/rescue?projectId=p1");
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1" }, true)).toBe("/(app)/rescue?projectId=p1");
  });

  it("never changes a non-rescue route", () => {
    expect(notifyRoute("/(app)/chat", { event: "publishHeld", projectId: "p1" }, true)).toBe("/(app)/chat");
  });

  it("changes nothing while the release flag is off", () => {
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1", event: "publishHeld" }, false)).toBe("/(app)/rescue?projectId=p1");
  });

  it("encodes the project id in the query", () => {
    expect(notifyRoute("/(app)/rescue", { projectId: "a b&c", event: "publishHeld" }, true))
      .toBe("/(app)/rescue?projectId=a%20b%26c&view=history");
  });
});

describe("isPublishHeld", () => {
  it("is true only for the held-publish event", () => {
    expect(isPublishHeld({ event: "publishHeld" })).toBe(true);
    expect(isPublishHeld({ event: "done" })).toBe(false);
    expect(isPublishHeld(null)).toBe(false);
  });
});
