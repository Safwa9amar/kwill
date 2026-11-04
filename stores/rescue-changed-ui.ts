import { create } from "zustand";

// Screen 16's page, shared by its stage (the one page) and its sheet (the rows that jump to a page). The stage and the sheet are different
// trees, so the state lives here. It belongs to one version: a different version starts again at page 1.

interface ChangedUiState {
  /** The version the page is for. */
  key: string | null;
  page: number;
  ensure(key: string): void;
  setPage(page: number): void;
}

export const useChangedUi = create<ChangedUiState>()((set, get) => ({
  key: null,
  page: 1,
  ensure: (key) => {
    if (get().key === key) return;
    set({ key, page: 1 });
  },
  setPage: (page) => set({ page }),
}));
