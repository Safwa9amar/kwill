import { create } from "zustand";
import type { RescueCoverChoice, RescueRuleFieldId, RescueRuleRowId } from "@/types/rescue-v2";
import type { CoverRowId, RuleValue } from "@/lib/rescue-v2-confirm";

// The student's own, not yet confirmed, choices on screens 10 to 12. The stage and the sheet are different trees, so the state lives here.
// Every choice shows at once (visual first), and it stays on screen when its save fails, so a failed save never loses an answer: the
// screen offers the retry. It belongs to one project: a different project starts clean (ensure).

export const NO_EDITS: Partial<Record<RescueRuleFieldId, RuleValue>> = {};

export type AnswerValue = { role: string } | { decide: true };
export interface PendingAnswer { questionKey: string; answer: AnswerValue }

interface ConfirmUiState {
  /** The project these choices belong to. */
  key: string | null;
  /** One call at a time across the three screens: a tap while one is in flight is refused, so a double tap never sends twice. */
  busy: boolean;
  rulesPending: Partial<Record<RescueRuleFieldId, RuleValue>>;
  pickerRow: RescueRuleRowId | null;
  answerPending: PendingAnswer | null;
  coverPending: RescueCoverChoice | null;
  /** The More section: null opens by itself when a value calls for it; a tap sets it. */
  coverMore: boolean | null;
  /** The field the cover field sheet is editing. */
  coverField: CoverRowId | null;

  /** Starts clean for a different project. `busy` is never cleared here: a call in flight still ends itself. */
  ensure(key: string): void;
  /** True when the call may start; false while another one is in flight. */
  begin(): boolean;
  end(): void;
  setRulesPending(edits: Partial<Record<RescueRuleFieldId, RuleValue>>): void;
  setPickerRow(row: RescueRuleRowId | null): void;
  setAnswerPending(p: PendingAnswer | null): void;
  setCoverPending(choice: RescueCoverChoice | null): void;
  setCoverMore(open: boolean | null): void;
  setCoverField(row: CoverRowId | null): void;
}

export const useConfirmUi = create<ConfirmUiState>()((set, get) => ({
  key: null,
  busy: false,
  rulesPending: NO_EDITS,
  pickerRow: null,
  answerPending: null,
  coverPending: null,
  coverMore: null,
  coverField: null,

  ensure: (key) => {
    if (get().key === key) return;
    set({ key, rulesPending: NO_EDITS, pickerRow: null, answerPending: null, coverPending: null, coverMore: null, coverField: null });
  },

  begin: () => {
    if (get().busy) return false;
    set({ busy: true });
    return true;
  },

  end: () => set({ busy: false }),

  setRulesPending: (edits) => set({ rulesPending: edits }),
  setPickerRow: (row) => set({ pickerRow: row }),
  setAnswerPending: (p) => set({ answerPending: p }),
  setCoverPending: (choice) => set({ coverPending: choice }),
  setCoverMore: (open) => set({ coverMore: open }),
  setCoverField: (row) => set({ coverField: row }),
}));
