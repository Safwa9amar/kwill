import { describe, expect, it } from "vitest";
import { routeForIncoming } from "./rescue-v2-share";

describe("routeForIncoming", () => {
  it("sends the native share intent to the rescue screen with its share flag", () => {
    expect(routeForIncoming("kwill://expo-sharing?x=1")).toBe("/rescue?share=1");
  });

  it("leaves a sign-in link alone", () => {
    expect(routeForIncoming("kwill:///#access_token=abc")).toBe("kwill:///#access_token=abc");
  });

  it("leaves a relative payment return alone", () => {
    expect(routeForIncoming("/payment-success?rescue=1")).toBe("/payment-success?rescue=1");
  });

  it("leaves another app path on the same scheme alone", () => {
    expect(routeForIncoming("kwill://payment-success")).toBe("kwill://payment-success");
  });

  it("leaves an empty path alone", () => {
    expect(routeForIncoming("")).toBe("");
  });
});
