// Task 23: an OS paste that may be a PICTURE → native inserts the figure.
//
// Left to the engine, a pasted picture usually vanishes: WebKit tends to hand the
// page nothing for it (see bridge/paste-image.ts). So a capture-phase listener —
// ahead of the engine's own `paste` handler on its content root — takes the maybes,
// swallows them, and reports WHERE the caret is; native re-reads the system
// clipboard (expo-clipboard) and inserts through the same `insertImage` op the Insert
// menu's "Paste image" uses. The bytes never cross the bridge — only the index does.
// A real text paste is not touched.

import { useEffect, useRef } from "react";
import { spannedBlocks } from "../bridge/dom-selectors";
import { clipboardFacts, maybeImagePaste } from "../bridge/paste-image";

export function usePasteImage(onPaste: ((index: number) => void) | undefined): void {
  const ref = useRef(onPaste);
  ref.current = onPaste;
  const enabled = !!onPaste;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      if (!cd || !maybeImagePaste(clipboardFacts(cd))) return;
      // The caret's BODY block; a header, a note or no caret at all → let it through.
      const index = spannedBlocks(window.getSelection()).focus?.index ?? -1;
      if (index < 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ref.current?.(index);
    };
    document.addEventListener("paste", handler, true);
    return () => document.removeEventListener("paste", handler, true);
  }, [enabled]);
}
