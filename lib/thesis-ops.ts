import {
  editThesisParagraph,
  splitThesisParagraph,
  editThesisParagraphs,
  moveThesisBlock,
  insertThesisImage,
  replaceThesisBlockImage,
  deleteThesisBlocks,
  startThesisBlocksOnNewPage,
  applyThesisOps,
  type DocBlockDTO,
  type DocumentDTO,
  type DocSectionDTO,
} from "@/lib/api";
import { setThesisFigureCaption } from "@/lib/thesis-suggest";

// Serializable manual-edit operations on a live-.docx thesis.
//
// An op is a plain-JSON descriptor — NOT a closure — so it can be persisted to
// SQLite (lib/thesis-op-queue.ts) and survive an app kill or a dead connection:
// the durable queue replays unsent ops when the thesis is reopened / the network
// returns. Each op type has two derivations here:
//   • applyOpToBlocks — the optimistic local patch (mirrors the server's effect
//     on the block DTOs) so the UI updates instantly and can be rebuilt from the
//     cached doc + queued ops after a restart.
//   • executeOp — the server call. The edit endpoints echo the mutated document,
//     which the doc store uses to reconcile.
//
// Indices are POSITIONAL (they shift on insert/delete/move), so ops for one
// thesis must replay strictly in order, and a permanently-rejected op poisons
// every later queued op for that thesis (the store drops the queue + revalidates).

type ParagraphBlock = Extract<DocBlockDTO, { kind: "paragraph" }>;
type ImageBlock = Extract<DocBlockDTO, { kind: "image" }>;
export type UiAlign = "left" | "center" | "right" | "justify";

export interface FormatChange {
  level?: number;
  // A Word named paragraph style to apply directly (e.g. "Title", "Subtitle",
  // "IntenseQuote", "NoSpacing", "Normal"). The server maps it via setBlockStyle.
  // Mutually exclusive with `level` (which derives its own Heading{n}/Normal style).
  styleId?: string;
  alignment?: UiAlign;
  direction?: "rtl" | "ltr";
  clearFormatting?: boolean;
  // Whole-paragraph inline character marks (the pill's Bold/Italic/Underline/Color).
  // A boolean is the TARGET toggle state (bold:true sets it on every run, false
  // clears it); `color` is a 6-hex RRGGBB (with or without '#') to set, or null to
  // CLEAR the colour. Absent = leave unchanged. The server sets/unsets the matching
  // <w:rPr> child on every run (see thesis-inline-format.ts).
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string | null;
}

// One visible run of a paragraph with its inline marks — mirrors the server's
// ParaRun (lib/thesis-doc.ts) that the paragraph DTO carries as `runs?`. Kept local
// because the app's DocBlockDTO (lib/api.ts, do-not-touch) doesn't yet declare it;
// we read/write it via a defensive cast in the optimistic patch below.
export type ParaRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
};

