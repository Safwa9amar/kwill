import { beforeEach, describe, expect, it } from "vitest";
import type { RescuePreviewDTO } from "@/lib/rescue-v2-api";
import { usePreviewView } from "./rescue-preview-view";

const P = () => usePreviewView.getState();
const preview: RescuePreviewDTO = { cover: { afterUrl: "a", beforeUrl: "b" }, chapter: null };

/** A read the test settles by hand, so a late reply can be sent after the student has moved on. */
function deferredRead() {
  const asks: { projectId: string; resolve(d: RescuePreviewDTO): void; reject(): void }[] = [];
  const read = (projectId: string) => new Promise<RescuePreviewDTO>((resolve, reject) => {
    asks.push({ projectId, resolve, reject: () => reject(new Error("net")) });
  });
  return { read, asks };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  P().clear();
});

describe("the shared preview", () => {
  it("is read once for a project and version, however many screens ask for it", async () => {
    const { read, asks } = deferredRead();
    P().load("p1", "v1", read);
    P().load("p1", "v1", read);
    expect(asks.length).toBe(1);
    asks[0].resolve(preview);
    await flush();
    expect(P().status).toBe("ready");
    expect(P().data).toEqual(preview);
  });

  it("is read again for the same project at a new version", () => {
    const { read, asks } = deferredRead();
    P().load("p1", "v1", read);
    P().load("p1", "v2", read);
    expect(asks.length).toBe(2);
    expect(P().versionId).toBe("v2");
  });

  it("shows nothing of one project when the student moves to another, and drops the late reply", async () => {
    const { read, asks } = deferredRead();
    P().load("p1", "v1", read);
    P().load("p2", "v1", read);
    expect(P().projectId).toBe("p2");
    expect(P().status).toBe("loading");
    expect(P().data).toBeNull();
    asks[0].resolve(preview);
    await flush();
    expect(P().status).toBe("loading");
    expect(P().data).toBeNull();
  });

  it("a Retry from the Sheet reaches the one state the Stage reads, and asks again", async () => {
    const { read, asks } = deferredRead();
    P().load("p1", "v1", read);
    asks[0].reject();
    await flush();
    expect(P().status).toBe("failed");
    P().retry(read);
    expect(asks.length).toBe(2);
    expect(P().status).toBe("loading");
    asks[1].resolve(preview);
    await flush();
    expect(P().status).toBe("ready");
  });

  it("clear forgets the preview", async () => {
    const { read, asks } = deferredRead();
    P().load("p1", "v1", read);
    asks[0].resolve(preview);
    await flush();
    P().clear();
    expect(P().projectId).toBeNull();
    expect(P().status).toBe("idle");
    expect(P().data).toBeNull();
  });
});
