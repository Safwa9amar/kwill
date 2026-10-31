// apply-op.ts against a FAKE engine: the real one needs a browser, but what this
// module decides — which paragraph is the target, whether it is proven, which
// span is rewritten, in what order commands go out — is plain logic over the
// engine's answers, and those answers are modelled here exactly as the 2.21.1
// runtime gives them (findMatches: case-sensitive literal search, raw offsets,
// 48-char context; selection-scoped text commands).

import { describe, it, expect, vi } from "vitest";

vi.mock("@docx-editor.dev/react", () => ({
  commandForSlot: (slot: string) => ({ type: "toggleMark", mark: slot.split(".")[1] }),
  toolbarCommandState: () => ({ active: false, enabled: true }),
}));
vi.mock("@docx-editor.dev/core/editor", () => ({
  commandForSlotValue: (_slot: string, value: string) => ({ type: "setMarkAttr", mark: "color", attr: "val", value }),
}));

import { applySteps, locateParagraph, placeCaret, type Engine } from "./apply-op";

type Para = { id: string; text: string; bold?: boolean; style?: string };
type Cmd = { type: string; [k: string]: unknown };

const BODY = (i: number) => `/word/document.xml#0.1.${i}`;

function fakeEngine(paras: Para[], opts: { styles?: string[] } = {}) {
  const log: Cmd[] = [];
  let sel = { id: paras[0]?.id ?? "", from: 0, to: 0 };
  const byId = (id: string) => paras.find((p) => p.id === id);
  const ed = {
    findMatches(q: string, o?: { matchCase?: boolean }) {
      if (!o?.matchCase) throw new Error("the fake only models case-sensitive search");
      const out = [];
      for (const p of paras) {
        for (let at = p.text.indexOf(q); at >= 0; at = p.text.indexOf(q, at + 1)) {
          out.push({
            blockId: p.id, start: at, length: q.length, paragraphIndex: 0, runIndex: 0, runOffset: at, text: q,
            contextBefore: p.text.slice(Math.max(0, at - 48), at), contextAfter: p.text.slice(at + q.length, at + q.length + 48),
          });
        }
      }
      return out;
    },
    exec(c: Cmd) {
      log.push(c);
      const p = byId(sel.id);
      switch (c.type) {
        case "setSelection": {
          const r = c.range as { anchor: { paragraphId: string; offset: number }; head: { paragraphId: string; offset: number } };
          sel = { id: r.anchor.paragraphId, from: r.anchor.offset, to: r.head.offset };
          return { ok: true, changed: false };
        }
        case "deleteText":
          if (!p) return { ok: false, code: "notFound", reason: "no paragraph" };
          p.text = p.text.slice(0, sel.from) + p.text.slice(sel.to);
          sel = { ...sel, to: sel.from };
          return { ok: true, changed: true };
        case "pasteWithoutFormatting": {
          // insertPlainText: the selection is deleted and the text inserted in one commit.
          if (!p) return { ok: false, code: "notFound", reason: "no paragraph" };
          if (!c.text) return { ok: false, code: "invalidArgs", reason: "there is nothing to paste" };
          p.text = p.text.slice(0, sel.from) + String(c.text) + p.text.slice(sel.to);
          const at = sel.from + String(c.text).length;
          sel = { ...sel, from: at, to: at };
          return { ok: true, changed: true };
        }
        case "toggleMark":
          if (p) p.bold = !p.bold;
          return { ok: true, changed: true };
        case "setParagraphStyle":
          if (!opts.styles?.includes(String(c.styleId))) return { ok: false, code: "invalidArgs", reason: `style '${c.styleId}' is not a paragraph style of this document` };
          if (p) p.style = String(c.styleId);
          return { ok: true, changed: true };
        default:
          return { ok: true, changed: true };
      }
    },
    isActive: () => !!byId(sel.id)?.bold,
    beginHistoryGroup: () => ({ state: "open", end: () => {} }),
    getSelectedTable: () => null,
  };
  const engine = { ed: ed as unknown as Engine["ed"], surface: null } as Engine;
  return { engine, log, paras, selection: () => sel };
}

const LONG = "ن".repeat(150) + " وسط الفقرة " + "م".repeat(150); // 313 chars: past the 256 query cap

