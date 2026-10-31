import { describe, it, expect } from "vitest";
import type { Editor } from "@docx-editor.dev/react";
import { applyRangeLocally, wholeParagraphMatch } from "./apply-range";

type Match = {
  blockId: string; start: number; length: number; text: string;
  paragraphIndex: number; runIndex: number; runOffset: number;
  scope?: unknown; contextBefore?: string; contextAfter?: string;
};
const id = (i: number) => `/word/document.xml#0.1.${i}`;
const match = (i: number, text: string, extra: Partial<Match> = {}): Match =>
  ({ blockId: id(i), start: 0, length: text.length, text, paragraphIndex: i, runIndex: 0, runOffset: 0, ...extra });

/** Just enough of the engine: findMatches answers from a table, can/exec record. */
function fakeEditor(matches: Record<string, Match[]>, opts: { refuse?: string; unchanged?: boolean } = {}) {
  const ran: { type: string; [k: string]: unknown }[] = [];
  const editor = {
    findMatches: (q: string) => matches[q] ?? [],
    can: (cmd: { type: string }) =>
      opts.refuse === cmd.type ? { ok: false, code: "unsupported", reason: "nope" } : { ok: true },
    exec: (cmd: { type: string }) => {
      ran.push(cmd);
      return { ok: true, changed: cmd.type === "paste" ? !opts.unchanged : false };
    },
  };
  return { editor: editor as unknown as Editor, ran };
}

describe("wholeParagraphMatch", () => {
  it("takes the match whose id parses to the index, whitespace-normalised", () => {
    const { editor } = fakeEditor({ "Alpha beta": [match(3, "Alpha beta"), match(9, "Alpha beta")] });
    expect(wholeParagraphMatch(editor, 9, "  Alpha \n beta ")?.blockId).toBe(id(9));
  });
  it("never falls back to another block (unlike navigation)", () => {
    const { editor } = fakeEditor({ "Alpha": [match(3, "Alpha")] });
    expect(wholeParagraphMatch(editor, 4, "Alpha")).toBeNull();
  });
  it("refuses a match that is only part of its paragraph", () => {
    const { editor } = fakeEditor({ "Alpha": [match(3, "Alpha", { contextAfter: " and more" })] });
    expect(wholeParagraphMatch(editor, 3, "Alpha")).toBeNull();
    const { editor: e2 } = fakeEditor({ "Alpha": [match(3, "Alpha", { contextBefore: "So: " })] });
    expect(wholeParagraphMatch(e2, 3, "Alpha")).toBeNull();
  });
  it("refuses cell paragraphs, other stories, and an empty text", () => {
    const { editor } = fakeEditor({
      "Alpha": [match(3, "Alpha", { blockId: `${id(3)}.0.0.0` }), match(3, "Alpha", { scope: { kind: "header" } })],
    });
    expect(wholeParagraphMatch(editor, 3, "Alpha")).toBeNull();
    expect(wholeParagraphMatch(editor, 3, "   ")).toBeNull();
  });
});

describe("applyRangeLocally", () => {
  const req = { start: 4, end: 6, firstText: "First para", lastText: "Last para", paragraphs: ["New one", " ", "New two"] };

  it("selects first-start → last-end, then pastes the kept paragraphs as lines", () => {
    const { editor, ran } = fakeEditor({
      "First para": [match(4, "First para")],
      "Last para": [match(6, "Last para", { start: 2 })],
    });
    expect(applyRangeLocally(editor, req)).toEqual({ ok: true });
    expect(ran).toEqual([
      {
        type: "setSelection",
        range: { anchor: { paragraphId: id(4), offset: 0 }, head: { paragraphId: id(6), offset: 2 + "Last para".length } },
      },
      { type: "paste", text: "New one\nNew two" },
    ]);
  });

  it("a one-block range reuses the first match", () => {
    const { editor, ran } = fakeEditor({ "Only": [match(2, "Only")] });
    expect(applyRangeLocally(editor, { start: 2, end: 2, firstText: "Only", lastText: "ignored", paragraphs: ["X"] }).ok).toBe(true);
    expect(ran[0]).toMatchObject({ range: { head: { paragraphId: id(2), offset: 4 } } });
  });

  it("refuses — and writes nothing — when either end cannot be pinned", () => {
    const { editor, ran } = fakeEditor({ "First para": [match(4, "First para")] });
    expect(applyRangeLocally(editor, req).ok).toBe(false);
    expect(ran).toEqual([]);
  });

  it("refuses when the engine will not paste, and when the paste changed nothing", () => {
    const m = { "First para": [match(4, "First para")], "Last para": [match(6, "Last para")] };
    const refused = fakeEditor(m, { refuse: "paste" });
    expect(applyRangeLocally(refused.editor, req).ok).toBe(false);
    expect(refused.ran.map((c) => c.type)).toEqual(["setSelection"]);
    const unchanged = fakeEditor(m, { unchanged: true });
    expect(applyRangeLocally(unchanged.editor, req).ok).toBe(false);
  });

  it("refuses an empty passage and a reversed range outright", () => {
    const { editor, ran } = fakeEditor({});
    expect(applyRangeLocally(editor, { ...req, paragraphs: [" ", ""] }).ok).toBe(false);
    expect(applyRangeLocally(editor, { ...req, start: 7, end: 6 }).ok).toBe(false);
    expect(ran).toEqual([]);
  });
});
