// Runs a local plan (bridge/op-map.ts) against the LIVE engine, in the WebView.
// Two phases, on purpose: every step is placed (its paragraph or cell found and
// proven) before any of them runs, so a plan that cannot be fully placed never
// half-runs — the host then sends the whole op to the server instead (D2: a local
// verdict is all of the op or none of it).
//
// Finding a block. Indices are positional and the engine's ids are positional only
// AS OF A LOAD (spec D7): a paragraph typed in since then has an id the model has
// never seen, and every id after it is one off. So an index is never trusted
// alone. A paragraph is found by its TEXT — the model's text, as the host read it
// before the op — and only a candidate whose WHOLE text agrees counts:
//   • ≤256 chars (the engine's query cap): one exact, case-sensitive match that
//     starts the paragraph and leaves nothing after it;
//   • longer: the head and the tail both match the same paragraph, at its start
//     and its end; a text edit additionally re-proves the span it rewrites, at the
//     exact offsets, before it touches it.
// Several candidates → the one whose id still parses to the index, else give up.
// The paragraph the student's selection is in is also known by id straight from the
// painted DOM (the same id the selection report used), which is the only way an
// EMPTY paragraph — nothing to search for — can be named at all.
//
// Selecting. The live editor's text commands refuse a DocTarget ("text inserts at
// the selection"), so every step selects first, with the semantic
// `{paragraphId, offset}` form — the engine's own selectMatch does exactly that
// with a TextMatch's blockId. Offsets are the engine's raw ones: a paragraph whose
// raw length differs from its text's (a field, a footnote reference) is never
// text-edited here.
//
// ⚠️ Nothing here is a React hook and nothing runs at import time — the DOM is
// touched only inside the functions — but it is not unit-tested: it needs a live
// engine. The pure half (planning, diffing) is op-map.ts and is.

import { commandForSlot, toolbarCommandState } from "@docx-editor.dev/react";
import type { ChromeSlotId, Editor, EditorCommand } from "@docx-editor.dev/react";
import { commandForSlotValue } from "@docx-editor.dev/core/editor";
import type { DocxEditorInstance, PaginatedSurface, SemanticSelection } from "@docx-editor.dev/core/editor";
import type { TextMatch } from "@docx-editor.dev/core/contracts/editor";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";
import { isBlockLevelId, nodeIdOf, spannedBlocks } from "./dom-selectors";
import { diffSpan, type LocalStep, type Marks, type ParaFormat, type ParaRef, type TableAct, type TableRef } from "./op-map";

const QUERY_MAX = 256; // the engine refuses a longer findMatches query
const PROBE = 120; // head/tail probe for a paragraph longer than QUERY_MAX
const CHUNK = 200; // span re-proof chunk, under QUERY_MAX
const MARGIN = 48; // context proven around a rewritten span

export type Outcome = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Outcome => ({ ok: false, reason });
const OK: Outcome = { ok: true };

/** A paragraph the engine can be pointed at: its id (= semantic paragraphId) and
 *  its length in the engine's raw offsets. */
export type Hit = { id: string; end: number };

export type Span = Map<number, { id: string; text: string }>;

// Not re-exported by name at 2.21.1; the facade's own return type is the same thing.
type HistoryGroup = ReturnType<Editor["beginHistoryGroup"]>;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The engine as this module needs it: the facade plus, when the host's instance
 *  is at hand, the paginated surface (selection read-back, list state, split). */
export type Engine = { ed: Editor; surface: PaginatedSurface | null };

export function engineOf(ed: Editor | null, inst: DocxEditorInstance | null): Engine | null {
  const e = inst ?? ed;
  if (!e) return null;
  return { ed: e, surface: inst?.surface ?? null };
}

// ── exec plumbing ──

// The command types the live editor runs at the SELECTION. Their contract shapes
// still carry a `target` the runtime refuses, hence the casts.
const cmd = (c: Record<string, unknown>) => c as unknown as EditorCommand;

function exec(e: Engine, c: EditorCommand, group?: HistoryGroup | null): Outcome {
  try {
    const r = e.ed.exec(c, group ? { historyGroup: group } : undefined);
    return r.ok ? OK : fail(`${c.type}: ${r.reason}`);
  } catch (err) {
    return fail(`${c.type} threw: ${String((err as Error)?.message ?? err)}`);
  }
}

function select(e: Engine, id: string, from: number, to = from): Outcome {
  return exec(e, cmd({ type: "setSelection", range: { anchor: { paragraphId: id, offset: from }, head: { paragraphId: id, offset: to } } }));
}

