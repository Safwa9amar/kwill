import { create } from "zustand";
import type { PickedFile } from "@/lib/rescue-v2-pick";

// Screen 17's choices: the new file (or files) the student picked, and whether a re-run call is in flight. The stage and the sheet are
// different trees, and the CTA in the foot needs the files the sheet picked, so the state lives here. It belongs to one version of one project
// (`revisionsKey`): a different key starts clean (ensure).

/** The empty list a selector returns for another project: one reference, so the selector never looks changed. */
export const NO_FILES: PickedFile[] = [];

/**
 * The key the choices belong to: the project and the version it works on now. An accepted re-run moves the active version, so the files and
 * the note of the last re-run are no longer the open key's, and a choice made after it starts clean.
 */
export function revisionsKey(project: { id: string; activeVersionId: string | null } | null): string | null {
  return project ? `${project.id}:${project.activeVersionId ?? ""}` : null;
}

interface RevisionsUiState {
  /** The project these choices belong to. */
  key: string | null;
  files: PickedFile[];
  /** The supervisor's note as typed; sent by the CTA or on blur, like the notes screen. */
  note: string;
  /** One re-run call at a time: a tap while one is in flight is refused. */
  busy: boolean;
  ensure(key: string): void;
  setFiles(key: string, files: PickedFile[]): void;
  setNote(key: string, note: string): void;
  begin(): boolean;
  end(): void;
}

export const useRevisionsUi = create<RevisionsUiState>()((set, get) => ({
  key: null,
  files: [],
  note: "",
  busy: false,
  ensure: (key) => {
    if (get().key === key) return;
    set({ key, files: [], note: "" });
  },
  setFiles: (key, files) => {
    if (get().key !== key) return;
    set({ files });
  },
  setNote: (key, note) => {
    if (get().key !== key) return;
    set({ note });
  },
  begin: () => {
    if (get().busy) return false;
    set({ busy: true });
    return true;
  },
  end: () => set({ busy: false }),
}));
