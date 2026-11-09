import { describe, expect, it } from "vitest";
import { isPublishHeld, notifyRoute, rescueRouteTarget } from "./rescue-v2-notify";

describe("notifyRoute", () => {
  it("opens History of the project for a held publish", () => {
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1", event: "publishHeld" }, true))
      .toBe("/(app)/rescue?projectId=p1&view=history");
  });

  it("opens the payment screen of the project for a rejected payment, where the reason is", () => {
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1", event: "paymentRejected" }, true))
      .toBe("/(app)/rescue?projectId=p1&view=payment");
  });

  it("keeps every other rescue route as it is", () => {
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1", event: "done" }, true)).toBe("/(app)/rescue?projectId=p1");
    expect(notifyRoute("/(app)/rescue?projectId=p1", { projectId: "p1" }, true)).toBe("/(app)/rescue?projectId=p1");
  });

  it("opens the library for a rescue notice with no project, such as a refund for a deleted project", () => {
    expect(notifyRoute("/(app)/rescue?projectId=", { projectId: "", event: "refundDone" }, true)).toBe("/(app)/rescue/library");
    expect(notifyRoute("/(app)/rescue", { event: "refundDone" }, true)).toBe("/(app)/rescue/library");
    expect(notifyRoute("/(app)/rescue", { projectId: null, event: "publishHeld" }, true)).toBe("/(app)/rescue/library");
  });

  it("keeps the old route for such a notice while the release flag is off", () => {
    expect(notifyRoute("/(app)/rescue", { event: "refundDone" }, false)).toBe("/(app)/rescue");
  });

  it("never changes a non-rescue route", () => {
    expect(notifyRoute("/(app)/chat", { event: "publishHeld", projectId: "p1" }, true)).toBe("/(app)/chat");
  });

  it("opens the (app) screen for a pre-drawer (tabs) route, whatever the flag", () => {
    expect(notifyRoute("/(tabs)/chat", { thesisId: "t1" } as never, false)).toBe("/(app)/chat");
    expect(notifyRoute("/(tabs)/chat", undefined, true)).toBe("/(app)/chat");
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

describe("rescueRouteTarget", () => {
  it("reads the project and view of the living screen's route", () => {
    expect(rescueRouteTarget("/(app)/rescue?projectId=p%201&view=history")).toEqual({ projectId: "p 1", view: "history" });
    expect(rescueRouteTarget("/(app)/rescue?projectId=abc")).toEqual({ projectId: "abc" });
  });
  it("reads a deep link URL too", () => {
    expect(rescueRouteTarget("kwill://rescue?projectId=abc")).toEqual({ projectId: "abc" });
    expect(rescueRouteTarget("com.kwill.app:///rescue?view=payment&projectId=abc")).toEqual({ projectId: "abc", view: "payment" });
  });
  it("is null for the library, other routes, and a rescue route with no project", () => {
    expect(rescueRouteTarget("/(app)/rescue/library")).toBeNull();
    expect(rescueRouteTarget("/(app)/chat?projectId=abc")).toBeNull();
    expect(rescueRouteTarget("/(app)/rescue?share=1")).toBeNull();
    expect(rescueRouteTarget("/(app)/myrescue?projectId=abc")).toBeNull();
    expect(rescueRouteTarget(null)).toBeNull();
  });
});
