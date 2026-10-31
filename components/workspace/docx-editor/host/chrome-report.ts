// Task 18, native half: a `chrome:top` / `chrome:bottom` report from the docx
// surface (the caret is in a running header/footer story — bridge/report-kind.ts)
// → the workspace's chrome selection, enriched from doc.sections exactly as
// WorkspaceLexicalView's chrome branch does it — and, on ENTERING a band, the
// HeaderFooterSheet, as Lexical opened it on a tap (user, 10-31: "the header and
// footer sheet is not opened"). Its whole toolset (instruction, preview, templates,
// remove) lives in that sheet. Only on entry: every keystroke typed into the band
// also reports, and a sheet re-opening under the student's fingers — or after they
// dismissed it — would make the band impossible to type into. Leaving the band
// (a body report) re-arms it.

import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { sectionAt, sectionPrints } from "@/lib/section-chrome";
import { useHfSheetStore } from "@/stores/hf-sheet-store";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function isChromeReport(s: LexicalState): boolean {
  return s.blockType === "chrome:top" || s.blockType === "chrome:bottom";
}

// The band the caret is in ("top:<index>"), or null in the body. Module state: there
// is one docx surface, and the sheet is a single app-wide sheet too.
let openedBand: string | null = null;

/** A body report: the caret left the band, so the next entry opens the sheet again. */
export function leftChrome(): void {
  openedBand = null;
}

export function reportChrome(thesisId: string, s: LexicalState, editorTop: number): void {
  const kind = s.blockType === "chrome:top" ? "top" : "bottom";
  const ws = useWorkspaceStore.getState();
  const doc = useThesisDocStore.getState().byId[thesisId];
  // The band's index is a block INSIDE its section (its first, here), so the
  // containing section is found by range — the same resolution /chrome-op does.
  const sec = sectionAt(doc?.available ? doc.sections : undefined, s.index);
  const band = `${kind}:${s.index}`;
  if (band !== openedBand) {
    openedBand = band;
    // An edge with nothing printed on it: offer to CREATE that part (the engine
    // opened an empty story; the sheet's "add" row is the real way to make one).
    if (!sectionPrints(sec, kind)) {
      useHfSheetStore.getState().openAdd({ thesisId, index: s.index, hasHeader: kind !== "top", hasFooter: kind !== "bottom" });
    } else {
      useHfSheetStore.getState().openBand({
        thesisId,
        index: s.index,
        region: kind === "top" ? "header" : "footer",
        text: kind === "top" ? sec?.header?.text ?? "" : sec?.footer?.text ?? "",
      });
    }
  }
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