function selectionNow(e: Engine): SemanticSelection | null {
  try {
    return e.surface?.state().selection ?? null;
  } catch {
    return null;
  }
}

function beginGroup(e: Engine): HistoryGroup | null {
  try {
    return e.ed.beginHistoryGroup();
  } catch {
    return null;
  }
}

// ── finding paragraphs and cells ──

function find(e: Engine, q: string): readonly TextMatch[] {
  if (!q || q.length > QUERY_MAX) return [];
  try {
    return e.ed.findMatches(q, { matchCase: true });
  } catch {
    return [];
  }
}

/** Top-level body paragraphs only: a cell's paragraph, a text box's, a header's
 *  must never stand in for a body block. */
const bodyBlock = (m: TextMatch) => !m.scope && isBlockLevelId(m.blockId);

/** The paragraphs the student's selection spans, by index, with the id the painted
 *  DOM carries — what the selection report told the host, read the same way. */
function spanNow(): Span {
  const out: Span = new Map();
  try {
    for (const b of spannedBlocks(window.getSelection()).blocks) {
      const id = nodeIdOf(b.el);
      if (id) out.set(b.index, { id, text: b.text });
    }
  } catch {
    /* no selection — nothing to add */
  }
  return out;
}

export function locateParagraph(e: Engine, ref: ParaRef, span: Span): Hit | null {
  const fromSpan = span.get(ref.index);
  const spanId = fromSpan && norm(fromSpan.text) === norm(ref.text) ? fromSpan.id : null;
  const t = ref.text;
  // Nothing to search for: only the selection can name an empty paragraph.
  if (!t) return spanId ? { id: spanId, end: 0 } : null;
  let cands: Hit[];
  if (t.length <= QUERY_MAX) {
    cands = find(e, t)
      .filter((m) => bodyBlock(m) && m.start === 0 && m.contextAfter === "")
      .map((m) => ({ id: m.blockId, end: m.start + m.length }));
  } else {
    const heads = find(e, t.slice(0, PROBE)).filter((m) => bodyBlock(m) && m.start === 0);
    const tails = find(e, t.slice(-PROBE)).filter((m) => bodyBlock(m) && m.contextAfter === "");
    cands = heads.flatMap((h) => {
      const tl = tails.find((x) => x.blockId === h.blockId);
      return tl ? [{ id: h.blockId, end: tl.start + tl.length }] : [];
    });
  }
  if (spanId) return cands.find((c) => c.id === spanId) ?? null;
  return cands.find((c) => blockIndexFromId(c.id) === ref.index) ?? (cands.length === 1 ? cands[0] : null);
}

/** A paragraph's end as painted: its runs carry their [data-start, data-end) model
 *  range, in the engine's raw offsets. Null while none of it is painted. */
function paintedEnd(id: string): number | null {
  if (typeof document === "undefined") return null;
  const sel = `[data-paragraph-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')}"][data-end]`;
  let end: number | null = null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
    const v = Number(el.dataset.end);
    if (Number.isFinite(v) && (end == null || v > end)) end = v;
  }
  return end;
}

/**
 * The paragraph a FORMAT or LIST step means. These change no text, so they do not
 * need the proof a rewrite does — and could not have it: a footnote mark or a field
 * sits in the engine's text and not in the model's, so the whole-text match fails on
 * exactly what a thesis is full of ("…MS Access⁷." — 11-02), and the student's edit
 * silently went to the server instead of onto the page. So, in order:
 *   1. the whole-text match, when it holds (it also proves the exact end);
 *   2. the paragraph's OPENING words, at its start, in the block whose id still parses
 *      to the index (or the only candidate);
 *   3. the paragraph the student's caret is in, which is what they are looking at.
 * `needEnd`: marks and Clear All act on a RANGE, so without a known end the step is
 * refused rather than half applied. Direction, alignment, style and lists only need
 * a caret inside the paragraph.
 */
export function locateForFormat(e: Engine, ref: ParaRef, span: Span, needEnd: boolean): Hit | null {
  const exact = locateParagraph(e, ref, span);
  if (exact) return exact;
  const withEnd = (id: string): Hit | null => {
    const end = paintedEnd(id);
    return end == null && needEnd ? null : { id, end: end ?? 0 };
  };
  const t = ref.text.trim();
  for (const n of [PROBE, 32]) {
    if (!t) break;
    const head = t.slice(0, n);
    const cands = find(e, head).filter((m) => bodyBlock(m) && m.start === 0);
    const m = cands.find((c) => blockIndexFromId(c.blockId) === ref.index) ?? (cands.length === 1 ? cands[0] : undefined);
    if (m) return withEnd(m.blockId);
    if (t.length <= n) break;
  }
  const inSpan = span.get(ref.index)?.id;
  if (inSpan) return withEnd(inSpan);
  const head = selectionNow(e)?.head.paragraphId;
  if (head && isBodyId(head) && isBlockLevelId(head) && blockIndexFromId(head) === ref.index) return withEnd(head);
  return null;
}

