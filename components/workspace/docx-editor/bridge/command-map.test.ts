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
  it("maps lists to the list slots", () => {
    expect(mapCommand(cmd("list", "bullet"))).toEqual([{ kind: "slot", slot: "list.bullet" }]);
    expect(mapCommand(cmd("list", "number"))).toEqual([{ kind: "slot", slot: "list.numbered" }]);
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
  it("selects the paragraph first, then sets (not toggles) the marks", () => {
    const value = JSON.stringify({ bold: true, italic: false, level: 3, alignment: "right", direction: "rtl", color: "2980B9" });
    expect(mapCommand(cmd("blockFormat", value))).toEqual([
      { kind: "selectParagraph" },
      { kind: "marks", marks: { bold: true, italic: false, color: { kind: "hex", value: "2980B9" } } },
      { kind: "style", styleId: "Heading3" },
      { kind: "paragraph", update: { alignment: "right" } },
      { kind: "server", changes: { direction: "rtl" } },
    ]);
  });
  it("level 0 is Normal; clearFormatting is the slot; a null color is automatic", () => {
    const value = JSON.stringify({ level: 0, clearFormatting: true, color: null });
    expect(mapCommand(cmd("blockFormat", value))).toEqual([
      { kind: "selectParagraph" },
      { kind: "marks", marks: { color: { kind: "auto" } } },
      { kind: "slot", slot: "format.clear" },
      { kind: "style", styleId: "Normal" },
    ]);
  });
  it("refuses malformed JSON without throwing", () => {
    expect(mapCommand(cmd("blockFormat", "{not json"))).toEqual([{ kind: "noop", reason: "blockFormat: malformed value" }]);
  });
});

describe("mapCommand — Lexical-only envelopes", () => {
  it("is a noop for serialize / patchBlocks / blur / focus / insert", () => {
    for (const t of ["serialize", "patchBlocks", "blur", "focus", "insert"]) {
      expect(mapCommand(cmd(t))).toEqual([{ kind: "noop", reason: `${t}: not an engine command` }]);
    }
  });
});
