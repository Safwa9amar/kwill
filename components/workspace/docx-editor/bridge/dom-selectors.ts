// The engine stamps painted elements with their node id (`/word/document.xml#…`,
// see lib/docx-block-id.ts). A block-level id has exactly three segments; runs and
// text nodes go deeper.
//
// What the engine paints for a body paragraph (2.21.1, read from its dist —
// core/dist/chunk-F4H3LC6M.cjs — not part of the typed API):
//
//   div.docx-paragraph-fragment[data-paragraph-id][data-fragment-index]  ← one per page the paragraph lands on
//     div.docx-line[data-line-id][data-paragraph-id]                     ← one per line, SAME id
//       span[data-paragraph-id][data-start][data-end]                     ← one per run, SAME id
//   div.docx-table-fragment[data-table-id][data-fragment-index]          ← one per page a table lands on
//     … cell paragraphs, painted the same way with DEEPER ids
//
// ⚠️ So "the nearest element carrying the block's id" is a RUN, not the paragraph.
// `data-fragment-index` is what only the fragment CONTAINERS carry; FRAGMENT_SELECTOR
// includes it for that reason. (The first version of this file walked up to the
// nearest id-carrying element: a selection inside one paragraph reported the same
// index once per run it crossed, each with one run's text, and a selection that ran
// into the next paragraph never reached it — the sibling walk ended at the last run.)
//
// ⚠️ The only element the engine sets `direction` on is the RUN span (its shaping
// direction). Lines and fragments inherit the page's, so a computed direction must
// be read off a run — see directionCarrierOf.
//
// Pure enough to run under node: nothing touches `document`/`window`, and the walks
// take duck-typed elements (PaintedEl), so dom-selectors.test.ts drives them with
// plain objects.

import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";

const BODY_PREFIX = "/word/document.xml#";

/** Fragment containers only — see the ⚠️ above for why `data-fragment-index` is in it. */
export const FRAGMENT_SELECTOR = "[data-fragment-index][data-paragraph-id],[data-fragment-index][data-table-id]";
const LINE_SELECTOR = "[data-line-id]";
// A span with a text range. Markers and tab leaders are painted with an EMPTY range
// and no data-start, so they never leak into a block's text.
const RUN_SELECTOR = "[data-start][data-paragraph-id]";

export function isBlockLevelId(id: string | null | undefined): boolean {
  return isBodyId(id) && /#\d+\.\d+\.\d+$/.test(id);
}

/** The id a fragment container carries: a paragraph's or a table's. */
export function fragmentIdOf(el: { getAttribute(name: string): string | null }): string | null {
  return el.getAttribute("data-paragraph-id") ?? el.getAttribute("data-table-id");
}

/**
 * The body block index a fragment id names, or null when it is not a BODY BLOCK
 * (a header/footnote story, a paragraph inside a table cell, a run).
 */
export function blockIndexOfFragmentId(id: string | null | undefined): number | null {
  return isBlockLevelId(id) ? blockIndexFromId(id) : null;
}

/** What the walks below need from an element. A real Element qualifies. */
export type PaintedEl = {
  getAttribute(name: string): string | null;
  /** Read only by directionCarrierOf; fakes may leave it out. */
  readonly attributes?: ArrayLike<{ value: string }>;
  closest(selector: string): PaintedEl | null;
  readonly parentElement: PaintedEl | null;
  querySelectorAll(selector: string): ArrayLike<PaintedEl>;
  readonly textContent: string | null;
};

/** A selection end (often a text node) → the element it sits in. */
function elementAt(node: unknown): PaintedEl | null {
  if (!node || typeof node !== "object") return null;
  if (typeof (node as PaintedEl).closest === "function") return node as PaintedEl;
  return ((node as { parentElement?: PaintedEl | null }).parentElement) ?? null;
}

/** The body node id an element carries, if any. */
export function nodeIdOf(el: { readonly attributes: ArrayLike<{ value: string }> }): string | null {
  for (const a of Array.from(el.attributes)) if (a.value.startsWith(BODY_PREFIX)) return a.value;
  return null;
}

/**
 * The fragment container of the BODY block at or above `start` — a paragraph's
 * fragment on this page, or the table's when `start` is inside a cell (a cell's own
 * paragraph fragments carry deeper ids, so the walk climbs past them).
 */
export function bodyFragmentOf(start: PaintedEl | null): PaintedEl | null {
  let el = start;
  while (el) {
    const frag = el.closest(FRAGMENT_SELECTOR);
    if (!frag) return null;
    if (blockIndexOfFragmentId(fragmentIdOf(frag)) != null) return frag;
    el = frag.parentElement;
  }
  return null;
}

/** The nearest painted BLOCK (paragraph / table fragment) element at or above `node`. */
export function blockElementOf(node: Node | null): HTMLElement | null {
  return bodyFragmentOf(elementAt(node)) as HTMLElement | null;
}

