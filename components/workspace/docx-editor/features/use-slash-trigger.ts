// Task 22 (DETECTION only): a "/query" typed at the caret → `onInsertTrigger`, the
// same `{ active, index, query }` Lexical's SlashPlugin sends, so the native
// BottomInsertDrawer blooms exactly as it does today. Executing the pick (deleting
// the /query and transforming the block) is the insert command's job, not this one.
//
// Read from the DOM selection the engine mirrors onto its painted runs
// (`setBaseAndExtent` on the run's text node): the text BEFORE the caret in that run
// — the same run-level rule SlashPlugin applied to a Lexical text node. One frame
// after the engine's event, so the run has repainted with the keystroke.
//
// Only a body paragraph that IS a block (not a table cell, a text box, a header):
// those are the places the Insert menu can place a block.

import { useRef } from "react";
import { useEditorEvent } from "@docx-editor.dev/react";
import { blockIndexFromId, isBodyId } from "@/lib/docx-block-id";
import { isBlockLevelId } from "../bridge/dom-selectors";
import { slashQuery } from "../bridge/slash-trigger";
import type { InsertTrigger } from "../bridge/surface-types";

const INACTIVE: InsertTrigger = { active: false, index: -1, query: "" };

export function useSlashTrigger(onTrigger: ((t: InsertTrigger) => void) | undefined): void {
  const ref = useRef(onTrigger);
  ref.current = onTrigger;
  const lastKey = useRef("");
  const raf = useRef(0);

  const check = () => {
    raf.current = 0;
    const send = ref.current;
    if (!send) return;
    const sel = window.getSelection();
    // No selection at all = no information (focus went to the native drawer this
    // trigger opened). Closing on that would snap the menu shut the moment it opens.
    if (!sel || sel.rangeCount === 0) return;
    let hit: InsertTrigger | null = null;
    const node = sel.anchorNode;
    if (sel.isCollapsed && node && node.nodeType === Node.TEXT_NODE) {
      const pid = node.parentElement?.closest("[data-paragraph-id]")?.getAttribute("data-paragraph-id") ?? null;
      const index = isBodyId(pid) && isBlockLevelId(pid) ? blockIndexFromId(pid) : null;
      const q = index != null ? slashQuery((node.textContent ?? "").slice(0, sel.anchorOffset)) : null;
      if (q && index != null) hit = { active: true, index, query: q.query };
    }
    const next = hit ?? INACTIVE;
    const key = `${next.active}|${next.index}|${next.query}`;
    if (key === lastKey.current) return;
    // Never open a closed menu with an "inactive" — only report a change.
    if (!next.active && !lastKey.current.startsWith("true")) { lastKey.current = key; return; }
    lastKey.current = key;
    send(next);
  };
  const schedule = () => { if (!raf.current) raf.current = requestAnimationFrame(check); };

  useEditorEvent("selectionChange", schedule);
  useEditorEvent("change", schedule);
}
