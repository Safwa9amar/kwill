import { beforeEach, describe, expect, it } from "vitest";
import { revisionsKey, useRevisionsUi } from "./rescue-revisions-ui";

// The Revisions choices belong to one version of one project. Accepting a re-run moves the project's active version, so the files chosen for
// the last re-run no longer belong to anything open and cannot be sent again.

const f = (name: string) => ({ uri: `file:///${name}`, name, size: 1 });
const S = () => useRevisionsUi.getState();

beforeEach(() => {
  useRevisionsUi.setState({ key: null, files: [], busy: false });
});

describe("revisionsKey", () => {
  it("is the project and its active version", () => {
    expect(revisionsKey({ id: "P", activeVersionId: "P-v1" })).toBe("P:P-v1");
  });

  it("moves when the active version moves, which a re-run accepted does", () => {
    expect(revisionsKey({ id: "P", activeVersionId: "P-v2" })).not.toBe(revisionsKey({ id: "P", activeVersionId: "P-v1" }));
  });

  it("has no key with no project", () => {
    expect(revisionsKey(null)).toBeNull();
  });
});

describe("the chosen files belong to one version", () => {
  it("a re-run accepted under a new active version leaves no files to re-send", () => {
    const before = revisionsKey({ id: "P", activeVersionId: "P-v1" });
    S().ensure(before as string);
    S().setFiles(before as string, [f("chosen-for-the-last-rerun.docx")]);
    expect(S().files.map((x) => x.name)).toEqual(["chosen-for-the-last-rerun.docx"]);

    S().ensure(revisionsKey({ id: "P", activeVersionId: "P-v2" }) as string);
    expect(S().files).toEqual([]);
  });

  it("files chosen for a version that is no longer open are refused", () => {
    S().ensure("P:P-v1");
    S().ensure("P:P-v2");
    S().setFiles("P:P-v1", [f("late.docx")]);
    expect(S().files).toEqual([]);
  });

  it("the same version keeps its files", () => {
    S().ensure("P:P-v1");
    S().setFiles("P:P-v1", [f("a.docx")]);
    S().ensure("P:P-v1");
    expect(S().files.map((x) => x.name)).toEqual(["a.docx"]);
  });
});

describe("one re-run call at a time", () => {
  it("a second call is refused while one is in flight, and allowed once it ends", () => {
    expect(S().begin()).toBe(true);
    expect(S().begin()).toBe(false);
    S().end();
    expect(S().begin()).toBe(true);
  });
});
