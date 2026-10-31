import { describe, it, expect } from "vitest";
import { mapCommand } from "./command-map";

const cmd = (type: string, value?: string) => ({ type, value, nonce: 1 });

describe("mapCommand — inline marks and history", () => {
  it("maps the three toggles to the engine's text slots", () => {
    expect(mapCommand(cmd("bold"))).toEqual([{ kind: "slot", slot: "text.bold" }]);
    expect(mapCommand(cmd("italic"))).toEqual([{ kind: "slot", slot: "text.italic" }]);
    expect(mapCommand(cmd("underline"))).toEqual([{ kind: "slot", slot: "text.underline" }]);
  });
  it("maps undo/redo to history slots", () => {
    expect(mapCommand(cmd("undo"))).toEqual([{ kind: "slot", slot: "history.undo" }]);
    expect(mapCommand(cmd("redo"))).toEqual([{ kind: "slot", slot: "history.redo" }]);
  });
  it("maps clearFormatting", () => {
    expect(mapCommand(cmd("clearFormatting"))).toEqual([{ kind: "slot", slot: "format.clear" }]);
  });
});

describe("mapCommand — paragraph level", () => {
  it("maps align to the alignment slots and ignores an unknown value", () => {
    expect(mapCommand(cmd("align", "center"))).toEqual([{ kind: "slot", slot: "alignment.center" }]);
    expect(mapCommand(cmd("align", "justify"))).toEqual([{ kind: "slot", slot: "alignment.justify" }]);
    expect(mapCommand(cmd("align", "weird"))).toEqual([{ kind: "noop", reason: "align: unknown value weird" }]);
  });
  it("maps heading to Word's Heading styles, paragraph to Normal, quote to Quote", () => {
    expect(mapCommand(cmd("heading", "h2"))).toEqual([{ kind: "style", styleId: "Heading2" }]);
    expect(mapCommand(cmd("heading", "paragraph"))).toEqual([{ kind: "style", styleId: "Normal" }]);
    expect(mapCommand(cmd("quote"))).toEqual([{ kind: "style", styleId: "Quote" }]);
  });
  it("maps every list value the bubbles send to a SET (not a toggle)", () => {
    for (const v of ["bullet", "ul", "check"]) expect(mapCommand(cmd("list", v))).toEqual([{ kind: "list", list: "bullet" }]);
    for (const v of ["number", "ol"]) expect(mapCommand(cmd("list", v))).toEqual([{ kind: "list", list: "number" }]);
    expect(mapCommand(cmd("list", "none"))).toEqual([{ kind: "list", list: null }]);
    expect(mapCommand(cmd("list", "indent"))).toEqual([{ kind: "indent", direction: "increase" }]);
    expect(mapCommand(cmd("list", "outdent"))).toEqual([{ kind: "indent", direction: "decrease" }]);
    expect(mapCommand(cmd("list", "weird"))).toEqual([{ kind: "noop", reason: "list: unknown value weird" }]);
  });
  it("routes direction to the server — the engine exposes no paragraph-direction command", () => {
    expect(mapCommand(cmd("direction", "rtl"))).toEqual([{ kind: "server", changes: { direction: "rtl" } }]);
  });
  it("maps color to a hex mark, and an empty value to automatic", () => {
    expect(mapCommand(cmd("color", "C0392B"))).toEqual([{ kind: "marks", marks: { color: { kind: "hex", value: "C0392B" } } }]);
    expect(mapCommand(cmd("color", ""))).toEqual([{ kind: "marks", marks: { color: { kind: "auto" } } }]);
  });
});

describe("mapCommand — whole-block format from the pill", () => {
  it("is not run in the DOM: the host sends it through mutate → applyOp as a format op", () => {
    const value = JSON.stringify({ indices: [3], changes: { bold: true, level: 3 } });
    expect(mapCommand(cmd("blockFormat", value))).toEqual([
      { kind: "noop", reason: "blockFormat: the docx host sends it through mutate → applyOp as a format op" },
    ]);
  });
});

describe("mapCommand — the Insert drawer", () => {
  const ins = (kind: string) => mapCommand(cmd("insert", JSON.stringify({ kind })));
  it("restyles for the text and style kinds", () => {
    expect(ins("h2")).toEqual([{ kind: "insert", then: { style: "Heading2" } }]);
    expect(ins("quote")).toEqual([{ kind: "insert", then: { style: "Quote" } }]);
    expect(ins("intenseQuote")).toEqual([{ kind: "insert", then: { style: "IntenseQuote" } }]);
    expect(ins("normal")).toEqual([{ kind: "insert", then: { style: "Normal" } }]);
  });
  it("lists, page break and table run in the engine", () => {
    expect(ins("bullet")).toEqual([{ kind: "insert", then: { list: "bullet" } }]);
    expect(ins("number")).toEqual([{ kind: "insert", then: { list: "number" } }]);
    expect(ins("pageBreak")).toEqual([{ kind: "insert", then: { pageBreak: true } }]);
    expect(ins("table")).toEqual([{ kind: "insert", then: { table: { rows: 3, cols: 3 } } }]);
  });
  it("clearSlash and the drawer's native kinds only clear the /query", () => {
    for (const k of ["clearSlash", "figure", "pasteImage", "equation", "toc", "footnote", "divider"]) {
      expect(ins(k)).toEqual([{ kind: "insert", then: null }]);
    }
  });
  it("refuses malformed JSON without throwing", () => {
    expect(mapCommand(cmd("insert", "{not json"))).toEqual([{ kind: "noop", reason: "insert: malformed value" }]);
  });
});

describe("mapCommand — keyboard and Lexical-only envelopes", () => {
  it("maps focus / blur", () => {
    expect(mapCommand(cmd("focus"))).toEqual([{ kind: "focus" }]);
    expect(mapCommand(cmd("blur"))).toEqual([{ kind: "blur" }]);
  });
  it("is a noop for serialize / patchBlocks (nothing sends them to this surface)", () => {
    for (const t of ["serialize", "patchBlocks"]) {
      expect(mapCommand(cmd(t))).toEqual([{ kind: "noop", reason: `${t}: not an engine command` }]);
    }
  });
});
