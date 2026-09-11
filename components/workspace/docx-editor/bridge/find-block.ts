// index → engine match (spec D7, the one allowed direction).
//
// ⚠️ `TextMatch` is NOT re-exported from @docx-editor.dev/react at 2.16 (its
// index.d.ts only forwards Editor, EditorCommand, EditorQuery, EditorScope,
// EditorSnapshot, the font types and PageSetup from the contract), so it is
// imported straight from the contract module. Type-only, so the import is erased
// and nothing new enters the bundle.

import type { Editor } from "@docx-editor.dev/react";
import type { TextMatch } from "@docx-editor.dev/core/contracts/editor";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";

/**
 * The engine's match for block `index`: search the block's own text, keep the
 * BODY match whose node id parses back to `index`; if none does (ids drifted
 * since the load — a local structural edit not yet reloaded), fall back to the
 * first body match, which is the right block whenever its text is unique.
 * `maxLen` bounds the query for navigation; pass Infinity to select the WHOLE
 * paragraph (`match.length` is then the paragraph's length).
 */
export function findBlockMatch(editor: Editor, index: number, text: string, maxLen = 120): TextMatch | null {
  const q = text.replace(/\s+/g, " ").trim().slice(0, maxLen);
  if (!q) return null;
  const matches = Array.from(editor.findMatches(q)).filter((m) => isBodyId(m.blockId));
  return matches.find((m) => blockIndexFromId(m.blockId) === index) ?? matches[0] ?? null;
}
