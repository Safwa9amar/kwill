// Task 21: the search panel on the docx surface.
//
// The panel keeps its matcher (DTO + Arabic folding, lib/search-match.ts) and sends
// each hit as a SearchTarget — the literal text it covers and where (see
// bridge/surface-types.ts for why). Here a target becomes a real engine match:
// `findMatches(literal)` in that block, the one meant picked by bridge/search-resolve.
//
//   focus   → selectMatch + scrollToBlock: the current hit is selected on the page
//   replace → replaceMatch per hit, back-to-front, as ONE history group when the
//             engine accepts one — local and instant; the save loop persists it
//
// Semantic hits need nothing here: they navigate by block index through the
// Phase 1 scrollToIndex path.

import { useEffect, useRef, type RefObject } from "react";
import type { DocxEditorRef, Editor } from "@docx-editor.dev/react";
import type { TextMatch } from "@docx-editor.dev/core/contracts/editor";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";
import { pickMatch, replaceOrder } from "../bridge/search-resolve";
import type { SearchFocusInput, SearchReplaceInput, SearchReplaceResult, SearchTarget } from "../bridge/surface-types";

function inBlock(editor: Editor, literal: string, blockIndex: number): TextMatch[] {
  return Array.from(editor.findMatches(literal, { matchCase: true }))
    .filter((m) => isBodyId(m.blockId) && blockIndexFromId(m.blockId) === blockIndex);
}

function resolveAll(editor: Editor, items: readonly SearchTarget[]): { found: TextMatch[]; missed: number } {
  // One findMatches per distinct literal — each one walks the whole document.
  const byLiteral = new Map<string, SearchTarget[]>();
  for (const t of items) byLiteral.set(t.literal, [...(byLiteral.get(t.literal) ?? []), t]);
  const found: TextMatch[] = [];
  let missed = 0;
  for (const [literal, targets] of byLiteral) {
    const all = Array.from(editor.findMatches(literal, { matchCase: true })).filter((m) => isBodyId(m.blockId));
    const taken = new Set<string>();
    for (const t of targets) {
      const pool = all.filter((m) => blockIndexFromId(m.blockId) === t.blockIndex && !taken.has(`${m.blockId}@${m.start}`));
      const m = pickMatch(pool, t);
      if (!m) { missed++; continue; }
      taken.add(`${m.blockId}@${m.start}`);
      found.push(m);
    }
  }
  return { found, missed };
}

export function useSearchBridge(
  editorRef: RefObject<DocxEditorRef | null>,
  focus: SearchFocusInput | null | undefined,
  replace: SearchReplaceInput | null | undefined,
  onReplaced: ((r: SearchReplaceResult) => void) | undefined,
): void {
  const editorOf = () => editorRef.current?.getEditor() ?? null;
  // Both are replayed to a remounted surface; neither may run twice.
  const seenFocus = useRef(focus?.nonce ?? -1);
  const seenReplace = useRef(replace?.nonce ?? -1);

  useEffect(() => {
    const editor = editorOf();
    if (!focus || !editor || focus.nonce === seenFocus.current) return;
    seenFocus.current = focus.nonce;
    const m = pickMatch(inBlock(editor, focus.literal, focus.blockIndex), focus);
    if (!m) return;
    editor.selectMatch(m);
    editor.scrollToBlock(m.blockId);
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const editor = editorOf();
    if (!replace || !editor || replace.nonce === seenReplace.current) return;
    seenReplace.current = replace.nonce;
    const { found, missed } = resolveAll(editor, replace.items);
    let replaced = 0;
    let failed = 0;
    // One undo step for a Replace All, as Word does — if the engine takes a group
    // for this command. If it refuses one, fall back to plain execs rather than
    // losing the replacement.
    let group = found.length > 1 ? editor.beginHistoryGroup() : null;
    for (const match of replaceOrder(found)) {
      const cmd = { type: "replaceMatch" as const, match, text: replace.text };
      let r = group ? editor.exec(cmd, { historyGroup: group }) : editor.exec(cmd);
      if (!r.ok && group && (r.code === "invalidArgs" || r.code === "unsupported")) {
        group.end();
        group = null;
        r = editor.exec(cmd);
      }
      if (r.ok) replaced++;
      else failed++;
    }
    group?.end();
    onReplaced?.({ nonce: replace.nonce, replaced, missed: missed + failed });
  }, [replace?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
}
