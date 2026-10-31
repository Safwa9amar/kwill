// Read the facts report-kind.ts classifies on, from the live engine and the painted
// DOM. Called from inside the report (the engine's own event), so it asks the
// engine at that moment — see the ⚠️ in Bridge.tsx about stale render values.

import type { Editor } from "@docx-editor.dev/react";
import type { SelectionFacts } from "./report-kind";

/** The painted element of a drawing, by its engine node id. */
export function drawingElement(id: string): HTMLElement | null {
  // CSS.escape: node ids carry `/`, `#` and `.`, all of which are selector syntax.
  const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  return document.querySelector<HTMLElement>(`[data-drawing-node-id="${esc}"]`);
}

export function readSelectionFacts(editor: Editor): SelectionFacts {
  let headerFooter: SelectionFacts["headerFooter"] = null;
  try {
    const hf = editor.getHeaderFooterState();
    if (hf?.editing === "header" || hf?.editing === "footer") {
      headerFooter = { editing: hf.editing, sectionIndex: hf.sectionIndex ?? 0 };
    }
  } catch { /* no document yet */ }

  let image: SelectionFacts["image"] = null;
  try {
    const img = editor.getSelectedImage();
    if (img?.id) {
      const el = drawingElement(img.id);
      image = { id: img.id, top: el ? el.getBoundingClientRect().top : null };
    }
  } catch { /* ignore */ }

  let table: SelectionFacts["table"] = null;
  try {
    const t = editor.getSelectedTable();
    if (t?.blockId) table = { blockId: t.blockId };
  } catch { /* ignore */ }

  return { headerFooter, image, table };
}
