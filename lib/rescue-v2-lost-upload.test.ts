import { describe, expect, it } from "vitest";
import { lostUploadTarget } from "./rescue-v2-lost-upload";

// "Choose the file again" on a lost upload deletes only what that upload made. A first upload (v0) deletes the project; a re-run's upload
// deletes its own version and never a finished one.

const project = (over: Partial<Parameters<typeof lostUploadTarget>[0]> = {}) => ({
  id: "P",
  originalVersionId: "P-v0",
  activeVersionId: "P-v0" as string | null,
  currentVersion: null as { id: string } | null,
  ...over,
});

describe("lostUploadTarget", () => {
  it("a first upload (the active version is v0) deletes the project", () => {
    expect(lostUploadTarget(project())).toEqual({ kind: "project", projectId: "P" });
  });

  it("a re-run's upload deletes only that re-run's version, never the project", () => {
    expect(lostUploadTarget(project({ activeVersionId: "P-v2", currentVersion: { id: "P-v1" } }))).toEqual({
      kind: "version",
      versionId: "P-v2",
    });
  });

  it("a re-run's version is deleted even when the finished version is still the current one", () => {
    expect(lostUploadTarget(project({ activeVersionId: "P-v2", currentVersion: { id: "P-v2" } }))).toEqual({
      kind: "version",
      versionId: "P-v2",
    });
  });

  it("with no active version but a finished version beside v0, deletes nothing", () => {
    expect(lostUploadTarget(project({ activeVersionId: null, currentVersion: { id: "P-v1" } }))).toEqual({ kind: "none" });
  });

  it("with no active version and no finished version, is the first upload", () => {
    expect(lostUploadTarget(project({ activeVersionId: null, currentVersion: null }))).toEqual({ kind: "project", projectId: "P" });
    expect(lostUploadTarget(project({ activeVersionId: null, currentVersion: { id: "P-v0" } }))).toEqual({ kind: "project", projectId: "P" });
  });
});
