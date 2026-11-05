import { describe, expect, it } from "vitest";
import { ifMatchValue, noteUntrackedWrite, onUntrackedWrite, tagOfRead, tagOfWrite, thesisOfWrite } from "./thesis-op-tag";

describe("ifMatchValue", () => {
  it("quotes a known tag, and sends no header when no tag is known", () => {
    expect(ifMatchValue("h1")).toBe('"h1"');
    expect(ifMatchValue(null)).toBeNull();
    expect(ifMatchValue(undefined)).toBeNull();
    expect(ifMatchValue("")).toBeNull();
  });
});

describe("tagOfWrite", () => {
  it("reads the tag of the state after the write, from the history", () => {
    expect(tagOfWrite({ ok: true, history: { canUndo: true, canRedo: false, docHash: "h2" } })).toBe("h2");
  });

  it("never reads the echoed document's tag, which is the one from before the write", () => {
    expect(tagOfWrite({ ok: true, document: { available: true, docHash: "h1" }, history: { canUndo: false, canRedo: false } })).toBeNull();
  });

  it("knows no tag for an answer without a history, or with an empty one", () => {
    expect(tagOfWrite({ ok: true, document: { available: true, docHash: "h1" } })).toBeNull();
    expect(tagOfWrite({ history: { docHash: "" } })).toBeNull();
    expect(tagOfWrite(null)).toBeNull();
  });
});

describe("tagOfRead", () => {
  it("reads the tag of a live document", () => {
    expect(tagOfRead({ id: "t", available: true, docHash: "h3" })).toBe("h3");
  });

  it("knows no tag for a legacy document, a document with no hash, or nothing", () => {
    expect(tagOfRead({ docMode: "legacy-db", available: false })).toBeNull();
    expect(tagOfRead({ available: true, docHash: null })).toBeNull();
    expect(tagOfRead(undefined)).toBeNull();
  });
});

describe("untracked writes", () => {
  it("names the thesis of a path under /api/thesis/<id>/, and nothing else", () => {
    expect(thesisOfWrite("/api/thesis/t1/chrome-op")).toBe("t1");
    expect(thesisOfWrite("/api/thesis/t%201/ops")).toBe("t 1");
    expect(thesisOfWrite("/api/thesis/t1")).toBeNull();
    expect(thesisOfWrite("/api/rescue/projects")).toBeNull();
  });

  it("tells every listener which thesis was written, and stops after unsubscribe", () => {
    const seen: string[] = [];
    const off = onUntrackedWrite((id) => seen.push(id));
    noteUntrackedWrite("/api/thesis/t1/chrome-op");
    noteUntrackedWrite("/api/rescue/projects");
    off();
    noteUntrackedWrite("/api/thesis/t2/chrome-op");
    expect(seen).toEqual(["t1"]);
  });
});
