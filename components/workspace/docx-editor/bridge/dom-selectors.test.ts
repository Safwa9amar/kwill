import { describe, it, expect } from "vitest";
import { bodyFragmentOf, isBlockLevelId, paintedText, spannedBlocks, spannedIn, type PaintedEl } from "./dom-selectors";

describe("isBlockLevelId", () => {
  it("is true for a paragraph/table id (exactly three segments)", () => {
    expect(isBlockLevelId("/word/document.xml#0.1.42")).toBe(true);
  });
  it("is false for a run or text id (deeper) and for other parts", () => {
    expect(isBlockLevelId("/word/document.xml#0.1.42.0")).toBe(false);
    expect(isBlockLevelId("/word/document.xml#0.1.42.1.0")).toBe(false);
    expect(isBlockLevelId("/word/header1.xml#0.0.2")).toBe(false);
    expect(isBlockLevelId(null)).toBe(false);
  });
});

// ── A fake painted DOM, shaped like the engine's (see the header of dom-selectors.ts):
// fragment > line > run, the SAME block id on all three. Just enough DOM for the
// walks: attribute-only selectors, closest, querySelectorAll in document order.

type Fake = PaintedEl & { attrs: Record<string, string>; kids: (Fake | FakeText)[]; parentElement: Fake | null; ownerDocument: FakeDoc };
type FakeText = { data: string; parentElement: Fake };
type FakeDoc = { querySelectorAll(selector: string): Fake[]; body: Fake };

/** `[a][b="v"],[c]` → [[["a"],["b","v"]],[["c"]]]. Enough for the selectors in use. */
function parse(selector: string): [string, string?][][] {
  return selector.split(",").map((part) =>
    Array.from(part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)).map((m) => [m[1], m[2]] as [string, string?]),
  );
}
function matches(el: Fake, selector: string): boolean {
  return parse(selector).some((compound) => compound.every(([name, v]) => (v == null ? name in el.attrs : el.attrs[name] === v)));
}
function descendants(el: Fake): Fake[] {
  const out: Fake[] = [];
  for (const k of el.kids) if ("kids" in k) out.push(k, ...descendants(k));
  return out;
}

const doc: FakeDoc = {
  querySelectorAll: (s) => descendants(doc.body).filter((e) => matches(e, s)),
  body: undefined as unknown as Fake,
};

function h(attrs: Record<string, string>, kids: (Fake | string)[] = []): Fake {
  const el = {
    attrs,
    kids: [] as (Fake | FakeText)[],
    parentElement: null as Fake | null,
    ownerDocument: doc,
    getAttribute: (n: string) => attrs[n] ?? null,
    get attributes() { return Object.values(attrs).map((value) => ({ value })); },
    closest(s: string) {
      for (let e: Fake | null = el as Fake; e; e = e.parentElement) if (matches(e, s)) return e;
      return null;
    },
    querySelectorAll: (s: string) => descendants(el as Fake).filter((e) => matches(e, s)),
    get nextElementSibling(): Fake | null {
      const sibs = el.parentElement?.kids.filter((k): k is Fake => "kids" in k) ?? [];
      return sibs[sibs.indexOf(el as Fake) + 1] ?? null;
    },
    get textContent(): string {
      return el.kids.map((k) => ("data" in k ? k.data : k.textContent)).join("");
    },
  } as Fake;
  for (const k of kids) {
    if (typeof k === "string") el.kids.push({ data: k, parentElement: el });
    else { k.parentElement = el; el.kids.push(k); }
  }
  return el;
}

const id = (i: number) => `/word/document.xml#0.1.${i}`;
const run = (i: number, text: string) => h({ "data-paragraph-id": id(i), "data-start": "0", "data-end": String(text.length) }, [text]);
const line = (i: number, ...runs: Fake[]) => h({ "data-line-id": `l${i}`, "data-paragraph-id": id(i) }, runs);
const frag = (i: number, fragmentIndex: number, ...lines: Fake[]) =>
  h({ class: "docx-paragraph-fragment", "data-paragraph-id": id(i), "data-fragment-index": String(fragmentIndex) }, lines);
const textOf = (el: Fake) => el.kids[0] as FakeText;

