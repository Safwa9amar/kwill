import { describe, it, expect } from "vitest";
import type { DocBlockDTO } from "@/lib/api";
import type { ThesisOp } from "@/lib/thesis-ops";
import { blocksOf, colorValue, diffSpan, paraFormatOf, planOp } from "./op-map";

const para = (index: number, text: string, extra: Record<string, unknown> = {}): DocBlockDTO =>
  ({ index, kind: "paragraph", text, styleId: null, level: 0, alignment: null, direction: null, ...extra }) as DocBlockDTO;
const table = (index: number, rows: string[][], extra: Record<string, unknown> = {}): DocBlockDTO =>
  ({ index, kind: "table", rows, ...extra }) as DocBlockDTO;
const image = (index: number): DocBlockDTO => ({ index, kind: "image", hasMedia: true }) as DocBlockDTO;

const DOC: DocBlockDTO[] = [
  para(0, "Introduction"),
  para(1, "First paragraph of the body."),
  table(2, [["Name", "Age"], ["Ali", ""], ["", ""]]),
  image(3),
  para(4, ""),
  para(5, "x = y", { math: [{ omml: "<m/>" }] }),
  table(6, [["أ", "ب"], ["ج", "د"]], { direction: "rtl" }),
];

const plan = (op: ThesisOp) => planOp(op, DOC);
const verdictOf = (op: ThesisOp) => (plan(op).local ? "local" : "server");

describe("planOp — every ThesisOp variant has a verdict", () => {
  const cases: [ThesisOp, "local" | "server"][] = [
    [{ type: "editText", index: 1, text: "Rewritten." }, "local"],
    [{ type: "splitParagraph", index: 1, before: "First", after: " paragraph" }, "server"],
    [{ type: "format", indices: [0, 1], changes: { bold: true } }, "local"],
    [{ type: "format", indices: [0], changes: { direction: "rtl" } }, "local"],
    [{ type: "move", from: 1, to: 0 }, "server"],
    [{ type: "insertImage", afterIndex: 1, data: "AAAA", format: "png" }, "server"],
    [{ type: "replaceImage", index: 3, data: "AAAA", format: "png" }, "server"],
    [{ type: "deleteBlocks", indices: [1] }, "server"],
    [{ type: "startOnNewPage", indices: [1] }, "server"],
    [{ type: "setList", indices: [1], list: "bullet" }, "local"],
    [{ type: "tableOp", index: 2, action: "addRow" }, "server"], // last row is empty — nothing to find it by
    [{ type: "tableOp", index: 2, action: "addRow", at: 0, before: true }, "local"],
    [{ type: "tableOp", index: 2, action: "deleteRow", row: 1 }, "local"],
    [{ type: "tableOp", index: 2, action: "addColumn" }, "local"],
    [{ type: "tableOp", index: 2, action: "deleteColumn", col: 0 }, "local"],
    [{ type: "tableOp", index: 2, action: "editCell", row: 0, col: 1, text: "Years" }, "local"],
    [{ type: "tableOp", index: 2, action: "layout", opts: { alignment: "center" } }, "local"],
    [{ type: "tableOp", index: 2, action: "shade", fills: [["FF0000"]] }, "server"],
    [{ type: "setCaption", index: 3, caption: "Figure 1" }, "server"],
    [{ type: "insertTable", index: 4, rows: [["a", "b"]] }, "server"],
  ];
  for (const [op, want] of cases) {
    it(`${op.type}${"action" in op ? `:${op.action}` : ""} → ${want}`, () => {
      expect(verdictOf(op)).toBe(want);
    });
  }
});

describe("planOp — text", () => {
  it("carries the model's ORIGINAL text so the DOM can prove it found the right paragraph", () => {
    expect(plan({ type: "editText", index: 1, text: "New." })).toEqual({
      local: true,
      steps: [{ k: "text", at: { index: 1, text: "First paragraph of the body." }, next: "New." }],
    });
  });
  it("sends a paragraph mark, an equation paragraph, or a non-paragraph to the server", () => {
    expect(verdictOf({ type: "editText", index: 1, text: "a\nb" })).toBe("server");
    expect(verdictOf({ type: "editText", index: 5, text: "x = z" })).toBe("server");
    expect(verdictOf({ type: "editText", index: 3, text: "nope" })).toBe("server");
  });
});

