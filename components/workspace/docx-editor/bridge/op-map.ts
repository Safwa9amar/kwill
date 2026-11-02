// A student's edit (a `ThesisOp`, the same descriptor every native tool hands to
// `thesis-doc-store.mutate`) → what the docx engine can do with it RIGHT NOW, in
// the page the student is looking at — or a reasoned "server" verdict. PURE: the
// host plans against the block model it holds; the DOM (bridge/apply-op.ts)
// resolves each step against the live engine and runs it.
//
// Local ops leave as BYTES through the save loop (spec D2) — the op itself is
// never sent, so a local verdict must be the WHOLE op or nothing. A server verdict
// keeps today's path (durable queue → server → echo → reload, D3); the pump saves
// the surface's bytes first so the op lands on the document the student sees.
//
// What 2.21.1 can really do (read off the runtime's capability table, not the
// .d.ts — see "Engine facts" below):
//
//   op                      verdict  how / why
//   ─────────────────────── ──────── ─────────────────────────────────────────────
//   editText                LOCAL    minimal diff → select the changed span →
//                                    a plain paste of the new middle (one undo step;
//                                    deleteText for a pure cut) (formatting outside the
//                                    span survives). SERVER when the text carries a
//                                    paragraph mark, the block is not a plain
//                                    paragraph (math/anchored shapes), or the DOM
//                                    cannot prove the paragraph still reads as the
//                                    model says (bridge/apply-op.ts).
//   splitParagraph          SERVER   the engine's split is Enter: the new paragraph
//                                    takes Word's FOLLOWER style, while the op
//                                    promises the source's. Nothing on this surface
//                                    sends it anyway — Enter is typed into the engine.
//   format  level/styleId   LOCAL    setParagraphStyle (refused when the document
//                                    does not define the style → SERVER, which can).
//           alignment       LOCAL    setAlignment.
//           bold/italic/    LOCAL    SET semantics over toggleMark (compare isActive
//           underline                first); color → setMarkAttr (hex | auto).
//           clearFormatting LOCAL    clearFormatting.
//           direction       LOCAL    setParagraphDirection (w:bidi, engine ≥ 2.33):
//                                    the page turns under the finger, like every
//                                    other format, and offline too.
//   move                    SERVER   no block move in the engine (spec D11).
//   insertImage/replaceImage SERVER  bytes never cross the JSON bridge.
//   deleteBlocks            SERVER   a multi-paragraph deleteSelection decides which
//                                    paragraph mark survives the join; unverified
//                                    against the server's semantics, so not guessed.
//                                    The blocks dim at once until the reload.
//   startOnNewPage          SERVER   the server writes a NEXT-PAGE SECTION before the
//                                    block (doc.startOnNewPage); the engine's
//                                    insertBreak at a caret would add a paragraph.
//   setList                 LOCAL    toggleList, made a SET by asking the surface
//                                    first (isListActive).
//   tableOp addRow/deleteRow LOCAL   caret into a cell of the target row (found by its
//           addColumn/              text and VERIFIED through getSelectedTable: same
//           deleteColumn            table size, same cell) → insertRow/deleteRow/
//                                    insertColumn/deleteColumn. SERVER when the row/
//                                    column has no text to find it by, or for
//                                    addColumn on an RTL table (left/right is visual
//                                    in the engine, logical on the server).
//           editCell        LOCAL    as editText, inside the verified cell. SERVER for
//                                    an empty or multi-line cell.
//           layout          LOCAL    alignment only → setTableProperties
//                                    justification. Everything else (direction =
//                                    bidiVisual, header row/fill, borders, width,
//                                    distribute) → SERVER: no engine command, or
//                                    units the engine does not document.
//           shade           SERVER   per-cell grids; the engine fills the SELECTED
//                                    cells only.
//   setCaption              SERVER   one caption model everywhere: Caption style +
//                                    SEQ field + bookmark (server).
//   insertTable             SERVER   the server's Doc.addTable writes the header row,
//                                    borders and bidiVisual the proposal card showed;
//                                    the engine's insertTable is a bare grid.
//
// Engine facts (2.21.1, CJS build Metro bundles): `replaceMatch`, `replaceText`,
// `applyFormatting`, `splitParagraph` and `mergeParagraphs` are DECLARED in the
// contract but absent from the runtime's capability table — exec answers "command
// 'X' is not supported by the tree editor". `insertText`/`deleteText`/
// `setParagraphStyle` refuse a DocTarget ("text inserts at the selection"), so every
// local step works by selecting first (setSelection with the semantic
// `{paragraphId, offset}` form, where paragraphId IS TextMatch.blockId — that is how
// the engine's own selectMatch does it). findMatches queries are 1–256 chars and
// case-INsensitive unless `matchCase: true`.