/** Re-prove, at their exact offsets in paragraph `id`, the characters a rewrite of
 *  [from, to) touches and a margin around them. Cheap insurance for a long
 *  paragraph, where the head/tail match proves only its two ends. */
function proveSpan(e: Engine, id: string, text: string, from: number, to: number): boolean {
  const a = Math.max(0, from - MARGIN);
  const b = Math.min(text.length, to + MARGIN);
  for (let o = a; o < b; o += CHUNK) {
    const chunk = text.slice(o, Math.min(b, o + CHUNK));
    if (!find(e, chunk).some((m) => m.blockId === id && m.start === o)) return false;
  }
  return true;
}

/** Put the caret in table cell (row, col) and prove it is THAT cell of THAT table:
 *  the engine's own table read-back must agree on the grid and the coordinates. A
 *  merged grid, a 1-based answer or an unknown shape all fail closed (→ server). */
function locateCell(e: Engine, t: TableRef, cell: { row: number; col: number; text: string }): Hit | null {
  const cols = t.rows[0]?.length ?? 0;
  const all = find(e, cell.text).filter((m) => !m.scope && isBodyId(m.blockId) && !isBlockLevelId(m.blockId) && m.start === 0 && m.contextAfter === "");
  // Cells whose id still parses to the table's index first; only when none does
  // (ids drifted since the load) any other table — and then it must be the ONLY
  // one that passes, since two same-shaped tables can share a header cell.
  const atIndex = all.filter((m) => blockIndexFromId(m.blockId) === t.index);
  const pool = (atIndex.length ? atIndex : all).slice(0, 8);
  const proven: Hit[] = [];
  for (const m of pool) {
    if (!select(e, m.blockId, 0).ok) continue;
    let st: ReturnType<Editor["getSelectedTable"]> = null;
    try {
      st = e.ed.getSelectedTable();
    } catch {
      st = null;
    }
    if (st?.cell && st.cell.row === cell.row && st.cell.column === cell.col && st.rowCount === t.rows.length && st.columnCount === cols) {
      proven.push({ id: m.blockId, end: m.start + m.length });
    }
  }
  return proven.length === 1 ? proven[0] : null;
}

// ── the steps ──

type Placed =
  | { k: "text"; hit: Hit; prev: string; next: string }
  | { k: "format"; hits: Hit[]; fmt: ParaFormat }
  | { k: "list"; hits: Hit[]; contiguous: boolean; list: "bullet" | "number" | null }
  | { k: "table"; hit: Hit; prev: string; act: TableAct };

function place(e: Engine, s: LocalStep, span: Span): Placed | Outcome {
  switch (s.k) {
    case "text": {
      const hit = locateParagraph(e, s.at, span);
      if (!hit) return fail(`text: paragraph ${s.at.index} not found by its text`);
      // Raw length ≠ text length → an atom (field, note reference) sits in it, and
      // the model's offsets are not the engine's.
      if (hit.end !== s.at.text.length) return fail(`text: paragraph ${s.at.index} holds non-text atoms`);
      return { k: "text", hit, prev: s.at.text, next: s.next };
    }
    case "format":
    case "list": {
      const hits: Hit[] = [];
      const needEnd = s.k === "format" && (!!s.fmt.marks || !!s.fmt.clear);
      for (const ref of s.at) {
        const hit = locateForFormat(e, ref, span, needEnd);
        if (!hit) return fail(`${s.k}: paragraph ${ref.index} could not be located`);
        hits.push(hit);
      }
      if (s.k === "format") return { k: "format", hits, fmt: s.fmt };
      const idx = s.at.map((r) => r.index);
      const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
      return { k: "list", hits, contiguous, list: s.list };
    }
    case "table": {
      const hit = locateCell(e, s.at, s.cell);
      if (!hit) return fail(`table ${s.at.index}: cell (${s.cell.row},${s.cell.col}) not proven in the engine`);
      if (s.act.do === "cellText" && hit.end !== s.cell.text.length) return fail("table: the cell holds non-text atoms");
      return { k: "table", hit, prev: s.cell.text, act: s.act };
    }
  }
}