export type ThesisOp =
  | { type: "editText"; index: number; text: string }
  | { type: "splitParagraph"; index: number; before: string; after: string }
  | { type: "format"; indices: number[]; changes: FormatChange }
  | { type: "move"; from: number; to: number }
  | {
      type: "insertImage";
      afterIndex: number;
      data: string; // base64 (no data: prefix)
      format: string;
      width?: number;
      height?: number;
    }
  | {
      // Swap the bytes of the existing image block at `index` in place (smart-pill
      // "Replace image"). Positional-index-safe like editText/format — it never
      // moves blocks — so it replays cleanly in the durable queue.
      type: "replaceImage";
      index: number;
      data: string; // base64 (no data: prefix)
      format: string;
      width?: number;
      height?: number;
    }
  | { type: "deleteBlocks"; indices: number[] }
  | { type: "startOnNewPage"; indices: number[] }
  // Word list membership: "bullet"/"number" adds the paragraph(s) to a list; null
  // removes it. Positional-index-safe (never moves blocks) → replays cleanly. The
  // server writes <w:numPr>; the optimistic patch just tags the block's `list`.
  | { type: "setList"; indices: number[]; list: "bullet" | "number" | null }
  // Structure/layout edit on the TABLE at `index` (formatting-preserving on the
  // server via the engine Doc facade). Positional-index-safe (edits one block in
  // place). The optimistic patch mutates the block's `rows` grid for structural
  // actions; layout is server-only (echoed doc reconciles it).
  | {
      type: "tableOp";
      index: number;
      action: "addRow" | "deleteRow" | "addColumn" | "deleteColumn" | "editCell" | "layout" | "shade";
      at?: number;
      /** addRow/addColumn: insert ABOVE/LEFT of `at` instead of below/right. */
      before?: boolean;
      row?: number;
      col?: number;
      text?: string;
      opts?: {
        alignment?: "left" | "center" | "right";
        direction?: "rtl" | "ltr";
        headerRow?: boolean;
        headerFill?: string;
        /** true/false = plain grid on/off; object = styled borders on all sides. */
        borders?: boolean | { style?: string; sizePt?: number; color?: string };
        /** Table width as a % of the page (10..100). */
        widthPct?: number;
        /** Equalize all row heights / column widths. */
        distributeRows?: boolean;
        distributeColumns?: boolean;
      };
      /** action "shade": per-cell 6-hex fills aligned with the grid (null = leave as-is). */
      fills?: (string | null)[][];
      /** action "shade": per-cell 6-hex FONT colors (null = leave as-is). */
      textColors?: (string | null)[][];
    }
  // Set (or create) a figure/image block's caption (approve of an inline AI
  // "add caption" action). `index` is the IMAGE block. The optimistic patch just
  // sets that block's `caption` (no block count change); the server edits the
  // caption paragraph after the image (or inserts one) and echoes the document, so
  // the reconcile brings any inserted-block truth. Not folded with anything.
  | { type: "setCaption"; index: number; caption: string }
  // Insert a NEW Word table so it occupies block `index` (the empty paragraph the
  // student asked to fill stays as the trailing spacer AFTER the table — Word needs
  // a paragraph after a table anyway). Approving an inline AI table proposal routes
  // here. Positional: inserts one block, so later indices shift +1. The optimistic
  // patch splices a table DTO in at `index`; the server (batch /ops) inserts the
  // real Word table via Doc.addTable and echoes the authoritative document, which
  // reconciles the exact borders/styling.
  | { type: "insertTable"; index: number; rows: string[][]; header?: boolean; rtl?: boolean };

// ── Edit coalescing (fold rapid same-block typing into one op) ────────────────
//
// Debounced typing commits one `editText` per pause; a burst enqueues several
// editTexts for the SAME block, each superseding the last (latest text wins).
// Collapsing trailing same-index editTexts into one cuts server round-trips.
//
// SAFETY: only the QUEUE TAIL is inspected. `editText` is positional-safe (same
// indices before and after), so replacing the last editText with a newer one for
// the same index is a pure text swap. We NEVER fold across a structural op
// (split/move/delete/insertImage/startOnNewPage) because such an op would be the
// tail (or would sit after the last editText), so the tail is no longer an
// editText for our index and the predicate returns false — positional indices
// can't desync. Callers must also refuse to fold an op that is already in flight
// (see the pump's head-of-line handling in thesis-doc-store).

/** True iff `next` should REPLACE `prev` in the queue: both are `editText` for
 *  the same block index (a rapid re-edit of one paragraph). Any structural (or
 *  differently-indexed) `prev` returns false, so folding never crosses an op
 *  that reindexes blocks. */
export function editTextCoalesces(prev: ThesisOp | undefined, next: ThesisOp): boolean {
  return (
    prev != null &&
    prev.type === "editText" &&
    next.type === "editText" &&
    prev.index === next.index
  );
}

/** Pure fold at enqueue time: if the queue's LAST op is an `editText` for the
 *  same index as `op`, drop it and keep `op` (latest text wins); otherwise
 *  append. Returns a new array — never mutates `queue`. */
export function coalesceEditText(queue: ThesisOp[], op: ThesisOp): ThesisOp[] {
  const tail = queue[queue.length - 1];
  return editTextCoalesces(tail, op) ? [...queue.slice(0, -1), op] : [...queue, op];
}

// ── Optimistic patches (DTO-level mirror of the server's effect) ─────────────