import type { DocBlockDTO } from "@/lib/api";
import type { FormatChange, ThesisOp } from "@/lib/thesis-ops";

/** A paragraph as the host's model read it BEFORE the op — what the engine must
 *  find. `text` is the model's text, verbatim (not whitespace-normalised: the
 *  engine matches it literally). */
export type ParaRef = { index: number; text: string };

/** A table as the model read it: the grid the engine's own must agree with. */
export type TableRef = { index: number; rows: string[][] };

export type Align = "left" | "center" | "right" | "justify";

/** Run marks, as SET values. `color` is upper-case RRGGBB without '#', or "auto". */
export type Marks = { bold?: boolean; italic?: boolean; underline?: boolean; color?: string };

export type ParaFormat = {
  clear?: boolean;
  styleId?: string;
  alignment?: Align;
  direction?: "rtl" | "ltr";
  marks?: Marks;
};

export type TableAct =
  | { do: "insertRow"; where: "above" | "below" }
  | { do: "deleteRow" }
  | { do: "insertColumn"; where: "left" | "right" }
  | { do: "deleteColumn" }
  | { do: "cellText"; next: string }
  | { do: "props"; justification: "left" | "center" | "right" };

/** One unit of local work. Plain JSON: it crosses the DOM bridge as a prop. */
export type LocalStep =
  | { k: "text"; at: ParaRef; next: string }
  | { k: "format"; at: ParaRef[]; fmt: ParaFormat }
  | { k: "list"; at: ParaRef[]; list: "bullet" | "number" | null }
  // `cell` is the cell the caret is put in to address the row/column/cell — its
  // TEXT is how the engine finds it, its coordinates are how the find is verified.
  | { k: "table"; at: TableRef; cell: { row: number; col: number; text: string }; act: TableAct };

/** Blocks a SERVER op will change, so the page answers the tap at once even when
 *  the edit itself has to round-trip: the host marks them pending
 *  (stores/docx-surface-store → overlays/PendingLayer) until the reload that
 *  shows the result. `look` records the intent; the layer has one shimmer today. */
export type PendingMark = { look: "busy" | "removing"; at: ParaRef[] };

export type OpPlan =
  | { local: true; steps: LocalStep[] }
  | { local: false; reason: string; pending: PendingMark | null };

/** The envelope the host hands the DOM: run `steps`, answer `onOpApplied(nonce,
 *  ok)`. `at` is the host's Date.now() when it was issued: the DOM refuses a stale
 *  one, because the host has by then given up waiting and sent the op to the
 *  server — running it as well would apply it twice. */
export type OpEnvelope = { nonce: number; at: number; steps: LocalStep[] };

/** The blocks a local plan touches — marked pending when the DOM could not run it
 *  after all and the op goes to the server. */
export function blocksOf(steps: readonly LocalStep[]): number[] {
  const out = new Set<number>();
  for (const s of steps) {
    if (s.k === "text" || s.k === "table") out.add(s.at.index);
    else for (const r of s.at) out.add(r.index);
  }
  return [...out];
}

type Para = Extract<DocBlockDTO, { kind: "paragraph" }>;
type Table = Extract<DocBlockDTO, { kind: "table" }>;

const PARA_MARK = new RegExp("[\\r\\n" + String.fromCharCode(0x0b, 0x0c, 0x2028, 0x2029) + "]");
const ALIGNS = new Set<string>(["left", "center", "right", "justify"]);

const server = (reason: string, pending: PendingMark | null = null): OpPlan => ({ local: false, reason, pending });

const refOf = (b: DocBlockDTO | undefined, index: number): ParaRef => ({
  index,
  text: b && (b.kind === "paragraph" || b.kind === "textbox") ? b.text : "",
});

const busy = (blocks: readonly DocBlockDTO[], indices: readonly number[]): PendingMark => ({
  look: "busy",
  at: indices.map((i) => refOf(blocks[i], i)),
});

const paraAt = (blocks: readonly DocBlockDTO[], i: number): Para | null => {
  const b = blocks[i];
  return b && b.kind === "paragraph" && b.index === i ? b : null;
};

const tableAt = (blocks: readonly DocBlockDTO[], i: number): Table | null => {
  const b = blocks[i];
  return b && b.kind === "table" && b.index === i ? b : null;
};

