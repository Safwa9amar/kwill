// The command kinds Bridge.tsx hands on because they need more than a slot: the
// paginated surface (list state, the caret, Enter) or the page's focus. See
// command-map.ts for which native dispatch becomes which kind.
//
// The Insert drawer's "/query". Lexical tracked the slash run while it was typed;
// here it is re-found when the pick arrives, from the MODEL (the surface's caret
// and findMatches), never the browser selection — the drawer blurs the WebView as
// it opens, and a blurred page's DOM selection is not to be trusted. A "/" counts
// when it starts the paragraph or follows whitespace and only non-space,
// non-slash characters sit between it and the caret: SlashPlugin's own rule.

import type { EditorCommand } from "@docx-editor.dev/react";
import { setListAtSelection, type Engine } from "./apply-op";
import type { EngineAction, InsertThen } from "./command-map";

type Extra = Extract<EngineAction, { kind: "list" | "indent" | "direction" | "insert" | "focus" | "blur" }>;

const cmd = (c: Record<string, unknown>) => c as unknown as EditorCommand;

function run(e: Engine, c: EditorCommand): boolean {
  try {
    const r = e.ed.exec(c);
    if (!r.ok) console.warn(`[docx] ${c.type} refused:`, r.reason);
    return r.ok;
  } catch (err) {
    console.warn(`[docx] ${c.type} threw`, err);
    return false;
  }
}

/** Remove the "/query" that ends at the caret. Returns whether the paragraph still
 *  holds text once it is gone (Lexical's rule for "restyle this one" vs "open a new
 *  one after it"); null when there was no slash run to remove. */
function clearSlash(e: Engine): { hasText: boolean } | null {
  const sel = e.surface?.state().selection;
  if (!sel) return null;
  const { anchor, head } = sel;
  if (anchor.paragraphId !== head.paragraphId || anchor.offset !== head.offset) return null;
  const caret = head.offset;
  let best: { start: number; before: string; after: string } | null = null;
  for (const m of e.ed.findMatches("/", { matchCase: true })) {
    if (m.blockId !== head.paragraphId || m.start >= caret) continue;
    const q = caret - m.start - 1;
    const after = m.contextAfter ?? "";
    if (after.length < q) continue; // context is bounded (48 chars); a query that long is not a slash command
    const query = after.slice(0, q);
    if (/[\s/]/.test(query)) continue;
    const before = m.contextBefore ?? "";
    if (before && !/\s$/.test(before)) continue;
    if (!best || m.start > best.start) best = { start: m.start, before, after: after.slice(q) };
  }
  if (!best) return null;
  const ok = run(e, cmd({ type: "setSelection", range: { anchor: { paragraphId: head.paragraphId, offset: best.start }, head: { paragraphId: head.paragraphId, offset: caret } } }))
    && run(e, cmd({ type: "deleteText" }));
  return ok ? { hasText: (best.before + best.after).trim().length > 0 } : null;
}

function insert(e: Engine, then: InsertThen): void {
  const cleared = clearSlash(e);
  if (!then) return;
  if ("pageBreak" in then) { run(e, cmd({ type: "insertBreak", kind: "page" })); return; }
  if ("table" in then) { run(e, cmd({ type: "insertTable", rows: then.table.rows, cols: then.table.cols })); return; }
  if ("toc" in then) { run(e, cmd({ type: "insertToc" })); return; }
  if ("footnote" in then) { run(e, cmd({ type: "insertNote", noteKind: "footnote" })); return; }
  // A text kind restyles the paragraph the slash was typed in when nothing else is
  // left in it, else a NEW paragraph after the caret (Enter, Word's follower style
  // then overwritten). Without the surface there is no Enter to press — restyle.
  if (cleared?.hasText && e.surface) e.surface.splitParagraph();
  if ("style" in then) run(e, cmd({ type: "setParagraphStyle", styleId: then.style }));
  else {
    const r = setListAtSelection(e, then.list);
    if (!r.ok) console.warn("[docx] list refused:", r.reason);
  }
}

export function runCommandAction(e: Engine | null, a: Extra): void {
  switch (a.kind) {
    case "focus":
      // Opens the keyboard on the caret the engine already holds.
      e?.ed.focus();
      return;
    case "blur":
      // Closes the OS keyboard. The engine's MODEL selection survives a blur, so a
      // slash insert that follows still lands where the student was.
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
  }
  if (!e) return;
  switch (a.kind) {
    case "list": {
      const r = setListAtSelection(e, a.list);
      if (!r.ok) console.warn("[docx] list refused:", r.reason);
      return;
    }
    case "indent":
      run(e, cmd({ type: "adjustIndent", direction: a.direction }));
      return;
    case "direction":
      run(e, cmd({ type: "setParagraphDirection", direction: a.direction }));
      return;
    case "insert":
      insert(e, a.then);
      return;
  }
}