describe("locateParagraph", () => {
  it("finds a paragraph by its whole text, preferring the one whose id still parses to the index", () => {
    const { engine } = fakeEngine([
      { id: BODY(3), text: "خلاصة الفصل" },
      { id: BODY(9), text: "خلاصة الفصل" },
    ]);
    expect(locateParagraph(engine, { index: 9, text: "خلاصة الفصل" }, new Map())).toEqual({ id: BODY(9), end: 11 });
  });
  it("gives up on two candidates when neither id matches (drifted ids, duplicate text)", () => {
    const { engine } = fakeEngine([
      { id: BODY(3), text: "Conclusion" },
      { id: BODY(9), text: "Conclusion" },
    ]);
    expect(locateParagraph(engine, { index: 5, text: "Conclusion" }, new Map())).toBeNull();
  });
  it("takes a unique candidate even when its id drifted", () => {
    const { engine } = fakeEngine([{ id: BODY(8), text: "Only one" }]);
    expect(locateParagraph(engine, { index: 7, text: "Only one" }, new Map())).toEqual({ id: BODY(8), end: 8 });
  });
  it("never accepts a paragraph that merely STARTS with the text", () => {
    const { engine } = fakeEngine([{ id: BODY(2), text: "Introduction to methods" }]);
    expect(locateParagraph(engine, { index: 2, text: "Introduction" }, new Map())).toBeNull();
  });
  it("ignores a table cell's paragraph (deeper id) with the same text", () => {
    const { engine } = fakeEngine([{ id: `${BODY(4)}.0.0.0`, text: "Total" }]);
    expect(locateParagraph(engine, { index: 4, text: "Total" }, new Map())).toBeNull();
  });
  it("proves a paragraph longer than the query cap by its head AND its tail", () => {
    const { engine } = fakeEngine([
      { id: BODY(1), text: LONG },
      { id: BODY(2), text: LONG.slice(0, 200) + " but a different ending" },
    ]);
    expect(locateParagraph(engine, { index: 1, text: LONG }, new Map())).toEqual({ id: BODY(1), end: LONG.length });
  });
  it("names an empty paragraph only through the selection", () => {
    const { engine } = fakeEngine([{ id: BODY(6), text: "" }]);
    expect(locateParagraph(engine, { index: 6, text: "" }, new Map())).toBeNull();
    expect(locateParagraph(engine, { index: 6, text: "" }, new Map([[6, { id: BODY(6), text: "" }]]))).toEqual({ id: BODY(6), end: 0 });
  });
});

describe("applySteps — text", () => {
  it("rewrites only the changed span: select it, then ONE plain paste (one undo step)", () => {
    const f = fakeEngine([{ id: BODY(1), text: "the cat sat on the mat" }]);
    const r = applySteps(f.engine, [{ k: "text", at: { index: 1, text: "the cat sat on the mat" }, next: "the dog sat on the mat" }]);
    expect(r).toEqual({ ok: true });
    expect(f.paras[0].text).toBe("the dog sat on the mat");
    expect(f.log.map((c) => c.type)).toEqual(["setSelection", "pasteWithoutFormatting"]);
    expect(f.log[0]).toMatchObject({ range: { anchor: { paragraphId: BODY(1), offset: 4 }, head: { paragraphId: BODY(1), offset: 7 } } });
    expect(f.log[1]).toMatchObject({ text: "dog" });
  });
  it("a pure insertion pastes at a caret", () => {
    const f = fakeEngine([{ id: BODY(0), text: "Hello world" }]);
    applySteps(f.engine, [{ k: "text", at: { index: 0, text: "Hello world" }, next: "Hello brave world" }]);
    expect(f.paras[0].text).toBe("Hello brave world");
    expect(f.log[0]).toMatchObject({ range: { anchor: { offset: 6 }, head: { offset: 6 } } });
  });
  it("a pure deletion is deleteText (an empty paste is refused)", () => {
    const f = fakeEngine([{ id: BODY(0), text: "Hello brave world" }]);
    applySteps(f.engine, [{ k: "text", at: { index: 0, text: "Hello brave world" }, next: "Hello world" }]);
    expect(f.paras[0].text).toBe("Hello world");
    expect(f.log.map((c) => c.type)).toEqual(["setSelection", "deleteText"]);
  });
  it("refuses — and touches nothing — when the paragraph no longer reads as the model says", () => {
    const f = fakeEngine([{ id: BODY(1), text: "the student typed here since" }]);
    const r = applySteps(f.engine, [{ k: "text", at: { index: 1, text: "the old text" }, next: "new" }]);
    expect(r.ok).toBe(false);
    expect(f.log).toEqual([]);
    expect(f.paras[0].text).toBe("the student typed here since");
  });
  it("re-proves the rewritten span of a long paragraph at its exact offsets", () => {
    const f = fakeEngine([{ id: BODY(1), text: LONG }]);
    const next = LONG.replace("وسط", "قلب");
    expect(applySteps(f.engine, [{ k: "text", at: { index: 1, text: LONG }, next }])).toEqual({ ok: true });
    expect(f.paras[0].text).toBe(next);
  });
  it("a long paragraph whose middle changed under the model is refused, ends intact or not", () => {
    const drifted = LONG.replace("وسط", "XYZ");
    const f = fakeEngine([{ id: BODY(1), text: drifted }]);
    const r = applySteps(f.engine, [{ k: "text", at: { index: 1, text: LONG }, next: LONG.replace("وسط", "قلب") }]);
    expect(r.ok).toBe(false);
    expect(f.paras[0].text).toBe(drifted);
  });
});

