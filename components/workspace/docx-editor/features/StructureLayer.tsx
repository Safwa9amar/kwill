// Phase 3 on the docx surface, in one child of <DocxEditor> (so the engine hooks
// resolve): equation tap (17), chart layer + chart tap (19), picture transforms (20),
// search (21), the slash trigger (22, detection) and image paste (23), plus the
// pending shimmer every server-side edit shows until its reload lands.
//
// The header/footer report (18) and the image/table report kinds live in the
// selection report itself — bridge/report-kind.ts, called from Bridge.tsx.

import type { RefObject } from "react";
import { toolbarCommandState } from "@docx-editor.dev/react";
import type { DocxEditorRef } from "@docx-editor.dev/react";
import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { structuralReport } from "../bridge/report-kind";
import type {
  ChartOverlayInput,
  ImageCommandInput,
  InsertTrigger,
  SearchFocusInput,
  SearchReplaceInput,
  SearchReplaceResult,
} from "../bridge/surface-types";
import { ChartLayer } from "../overlays/ChartLayer";
import { PendingLayer } from "../overlays/PendingLayer";
import { useEquationTap } from "./use-equation-tap";
import { useHeaderTap } from "./use-header-tap";
import { useImageCommand } from "./use-image-command";
import { usePasteImage } from "./use-paste-image";
import { useSearchBridge } from "./use-search-bridge";
import { useSlashTrigger } from "./use-slash-trigger";

const NONE: readonly never[] = [];

export type StructureLayerProps = {
  editorRef: RefObject<DocxEditorRef | null>;
  charts: readonly ChartOverlayInput[] | undefined;
  selectedChart: number | undefined;
  pending: readonly number[] | undefined;
  pendingChrome: readonly string[] | undefined;
  imageCommand: ImageCommandInput | null | undefined;
  searchFocus: SearchFocusInput | null | undefined;
  searchReplace: SearchReplaceInput | null | undefined;
  onState: (s: LexicalState) => void;
  onEquationTap: ((payload: string) => void) | undefined;
  onInsertTrigger: ((t: InsertTrigger) => void) | undefined;
  onPasteImage: ((index: number) => void) | undefined;
  onSearchReplaced: ((r: SearchReplaceResult) => void) | undefined;
  onImageRefused: ((index: number) => void) | undefined;
};

export function StructureLayer(p: StructureLayerProps) {
  useEquationTap(p.onEquationTap);
  useHeaderTap(p.editorRef);
  useSlashTrigger(p.onInsertTrigger);
  usePasteImage(p.onPasteImage);
  useImageCommand(p.editorRef, p.imageCommand, p.onImageRefused);
  useSearchBridge(p.editorRef, p.searchFocus, p.searchReplace, p.onSearchReplaced);

  // A chart is an overlay outside the engine's content, so the engine never sees the
  // tap: report the selection ourselves, as the whole-block selection Lexical's
  // chart node produced. History availability rides every report (the host feeds
  // the undo/redo buttons from it), so it is read here too.
  const onChartSelect = (index: number, rect: { top: number }) => {
    const editor = p.editorRef.current?.getEditor() ?? null;
    const base: LexicalState = {
      bold: false, italic: false, underline: false, blockType: "paragraph", isRTL: false, alignment: null,
      index, text: "", y: rect.top,
      canUndo: editor ? toolbarCommandState(editor, "history.undo").enabled : false,
      canRedo: editor ? toolbarCommandState(editor, "history.redo").enabled : false,
      userDriven: true,
    };
    p.onState(structuralReport(base, "image", index, rect.top));
  };

  return (
    <>
      <ChartLayer charts={p.charts ?? NONE} selectedIndex={p.selectedChart ?? -1} onSelect={onChartSelect} />
      <PendingLayer pending={p.pending ?? NONE} pendingChrome={p.pendingChrome ?? NONE} />
    </>
  );
}
