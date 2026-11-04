import { create } from "zustand";
import { chipTarget, firstPage, firstVisibleN } from "@/lib/rescue-v2-diagnosis";
import type { RescueChipKey, RescueDotDTO } from "@/types/rescue-v2";

// Screen 7's view, shared by its stage (the page and the dots) and its sheet (the chips and the student's items). Both are rendered in
// different trees, so the state lives here. It belongs to one project and version: a different one starts over (ensure).

interface DiagnosisViewState {
  /** The project and version this view belongs to, as one key (see `viewKey`). */
  key: string | null;
  page: number;
  chip: RescueChipKey | null;
  selectedN: number | null;
  /** Starts the view when the project or its version differs; the same project and version keep where the student was. */
  ensure(projectId: string, versionId: string, dots: RescueDotDTO[]): void;
  /** A swipe or a jump to a page: the page's first visible dot is selected. */
  goTo(page: number, dots: RescueDotDTO[]): void;
  select(n: number): void;
  /** A chip: picked, it filters and jumps; tapped again, it clears the filter. */
  pickChip(chip: RescueChipKey, dots: RescueDotDTO[]): void;
}

/** A re-run is a new version of the same project: its dots are new, so the view starts over for it. */
export function viewKey(projectId: string, versionId: string): string {
  return `${projectId}\n${versionId}`;
}

export const useDiagnosisView = create<DiagnosisViewState>()((set, get) => ({
  key: null,
  page: 1,
  chip: null,
  selectedN: null,

  ensure: (projectId, versionId, dots) => {
    const key = viewKey(projectId, versionId);
    if (get().key === key) return;
    const page = firstPage(dots);
    set({ key, page, chip: null, selectedN: firstVisibleN(dots, page, null) });
  },

  goTo: (page, dots) => {
    set({ page, selectedN: firstVisibleN(dots, page, get().chip) });
  },

  select: (n) => set({ selectedN: n }),

  pickChip: (chip, dots) => {
    const s = get();
    if (s.chip === chip) {
      set({ chip: null, selectedN: firstVisibleN(dots, s.page, null) });
      return;
    }
    const target = chipTarget(dots, chip, s.page);
    if (target) set({ chip, page: target.page, selectedN: target.n });
    else set({ chip, selectedN: null });
  },
}));