// Reindex after a structural change — the DTO `index` is a block's position.
// Preserve a block's REFERENCE when its index didn't move, so React.memo(DocBlock)
// skips the unchanged prefix instead of reconciling the whole document on every
// split/move/delete. splitParagraph re-creates its before/after blocks (with new
// text) BEFORE calling reindex, so an unchanged index never returns stale text.
const reindex = (blocks: DocBlockDTO[]): DocBlockDTO[] =>
  blocks.map((b, i) => (b.index === i ? b : { ...b, index: i }));

// Whether a format change carries any inline character mark (the pill's Bold/
// Italic/Underline/Color) — those need the block's `runs` repainted optimistically.
const hasInlineMarks = (ch: FormatChange): boolean =>
  ch.bold !== undefined || ch.italic !== undefined || ch.underline !== undefined || ch.color !== undefined;

// Apply the whole-paragraph inline marks to an optimistic `runs` list (mirror of the
// server's per-run <w:rPr> transform). Absent runs → one run from the flat text so
// the outline repaints instantly formatted. `color` normalizes to uppercase 6-hex
// (no '#'), matching the server-emitted `runs`.
function patchRuns(runs: ParaRun[], ch: FormatChange): ParaRun[] {
  return runs.map((r) => {
    const nr: ParaRun = { ...r };
    if (ch.bold !== undefined) { if (ch.bold) nr.bold = true; else delete nr.bold; }
    if (ch.italic !== undefined) { if (ch.italic) nr.italic = true; else delete nr.italic; }
    if (ch.underline !== undefined) { if (ch.underline) nr.underline = true; else delete nr.underline; }
    if (ch.color !== undefined) {
      if (ch.color == null) delete nr.color;
      else nr.color = ch.color.replace(/^#/, "").toUpperCase();
    }
    return nr;
  });
}

function patchFormat(blocks: DocBlockDTO[], indices: number[], ch: FormatChange): DocBlockDTO[] {
  const set = new Set(indices);
  const marksPresent = hasInlineMarks(ch);
  return blocks.map((b) => {
    if (b.kind !== "paragraph" || !set.has(b.index)) return b;
    let nb: ParagraphBlock = { ...b };
    if (ch.clearFormatting) nb = { ...nb, level: 0, styleId: null, alignment: null, direction: null };
    if (ch.level != null) {
      nb.level = Math.max(0, Math.min(6, ch.level)) as ParagraphBlock["level"];
      nb.styleId = ch.level === 0 ? "Normal" : `Heading${ch.level}`;
    } else if (ch.styleId !== undefined) {
      // Named Word paragraph style (Title/Subtitle/…). Stays level 0 — the Lexical
      // editor renders it as a plain paragraph; the style shows in Preview/PDF/export.
      nb.styleId = ch.styleId;
    }
    if (ch.alignment != null) nb.alignment = ch.alignment === "justify" ? "both" : ch.alignment;
    if (ch.direction != null) nb.direction = ch.direction;
    if (marksPresent) {
      // `runs` isn't in the app's DocBlockDTO type (lib/api.ts is do-not-touch); read/
      // write it via cast. Seed a single run from the flat text when the paragraph
      // carried no marks yet, so bolding a plain paragraph paints immediately.
      const current = ((b as { runs?: ParaRun[] }).runs) ?? [{ text: b.text }];
      (nb as { runs?: ParaRun[] }).runs = patchRuns(current, ch);
    }
    return nb;
  });
}

function patchMove(blocks: DocBlockDTO[], from: number, to: number): DocBlockDTO[] {
  if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) return blocks;
  const arr = [...blocks];
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  return reindex(arr);
}

function patchInsertImage(
  blocks: DocBlockDTO[],
  op: Extract<ThesisOp, { type: "insertImage" }>,
): DocBlockDTO[] {
  const at = Math.min(Math.max(op.afterIndex + 1, 0), blocks.length);
  const img: ImageBlock = {
    index: at,
    kind: "image",
    dataUri: `data:image/${op.format};base64,${op.data}`,
    hasMedia: true,
    width: op.width,
    height: op.height,
  };
  const arr = [...blocks];
  arr.splice(at, 0, img);
  return reindex(arr);
}

