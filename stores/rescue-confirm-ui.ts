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
  /**
   * One call at a time per project: a tap while one is in flight for the open project is refused, so a double tap never sends twice. `busy`
   * is that for the open project only; another project's hung call does not disable this one's buttons.
   */
  busy: boolean;
  /** The projects with a call in flight, in the order they began. `end` releases the last one begun. */
  calls: string[];
  rulesPending: Partial<Record<RescueRuleFieldId, RuleValue>>;
  pickerRow: RescueRuleRowId | null;
  answerPending: PendingAnswer | null;
  coverPending: RescueCoverChoice | null;
  /** The More section: null opens by itself when a value calls for it; a tap sets it. */
  coverMore: boolean | null;
  /** The field the cover field sheet is editing. */
  coverField: CoverRowId | null;

  /** Starts clean for a different project. A call in flight for it stays in flight: `busy` follows the lock, not the screen. */
  ensure(key: string): void;
  /** True when the call may start; false while another one is in flight for the open project. */
  begin(): boolean;
  /** Ends the call begun last. Calls for one project end in the order they began; a call that ends before another project's still releases its own slot. */
  end(): void;
  setRulesPending(edits: Partial<Record<RescueRuleFieldId, RuleValue>>): void;
  setPickerRow(row: RescueRuleRowId | null): void;
  setAnswerPending(p: PendingAnswer | null): void;
  setCoverPending(choice: RescueCoverChoice | null): void;
  setCoverMore(open: boolean | null): void;
  setCoverField(row: CoverRowId | null): void;
}

/** The key a call is held under when no project is open (the stores' own default). */
const NO_KEY = "";

export const useConfirmUi = create<ConfirmUiState>()((set, get) => ({
  key: null,
  busy: false,
  calls: [],
  rulesPending: NO_EDITS,
  pickerRow: null,
  answerPending: null,
  coverPending: null,
  coverMore: null,
  coverField: null,

  ensure: (key) => {
    if (get().key === key) return;
    set({
      key, busy: get().calls.includes(key), rulesPending: NO_EDITS, pickerRow: null, answerPending: null, coverPending: null, coverMore: null,
      coverField: null,
    });
  },

  begin: () => {
    const k = get().key ?? NO_KEY;
    if (get().calls.includes(k)) return false;
    const calls = [...get().calls, k];
    set({ calls, busy: calls.includes(get().key ?? NO_KEY) });
    return true;
  },

  end: () => {
    const calls = get().calls.slice(0, -1);
    set({ calls, busy: calls.includes(get().key ?? NO_KEY) });
  },

  setRulesPending: (edits) => set({ rulesPending: edits }),
  setPickerRow: (row) => set({ pickerRow: row }),
  setAnswerPending: (p) => set({ answerPending: p }),
  setCoverPending: (choice) => set({ coverPending: choice }),
  setCoverMore: (open) => set({ coverMore: open }),
  setCoverField: (row) => set({ coverField: row }),
}));
