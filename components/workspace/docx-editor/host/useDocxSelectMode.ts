// Task 24, native half: checkbox select mode on the docx surface, fed exactly as
// WorkspaceLexicalView feeds the Lexical SelectPlugin — the mode flag and the
// checked indices from the workspace store in, a tapped block out to
// `toggleBlock` with a haptic tick. The DOM half is overlays/SelectCheckboxes.tsx.

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { hSelection } from "@/lib/haptics";
import { useWorkspaceStore } from "@/stores/workspace-store";

// How long after leaving the mode a selection report is still read as the mode
// switch's own echo (see swallowsReport). Comfortably above a slow bridge round trip,
// well below a student's "done picking → tap a block" gesture.
const EXIT_ECHO_MS = 1000;

const NONE: number[] = [];

export function useDocxSelectMode(lastSelKeyRef: MutableRefObject<string>) {
  const selectMode = useWorkspaceStore((s) => s.selectMode);
  // The store's own array: a stable reference until the pick changes.
  const selectedBlocks = useWorkspaceStore((s) => s.selectedBlocks);
  // Which blocks the surface draws CHECKED — one checked box is a legitimate state.
  const selectedForCheck = useMemo(
    () => (selectMode ? selectedBlocks.map((b) => b.index) : NONE),
    [selectMode, selectedBlocks],
  );

  // The checkboxes drive the selection without going through onState, so its
  // dedupe key goes stale while the mode is on; clear it on every flip (Lexical's
  // rule). Subscribed rather than an effect, so the stamp below is set before any
  // report the flip provokes can reach onState.
  const leftAt = useRef(0);
  useEffect(() => useWorkspaceStore.subscribe((s, prev) => {
    if (s.selectMode === prev.selectMode) return;
    lastSelKeyRef.current = "";
    if (!s.selectMode) leftAt.current = Date.now();
  }), [lastSelKeyRef]);

  /**
   * True while a selection report must not touch the workspace selection: during
   * the mode (the checkboxes own it), and just after leaving it.
   *
   * ⚠️ The engine's setMode emits a selectionChange, so flipping back to "edit"
   * reports wherever the old caret was — and the host would replace the pick with
   * that one block. Leaving the mode is meant to KEEP the pick (toggleSelectMode),
   * and the report's `userDriven` cannot veto it: the checkbox taps that just
   * happened stamp the Bridge's "recent input" clock.
   */
  const swallowsReport = useCallback(
    () => useWorkspaceStore.getState().selectMode || Date.now() - leftAt.current < EXIT_ECHO_MS,
    [],
  );

  const onToggleSelect = useCallback(async (index: number, text: string) => {
    hSelection();
    useWorkspaceStore.getState().toggleBlock(index, text);
  }, []);

  return { swallowsReport, props: { selectActive: selectMode, selectedForCheck, onToggleSelect } };
}
