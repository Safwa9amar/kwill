import { create } from "zustand";
import type { RescueCompareDTO } from "@/lib/rescue-v2-api";
import type { RescueImpactDTO } from "@/types/rescue-v2";

// The history screens' shared state (H2 to H5). A step's stage and sheet are different trees, so what one shows and the other changes lives
// here. Every value belongs to one project (`key`): a write for another project starts the store clean, and a read asks for its own key.

export type HistoryLoad = "loading" | "ok" | "failed";

const CLEAR = {
  selected: null as string | null,
  pageVersion: null as string | null,
  page: 1,
  comparePair: null as string | null,
  comparePage: 0,
  compare: { slot: null as string | null, state: "loading" as HistoryLoad, value: null as RescueCompareDTO | null },
  impact: { state: "loading" as HistoryLoad, value: null as RescueImpactDTO | null },
  draft: "",
};

interface HistoryUiState {
  /** The project these values are for. */
  key: string | null;
  /** H2's selected version (the stage previews it). Null: the current one. */
  selected: string | null;
  /** The page on show of one version, kept while the student stays on it. */
  pageVersion: string | null;
  page: number;
  /** H4's pair, `a|b`, and the pager's index into the pages that differ. */
  comparePair: string | null;
  comparePage: number;
  /** The compare reply for one pair and index, `pair|index`. */
  compare: { slot: string | null; state: HistoryLoad; value: RescueCompareDTO | null };
  /** H5's impact for the project. */
  impact: { state: HistoryLoad; value: RescueImpactDTO | null };
  /** H5's supervisor note as typed, not yet sent (the notes section's field, and the CTA that sends it). */
  draft: string;

  select(key: string, id: string | null): void;
  setPage(key: string, versionId: string, page: number): void;
  setComparePair(key: string, pair: string): void;
  setComparePage(key: string, pair: string, index: number): void;
  setCompare(key: string, slot: string, state: HistoryLoad, value: RescueCompareDTO | null): void;
  setImpact(key: string, state: HistoryLoad, value: RescueImpactDTO | null): void;
  setDraft(key: string, text: string): void;
  reset(): void;
}

export const useHistoryUi = create<HistoryUiState>()((set) => {
  /** Every write names its project. A different one starts clean, then takes the write. */
  const scoped = (key: string, patch: Partial<HistoryUiState>) =>
    set((s) => (s.key === key ? patch : { key, ...CLEAR, ...patch }));
  return {
    key: null,
    ...CLEAR,
    select: (key, id) => scoped(key, { selected: id }),
    setPage: (key, versionId, page) => scoped(key, { pageVersion: versionId, page }),
    setComparePair: (key, pair) => scoped(key, { comparePair: pair, comparePage: 0 }),
    setComparePage: (key, pair, index) => scoped(key, { comparePair: pair, comparePage: index }),
    setCompare: (key, slot, state, value) => scoped(key, { compare: { slot, state, value } }),
    setImpact: (key, state, value) => scoped(key, { impact: { state, value } }),
    setDraft: (key, text) => scoped(key, { draft: text }),
    reset: () => set({ key: null, ...CLEAR }),
  };
});
