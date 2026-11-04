import { describe, expect, it } from "vitest";
import { keepDocx, partsRefusal } from "./rescue-v2-pick";

const MB = 1024 * 1024;
const LIMITS = { partMb: 50, parts: 12, totalMb: 120 };

describe("keepDocx", () => {
  it("keeps .docx in any letter case and drops everything else", () => {
    const kept = keepDocx([
      { name: "a.docx" },
      { name: "B.DOCX" },
      { name: "thesis.pdf" },
      { name: "old.doc" },
      { name: "docx" },
    ]);
    expect(kept.map((f) => f.name)).toEqual(["a.docx", "B.DOCX"]);
  });
});

describe("partsRefusal", () => {
  const part = (size: number) => ({ uri: "file:///x", name: "p.docx", size });

  it("refuses more parts than the limit", () => {
    const files = Array.from({ length: 13 }, () => part(1));
    expect(partsRefusal(files, LIMITS)).toEqual({ key: "tooMany" });
  });

  it("accepts exactly the limit of parts", () => {
    const files = Array.from({ length: 12 }, () => part(1));
    expect(partsRefusal(files, LIMITS)).toBeNull();
  });

  it("refuses one part over the per-part limit, naming that limit", () => {
    expect(partsRefusal([part(50 * MB + 1)], LIMITS)).toEqual({ key: "tooLarge", mb: 50 });
  });

  it("accepts a part exactly at the per-part limit", () => {
    expect(partsRefusal([part(50 * MB)], LIMITS)).toBeNull();
  });

  it("refuses when the parts together pass the total, naming the total", () => {
    const files = [part(50 * MB), part(50 * MB), part(20 * MB + 1)];
    expect(partsRefusal(files, LIMITS)).toEqual({ key: "tooLarge", mb: 120 });
  });

  it("treats an unknown size (0) as fitting", () => {
    expect(partsRefusal([part(0)], LIMITS)).toBeNull();
  });
});
