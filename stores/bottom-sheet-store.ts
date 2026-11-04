import { create } from "zustand";

// One name per globally-controlled bottom sheet. Add new sheets here as they're
// migrated to the store so any screen can open them without prop plumbing.
export type SheetName =
  | "structure" | "ask" | "new-thesis" | "thesis-sources" | "thesis-attach"
  // Scheduled tasks: pick a job, choose when it runs, or turn the selected
  // paragraph into a task without leaving the Writer.
  | "task-job" | "task-schedule" | "task-from-block"
  // Rescue v2: the living screen's pickers (university, guide, rule, cover field).
  | "rescue-university" | "rescue-guide" | "rescue-rule-picker" | "rescue-cover-field";

interface BottomSheetState {
  openSheets: Set<SheetName>;
  openSheet: (name: SheetName) => void;
  closeSheet: (name: SheetName) => void;
  closeAllSheets: () => void;
  isOpen: (name: SheetName) => boolean;
}

/**
 * Global control for gorhom bottom sheets. A sheet component subscribes to
 * `openSheets.has(<its name>)` to present/dismiss itself; any caller opens it
 * with `useBottomSheet.getState().openSheet("structure")`.
 */
export const useBottomSheet = create<BottomSheetState>()((set, get) => ({
  openSheets: new Set<SheetName>(),

  openSheet: (name) =>
    set((state) => {
      const next = new Set(state.openSheets);
      next.add(name);
      return { openSheets: next };
    }),

  closeSheet: (name) =>
    set((state) => {
      const next = new Set(state.openSheets);
      next.delete(name);
      return { openSheets: next };
    }),

  closeAllSheets: () => set({ openSheets: new Set() }),

  isOpen: (name) => get().openSheets.has(name),
}));
