import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl, Alert } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { BackButton } from "@/components/BackButton";
import { TaskRow } from "@/components/tasks/TaskRow";
import { getRun, decideAllProposals, undoRun, type TaskRun, type TaskItem, type TaskProposal } from "@/lib/tasks-api";
import { useTasksStore } from "@/stores/tasks-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { TASKS_ENABLED } from "@/lib/tasks-enabled";

/**
 * What one run did. Owns the things the document itself cannot show: what was
 * applied, what is waiting, what failed and WHY, and cancelling a run that is
 * still going.
 *
 * Reviewing a proposal happens in the WRITER, not here: a rewrite is only
 * judgeable with the page around it. This screen is the way in — it counts
 * what is waiting, hands the student over to the document, and owns the two
 * things the document cannot do: deciding them all at once, and undoing the
 * whole run.
 *
 * ⚠️ The route is CLOSED — see lib/tasks-enabled.ts and the note on the Tasks
 * screen's own guard. Everything below survives intact behind it.
 */
export default function TaskRunScreen() {
  if (!TASKS_ENABLED) return <Redirect href={"/(app)/chat" as any} />;
  return <TaskRunScreenInner />;
}

function TaskRunScreenInner() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { textAlign, flexDirection } = useRTL();
  const bottomPad = useSafeAreaInsets().bottom + 24;
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const router = useRouter();
  const cancel = useTasksStore((s) => s.cancel);

  const [run, setRun] = useState<TaskRun | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [proposals, setProposals] = useState<TaskProposal[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [working, setWorking] = useState(false);

  /**
   * Runs one action, then refreshes. Every call here can fail on the network,
   * and an async onPress that throws in React Native fails SILENTLY — which is
   * precisely what made these buttons look dead. A failure now says so, and an
   * action that legitimately changed nothing says that too rather than leaving
   * the student tapping a button that appears broken.
   */
  const act = useCallback(
    async (fn: () => Promise<string | null>) => {
      setWorking(true);
      try {
        const note = await fn();
        if (note) Alert.alert("", note);
      } catch (e: unknown) {
        Alert.alert(
          t("common.somethingWrong", { defaultValue: "Something went wrong" }),
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        setWorking(false);
        void fetchRunRef.current?.();
      }
    },
    [t],
  );

  const fetchRun = useCallback(async () => {
    if (!runId) return;
    try {
      const r = await getRun(runId);
      setRun(r.run);
      setTasks(r.tasks);
      setProposals(r.proposals);
    } catch {
      // Keep whatever is on screen; pull-to-refresh is the retry.
    }
  }, [runId]);

  // `act` is defined above fetchRun so the handlers can use it; this ref is how
  // it reaches the current fetchRun without a circular dependency.
  const fetchRunRef = useRef<(() => Promise<void>) | null>(null);
  fetchRunRef.current = fetchRun;

  useEffect(() => {
    void fetchRun();
  }, [fetchRun]);

  // A run in flight changes underneath this screen, so poll while it does.
  // Stops the moment it settles — no timer left running on a finished run.
  const live = run?.status === "running" || run?.status === "cancelling";
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void fetchRun(), 5000);
    return () => clearInterval(id);
  }, [live, fetchRun]);

  const pending = proposals.filter((p) => p.status === "pending").length;

  const summaryLine = live
    ? t("tasks.running")
    : [
        (run?.summary?.applied ?? 0) > 0 ? `${run?.summary?.applied} ${t("tasks.done")}` : null,
        pending > 0 ? `${pending} ${t("tasks.waitingForYou")}` : null,
        (run?.summary?.failed ?? 0) > 0 ? `${run?.summary?.failed} ${t("tasks.failed")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={[styles.header, { flexDirection }]}>
        <BackButton />
        <Text style={[styles.title, { color: colors.textPrimary, textAlign }]}>{t("tasks.title")}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomPad }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await fetchRun();
              setRefreshing(false);
            }}
            tintColor={colors.textSecondary}
          />
        }
      >
        {run ? (
          <View style={[styles.summary, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
            <Text style={[styles.summaryText, { color: colors.textPrimary, textAlign }]}>{summaryLine}</Text>
            {/* Honest about the ways a run can end short of its list. */}
            {run.summary?.stoppedForBudget ? (
              <Text style={[styles.note, { color: colors.semanticWarning, textAlign }]}>{t("tasks.stoppedEarly")}</Text>
            ) : null}
            {run.summary?.lateMinutes ? (
              <Text style={[styles.note, { color: colors.textSecondary, textAlign }]}>{t("tasks.ranLate")}</Text>
            ) : null}
            {run.status === "cancelling" ? (
              <Text style={[styles.note, { color: colors.textSecondary, textAlign }]}>{t("tasks.cancelling")}</Text>
            ) : null}
          </View>
        ) : null}

        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}

        {run && pending > 0 ? (
          <>
            {/* The report counts; the document reviews. Tapping through is the
                whole point — a rewrite is only judgeable in context. */}
            <Pressable
              onPress={() =>
                // navigate, NOT push: the Writer is normally already in the
                // stack, and pushing a second copy remounts it and reloads the
                // document — which is exactly when proposals have no blocks to
                // attach to. Returning to the live one lands on a loaded page.
                router.navigate({
                  pathname: "/(app)/thesis-workspace",
                  params: { thesisId: run.thesisId },
                } as any)
              }
              style={[styles.review, { backgroundColor: colors.brandPrimary }]}
            >
              <Text style={{ color: colors.brandOnPrimary, fontWeight: "600" }}>
                {t("tasks.reviewInDocument", { count: pending })}
              </Text>
            </Pressable>

            <View style={[styles.bulkRow, { flexDirection }]}>
              <Pressable
                disabled={working}
                onPress={() =>
                  act(async () => {
                    const n = await decideAllProposals(run.id, "reject");
                    return n === 0 ? t("tasks.nothingWaiting") : null;
                  })
                }
                style={[styles.bulk, { borderColor: colors.borderDefault }]}
              >
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{t("tasks.rejectAll")}</Text>
              </Pressable>

              {/* Approve all must APPLY the text, not just mark the rows
                  accepted — marking them would drop them out of the pending
                  list the Writer hydrates from, and the student would be told
                  "approved" over text that never changed. */}
              <Pressable
                disabled={working}
                onPress={() =>
                  act(async () => {
                    const n = await useTasksStore.getState().approveAllPending(run.thesisId);
                    // Zero here means the proposals could not be matched to a
                    // paragraph — say so instead of reporting a silent success.
                    return n === 0 ? t("tasks.nothingWaiting") : null;
                  })
                }
                style={[styles.bulk, { borderColor: colors.semanticSuccess }]}
              >
                <Text style={{ color: colors.semanticSuccess, fontSize: 13 }}>{t("tasks.approveAll")}</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {run && run.status === "done" && run.historyCheckpoint != null ? (
          <Pressable
            disabled={working}
            onPress={() => {
              // Undo takes back MORE than this run's own edits once proposals
              // have been accepted — those are ordinary text by then. Say so
              // before they tap, not after.
              Alert.alert(t("tasks.undoTitle"), t("tasks.undoBody"), [
                { text: t("common.cancel", { defaultValue: "Cancel" }), style: "cancel" },
                {
                  text: t("tasks.undoConfirm"),
                  style: "destructive",
                  onPress: () =>
                    act(async () => {
                      await undoRun(run.id);
                      await useThesisDocStore.getState().revalidate(run.thesisId);
                      return null;
                    }),
                },
              ]);
            }}
            style={[styles.undo, { borderColor: colors.semanticError }]}
          >
            <Text style={{ color: colors.semanticError, fontWeight: "600" }}>{t("tasks.undoRun")}</Text>
          </Pressable>
        ) : null}

        {run && (run.status === "scheduled" || run.status === "running") ? (
          <Pressable
            onPress={() => void cancel(run.id).then(fetchRun)}
            style={[styles.cancel, { borderColor: colors.semanticError }]}
          >
            <Text style={{ color: colors.semanticError, fontWeight: "600" }}>{t("tasks.cancel")}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  title: { fontSize: 20, fontWeight: "700", flex: 1 },
  summary: { padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 14 },
  summaryText: { fontSize: 14, fontWeight: "600" },
  note: { fontSize: 12, marginTop: 6 },
  cancel: { marginTop: 18, paddingVertical: 14, borderRadius: 12, borderWidth: 1, alignItems: "center" },
  review: { paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 6 },
  bulkRow: { gap: 8, marginTop: 8 },
  bulk: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, alignItems: "center" },
  undo: { marginTop: 18, paddingVertical: 14, borderRadius: 12, borderWidth: 1, alignItems: "center" },
});
