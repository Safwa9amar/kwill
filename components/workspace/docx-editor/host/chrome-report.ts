// Task 18, native half: a `chrome:top` / `chrome:bottom` report from the docx
// surface (the caret is in a running header/footer story — bridge/report-kind.ts)
// → the workspace's chrome selection, enriched from doc.sections exactly as
// WorkspaceLexicalView's chrome branch does it.
//
// One deliberate difference from Lexical: a band there opened the HeaderFooterSheet
// at once (or its "add" flow on a bare edge), because a Lexical band could not be
// typed into. Here the engine edits the header ITSELF — the student is in it, typing
// (an empty edge is materialised by the engine on entry) — so a sheet sliding over
// most of the screen would bury what they are writing. The report selects the band
// instead: the bubble's hfTop/hfBottom toolset (its ✦ chip) opens the same sheet, on
// the same section, for the AI/template path.

import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { sectionAt } from "@/lib/section-chrome";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function isChromeReport(s: LexicalState): boolean {
  return s.blockType === "chrome:top" || s.blockType === "chrome:bottom";
}

export function reportChrome(thesisId: string, s: LexicalState, editorTop: number): void {
  const kind = s.blockType === "chrome:top" ? "top" : "bottom";
  const ws = useWorkspaceStore.getState();
  const doc = useThesisDocStore.getState().byId[thesisId];
  // The band's index is a block INSIDE its section (its first, here), so the
  // containing section is found by range — the same resolution /chrome-op does.
  const sec = sectionAt(doc?.available ? doc.sections : undefined, s.index);
  ws.setChromeSelection({
    kind,
    index: s.index,
    // The ACTUAL header/footer text, not the painted story's: it grounds the AI ask.
    text: kind === "top" ? sec?.header?.text ?? "" : sec?.footer?.text ?? "",
    pageNumbers: kind === "bottom" ? !!sec?.footer?.pageNumbers : undefined,
    segments: kind === "top" ? sec?.header?.segments : undefined,
  });
  // Otherwise the body block selected before would still own the bubble.
  ws.clearSelection();
  useLexicalEditorStore.getState().setFormat({
    bold: false, italic: false, underline: false,
    blockType: s.blockType, isRTL: s.isRTL, alignment: s.alignment,
  });
  if (typeof s.y === "number" && s.y >= 0) useFloatingPillStore.getState().setAnchorY(editorTop + s.y);
}
