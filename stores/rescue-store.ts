// stores/rescue-store.ts
// مسار الإنقاذ: pick → diagnose (free, ephemeral) → verdict → answers →
// repair (paid) → result. The runId is persisted so a cold start resumes the
// run instead of losing it. Select PRIMITIVES from this store.
import { create } from "zustand";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  rescueDiagnose, getRescueRun, submitRescueAnswers, rescueRepair,
  type RescueRun, type RescueQuestion, type RescueStep, type RescueVerdict, type RescueRole,
} from "@/lib/api";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ACTIVE_KEY = "rescue.activeRunId";

export type RescueStatus =
  | "idle" | "picking" | "uploading" | "diagnosing"
  | "verdict" | "repairing" | "done" | "payment" | "error";

interface RescueState {
  status: RescueStatus;
  runId: string | null;
  fileName: string | null;
  normProfileId: string | null;
  uploadProgress: number;
  verdict: RescueVerdict | null;
  degraded: boolean;
  questions: RescueQuestion[];
  answers: Record<string, { role: RescueRole; level?: 1 | 2 | 3 | 4 }>;
  steps: RescueStep[];
  thesisId: string | null;
  conformityOk: number;
  conformityTotal: number;
  errorMessage: string | null;

  setNormProfileId: (id: string | null) => void;
  /** onPicked fires the moment a valid .docx is chosen — navigate THEN. */
  pickAndDiagnose: (opts?: { onPicked?: (fileName: string) => void }) => Promise<"ok" | "canceled" | "error">;
  answerQuestion: (id: string, choice: { role: RescueRole; level?: 1 | 2 | 3 | 4 }) => void;
  dismissQuestion: (id: string) => void;
  /** Sends answers (if any), then starts the paid repair. */
  startRepair: () => Promise<"ok" | "payment" | "error">;
  /** Poll the run while repairing — drives the progress screen. */
  refresh: () => Promise<void>;
  /** Cold-start: pick up an unfinished run from AsyncStorage. */
  resume: () => Promise<boolean>;
  reset: () => void;
}

const INITIAL = {
  status: "idle" as RescueStatus,
  runId: null as string | null,
  fileName: null as string | null,
  normProfileId: null as string | null,
  uploadProgress: 0,
  verdict: null as RescueVerdict | null,
  degraded: false,
  questions: [] as RescueQuestion[],
  answers: {} as Record<string, { role: RescueRole; level?: 1 | 2 | 3 | 4 }>,
  steps: [] as RescueStep[],
  thesisId: null as string | null,
  conformityOk: 0,
  conformityTotal: 0,
  errorMessage: null as string | null,
};

// The four rescue endpoints do not all return the same shape (see the doc
// comment on RescueRun in lib/api.ts): /diagnose and GET /:id send the full
// run, /answers sends a fresh verdict + questions + steps but no status, and
// /repair sends status + thesisId + conformity but never verdict/questions/
// degraded. absorb() must only touch keys the payload actually carries —
// setting every field unconditionally would wipe the stored verdict every
// time a repair response comes back, since repair never includes one.
type RescuePayload = Partial<
  Pick<RescueRun, "runId" | "verdict" | "degraded" | "questions" | "steps" | "thesisId" | "conformity">
>;

function absorb(payload: RescuePayload, set: (p: Partial<RescueState>) => void): void {
  const patch: Partial<RescueState> = {};
  if ("runId" in payload) patch.runId = payload.runId ?? null;
  if ("verdict" in payload) patch.verdict = payload.verdict ?? null;
  if ("degraded" in payload) patch.degraded = payload.degraded ?? false;
  if ("questions" in payload) patch.questions = payload.questions ?? [];
  if ("steps" in payload) patch.steps = payload.steps ?? [];
  if ("thesisId" in payload) patch.thesisId = payload.thesisId ?? null;
  if ("conformity" in payload) {
    patch.conformityOk = payload.conformity?.checks.filter((c) => c.ok).length ?? 0;
    patch.conformityTotal = payload.conformity?.checks.length ?? 0;
  }
  set(patch);
}