function patchReplaceImage(
  blocks: DocBlockDTO[],
  op: Extract<ThesisOp, { type: "replaceImage" }>,
): DocBlockDTO[] {
  return blocks.map((b) => {
    if (b.index !== op.index || b.kind !== "image") return b;
    // Paint the newly-picked bytes immediately as a self-contained data: URI
    // (DocBlock renders `dataUri` first), so the swap is instant. On reconcile the
    // server echoes the persisted image (small → its own `dataUri`; large → the
    // media endpoint keyed on the bumped doc version).
    const next: ImageBlock = {
      ...b,
      dataUri: `data:image/${op.format};base64,${op.data}`,
      hasMedia: true,
    };
    if (op.width) next.width = op.width;
    if (op.height) next.height = op.height;
    return next;
  });
}

function patchDelete(blocks: DocBlockDTO[], indices: number[]): DocBlockDTO[] {
  const set = new Set(indices);
  return reindex(blocks.filter((b) => !set.has(b.index)));
}

/** Apply an op's optimistic effect to a block list. Pure — returns a new array. */
export function applyOpToBlocks(blocks: DocBlockDTO[], op: ThesisOp): DocBlockDTO[] {
  switch (op.type) {
    case "editText":
      return blocks.map((b) => (b.index === op.index && b.kind === "paragraph" ? { ...b, text: op.text } : b));
    case "splitParagraph": {
      const arr: DocBlockDTO[] = [];
      for (const b of blocks) {
        if (b.index === op.index && b.kind === "paragraph") {
          arr.push({ ...b, text: op.before });
          // New paragraph inherits the source's style/level/alignment/direction.
          arr.push({ ...b, text: op.after });
        } else {
          arr.push(b);
        }
      }
      return reindex(arr);
    }
    case "format":
      return patchFormat(blocks, op.indices, op.changes);
    case "move":
      return patchMove(blocks, op.from, op.to);
    case "insertImage":
      return patchInsertImage(blocks, op);
    case "replaceImage":
      return patchReplaceImage(blocks, op);
    case "deleteBlocks":
      return patchDelete(blocks, op.indices);
    case "startOnNewPage":
      // Page breaks don't change the block list — nothing to patch (the PDF/Word
      // views pick the change up from the server reconcile).
      return blocks;
    case "setCaption":
      // Paint the caption on the image block immediately. If the server ends up
      // inserting a new caption paragraph (the figure had none), its echoed
      // document reconciles the extra block on drain — the optimistic view already
      // shows the caption via the image block's `caption` field.
      return blocks.map((b) => (b.index === op.index && b.kind === "image" ? { ...b, caption: op.caption } : b));
    case "setList":
      // Tag the target paragraphs with the list kind (or clear it). `list` is an
      // extension field (not in the base DTO) — same convention as `runs`.
      return blocks.map((b) =>
        op.indices.includes(b.index) && b.kind === "paragraph"
          ? ({ ...b, list: op.list } as unknown as DocBlockDTO)
          : b,
      );
    case "tableOp":
      // Optimistic grid edit for structural actions (instant feedback); layout is
      // server-only. The server echo reconciles the authoritative table.
      return blocks.map((b) => {
        if (b.index !== op.index || b.kind !== "table") return b;
        const rows = b.rows.map((r) => [...r]);
        const cols = rows[0]?.length ?? 1;
        if (op.action === "addRow") rows.splice(op.at != null ? (op.before ? op.at : op.at + 1) : rows.length, 0, Array(cols).fill(""));
        else if (op.action === "deleteRow") { if (op.row != null && op.row >= 0 && op.row < rows.length && rows.length > 1) rows.splice(op.row, 1); }
        else if (op.action === "addColumn") rows.forEach((r) => r.splice(op.at != null ? (op.before ? op.at : op.at + 1) : r.length, 0, ""));
        else if (op.action === "deleteColumn") { if (cols > 1) rows.forEach((r) => { if (op.col != null && op.col >= 0 && op.col < r.length) r.splice(op.col, 1); }); }
        else if (op.action === "editCell") { if (op.row != null && op.col != null && rows[op.row]) rows[op.row][op.col] = op.text ?? ""; }
        else if (op.action === "layout") {
          // Instant feedback for the styling fields the render reflects
          // (align / direction / header / header fill); borders come with the
          // authoritative server echo. `align`/`header`/`fills` are DTO
          // extensions (like `list`/`runs`), so patch them on via a cast.
          const patched: Record<string, unknown> = { ...b, rows };
          if (op.opts?.alignment) patched.align = op.opts.alignment;
          if (op.opts?.direction) patched.direction = op.opts.direction;
          if (op.opts?.headerRow || op.opts?.headerFill) patched.header = true;
          // Border render source is the DTO `border` extra — patch it so the
          // Writer repaints instantly (echo reconciles the exact values).
          const bo = op.opts?.borders;
          if (bo === false) patched.border = null;
          else if (bo === true) patched.border = { style: "single", pt: 0.5, color: "#000000" };
          else if (bo && typeof bo === "object") {
            patched.border = {
              style: bo.style ?? "single",
              pt: bo.sizePt ?? 0.5,
              color: `#${(bo.color ?? "000000").replace("#", "").toUpperCase()}`,
            };
          }
          if (op.opts?.headerFill) {
            const prev = ((b as unknown as { fills?: (string | null)[][] }).fills ?? []).map((r) => [...r]);
            while (prev.length < rows.length) prev.push([]);
            prev[0] = rows[0].map(() => `#${op.opts!.headerFill!.replace("#", "").toUpperCase()}`);
            patched.fills = prev;
          }
          return patched as unknown as DocBlockDTO;
        }
        else if (op.action === "shade") {
          // Merge the shading + font-color grids onto the DTO's extras (render
          // source): fills = backgrounds, textColors = font colors.
          const merge = (base: (string | null)[][] | undefined, add: (string | null)[][] | undefined) => {
            const out = (base ?? []).map((r) => [...r]);
            while (out.length < rows.length) out.push([]);
            for (let r = 0; r < rows.length; r++) {
              const ar = add?.[r] ?? [];
              while (out[r].length < rows[r].length) out[r].push(null);
              for (let c = 0; c < rows[r].length; c++) {
                const v = ar[c];
                if (v) out[r][c] = `#${v.replace("#", "").toUpperCase()}`;
              }
            }
            return out;
          };
          const bx = b as unknown as { fills?: (string | null)[][]; textColors?: (string | null)[][] };
          return {
            ...b,
            rows,
            fills: merge(bx.fills, op.fills),
            textColors: merge(bx.textColors, op.textColors),
          } as unknown as DocBlockDTO;
        }
        return { ...b, rows };
      });
    case "insertTable": {
      // Splice a table DTO in at `index` so it renders instantly (the empty
      // paragraph shifts down to become the trailing spacer). `header`/`direction`
      // are DTO extensions patched on via cast (like the tableOp path); the server
      // echo reconciles the authoritative borders/styling. Mirrors patchInsertImage.
      const at = Math.min(Math.max(op.index, 0), blocks.length);
      const table: Record<string, unknown> = { index: at, kind: "table", rows: op.rows.map((r) => [...r]) };
      if (op.header) table.header = true;
      if (op.rtl) table.direction = "rtl";
      const arr = [...blocks];
      arr.splice(at, 0, table as unknown as DocBlockDTO);
      return reindex(arr);
    }
  }
}

