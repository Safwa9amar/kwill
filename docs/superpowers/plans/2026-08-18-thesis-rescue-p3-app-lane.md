# Thesis Rescue P3 — The App Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The five-tap rescue lane in the Expo app: drawer → pick .docx → pick faculty → free verdict → (pay) → questions → live progress → result with Download / Open in editor / Undo. Requires P2 deployed (or running locally).

**Architecture:** One Zustand store (`rescue-store`) drives four screens under `app/(app)/`. Diagnose and repair are long POSTs (`apiPostLong`); progress during repair is polled via `GET /api/rescue/:id` every 2s and fed to the existing `ProcessingSteps` component from the plan's real step list. A 402 from repair routes to the subscription screen. The active runId survives cold start in AsyncStorage.

**Spec deviation (recorded):** the spec's before/after PDF preview on the result screen is DEFERRED — the OnlyOffice PDF view exists only inside the workspace (`components/workspace/PdfView.tsx`), so "Open in the editor" is the preview path for now. The result screen ships conformity + download + editor + undo.

**Tech Stack:** Expo v56 (read https://docs.expo.dev/versions/v56.0.0/ before writing code), expo-router, Zustand (SELECT PRIMITIVES — never a fresh object literal), `useThemeColors()`, trilingual ar/fr/en (locale JSONs have duplicate keys — edit surgically, NEVER round-trip). Repo: `~/modakerati`. Gate: `npx tsc --noEmit` (no test runner in this repo).

---

### Task 1: API client

**Files:**
- Modify: `lib/api.ts` (append near the import/combine section, after `formatThesis` ~line 1075)

- [ ] **Step 1: Add types + four functions**

```ts
// ============================================================
// Rescue lane API — mirrors the server DTOs from /api/rescue/*.
// Diagnosis is FREE and creates no thesis; repair 402s on the free plan.
// ============================================================

export type RescueStepId =
  | "snapshot" | "clean" | "structure" | "norms"
  | "sections-numbering" | "pagination" | "captions" | "apparatus" | "finish";

export interface RescueStep {
  id: RescueStepId;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error?: string;
}

export interface RescueVerdictIssue {
  code: string;
  severity: "error" | "warning" | "info";
  count: number;
  message: string;
}

export interface RescueVerdict { issues: RescueVerdictIssue[]; total: number }

export interface RescueQuestion {
  id: string;
  index: number;
  textHead: string;
  before: string;
  after: string;
  suggested: { role: string; level?: number };
  choices: Array<{ role: string; level?: number }>;
}

export interface RescueConformityCheck { code: string; ok: boolean; detail: string }

export interface RescueRun {
  runId: string;
  status: "diagnosing" | "diagnosed" | "repairing" | "done" | "failed" | "expired";
  degraded: boolean;
  verdict: RescueVerdict | null;
  questions: RescueQuestion[];
  steps: RescueStep[];
  thesisId?: string | null;
  conformity?: { checks: RescueConformityCheck[]; degraded: boolean } | null;
}

export async function rescueDiagnose(
  input: { base64: string; filename: string; normProfileId: string },
  opts?: LongPostOptions,
): Promise<RescueRun> {
  // Minutes on a real thesis: upload + parse + one windowed AI pass.
  return apiPostLong("/api/rescue/diagnose", input, opts);
}

export async function getRescueRun(runId: string): Promise<RescueRun> {
  return apiGet(`/api/rescue/${runId}`);
}

export async function submitRescueAnswers(
  runId: string,
  answers: Record<string, { role: string; level?: number }>,
): Promise<Pick<RescueRun, "runId" | "questions" | "steps">> {
  return apiPost(`/api/rescue/${runId}/answers`, { answers });
}

export async function rescueRepair(runId: string, opts?: LongPostOptions): Promise<RescueRun> {
  // The longest call in the lane — the whole FormatPlan runs inside it.
  return apiPostLong(`/api/rescue/${runId}/repair`, {}, opts);
}
```

- [ ] **Step 2: Typecheck.** `cd ~/modakerati && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/modakerati && git add lib/api.ts && git commit -m "feat(rescue): API client — diagnose, run read, answers, repair"
```

---

### Task 2: The store

**Files:**
- Create: `stores/rescue-store.ts`

Model it on `stores/import-store.ts` (picker + base64 read + progress callbacks) — same DocumentPicker flow, same `onPicked` hook so the caller can navigate before the slow part.

- [ ] **Step 1: Implement**

```ts
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
  type RescueRun, type RescueQuestion, type RescueStep, type RescueVerdict,
} from "@/lib/api";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ACTIVE_KEY = "rescue.activeRunId";

export type RescueStatus =
  | "idle" | "picking" | "uploading" | "diagnosing"
  | "verdict" | "questions" | "repairing" | "done" | "payment" | "error";

interface RescueState {
  status: RescueStatus;
  runId: string | null;
  fileName: string | null;
  normProfileId: string | null;
  uploadProgress: number;
  verdict: RescueVerdict | null;
  degraded: boolean;
  questions: RescueQuestion[];
  answers: Record<string, { role: string; level?: number }>;
  steps: RescueStep[];
  thesisId: string | null;
  conformityOk: number;
  conformityTotal: number;
  errorMessage: string | null;

  setNormProfileId: (id: string | null) => void;
  /** onPicked fires the moment a valid .docx is chosen — navigate THEN. */
  pickAndDiagnose: (opts?: { onPicked?: (fileName: string) => void }) => Promise<"ok" | "canceled" | "error">;
  answerQuestion: (id: string, choice: { role: string; level?: number }) => void;
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
  answers: {} as Record<string, { role: string; level?: number }>,
  steps: [] as RescueStep[],
  thesisId: null as string | null,
  conformityOk: 0,
  conformityTotal: 0,
  errorMessage: null as string | null,
};

function absorb(run: RescueRun, set: (p: Partial<RescueState>) => void): void {
  set({
    runId: run.runId,
    verdict: run.verdict ?? null,
    degraded: run.degraded,
    questions: run.questions ?? [],
    steps: run.steps ?? [],
    thesisId: run.thesisId ?? null,
    conformityOk: run.conformity?.checks.filter((c) => c.ok).length ?? 0,
    conformityTotal: run.conformity?.checks.length ?? 0,
  });
}

export const useRescueStore = create<RescueState>((set, get) => ({
  ...INITIAL,

  setNormProfileId: (id) => set({ normProfileId: id }),

  pickAndDiagnose: async (opts) => {
    set({ ...INITIAL, normProfileId: get().normProfileId, status: "picking" });

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
      await AsyncStorage.setItem(ACTIVE_KEY, run.runId);
      set({ status: "verdict" });
      return "ok";
    } catch (err: any) {
      set({ status: "error", errorMessage: err?.message ?? "diagnose" });
      return "error";
    }
  },

  answerQuestion: (id, choice) =>
    set((s) => ({ answers: { ...s.answers, [id]: choice }, questions: s.questions.filter((q) => q.id !== id) })),

  // PRODUCT RULE: every AI question is dismissible. Dismissed = "not a heading".
  dismissQuestion: (id) =>
    set((s) => ({ answers: { ...s.answers, [id]: { role: "body" } }, questions: s.questions.filter((q) => q.id !== id) })),

  startRepair: async () => {
    const { runId, answers } = get();
    if (!runId) return "error";
    try {
      if (Object.keys(answers).length > 0) {
        const res = await submitRescueAnswers(runId, answers);
        set({ questions: res.questions ?? [], steps: res.steps ?? [] });
      }
      set({ status: "repairing" });
      const run = await rescueRepair(runId);
      absorb(run, set);
      await AsyncStorage.removeItem(ACTIVE_KEY);
      set({ status: run.status === "done" ? "done" : "error", errorMessage: run.status === "done" ? null : "repair" });
      return run.status === "done" ? "ok" : "error";
    } catch (err: any) {
      // A 402 is the paywall, not a failure.
      if (err?.status === 402 || /402|payment_required/.test(err?.message ?? "")) {
        set({ status: "payment" });
        return "payment";
      }
      set({ status: "error", errorMessage: err?.message ?? "repair" });
      return "error";
    }
  },

  refresh: async () => {
    const { runId } = get();
    if (!runId) return;
    try {
      const run = await getRescueRun(runId);
      absorb(run, set);
      if (run.status === "done") { set({ status: "done" }); await AsyncStorage.removeItem(ACTIVE_KEY); }
    } catch { /* polling is best-effort; the long POST is the source of truth */ }
  },

  resume: async () => {
    const saved = await AsyncStorage.getItem(ACTIVE_KEY);
    if (!saved) return false;
    try {
      const run = await getRescueRun(saved);
      if (run.status === "expired" || run.status === "failed") { await AsyncStorage.removeItem(ACTIVE_KEY); return false; }
      absorb(run, set);
      set({ status: run.status === "done" ? "done" : run.status === "repairing" ? "repairing" : "verdict" });
      return true;
    } catch { return false; }
  },

  reset: () => { void AsyncStorage.removeItem(ACTIVE_KEY); set({ ...INITIAL }); },
}));
```

⚠️ Check how `apiPost` surfaces HTTP status in this codebase (lib/api.ts error construction) and make the 402 detection match it exactly — if errors carry `status`, drop the message-regex fallback.

⚠️ Verify `@react-native-async-storage/async-storage` is already a dependency (`grep async-storage package.json`); it is used elsewhere in the app — if the import path differs, copy it from an existing store.

- [ ] **Step 2: Typecheck.** `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/modakerati && git add stores/rescue-store.ts && git commit -m "feat(rescue): store — pick, free diagnose, dismissible answers, paid repair, cold-start resume"
```

---

### Task 3: Screens — verdict + questions

**Files:**
- Create: `app/(app)/rescue-verdict.tsx`
- Create: `app/(app)/rescue-questions.tsx`

Both follow the house pattern of `app/(app)/import-analysis.tsx`: `SafeAreaView` from `react-native-safe-area-context`, `useThemeColors()`, `useTranslation()`, `BackButton`, primitives-only selectors. RTL: user-facing strings come from i18n (Task 5 keys); question text is the student's own and renders with `writingDirection` derived per-string — reuse the helper the chat uses (`lib/rtl-layout.ts`).

- [ ] **Step 1: Verdict screen**

```tsx
// app/(app)/rescue-verdict.tsx
// The free diagnosis — the sales pitch. "مذكرتك بها N مخالفة لمعايير كليتك"
// with the issue list; the CTA starts the paid repair (or routes to payment).
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescueStore } from "@/stores/rescue-store";
import { BackButton } from "@/components/BackButton";
import { AlertCircle, AlertTriangle, Info, Wrench } from "lucide-react-native";

const SEVERITY = { error: "#EF4444", warning: "#F59E0B", info: "#3B82F6" } as const;

export default function RescueVerdictScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const total = useRescueStore((s) => s.verdict?.total ?? 0);
  const issues = useRescueStore((s) => s.verdict?.issues ?? []);
  const degraded = useRescueStore((s) => s.degraded);
  const questionCount = useRescueStore((s) => s.questions.length);
  const startRepair = useRescueStore((s) => s.startRepair);

  const onRepair = async () => {
    if (questionCount > 0) { router.push("/(app)/rescue-questions" as any); return; }
    router.push("/(app)/rescue-working" as any);
    const res = await startRepair();
    if (res === "payment") router.replace("/(app)/subscription" as any);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.header}><BackButton /></View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.big, { color: colors.textPrimary }]}>
          {total === 0 ? t("rescue.verdictClean") : t("rescue.verdictTitle", { count: total })}
        </Text>
        {degraded ? (
          <Text style={[styles.note, { color: colors.textSecondary }]}>{t("rescue.degraded")}</Text>
        ) : null}
        <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
          {issues.map((issue) => {
            const Icon = issue.severity === "error" ? AlertCircle : issue.severity === "warning" ? AlertTriangle : Info;
            return (
              <View key={issue.code} style={styles.row}>
                <Icon size={18} color={SEVERITY[issue.severity]} />
                <Text style={[styles.rowText, { color: colors.textPrimary }]}>
                  {t(`rescue.issue.${issue.code}`, { count: issue.count, defaultValue: issue.message })}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Pressable onPress={onRepair} style={[styles.cta, { backgroundColor: colors.accentPrimary }]}>
          <Wrench size={18} color="#fff" />
          <Text style={styles.ctaText}>{t(total === 0 ? "rescue.formatAnyway" : "rescue.repairCta")}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 },
  body: { padding: 20, gap: 16 },
  big: { fontSize: 24, fontWeight: "700", textAlign: "center" },
  note: { fontSize: 13, textAlign: "center" },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 12 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  rowText: { flex: 1, fontSize: 14, lineHeight: 20 },
  footer: { padding: 16 },
  cta: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", borderRadius: 14, paddingVertical: 14 },
  ctaText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
```

⚠️ `colors.accentPrimary` etc.: check the actual token names in `hooks/useThemeColors` and use the ones the neighbouring screens use (import-analysis uses `colors.bgCard`, `colors.borderDefault`, `colors.textPrimary`). Never hardcode beyond the severity triad already used by import-analysis.

- [ ] **Step 2: Questions screen** — a card stack; every card dismissible (skip = safest default):

```tsx
// app/(app)/rescue-questions.tsx
// The ~5 genuinely ambiguous calls. Answering or dismissing pops the card;
// dismissal means "not a heading" (a false heading poisons the TOC — a missed
// one is a line the student can promote later). PRODUCT RULE: dismissible.
import { useEffect } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescueStore } from "@/stores/rescue-store";
import { BackButton } from "@/components/BackButton";

export default function RescueQuestionsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const questions = useRescueStore((s) => s.questions);
  const answerQuestion = useRescueStore((s) => s.answerQuestion);
  const dismissQuestion = useRescueStore((s) => s.dismissQuestion);
  const startRepair = useRescueStore((s) => s.startRepair);

  const q = questions[0];

  const launch = async () => {
    router.replace("/(app)/rescue-working" as any);
    const res = await startRepair();
    if (res === "payment") router.replace("/(app)/subscription" as any);
  };

  // "Skip the rest" RECORDS the safe default for every remaining card — the
  // difference between skipped and lost.
  const skipAll = () => {
    for (const qq of useRescueStore.getState().questions) dismissQuestion(qq.id);
  };

  // All cards answered/dismissed → go. In an effect, not in render.
  useEffect(() => {
    if (questions.length === 0) void launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions.length]);

  if (!q) return null;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.header}>
        <BackButton />
        <Text style={[styles.progress, { color: colors.textSecondary }]}>
          {t("rescue.questionsLeft", { count: questions.length })}
        </Text>
      </View>
      <View style={styles.body}>
        <Text style={[styles.ask, { color: colors.textPrimary }]}>{t("rescue.isThisAHeading")}</Text>
        <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
          <Text style={[styles.ctx, { color: colors.textSecondary }]} numberOfLines={1}>{q.before}</Text>
          <Text style={[styles.target, { color: colors.textPrimary }]}>{q.textHead}</Text>
          <Text style={[styles.ctx, { color: colors.textSecondary }]} numberOfLines={1}>{q.after}</Text>
        </View>
        <View style={styles.choices}>
          {q.choices.map((c, i) => (
            <Pressable key={i} onPress={() => answerQuestion(q.id, c)}
              style={[styles.choice, { borderColor: colors.borderDefault, backgroundColor: colors.bgCard }]}>
              <Text style={{ color: colors.textPrimary }}>
                {c.role === "heading" ? t(`rescue.headingLevel${c.level ?? 2}`) : t(`rescue.role.${c.role}`)}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={() => dismissQuestion(q.id)} style={styles.skip}>
            <Text style={{ color: colors.textSecondary }}>{t("rescue.notAHeading")}</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.footer}>
        <Pressable onPress={skipAll}>
          <Text style={{ color: colors.textSecondary, textAlign: "center" }}>{t("rescue.skipAll")}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8 },
  progress: { fontSize: 13 },
  body: { flex: 1, padding: 20, gap: 16, justifyContent: "center" },
  ask: { fontSize: 18, fontWeight: "600", textAlign: "center" },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 8 },
  ctx: { fontSize: 12 },
  target: { fontSize: 16, fontWeight: "700" },
  choices: { gap: 10 },
  choice: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, alignItems: "center" },
  skip: { padding: 12, alignItems: "center" },
  footer: { padding: 16 },
});
```

- [ ] **Step 3: Typecheck.** `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
cd ~/modakerati && git add "app/(app)/rescue-verdict.tsx" "app/(app)/rescue-questions.tsx" && git commit -m "feat(rescue): verdict + dismissible question cards"
```

---

### Task 4: Screens — working + result, drawer wiring

**Files:**
- Create: `app/(app)/rescue-working.tsx`
- Create: `app/(app)/rescue-result.tsx`
- Modify: `components/AppDrawer.tsx` (~line 224: the import row's handler)

- [ ] **Step 1: Working screen** — `ProcessingSteps` fed by the plan's REAL steps, polled every 2s:

```tsx
// app/(app)/rescue-working.tsx
// Live progress from the ACTUAL FormatPlan — never a fake bar. The long POST
// does the work; this screen just watches the plan's status board.
import { useEffect } from "react";
import { View, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescueStore } from "@/stores/rescue-store";
import { ProcessingSteps, type ProcessingStep } from "@/components/ProcessingSteps";

export default function RescueWorkingScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const status = useRescueStore((s) => s.status);
  const steps = useRescueStore((s) => s.steps);
  const fileName = useRescueStore((s) => s.fileName);
  const refresh = useRescueStore((s) => s.refresh);

  useEffect(() => {
    if (status !== "repairing" && status !== "diagnosing" && status !== "uploading") return;
    const id = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(id);
  }, [status, refresh]);

  useEffect(() => {
    if (status === "done") router.replace("/(app)/rescue-result" as any);
    if (status === "error") router.back();
  }, [status, router]);

  const visible: ProcessingStep[] = steps
    .filter((s) => s.status !== "skipped")
    .map((s) => ({
      key: s.id,
      label: t(`rescue.step.${s.id}`),
      status: s.status === "done" ? "done" : s.status === "running" ? "active" : "pending",
    }));

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.body}>
        <ProcessingSteps title={t("rescue.workingTitle")} subtitle={fileName ?? ""} steps={visible} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 }, body: { flex: 1, justifyContent: "center", padding: 20 } });
```

⚠️ Check `ProcessingStep`'s real shape at `components/ProcessingSteps.tsx:11` — the `key/label/status` names above are from its usage in import-analysis; mirror the actual interface. A `failed` server step maps to `done` here plus a note on the result screen — the progress list is not where a student debugs.

- [ ] **Step 2: Result screen**

```tsx
// app/(app)/rescue-result.tsx
// Download is the hero — the deadline student's exit. Open-in-editor is the
// quiet door into Kwill. Undo restores the pre-formatting snapshot (never gated).
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescueStore } from "@/stores/rescue-store";
import { useThesisStore } from "@/stores/thesis-store";
import { undoThesisHistory } from "@/lib/api";
import { CheckCircle, Download, PenLine, Undo2 } from "lucide-react-native";

export default function RescueResultScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const thesisId = useRescueStore((s) => s.thesisId);
  const ok = useRescueStore((s) => s.conformityOk);
  const total = useRescueStore((s) => s.conformityTotal);
  const reset = useRescueStore((s) => s.reset);

  const openThesis = (route: string) => {
    if (!thesisId) return;
    useThesisStore.getState().setCurrentThesis(thesisId);
    router.replace(route as any);
  };

  const onUndo = () => {
    if (!thesisId) return;
    Alert.alert(t("rescue.undoTitle"), t("rescue.undoBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("rescue.undoConfirm"), style: "destructive",
        onPress: async () => { await undoThesisHistory(thesisId); reset(); router.back(); } },
    ]);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.body}>
        <CheckCircle size={56} color="#22C55E" />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescue.doneTitle")}</Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {t("rescue.conformity", { ok, total })}
        </Text>
        <Pressable onPress={() => openThesis("/(app)/export")}
          style={[styles.cta, { backgroundColor: colors.accentPrimary }]}>
          <Download size={18} color="#fff" />
          <Text style={styles.ctaText}>{t("rescue.download")}</Text>
        </Pressable>
        <Pressable onPress={() => openThesis("/(app)/thesis-workspace")} style={styles.secondary}>
          <PenLine size={16} color={colors.textPrimary} />
          <Text style={{ color: colors.textPrimary }}>{t("rescue.openEditor")}</Text>
        </Pressable>
        <Pressable onPress={onUndo} style={styles.secondary}>
          <Undo2 size={16} color={colors.textSecondary} />
          <Text style={{ color: colors.textSecondary }}>{t("rescue.undo")}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 },
  title: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  sub: { fontSize: 14, textAlign: "center" },
  cta: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", borderRadius: 14, paddingVertical: 14, paddingHorizontal: 28, alignSelf: "stretch", marginTop: 10 },
  ctaText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondary: { flexDirection: "row", gap: 8, alignItems: "center", padding: 10 },
});
```

⚠️ Check the export screen's expectations (`app/(app)/export.tsx`): if it reads a thesis id from params rather than the store, pass it the way its other callers do (`grep -rn "export'" app components | grep push`).

- [ ] **Step 3: Drawer wiring** — in `components/AppDrawer.tsx`, the import row (~line 224) currently calls `store.pickAndImport` → `import-analysis`. Point it at the rescue lane; the old flow stays for anything else that links to it:

```tsx
// Before (inside handleImport):
//   const result = await store.pickAndImport({ onPicked: () => router.push("/(app)/import-analysis" as any) });
// After — the rescue lane replaces the destination:
const store = useRescueStore.getState();
const result = await store.pickAndDiagnose({
  onPicked: () => { router.push("/(app)/rescue-working" as any); },
});
if (result === "ok") router.replace("/(app)/rescue-verdict" as any);
else if (result === "error") {
  Alert.alert(t("rescue.title"), t(`rescue.error.${useRescueStore.getState().errorMessage ?? "generic"}`, { defaultValue: t("thesis.genericError") }));
}
```

**Norm profile first.** The server refuses a diagnose without one, so the drawer routes to a tiny picker BEFORE the document picker. The chip pattern and the data both already exist — `app/(app)/combine-arrange.tsx:239-247` renders `useThesisStore((s) => s.normProfiles)` as tappable chips. Create:

```tsx
// app/(app)/rescue-norms.tsx
// One question before the file: which faculty's norms? Same chip list the
// combine flow uses (combine-arrange.tsx) — the profiles are already in
// thesis-store. Picking one launches the document picker immediately.
import { View, Text, ScrollView, Pressable, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useThesisStore } from "@/stores/thesis-store";
import { useRescueStore } from "@/stores/rescue-store";
import { BackButton } from "@/components/BackButton";

export default function RescueNormsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const normProfiles = useThesisStore((s) => s.normProfiles);

  const pick = async (id: string) => {
    const store = useRescueStore.getState();
    store.setNormProfileId(id);
    const result = await store.pickAndDiagnose({
      onPicked: () => router.replace("/(app)/rescue-working" as any),
    });
    if (result === "ok") router.replace("/(app)/rescue-verdict" as any);
    else if (result === "error") {
      Alert.alert(t("rescue.title"),
        t(`rescue.error.${useRescueStore.getState().errorMessage ?? "generic"}`, { defaultValue: t("thesis.genericError") }));
      router.back();
    }
    // canceled: stay here — the student can re-pick or back out.
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.header}><BackButton /></View>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescue.pickNorms")}</Text>
      <ScrollView contentContainerStyle={styles.list}>
        {normProfiles.map((np) => (
          <Pressable key={np.id} onPress={() => pick(np.id)}
            style={[styles.chip, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
            <Text style={{ color: colors.textPrimary }}>{np.name}</Text>
            {np.university ? <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{np.university}</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 },
  title: { fontSize: 20, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  list: { padding: 16, gap: 10 },
  chip: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 2 },
});
```

⚠️ Check the norm-profile row shape on `useThesisStore` (`grep -n "normProfiles" stores/thesis-store.ts`) — `combine-arrange.tsx` shows the fields it really has; mirror it. If the store lazy-loads them, trigger the same loader combine-arrange uses on mount.

The drawer's import row then simply routes here (replacing the Step 3 handler above — the picker now starts from this screen):

```tsx
{ key: "import", icon: FolderUp, label: t("rescue.title"), onPress: () => go(() => router.push("/(app)/rescue-norms" as any)) },
```

Add `app/(app)/rescue-norms.tsx` to this task's commit.

- [ ] **Step 4: Typecheck.** `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
cd ~/modakerati && git add "app/(app)/rescue-working.tsx" "app/(app)/rescue-result.tsx" components/AppDrawer.tsx && git commit -m "feat(rescue): working + result screens; drawer import row enters the rescue lane"
```

---

### Task 5: i18n — ar / fr / en

**Files:**
- Modify: `locales/ar.json`, `locales/fr.json`, `locales/en.json` (⚠️ find the exact paths with `ls locales i18n 2>/dev/null` / `grep -rn "importDocx" --include="*.json" .` — follow where `home.importDocx` lives)

⚠️ These files contain ~155 duplicate keys each. **Edit surgically with a text editor — NEVER json.load/json.dump, never jq.** Insert the block right after the existing `"import"` block's closing brace, at the same nesting level.

- [ ] **Step 1: Add the `rescue` block to each file.** English (translate faithfully for fr/ar; Arabic is the primary audience — write it first, natural Algerian academic register):

```json
"rescue": {
  "title": "Rescue my thesis",
  "pickNorms": "Which faculty's norms?",
  "verdictTitle": "Your thesis has {{count}} issues against your faculty's norms",
  "verdictClean": "Your thesis already matches your faculty's norms",
  "degraded": "Some checks ran in reduced mode — the AI reader was unavailable.",
  "repairCta": "Fix it all",
  "formatAnyway": "Format it anyway",
  "questionsLeft": "{{count}} questions",
  "isThisAHeading": "Is this a chapter or section title?",
  "headingLevel1": "Chapter title (الفصل)",
  "headingLevel2": "Section title (المبحث)",
  "headingLevel3": "Sub-section (المطلب)",
  "notAHeading": "Not a title — leave it",
  "skipAll": "Skip the rest — use the safe defaults",
  "workingTitle": "Formatting your thesis…",
  "step": {
    "snapshot": "Saving a restore point",
    "clean": "Removing typed page numbers",
    "structure": "Rebuilding the structure",
    "norms": "Applying your faculty's norms",
    "sections-numbering": "Numbering the pages",
    "pagination": "Fixing page breaks",
    "captions": "Converting captions",
    "apparatus": "Building the table of contents",
    "finish": "Final checks"
  },
  "issue": {
    "headings-not-real": "{{count}} titles are not real Word headings",
    "noise-blocks": "{{count}} typed page numbers to remove",
    "wrong-font": "Wrong body font",
    "wrong-font-size": "Wrong font size",
    "wrong-spacing": "Wrong line spacing",
    "no-real-toc": "No automatic table of contents",
    "typed-captions": "{{count}} captions typed by hand",
    "missing-list-of-figures": "No list of figures",
    "missing-list-of-tables": "No list of tables"
  },
  "doneTitle": "Your thesis is ready",
  "conformity": "{{ok}} of {{total}} checks passed",
  "download": "Download the .docx",
  "openEditor": "Open in the editor",
  "undo": "Undo the formatting",
  "undoTitle": "Undo everything?",
  "undoBody": "The document returns to exactly how it was before formatting.",
  "undoConfirm": "Undo",
  "error": { "picker": "Could not open the file picker", "notDocx": "Please choose a .docx file", "generic": "Something went wrong" }
}
```

- [ ] **Step 2: Verify no key was lost** — the surgical-edit check:

```bash
cd ~/modakerati && git diff --stat locales/ && git diff locales/ | grep -c "^-" 
# expect: only ADDED lines (the grep count of removed lines = 0, or exactly the
# context-free minimum if a trailing comma moved). Eyeball the full diff.
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit && git add locales/ && git commit -m "feat(rescue): trilingual strings for the rescue lane"
```

---

### Task 6: Gate + finish

- [ ] **Step 1: Full typecheck.** `cd ~/modakerati && npx tsc --noEmit` — green.

- [ ] **Step 2: `node scripts/verify-use-dom.mjs`** — only if any screen ended up using a `use dom` component (none should).

- [ ] **Step 3: Walk the lane on the dev build against the local server** (the user tests on their own device — do NOT claim it works beyond: tsc green, screens registered, store wired):

Drawer → أصلح مذكرتي → pick a .docx → verdict shows counts → repair (free plan) → lands on subscription screen; (paid plan) → questions → working with real steps → result → Download opens export.

- [ ] **Step 4: Final commit** (anything loose) + STOP. No OTA publish in this plan — release order is commit → build APK → verify fingerprint → publish, and it is the user's call.

---

## Done means

- The drawer's import row starts the rescue lane; the old import-analysis screen still exists but nothing routes to it from the drawer.
- Free plan: verdict is reachable, repair bounces to subscription. Paid: full lane to a downloadable, undoable thesis.
- Every question card is dismissible; "skip all" records the safe default for every remaining card.
- `npx tsc --noEmit` green; locale diffs are pure additions.
