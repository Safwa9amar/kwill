import { create } from "zustand";
import type { PickedFile } from "@/lib/rescue-v2-pick";

// Screen 17's choices: the new file (or files) the student picked, and whether a re-run call is in flight. The stage and the sheet are
// different trees, and the CTA in the foot needs the files the sheet picked, so the state lives here. It belongs to one project: a different
// project starts clean (ensure).

/** The empty list a selector returns for another project: one reference, so the selector never looks changed. */
export const NO_FILES: PickedFile[] = [];

interface RevisionsUiState {
  /** The project these choices belong to. */
  key: string | null;
  files: PickedFile[];
  /** One re-run call at a time: a tap while one is in flight is refused. */
  busy: boolean;
  ensure(key: string): void;
  setFiles(key: string, files: PickedFile[]): void;
  begin(): boolean;
  end(): void;
}

export const useRevisionsUi = create<RevisionsUiState>()((set, get) => ({
  key: null,
  files: [],
  busy: false,
  ensure: (key) => {
    if (get().key === key) return;
    set({ key, files: [] });
  },
  setFiles: (key, files) => {
    if (get().key !== key) return;
    set({ files });
  },
  begin: () => {
    if (get().busy) return false;
    set({ busy: true });
    return true;
  },
  end: () => set({ busy: false }),
}));