function rewrite(e: Engine, hit: Hit, prev: string, next: string): Outcome {
  const d = diffSpan(prev, next);
  if (d.from === d.to && !d.insert) return OK;
  // Short paragraphs were matched whole; a long one proved only its ends.
  if (prev.length > QUERY_MAX && !proveSpan(e, hit.id, prev, d.from, d.to)) return fail("text: the span to rewrite no longer reads as the model says");
  const r = select(e, hit.id, d.from, d.to);
  if (!r.ok) return r;
  // A plain paste is insertPlainText: delete the selection and insert, in ONE
  // commit (one undo step), the text taking the formatting at the caret as typing
  // would. Not insertText over a range — what typing does to a RANGE is not part
  // of the contract. A pure deletion has nothing to paste (the engine refuses an
  // empty one), so it is deleteText.
  if (d.insert) return exec(e, cmd({ type: "pasteWithoutFormatting", text: d.insert }));
  return exec(e, cmd({ type: "deleteText" }));
}

const MARK_SLOTS: readonly (readonly [keyof Marks, ChromeSlotId])[] = [
  ["bold", "text.bold"],
  ["italic", "text.italic"],
  ["underline", "text.underline"],
];

function formatOne(e: Engine, hit: Hit, fmt: ParaFormat, group: HistoryGroup | null): Outcome {
  let r = select(e, hit.id, 0, hit.end);
  if (!r.ok) return r;
  // Clear first: it would wipe whatever the rest of the step set.
  if (fmt.clear && !(r = exec(e, cmd({ type: "clearFormatting" }), group)).ok) return r;
  if (fmt.styleId && !(r = exec(e, cmd({ type: "setParagraphStyle", styleId: fmt.styleId }), group)).ok) return r;
  // Direction before alignment: the engine stores alignment against the paragraph's
  // direction (jc is logical in an RTL paragraph), so a change carrying both must
  // have the direction in place when the alignment is resolved.
  if (fmt.direction && !(r = exec(e, cmd({ type: "setParagraphDirection", direction: fmt.direction }), group)).ok) return r;
  if (fmt.alignment && !(r = exec(e, cmd({ type: "setAlignment", align: fmt.alignment }), group)).ok) return r;
  // Marks over an EMPTY paragraph would only arm the caret (Word's stored marks) —
  // there is no text to carry them.
  if (fmt.marks && hit.end > 0) {
    for (const [key, slot] of MARK_SLOTS) {
      const want = fmt.marks[key];
      if (want == null) continue;
      const c = commandForSlot(slot);
      if (!c) continue;
      // SET over a TOGGLE. isActive is the engine's own "the WHOLE selection has
      // it", so "not active" is ambiguous: none of it, or some. "Off" therefore
      // first toggles once (a mixed span goes all-on in Word's rule, or all-off in
      // the other one) and then toggles while it reads on — a paragraph that was
      // half bold must not stay half bold whichever rule the engine follows.
      if (want) {
        for (let i = 0; i < 2 && !e.ed.isActive(c); i++) if (!(r = exec(e, c, group)).ok) return r;
      } else {
        if (!e.ed.isActive(c) && !(r = exec(e, c, group)).ok) return r;
        for (let i = 0; i < 2 && e.ed.isActive(c); i++) if (!(r = exec(e, c, group)).ok) return r;
      }
    }
    if (fmt.marks.color != null) {
      const c = commandForSlotValue("text.color", fmt.marks.color);
      if (c && !(r = exec(e, c, group)).ok) return r;
    }
  }
  return OK;
}

/** Make the selection a list of `want` (or no list), whatever it is now — the
 *  engine only toggles. Without the surface the list state is a guess, so refuse. */
export function setListAtSelection(e: Engine, want: "bullet" | "number" | null, group: HistoryGroup | null = null): Outcome {
  const s = e.surface;
  let bullet: boolean;
  let ordered: boolean;
  try {
    bullet = s ? s.isListActive("bullet") : toolbarCommandState(e.ed, "list.bullet").active;
    ordered = s ? s.isListActive("ordered") : toolbarCommandState(e.ed, "list.numbered").active;
  } catch {
    return fail("list: the selection's list state is unreadable");
  }
  if (want === "bullet") return bullet ? OK : exec(e, cmd({ type: "toggleList", kind: "bullet" }), group);
  if (want === "number") return ordered ? OK : exec(e, cmd({ type: "toggleList", kind: "ordered" }), group);
  if (bullet) return exec(e, cmd({ type: "toggleList", kind: "bullet" }), group);
  if (ordered) return exec(e, cmd({ type: "toggleList", kind: "ordered" }), group);
  return OK;
}