/**
 * The innermost element at or above `node` that carries a body block-level id —
 * for a paragraph that is the RUN, the one element whose computed `direction` is
 * the text's (see the ⚠️ at the top); inside a table, the table fragment.
 */
function directionCarrierOf(node: unknown): HTMLElement | null {
  for (let el = elementAt(node); el; el = el.parentElement) {
    if (el.attributes && isBlockLevelId(nodeIdOf({ attributes: el.attributes }))) return el as unknown as HTMLElement;
  }
  return null;
}

/**
 * The text a block's painted fragments show: its runs, line by line. Lines are
 * joined with a space because the engine does not reliably paint the space a line
 * wrapped at — a fragment's raw textContent glues the last word of one line to the
 * first of the next. Whitespace is collapsed, as everywhere else the text is
 * compared (findBlockMatch, block-links).
 */
export function paintedText(frags: readonly PaintedEl[]): string {
  const parts: string[] = [];
  for (const f of frags) {
    const lines = Array.from(f.querySelectorAll(LINE_SELECTOR));
    if (!lines.length) { parts.push(f.textContent ?? ""); continue; }
    for (const line of lines) {
      const runs = Array.from(line.querySelectorAll(RUN_SELECTOR));
      parts.push(runs.length ? runs.map((r) => r.textContent ?? "").join("") : (line.textContent ?? ""));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export type SpannedBlock = { index: number; text: string; el: HTMLElement };

/**
 * The body blocks from fragment `first` to fragment `last` (inclusive, document
 * order; `last` null = `first`'s block alone), ONE entry per block. `all` is every
 * painted fragment in document order — the walk runs over it rather than over
 * siblings, so a selection crosses a page boundary. Each block's text is read from
 * ALL its painted fragments, not only the ones the selection touches.
 */
export function spannedIn(all: ArrayLike<PaintedEl>, first: PaintedEl, last: PaintedEl | null): { index: number; text: string; el: PaintedEl }[] {
  const frags = new Map<number, PaintedEl[]>();
  const order: { index: number; el: PaintedEl }[] = [];
  const seen = new Set<number>();
  let on = false;
  let done = false;
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const index = blockIndexOfFragmentId(fragmentIdOf(el));
    if (index == null) continue;
    const list = frags.get(index);
    if (list) list.push(el);
    else frags.set(index, [el]);
    if (done) continue;
    if (el === first) on = true;
    if (!on) continue;
    if (!seen.has(index)) { seen.add(index); order.push({ index, el }); }
    if (el === last || !last) done = true;
  }
  if (!order.length) {
    // `first` is not among the painted fragments (a page recycled mid-report): its
    // own block is still the honest answer.
    const index = blockIndexOfFragmentId(fragmentIdOf(first));
    return index == null ? [] : [{ index, text: paintedText([first]), el: first }];
  }
  return order.map(({ index, el }) => ({ index, text: paintedText(frags.get(index) ?? [el]), el }));
}

/**
 * Every painted body block the current browser selection spans, in document
 * order and without repeats, plus which one holds the FOCUS end. Mirrors what
 * read-state.ts reported for Lexical (`blocks` + `index`/`text`) so the native
 * multi-block selection keeps working unchanged. `el` is the block's fragment,
 * except on `focus`, where it is the run at the focus (directionCarrierOf) — the
 * Bridge reads the text direction and the caret's height off it. Pages the engine
 * has virtualised out are not in the DOM and therefore not in this list — a
 * limitation the host tolerates: a selection that long is an AI "range" ask, and
 * those re-resolve by text.
 */
export function spannedBlocks(sel: Selection | null): { blocks: SpannedBlock[]; focus: SpannedBlock | null } {
  if (!sel || sel.rangeCount === 0) return { blocks: [], focus: null };
  const range = sel.getRangeAt(0);
  const first = bodyFragmentOf(elementAt(range.startContainer));
  if (!first) return { blocks: [], focus: null };
  const last = bodyFragmentOf(elementAt(range.endContainer));
  const root = (first as unknown as { ownerDocument?: { querySelectorAll(s: string): ArrayLike<PaintedEl> } | null }).ownerDocument;
  const blocks = spannedIn(root ? root.querySelectorAll(FRAGMENT_SELECTOR) : [first], first, last) as SpannedBlock[];
  const focusFrag = bodyFragmentOf(elementAt(sel.focusNode));
  const focusIndex = focusFrag ? blockIndexOfFragmentId(fragmentIdOf(focusFrag)) : null;
  const hit = blocks.find((b) => b.index === focusIndex) ?? blocks[0] ?? null;
  const focus = hit ? { ...hit, el: directionCarrierOf(sel.focusNode) ?? hit.el } : null;
  return { blocks, focus };
}
