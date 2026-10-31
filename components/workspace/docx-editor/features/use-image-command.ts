// Task 20: rotate / flip a picture IN THE ENGINE — the student sees it turn the
// instant they tap, and the save loop persists the bytes (spec D2: the change is NOT
// also sent as a server op). The old path downloaded the image, re-encoded it on
// device and swapped the bytes through the server; that stays as the fallback when
// this surface is not mounted.
//
// The picture is addressed by its drawing node id, found from the block index on the
// painted page (the one the student just tapped is on screen); the selected image is
// the fallback when its page has been virtualised out.

import { useEffect, useRef, type RefObject } from "react";
import type { DocxEditorRef, Editor } from "@docx-editor.dev/react";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";
import type { ImageCommandInput } from "../bridge/surface-types";

function drawingIdFor(editor: Editor, index: number): string | null {
  for (const el of Array.from(document.querySelectorAll("[data-drawing-node-id]"))) {
    const id = el.getAttribute("data-drawing-node-id");
    if (isBodyId(id) && blockIndexFromId(id) === index) return id;
  }
  const sel = editor.getSelectedImage();
  return sel && isBodyId(sel.id) && blockIndexFromId(sel.id) === index ? sel.id : null;
}

export function useImageCommand(
  editorRef: RefObject<DocxEditorRef | null>,
  cmd: ImageCommandInput | null | undefined,
  /** The engine would not do it — the host tells the student (it has the i18n). */
  onRefused: ((index: number) => void) | undefined,
): void {
  // A remount (crash recovery) hands us the last command again; it was already run.
  const seen = useRef(cmd?.nonce ?? -1);
  useEffect(() => {
    const editor = editorRef.current?.getEditor() ?? null;
    if (!cmd || !editor || cmd.nonce === seen.current) return;
    seen.current = cmd.nonce;
    const id = drawingIdFor(editor, cmd.index);
    const r = id ? editor.exec({ type: "transformImage", drawingNodeId: id, action: cmd.action }) : null;
    if (!r?.ok) {
      console.warn("[docx] transformImage refused", cmd, r && !r.ok ? r.reason : "no painted drawing for that index");
      onRefused?.(cmd.index);
    }
  }, [cmd?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
}
