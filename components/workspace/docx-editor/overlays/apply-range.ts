// Visual-first range rewrite: replace body blocks start..end with N paragraphs IN
// THE ENGINE, so the student sees the passage the instant they tap Apply. The bytes
// then leave through the ordinary save loop (the change marks the document dirty),
// and the change carries created/deleted ids, so the Bridge re-parses after that
// save and indices are positional again (spec D7).
//
// It is the same edit the server's /blocks/replace-range makes — every new paragraph
// inherits the FIRST block's paragraph properties — expressed as what a student
// would do by hand: select from the start of the first paragraph to the end of the
// last, and paste the passage as plain text, whose newlines the engine turns into
// real paragraph boundaries (`paste` contract: "the plain lane inserts text with
// newlines becoming real paragraph boundaries"). One paste = one undo step.
//
// It REFUSES rather than guesses whenever the two ends cannot be pinned exactly —
// both must be found by their whole text AND parse back to their own index, with
// nothing else in the paragraph around the match. A refusal costs nothing: the
// store falls back to the server path. A wrong guess would rewrite the wrong text.

import type { Editor } from "@docx-editor.dev/react";
import type { EditorCommand, TextMatch } from "@docx-editor.dev/core/contracts/editor";
import { blockIndexFromId } from "@/lib/docx-block-id";
import { isBlockLevelId } from "../bridge/dom-selectors";

export type RangeApplyOutcome = { ok: true } | { ok: false; reason: string };

const blank = (s: string | undefined) => !s || !s.trim();

// The engine refuses a findMatches query longer than this, so a real thesis
// paragraph (routinely 300–900 chars) could never be found whole: every range
// rewrite fell back to the server and the student watched a preview instead of
// their page (found driving the simulator, 10-31). Past the cap the paragraph is
// pinned by its head AND its tail — same block, at its start and at its end —
// the method bridge/apply-op.ts proved for single-paragraph edits.
const QUERY_MAX = 256;
const PROBE = 120;

/** Where a whole paragraph sits: its id (= semantic paragraphId) and its end offset. */
export type WholeParagraph = { blockId: string; end: number };

/**
 * The WHOLE body paragraph `index` whose text is `text`, or null. Stricter than
 * bridge/find-block.ts on purpose: no fallback to "the first body match" (that is
 * fine for scrolling to a place, not for deleting one), and the match must span
 * the paragraph — the engine's context around it is empty.
 */
export function wholeParagraphMatch(editor: Editor, index: number, text: string): WholeParagraph | null {
  const q = text.replace(/\s+/g, " ").trim();
  if (!q) return null;
  const inBlock = (query: string) => Array.from(editor.findMatches(query, { matchCase: true })).filter(
    (m) => !m.scope && isBlockLevelId(m.blockId) && blockIndexFromId(m.blockId) === index,
  );
  if (q.length <= QUERY_MAX) {
    const hits = inBlock(q);
    if (hits.length !== 1) return null;
    const m = hits[0];
    return blank(m.contextBefore) && blank(m.contextAfter) ? { blockId: m.blockId, end: m.start + m.length } : null;
  }
  const heads = inBlock(q.slice(0, PROBE)).filter((m) => blank(m.contextBefore));
  const tails = inBlock(q.slice(-PROBE)).filter((m) => blank(m.contextAfter));
  if (heads.length !== 1 || tails.length !== 1 || heads[0].blockId !== tails[0].blockId) return null;
  return { blockId: heads[0].blockId, end: tails[0].start + tails[0].length };
}

export function applyRangeLocally(
  editor: Editor,
  req: { start: number; end: number; firstText: string; lastText: string; paragraphs: string[] },
): RangeApplyOutcome {
  const paragraphs = req.paragraphs.map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return { ok: false, reason: "nothing to apply" };
  if (req.end < req.start) return { ok: false, reason: "bad range" };
  const first = wholeParagraphMatch(editor, req.start, req.firstText);
  if (!first) return { ok: false, reason: "first block not found exactly" };
  const last = req.end === req.start ? first : wholeParagraphMatch(editor, req.end, req.lastText);
  if (!last) return { ok: false, reason: "last block not found exactly" };

  // `paragraphId` is the same id the painted surface and TextMatch.blockId carry
  // (SemanticPosition: "the paragraph id the painted surface and the ops already use").
  const select = {
    type: "setSelection",
    range: {
      anchor: { paragraphId: first.blockId, offset: 0 },
      head: { paragraphId: last.blockId, offset: last.end },
    },
  } as EditorCommand;
  const canSelect = editor.can(select);
  if (!canSelect.ok) return { ok: false, reason: `select refused: ${canSelect.reason}` };
  const selected = editor.exec(select);
  if (!selected.ok) return { ok: false, reason: `select failed: ${selected.reason}` };

  const paste = { type: "paste", text: paragraphs.join("\n") } as EditorCommand;
  const canPaste = editor.can(paste);
  if (!canPaste.ok) return { ok: false, reason: `paste refused: ${canPaste.reason}` };
  const pasted = editor.exec(paste);
  if (!pasted.ok) return { ok: false, reason: `paste failed: ${pasted.reason}` };
  // ok but unchanged would mean nothing was written — the server path is still safe.
  if (!pasted.changed) return { ok: false, reason: "paste changed nothing" };
  return { ok: true };
}