describe("planOp — format", () => {
  it("maps level to Heading styles and keeps marks as SET values", () => {
    expect(plan({ type: "format", indices: [1], changes: { level: 2, bold: false, color: "#c0392b", alignment: "justify" } })).toEqual({
      local: true,
      steps: [{
        k: "format",
        at: [{ index: 1, text: "First paragraph of the body." }],
        fmt: { styleId: "Heading2", alignment: "justify", marks: { bold: false, color: "C0392B" } },
      }],
    });
  });
  it("direction is LOCAL: the page turns first, then the bytes leave", () => {
    expect(plan({ type: "format", indices: [0], changes: { direction: "rtl", bold: true } })).toEqual({
      local: true,
      steps: [{ k: "format", at: [{ index: 0, text: "Introduction" }], fmt: { direction: "rtl", marks: { bold: true } } }],
    });
  });
  it("a target that is not a paragraph sends the whole op to the server", () => {
    expect(verdictOf({ type: "format", indices: [1, 2], changes: { italic: true } })).toBe("server");
  });
  it("level 0 is Normal, a named style passes through, clear is the engine's Clear All", () => {
    expect(paraFormatOf({ level: 0 })).toEqual({ styleId: "Normal" });
    expect(paraFormatOf({ styleId: "Title" })).toEqual({ styleId: "Title" });
    expect(paraFormatOf({ clearFormatting: true, color: null })).toEqual({ clear: true, marks: { color: "auto" } });
  });
  it("an empty change is a no-op handled locally (nothing to send)", () => {
    expect(plan({ type: "format", indices: [1], changes: {} })).toEqual({ local: true, steps: [] });
  });
});

describe("planOp — tables", () => {
  it("addRow at the top finds row 0 by a cell's text and inserts above", () => {
    expect(plan({ type: "tableOp", index: 2, action: "addRow", at: 0, before: true })).toEqual({
      local: true,
      steps: [{
        k: "table",
        at: { index: 2, rows: [["Name", "Age"], ["Ali", ""], ["", ""]] },
        cell: { row: 0, col: 0, text: "Name" },
        act: { do: "insertRow", where: "above" },
      }],
    });
  });
  it("addColumn on an RTL table goes to the server (left/right is visual in the engine)", () => {
    expect(verdictOf({ type: "tableOp", index: 6, action: "addColumn" })).toBe("server");
    expect(verdictOf({ type: "tableOp", index: 6, action: "deleteColumn", col: 1 })).toBe("local");
  });
  it("editCell into an empty cell cannot be found → server", () => {
    expect(verdictOf({ type: "tableOp", index: 2, action: "editCell", row: 1, col: 1, text: "30" })).toBe("server");
  });
  it("layout beyond alignment has no engine command → server", () => {
    expect(verdictOf({ type: "tableOp", index: 2, action: "layout", opts: { alignment: "left", borders: true } })).toBe("server");
    expect(verdictOf({ type: "tableOp", index: 2, action: "layout", opts: { widthPct: 80 } })).toBe("server");
  });
  it("a tableOp on a block the model does not call a table is server", () => {
    expect(verdictOf({ type: "tableOp", index: 1, action: "addRow" })).toBe("server");
  });
});

describe("planOp — in-flight marks for server ops", () => {
  it("deleteBlocks dims the blocks it will remove", () => {
    expect(plan({ type: "deleteBlocks", indices: [0, 1] })).toMatchObject({
      local: false,
      pending: { look: "removing", at: [{ index: 0, text: "Introduction" }, { index: 1, text: "First paragraph of the body." }] },
    });
  });
  it("a non-text block is marked by index alone", () => {
    expect(plan({ type: "replaceImage", index: 3, data: "", format: "png" })).toMatchObject({
      pending: { look: "busy", at: [{ index: 3, text: "" }] },
    });
  });
});

describe("blocksOf", () => {
  it("lists every block a local plan touches, once", () => {
    expect(blocksOf([
      { k: "text", at: { index: 4, text: "a" }, next: "b" },
      { k: "format", at: [{ index: 4, text: "a" }, { index: 5, text: "c" }], fmt: { clear: true } },
      { k: "table", at: { index: 9, rows: [["x"]] }, cell: { row: 0, col: 0, text: "x" }, act: { do: "deleteRow" } },
    ])).toEqual([4, 5, 9]);
  });
});

describe("colorValue", () => {
  it("normalises hex and falls back to auto", () => {
    expect(colorValue("#2980b9")).toBe("2980B9");
    expect(colorValue(null)).toBe("auto");
    expect(colorValue("red")).toBe("auto");
  });
});

describe("diffSpan", () => {
  it("replaces only the changed middle", () => {
    expect(diffSpan("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(diffSpan("the cat sat", "the dog sat")).toEqual({ from: 4, to: 7, insert: "dog" });
    expect(diffSpan("abc", "abc")).toEqual({ from: 3, to: 3, insert: "" });
    expect(diffSpan("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
    expect(diffSpan("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
  });
  it("never lets the shared suffix overlap the shared prefix", () => {
    expect(diffSpan("aa", "aaa")).toEqual({ from: 2, to: 2, insert: "a" });
    expect(diffSpan("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
  });
  it("works on Arabic and never splits a surrogate pair", () => {
    expect(diffSpan("قال الباحث", "قال الطالب")).toEqual({ from: 6, to: 10, insert: "طالب" });
    // 😀 and 😃 share their high surrogate: the whole pair must be replaced.
    const d = diffSpan("a😀b", "a😃b");
    expect(d).toEqual({ from: 1, to: 3, insert: "😃" });
  });
});