/** `color` as the engine takes it: RRGGBB upper-case, or "auto" to fall back to
 *  the style. */
export function colorValue(c: string | null | undefined): string {
  const v = (c ?? "").replace(/^#/, "").trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(v) ? v : "auto";
}

/** A pill/model FormatChange → the engine's paragraph format. */
export function paraFormatOf(ch: FormatChange): ParaFormat {
  const fmt: ParaFormat = {};
  if (ch.clearFormatting) fmt.clear = true;
  if (ch.level != null) fmt.styleId = ch.level <= 0 ? "Normal" : `Heading${Math.min(6, Math.round(ch.level))}`;
  else if (ch.styleId) fmt.styleId = ch.styleId;
  if (ch.alignment && ALIGNS.has(ch.alignment)) fmt.alignment = ch.alignment;
  if (ch.direction === "rtl" || ch.direction === "ltr") fmt.direction = ch.direction;
  const marks: Marks = {};
  if (ch.bold != null) marks.bold = ch.bold;
  if (ch.italic != null) marks.italic = ch.italic;
  if (ch.underline != null) marks.underline = ch.underline;
  if (ch.color !== undefined) marks.color = colorValue(ch.color);
  if (Object.keys(marks).length) fmt.marks = marks;
  return fmt;
}

/** The first cell in `row` (or column `col`) the engine can be pointed at: one
 *  line of text it can search for. An empty or multi-line cell cannot be found. */
function findableCell(rows: string[][], pick: { row?: number; col?: number }): { row: number; col: number; text: string } | null {
  for (let r = 0; r < rows.length; r++) {
    if (pick.row != null && r !== pick.row) continue;
    for (let c = 0; c < rows[r].length; c++) {
      if (pick.col != null && c !== pick.col) continue;
      const text = rows[r][c] ?? "";
      if (text.trim() && !PARA_MARK.test(text) && text.length <= 256) return { row: r, col: c, text };
    }
  }
  return null;
}

function planTable(blocks: readonly DocBlockDTO[], op: Extract<ThesisOp, { type: "tableOp" }>): OpPlan {
  const t = tableAt(blocks, op.index);
  const hold = busy(blocks, [op.index]);
  if (!t) return server("tableOp: the block is not a table in the model", hold);
  const rows = t.rows;
  const nRows = rows.length;
  const nCols = rows[0]?.length ?? 0;
  if (!nRows || !nCols) return server("tableOp: empty grid", hold);
  const rtl = (t as { direction?: string }).direction === "rtl";
  const at: TableRef = { index: op.index, rows };
  const step = (cell: ReturnType<typeof findableCell>, act: TableAct): OpPlan =>
    cell ? { local: true, steps: [{ k: "table", at, cell, act }] } : server(`tableOp ${op.action}: no text in that row/column to find it by`, hold);

  switch (op.action) {
    case "addRow": {
      const row = op.at != null ? op.at : nRows - 1;
      if (row < 0 || row >= nRows) return server("addRow: row out of range", hold);
      return step(findableCell(rows, { row }), { do: "insertRow", where: op.at != null && op.before ? "above" : "below" });
    }
    case "deleteRow":
      if (op.row == null || op.row < 0 || op.row >= nRows || nRows <= 1) return server("deleteRow: row out of range", hold);
      return step(findableCell(rows, { row: op.row }), { do: "deleteRow" });
    case "addColumn": {
      if (rtl) return server("addColumn: an RTL table's left/right is visual in the engine, logical on the server", hold);
      const col = op.at != null ? op.at : nCols - 1;
      if (col < 0 || col >= nCols) return server("addColumn: column out of range", hold);
      return step(findableCell(rows, { col }), { do: "insertColumn", where: op.at != null && op.before ? "left" : "right" });
    }
    case "deleteColumn":
      if (op.col == null || op.col < 0 || op.col >= nCols || nCols <= 1) return server("deleteColumn: column out of range", hold);
      return step(findableCell(rows, { col: op.col }), { do: "deleteColumn" });
    case "editCell": {
      if (op.row == null || op.col == null || !rows[op.row] || op.col >= rows[op.row].length) return server("editCell: cell out of range", hold);
      const next = op.text ?? "";
      if (PARA_MARK.test(next)) return server("editCell: multi-line text needs the server", hold);
      const cell = findableCell(rows, { row: op.row, col: op.col });
      return cell ? { local: true, steps: [{ k: "table", at, cell, act: { do: "cellText", next } }] } : server("editCell: an empty or multi-line cell cannot be found in the engine", hold);
    }
    case "layout": {
      const o = op.opts ?? {};
      const extra = Object.keys(o).filter((k) => k !== "alignment" && (o as Record<string, unknown>)[k] !== undefined);
      if (extra.length || !o.alignment) return server(`layout: ${extra.join(", ") || "nothing"} has no engine command`, hold);
      return step(findableCell(rows, {}), { do: "props", justification: o.alignment });
    }
    case "shade":
      return server("shade: per-cell grids; the engine fills only the selected cells", hold);
  }
}

/**
 * Plan `op` against `blocks` — the model AS IT WAS BEFORE the op (the store calls
 * the surface before its optimistic patch, so the host reads exactly that).
 */
export function planOp(op: ThesisOp, blocks: readonly DocBlockDTO[]): OpPlan {
  switch (op.type) {
    case "editText": {
      const p = paraAt(blocks, op.index);
      if (!p) return server("editText: the block is not a paragraph in the model");
      if (PARA_MARK.test(op.text)) return server("editText: a paragraph mark in the text needs the server's split", busy(blocks, [op.index]));
      if (p.math?.length || p.anchors?.length) return server("editText: the paragraph carries equations or anchored shapes", busy(blocks, [op.index]));
      return { local: true, steps: [{ k: "text", at: { index: op.index, text: p.text }, next: op.text }] };
    }
    case "splitParagraph":
      return server("splitParagraph: the engine's split is Enter (follower style); the op promises the source's style", busy(blocks, [op.index]));
    case "format": {
      if (!op.indices.length) return { local: true, steps: [] };
      const hold = busy(blocks, op.indices);
      if (op.indices.some((i) => !paraAt(blocks, i))) return server("format: a target is not a paragraph in the model", hold);
      const fmt = paraFormatOf(op.changes);
      if (!fmt.clear && !fmt.styleId && !fmt.alignment && !fmt.direction && !fmt.marks) return { local: true, steps: [] };
      return { local: true, steps: [{ k: "format", at: op.indices.map((i) => refOf(blocks[i], i)), fmt }] };
    }
    case "setList": {
      if (!op.indices.length) return { local: true, steps: [] };
      if (op.indices.some((i) => !paraAt(blocks, i))) return server("setList: a target is not a paragraph in the model", busy(blocks, op.indices));
      return { local: true, steps: [{ k: "list", at: op.indices.map((i) => refOf(blocks[i], i)), list: op.list }] };
    }
    case "tableOp":
      return planTable(blocks, op);
    case "move":
      return server("move: the engine has no block move (spec D11)", busy(blocks, [op.from]));
    case "insertImage":
      return server("insertImage: image bytes never cross the DOM bridge");
    case "replaceImage":
      return server("replaceImage: image bytes never cross the DOM bridge", busy(blocks, [op.index]));
    case "deleteBlocks":
      return server("deleteBlocks: which paragraph mark survives a multi-block delete is unverified in the engine", {
        look: "removing",
        at: op.indices.map((i) => refOf(blocks[i], i)),
      });
    case "startOnNewPage":
      return server("startOnNewPage: the server writes a next-page SECTION break; the engine's break adds a paragraph", busy(blocks, op.indices));
    case "setCaption":
      return server("setCaption: one caption model (Caption style + SEQ + bookmark) lives on the server", busy(blocks, [op.index]));
    case "insertTable":
      return server("insertTable: the server's table carries the header/borders/bidiVisual the card showed", busy(blocks, [op.index]));
  }
}

/**
 * The smallest span that turns `prev` into `next`: everything both share at the
 * start and the end is left in place (with its formatting), only the middle is
 * replaced. Offsets are UTF-16, like the engine's. The suffix never overlaps the
 * prefix, so "aa" → "aaa" is an insertion at 2, not a rewrite.
 */
export function diffSpan(prev: string, next: string): { from: number; to: number; insert: string } {
  const max = Math.min(prev.length, next.length);
  let a = 0;
  while (a < max && prev.charCodeAt(a) === next.charCodeAt(a)) a++;
  // Never split a surrogate pair: the engine would be handed half a character.
  if (a > 0 && a < prev.length && isLowSurrogate(prev.charCodeAt(a))) a--;
  let s = 0;
  while (s < max - a && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  if (s > 0 && isLowSurrogate(prev.charCodeAt(prev.length - s))) s--;
  return { from: a, to: prev.length - s, insert: next.slice(a, next.length - s) };
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