// Page 1: para 3 (two runs on one line, then a second line), para 4, para 5 (part 1).
// Page 2: para 5 (part 2), a table (index 6) with one cell paragraph, para 7.
const r3a = run(3, "Hello ");
const r3b = run(3, "world");
const p3 = frag(3, 0, line(3, r3a, r3b), line(3, run(3, "again")));
const r4 = run(4, "Second");
const p4 = frag(4, 0, line(4, r4));
const p5a = frag(5, 0, line(5, run(5, "split across")));
const p5b = frag(5, 1, line(5, run(5, "two pages")));
const cellRun = h({ "data-paragraph-id": `${id(6)}.0.0.0`, "data-start": "0", "data-end": "4" }, ["cell"]);
const cellPara = h({ "data-paragraph-id": `${id(6)}.0.0.0`, "data-fragment-index": "0" }, [
  h({ "data-line-id": "c", "data-paragraph-id": `${id(6)}.0.0.0` }, [cellRun]),
]);
const table = h({ class: "docx-table-fragment", "data-table-id": id(6), "data-fragment-index": "0" }, [cellPara]);
const r7 = run(7, "Last");
const p7 = frag(7, 0, line(7, r7));
doc.body = h({}, [
  h({ class: "docx-page", "data-page-index": "0" }, [p3, p4, p5a]),
  h({ class: "docx-page", "data-page-index": "1" }, [p5b, table, p7]),
]);

/** A selection from (aNode) to (fNode), forward. */
function sel(anchor: FakeText, focus: FakeText) {
  return {
    rangeCount: 1,
    focusNode: focus,
    getRangeAt: () => ({ startContainer: anchor, endContainer: focus }),
  } as unknown as Selection;
}

describe("bodyFragmentOf", () => {
  it("climbs from a run's text past the line to the paragraph FRAGMENT (not the run, which carries the same id)", () => {
    expect(bodyFragmentOf(textOf(r3b).parentElement)).toBe(p3);
  });
  it("climbs past a table cell's own paragraph fragment to the table", () => {
    expect(bodyFragmentOf(cellRun)).toBe(table);
  });
});

describe("paintedText", () => {
  it("joins lines with a space (the wrap space is not reliably painted) and collapses whitespace", () => {
    expect(paintedText([p3])).toBe("Hello world again");
  });
  it("reads every fragment of a paragraph that spans a page", () => {
    expect(paintedText([p5a, p5b])).toBe("split across two pages");
  });
  it("leaves out spans without a text range (list markers, tab leaders)", () => {
    const marker = h({ "data-paragraph-id": id(9) }, ["1."]);
    const p = frag(9, 0, h({ "data-line-id": "m", "data-paragraph-id": id(9) }, [marker, run(9, "Item")]));
    expect(paintedText([p])).toBe("Item");
  });
});

describe("spannedBlocks", () => {
  it("reports a selection inside ONE paragraph once, with the paragraph's whole text (was: once per run, one run's text)", () => {
    const { blocks, focus } = spannedBlocks(sel(textOf(r3a), textOf(r3b)));
    expect(blocks.map((b) => [b.index, b.text])).toEqual([[3, "Hello world again"]]);
    expect(focus?.index).toBe(3);
    expect(focus?.text).toBe("Hello world again");
  });
  it("reaches the next paragraph (was: the walk ended at the first paragraph's last run)", () => {
    const { blocks, focus } = spannedBlocks(sel(textOf(r3a), textOf(r4)));
    expect(blocks.map((b) => b.index)).toEqual([3, 4]);
    expect(focus?.index).toBe(4);
  });
  it("crosses a page boundary, one entry per block, a split paragraph counted once with both parts' text", () => {
    const { blocks } = spannedBlocks(sel(textOf(r4), textOf(r7)));
    expect(blocks.map((b) => b.index)).toEqual([4, 5, 6, 7]);
    expect(blocks.find((b) => b.index === 5)?.text).toBe("split across two pages");
    expect(blocks.find((b) => b.index === 6)?.text).toBe("cell");
  });
  it("hands the focus's RUN out as `el` (the only element the engine sets a direction on), the fragment for blocks", () => {
    const { blocks, focus } = spannedBlocks(sel(textOf(r3a), textOf(r4)));
    expect(blocks[0].el).toBe(p3);
    expect(focus?.el).toBe(r4);
  });
  it("puts a caret in a table cell on the table block", () => {
    const { blocks, focus } = spannedBlocks(sel(textOf(cellRun), textOf(cellRun)));
    expect(blocks.map((b) => b.index)).toEqual([6]);
    expect(focus?.index).toBe(6);
  });
  it("reports nothing for no selection or a selection outside the body", () => {
    expect(spannedBlocks(null)).toEqual({ blocks: [], focus: null });
    const hf = h({ "data-paragraph-id": "/word/header1.xml#0.0.1", "data-fragment-index": "0" }, ["Header"]);
    expect(spannedBlocks(sel(textOf(hf), textOf(hf))).blocks).toEqual([]);
  });
});

describe("spannedIn", () => {
  it("falls back to `first`'s own block when it is not among the painted fragments", () => {
    const stray = frag(12, 0, line(12, run(12, "Stray")));
    expect(spannedIn([p3, p4], stray, null).map((b) => [b.index, b.text])).toEqual([[12, "Stray"]]);
  });
});