describe("applySteps — format", () => {
  it("bold is a SET: an already-bold paragraph is not toggled off", () => {
    const f = fakeEngine([{ id: BODY(2), text: "Heading text", bold: true }], { styles: ["Heading2"] });
    const r = applySteps(f.engine, [{ k: "format", at: [{ index: 2, text: "Heading text" }], fmt: { styleId: "Heading2", marks: { bold: true } } }]);
    expect(r).toEqual({ ok: true });
    expect(f.paras[0]).toMatchObject({ bold: true, style: "Heading2" });
    expect(f.log.filter((c) => c.type === "toggleMark")).toHaveLength(0);
  });
  it("bold off on a bold paragraph toggles exactly once", () => {
    const f = fakeEngine([{ id: BODY(2), text: "Some text", bold: true }]);
    applySteps(f.engine, [{ k: "format", at: [{ index: 2, text: "Some text" }], fmt: { marks: { bold: false } } }]);
    expect(f.paras[0].bold).toBe(false);
    expect(f.log.filter((c) => c.type === "toggleMark")).toHaveLength(1);
  });
  it("a style the document does not define is refused → the whole op goes to the server", () => {
    const f = fakeEngine([{ id: BODY(2), text: "Some text" }], { styles: [] });
    const r = applySteps(f.engine, [{ k: "format", at: [{ index: 2, text: "Some text" }], fmt: { styleId: "IntenseQuote" } }]);
    expect(r.ok).toBe(false);
  });
  it("places EVERY target before running any: one missing paragraph changes nothing", () => {
    const f = fakeEngine([{ id: BODY(1), text: "first" }]);
    const r = applySteps(f.engine, [{ k: "format", at: [{ index: 1, text: "first" }, { index: 2, text: "gone" }], fmt: { marks: { bold: true } } }]);
    expect(r.ok).toBe(false);
    expect(f.paras[0].bold).toBeFalsy();
    expect(f.log.filter((c) => c.type !== "setSelection")).toEqual([]);
  });
});

describe("placeCaret — the caret put back after a load()", () => {
  const match = (id: string, text: string, query: string) => ({
    blockId: id, start: 0, length: query.length, paragraphIndex: 0, runIndex: 0, runOffset: 0, text: query,
    contextBefore: "", contextAfter: text.slice(query.length, query.length + 48),
  });
  it("restores the student's offsets as a CARET, never the matched range", () => {
    const text = "a paragraph the student was typing in";
    const f = fakeEngine([{ id: BODY(4), text }]);
    placeCaret(f.engine.ed, match(BODY(4), text, text), { anchor: 17, head: 17 });
    expect(f.selection()).toEqual({ id: BODY(4), from: 17, to: 17 });
  });
  it("without remembered offsets, lands collapsed at the end of the match", () => {
    const f = fakeEngine([{ id: BODY(4), text: "short" }]);
    placeCaret(f.engine.ed, match(BODY(4), "short", "short"), null);
    expect(f.selection()).toEqual({ id: BODY(4), from: 5, to: 5 });
  });
  it("clamps offsets past a paragraph the match proves whole (the reload shortened it)", () => {
    const f = fakeEngine([{ id: BODY(4), text: "now shorter" }]);
    placeCaret(f.engine.ed, match(BODY(4), "now shorter", "now shorter"), { anchor: 40, head: 40 });
    expect(f.selection()).toEqual({ id: BODY(4), from: 11, to: 11 });
  });
});