/**
 * Optimistic shift of section boundaries (startBlockIndex) for ops that change
 * block positions. Approximation — exact Word semantics (the section break
 * travels with its paragraph) are reconciled by the server echo at queue drain.
 */
export function applyOpToSections(
  sections: DocSectionDTO[] | undefined,
  op: ThesisOp,
): DocSectionDTO[] | undefined {
  if (!sections?.length) return sections;
  const shift = (fn: (start: number) => number) =>
    sections.map((s) => ({ ...s, startBlockIndex: Math.max(0, fn(s.startBlockIndex)) }));
  switch (op.type) {
    case "insertImage": {
      const at = Math.max(op.afterIndex + 1, 0);
      return shift((st) => (st > at ? st + 1 : st));
    }
    case "insertTable": {
      const at = Math.max(op.index, 0);
      return shift((st) => (st >= at ? st + 1 : st));
    }
    case "splitParagraph": {
      const at = op.index + 1;
      return shift((st) => (st > at ? st + 1 : st));
    }
    case "deleteBlocks": {
      return shift((st) => st - op.indices.filter((i) => i < st).length);
    }
    case "move": {
      if (op.from === op.to) return sections;
      return shift((st) => {
        let v = st > op.from ? st - 1 : st;
        if (v > op.to) v += 1;
        return v;
      });
    }
    // editText/format: no positions change. startOnNewPage DOES create a
    // section server-side, but its chrome is unknown locally — the echo brings it.
    default:
      return sections;
  }
}