function runTable(e: Engine, p: Extract<Placed, { k: "table" }>): Outcome {
  // Re-place the caret: placing other steps (or the student) may have moved it.
  const r = select(e, p.hit.id, 0);
  if (!r.ok) return r;
  switch (p.act.do) {
    case "insertRow": return exec(e, cmd({ type: "insertRow", where: p.act.where }));
    case "deleteRow": return exec(e, cmd({ type: "deleteRow" }));
    case "insertColumn": return exec(e, cmd({ type: "insertColumn", where: p.act.where }));
    case "deleteColumn": return exec(e, cmd({ type: "deleteColumn" }));
    case "cellText": return rewrite(e, p.hit, p.prev, p.act.next);
    case "props": return exec(e, cmd({ type: "setTableProperties", justification: p.act.justification }));
  }
}

/**
 * Place, then run, every step. `{ok: true}` means the engine now shows the edit
 * and the caller must mark the save loop dirty; a failure while PLACING changed
 * nothing, a failure while RUNNING may have changed part of it — both are answered
 * `false`, and the server re-applies the whole op (every local op is a SET, so a
 * part the engine already did lands identically).
 */
export function applySteps(e: Engine, steps: readonly LocalStep[]): Outcome {
  if (!steps.length) return OK;
  const before = selectionNow(e);
  const putBack = () => {
    if (before) exec(e, cmd({ type: "setSelection", range: before }));
  };
  const span = spanNow();
  const placed: Placed[] = [];
  for (const s of steps) {
    const p = place(e, s, span);
    if ("ok" in p) {
      putBack();
      return p;
    }
    placed.push(p);
  }
  const group = placed.some((p) => p.k === "format" || p.k === "list") ? beginGroup(e) : null;
  let changesText = false;
  try {
    for (const p of placed) {
      let r: Outcome = OK;
      if (p.k === "text") {
        changesText = true;
        r = rewrite(e, p.hit, p.prev, p.next);
      } else if (p.k === "format") {
        for (const hit of p.hits) if (!(r = formatOne(e, hit, p.fmt, group)).ok) break;
      } else if (p.k === "list") {
        if (p.contiguous && p.hits.length > 1) {
          // One range → one list (per-paragraph toggles would each start their own
          // numbering).
          const first = p.hits[0];
          const last = p.hits[p.hits.length - 1];
          r = exec(e, cmd({ type: "setSelection", range: { anchor: { paragraphId: first.id, offset: 0 }, head: { paragraphId: last.id, offset: last.end } } }));
          if (r.ok) r = setListAtSelection(e, p.list, group);
        } else {
          for (const hit of p.hits) {
            if (!(r = select(e, hit.id, 0)).ok) break;
            if (!(r = setListAtSelection(e, p.list, group)).ok) break;
          }
        }
      } else {
        changesText = p.act.do === "cellText";
        r = runTable(e, p);
      }
      if (!r.ok) return r;
    }
  } finally {
    group?.end();
  }
  // A paragraph-level edit leaves the caret where the student had it; a text edit
  // leaves it after the new text, where typing would have.
  if (!changesText) putBack();
  return OK;
}

/**
 * Put the caret back in paragraph `m.blockId` after a load(), at the offsets the
 * student had (`caret`, read off the surface before the load), else at the end of
 * the matched text. NEVER a selected range: Bridge used `selectMatch(m)`, which
 * selects the paragraph's first ≤120 chars — and the next keystroke typed over
 * them, which after a structural save's re-parse is mid-sentence, i.e. always.
 * Offsets past what the match proves are clamped when the match is known to cover
 * the whole paragraph; a refused placement falls back to the match's end.
 */
export function placeCaret(ed: Editor, m: TextMatch, caret: { anchor: number; head: number } | null): void {
  const end = m.start + m.length;
  const clamp = (o: number) => (m.contextAfter === "" ? Math.min(o, end) : o);
  const at = (a: number, h: number) =>
    ed.exec(cmd({ type: "setSelection", range: { anchor: { paragraphId: m.blockId, offset: a }, head: { paragraphId: m.blockId, offset: h } } }));
  try {
    if (caret && at(clamp(caret.anchor), clamp(caret.head)).ok) return;
  } catch {
    /* fall through to the safe caret */
  }
  try {
    at(end, end);
  } catch {
    /* nothing more to do: the engine keeps whatever caret the load gave it */
  }
}