export const useRescueStore = create<RescueState>((set, get) => ({
  ...INITIAL,

  setNormProfileId: (id) => set({ normProfileId: id }),

  pickAndDiagnose: async (opts) => {
    set({ ...INITIAL, normProfileId: get().normProfileId, status: "picking" });
    // A crash mid-diagnose must not resume the PREVIOUS run.
    void AsyncStorage.removeItem(ACTIVE_KEY).catch(() => {});

    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({ type: [DOCX_MIME], copyToCacheDirectory: true });
    } catch {
      set({ status: "error", errorMessage: "picker" });
      return "error";
    }
    if (picked.canceled || !picked.assets?.[0]) { set({ status: "idle" }); return "canceled"; }
    const asset = picked.assets[0];
    if (!/\.docx$/i.test(asset.name ?? "")) { set({ status: "error", errorMessage: "notDocx" }); return "error"; }

    set({ status: "uploading", fileName: asset.name ?? "document.docx", uploadProgress: 0 });
    opts?.onPicked?.(asset.name ?? "document.docx");

    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      const run = await rescueDiagnose(
        { base64, filename: asset.name ?? "document.docx", normProfileId: get().normProfileId! },
        { onUploadProgress: (f) => set(f >= 1 ? { status: "diagnosing", uploadProgress: 1 } : { uploadProgress: f }) },
      );
      absorb(run, set);
      set({ status: "verdict" });
      // Resume is a convenience; a storage failure must not discard a
      // minutes-long diagnosis that already succeeded.
      void AsyncStorage.setItem(ACTIVE_KEY, run.runId).catch(() => {});
      return "ok";
    } catch (err) {
      set({ status: "error", errorMessage: (err as Error)?.message ?? "diagnose" });
      return "error";
    }
  },

  answerQuestion: (id, choice) =>
    set((s) => ({ answers: { ...s.answers, [id]: choice }, questions: s.questions.filter((q) => q.id !== id) })),

  // PRODUCT RULE: every AI question is dismissible. Dismissed = "not a heading".
  dismissQuestion: (id) =>
    set((s) => ({ answers: { ...s.answers, [id]: { role: "body" } }, questions: s.questions.filter((q) => q.id !== id) })),

  startRepair: async () => {
    const { runId, answers, status: currentStatus } = get();
    if (!runId) return "error";
    // Double-tap guard; a retry from "error" is allowed.
    if (currentStatus === "repairing") return "ok";

    if (Object.keys(answers).length > 0) {
      try {
        const res = await submitRescueAnswers(runId, answers);
        absorb(res, set);
        // Persisted server-side in run.answers now — resubmitting them on a
        // retry would only 409 against a run that already recorded them.
        set({ answers: {} });
      } catch (err) {
        // The run may already be claimed/failed — answers can no longer
        // change it, but the repair itself must still fire; the server
        // merges recorded answers server-side.
        console.warn("[rescue] answers submit failed, continuing to repair", err);
      }
    }

    set({ status: "repairing" });
    try {
      const run = await rescueRepair(runId);
      absorb(run, set);
      await AsyncStorage.removeItem(ACTIVE_KEY);
      set({ status: run.status === "done" ? "done" : "error", errorMessage: run.status === "done" ? null : "repair" });
      return run.status === "done" ? "ok" : "error";
    } catch (err) {
      // apiPostLong decorates every rejection with `.status`/`.code` now (same
      // as apiGet/apiPost), so a bare status check replaces the old
      // message-regex fallback. This mapping applies only to errors thrown by
      // rescueRepair itself — the answers submission above is handled on its
      // own, separate from these codes.
      const status = (err as { status?: number })?.status;
      // A 402 is the paywall, not a failure.
      if (status === 402) {
        set({ status: "payment" });
        return "payment";
      }
      // A 409 (repair_in_progress) means a repair on this run is already under
      // way — e.g. a retried request after a dropped connection. Not an
      // error: keep polling, the working screen's refresh() will see it finish.
      if (status === 409) {
        set({ status: "repairing" });
        return "ok";
      }
      // A 410 (source_expired) means the uploaded source behind this run was
      // swept — diagnose results are ephemeral. There is nothing left to repair.
      if (status === 410) {
        set({ status: "error", errorMessage: "expired" });
        return "error";
      }
      set({ status: "error", errorMessage: (err as Error)?.message ?? "repair" });
      return "error";
    }
  },

  refresh: async () => {
    const { runId } = get();
    if (!runId) return;
    try {
      const run = await getRescueRun(runId);
      absorb(run, set);
      if (run.status === "failed") {
        set({ status: "error", errorMessage: "repair" });
        await AsyncStorage.removeItem(ACTIVE_KEY).catch(() => {});
        return;
      }
      if (run.status === "done") { set({ status: "done" }); await AsyncStorage.removeItem(ACTIVE_KEY); }
    } catch (err) {
      // A swept run — stop polling a ghost.
      if ((err as { status?: number })?.status === 404) {
        set({ status: "error", errorMessage: "repair" });
        await AsyncStorage.removeItem(ACTIVE_KEY).catch(() => {});
      }
      // otherwise: polling is best-effort; the long POST is the source of truth
    }
  },

  resume: async () => {
    const saved = await AsyncStorage.getItem(ACTIVE_KEY);
    if (!saved) return false;
    try {
      const run = await getRescueRun(saved);
      // The "expired" status is never actually returned here — a swept run's
      // GET 404s into the catch below, which already clears the key. Only
      // "failed" is a live 200 response worth checking for.
      if (run.status === "failed") { await AsyncStorage.removeItem(ACTIVE_KEY); return false; }
      absorb(run, set);
      set({ status: run.status === "done" ? "done" : run.status === "repairing" ? "repairing" : "verdict" });
      return true;
    } catch {
      // A swept run 404s here — it must not haunt every cold start, so the
      // stale pointer is cleared on the error path too, not just on success.
      await AsyncStorage.removeItem(ACTIVE_KEY);
      return false;
    }
  },

  reset: () => { void AsyncStorage.removeItem(ACTIVE_KEY); set({ ...INITIAL }); },
}));