type LiveDocumentDTO = Extract<DocumentDTO, { available: true }>;

/** Apply an op's optimistic effect to the whole doc DTO (blocks + sections). */
export function applyOpToDoc(doc: LiveDocumentDTO, op: ThesisOp): LiveDocumentDTO {
  const blocks = applyOpToBlocks(doc.blocks, op);
  // A move patchMove rejected (out-of-range) must not shift sections either.
  const rejectedMove =
    op.type === "move" &&
    (op.from < 0 || op.to < 0 || op.from >= doc.blocks.length || op.to >= doc.blocks.length);
  // A splitParagraph whose target isn't a real paragraph block is a no-op on
  // blocks (applyOpToBlocks skips it) — don't shift sections as if one were inserted.
  const rejectedSplit =
    op.type === "splitParagraph" &&
    !doc.blocks.some((b) => b.index === op.index && b.kind === "paragraph");
  return {
    ...doc,
    blocks,
    sections: rejectedMove || rejectedSplit ? doc.sections : applyOpToSections(doc.sections, op),
  };
}

// ── Server execution ─────────────────────────────────────────────────────────

/** Run an op against the server. Returns the endpoint's echoed document (when
 *  the endpoint provides one) for the doc store to reconcile from. */
// `ifMatch` is the document tag this batch is built against (P-66). Only the batch route (applyThesisOps) checks it; the per-op routes ignore it.
export async function executeOp(
  thesisId: string,
  op: ThesisOp,
  ifMatch: string | null = null,
): Promise<{ document?: DocumentDTO; history?: { canUndo: boolean; canRedo: boolean } }> {
  switch (op.type) {
    case "editText":
      return editThesisParagraph(thesisId, op.index, { text: op.text });
    case "splitParagraph":
      return splitThesisParagraph(thesisId, op.index, { before: op.before, after: op.after });
    case "format":
      return editThesisParagraphs(thesisId, op.indices, op.changes);
    case "move":
      return moveThesisBlock(thesisId, op.from, op.to);
    case "insertImage":
      return insertThesisImage(thesisId, {
        data: op.data,
        format: op.format,
        width: op.width,
        height: op.height,
        afterIndex: op.afterIndex,
      });
    case "replaceImage":
      return replaceThesisBlockImage(thesisId, op.index, {
        data: op.data,
        format: op.format,
        width: op.width,
        height: op.height,
      });
    case "deleteBlocks":
      return deleteThesisBlocks(thesisId, op.indices);
    case "startOnNewPage":
      return startThesisBlocksOnNewPage(thesisId, op.indices);
    case "setCaption":
      return setThesisFigureCaption(thesisId, op.index, op.caption);
    case "setList":
      // No single-op endpoint — route through the batch /ops (the only place the
      // server applies list numbering). Rare here (lists flow via the Lexical
      // auto-sync batch), but keeps the durable queue path total.
      return applyThesisOps(thesisId, [op], ifMatch);
    case "tableOp":
      // Table edits are applied server-side by the /ops handler (engine Doc facade).
      return applyThesisOps(thesisId, [op], ifMatch);
    case "insertTable":
      // New-table insert is applied server-side by the /ops handler (Doc.addTable).
      return applyThesisOps(thesisId, [op], ifMatch);
  }
}

// ── Failure classification ───────────────────────────────────────────────────

// A RETRYABLE failure means the request likely never reached the server (offline,
// DNS, timeout) → keep the op queued and retry later. Anything else is the server
// REJECTING the op (validation, auth, conflict) → retrying would never succeed.
// RN's fetch throws TypeError("Network request failed") when offline; our api.ts
// throws plain Errors carrying the server's message for HTTP-level failures.
export function isRetryableError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /network|fetch failed|timed? ?out|socket|ECONN|abort/i.test(msg);
}
