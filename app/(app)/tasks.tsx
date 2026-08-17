import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { BackButton } from "@/components/BackButton";
import { ZoomFromOrigin } from "@/components/ZoomFromOrigin";
import { TasksSkeleton } from "@/components/skeletons/TasksSkeleton";
import { TaskRow } from "@/components/tasks/TaskRow";
import { JobPickerSheet } from "@/components/tasks/JobPickerSheet";
import { ScheduleSheet } from "@/components/tasks/ScheduleSheet";
import { useTasksStore, needsYou } from "@/stores/tasks-store";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { AlertTriangle, Plus, Clock } from "lucide-react-native";
import { TASKS_ENABLED } from "@/lib/tasks-enabled";

/**
 * ⚠️ The route is CLOSED — see lib/tasks-enabled.ts.
 *
 * A guard rather than a deleted file: a link can still be in flight (a
 * notification tap for a run queued before the switch, a stale deep link), and
 * it should land on the chat rather than on a screen whose "add task" button no
 * longer leads anywhere. The screen below is untouched and comes back whole the
 * moment the flag flips — its hooks never run while this returns first.
 */
export default function TasksScreen() {
  if (!TASKS_ENABLED) return <Redirect href={"/(app)/chat" as any} />;
  return <TasksScreenInner />;
}

function TasksScreenInner() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const { textAlign, flexDirection } = useRTL();
  const bottomPad = useSafeAreaInsets().bottom + 24;
  const { thesisId } = useLocalSearchParams<{ thesisId: string }>();

  // Select PRIMITIVES — a fresh object literal here throws "Maximum update depth".
  const jobs = useTasksStore((s) => s.jobs);
  const tasks = useTasksStore((s) => s.tasks);
  const runs = useTasksStore((s) => s.runs);
  const loading = useTasksStore((s) => s.loading);
  const busy = useTasksStore((s) => s.busy);
  const failed = useTasksStore((s) => s.failed);
  const load = useTasksStore((s) => s.load);
  const add = useTasksStore((s) => s.add);
  const remove = useTasksStore((s) => s.remove);
  const schedule = useTasksStore((s) => s.schedule);
  const start = useTasksStore((s) => s.start);

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (thesisId) void load(thesisId);
  }, [thesisId, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (thesisId) await load(thesisId);
    setRefreshing(false);
  }, [thesisId, load]);

  const openRun = (runId: string) =>
    router.push({ pathname: "/(app)/task-run", params: { runId } } as any);

  const attention = needsYou(runs);

  return (
    // Grows out of the chip that opened it, and collapses back into it — the
    // BackButton drives the reverse (see components/ZoomFromOrigin).
    <ZoomFromOrigin backdropColor={colors.bgPrimary}>
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={[styles.header, { flexDirection }]}>
        <BackButton />
        <Text style={[styles.title, { color: colors.textPrimary, textAlign }]}>{t("tasks.title")}</Text>
      </View>

      {loading ? (
        <TasksSkeleton />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomPad }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />
          }
        >
          {/* The server could not be reached. Said out loud rather than left to
              look like an empty queue — those are very different things. */}
          {failed ? (
            <View style={[styles.offline, { backgroundColor: colors.bgCard, borderColor: colors.semanticError }]}>
              <Text style={[styles.offlineText, { color: colors.textPrimary, textAlign }]}>{t("tasks.offline")}</Text>
              <Text style={[styles.offlineHint, { color: colors.textSecondary, textAlign }]}>
                {t("tasks.offlineHint")}
              </Text>
            </View>
          ) : null}

          {/* Only present when something is actually waiting. It collapses away
              rather than sitting there empty. */}
          {attention.length > 0 ? (
            <>
              <Text style={[styles.section, { color: colors.semanticWarning, textAlign }]}>{t("tasks.needsYou")}</Text>
              {attention.map((r) => (
                <Pressable
                  key={r.id}
                  onPress={() => openRun(r.id)}
                  style={[styles.runCard, { flexDirection, backgroundColor: colors.bgCard, borderColor: colors.semanticWarning }]}
                >
                  <AlertTriangle size={16} color={colors.semanticWarning} strokeWidth={2} />
                  <Text style={[styles.runText, { color: colors.textPrimary, textAlign }]}>
                    {(r.summary?.proposed ?? 0) > 0
                      ? `${r.summary?.proposed} ${t("tasks.waitingForYou")}`
                      : `${r.summary?.failed} ${t("tasks.failed")}`}
                  </Text>
                </Pressable>
              ))}
            </>
          ) : null}

          <Text style={[styles.section, { color: colors.textPlaceholder, textAlign }]}>{t("tasks.upNext")}</Text>

          {tasks.length === 0 ? (
            <View style={styles.empty}>
              <Text style={[styles.emptyTitle, { color: colors.textPrimary, textAlign }]}>{t("tasks.empty")}</Text>
              <Text style={[styles.emptyHint, { color: colors.textSecondary, textAlign }]}>{t("tasks.emptyHint")}</Text>
            </View>
          ) : (
            tasks.map((task) => <TaskRow key={task.id} task={task} onRemove={remove} />)
          )}

          <Pressable
            onPress={() => useBottomSheet.getState().openSheet("task-job")}
            style={[styles.addBtn, { flexDirection }]}
          >
            <Plus size={16} color={colors.brandPrimary} strokeWidth={2.2} />
            <Text style={{ color: colors.brandPrimary, fontSize: 13, fontWeight: "600" }}>{t("tasks.addTask")}</Text>
          </Pressable>

          {tasks.length > 0 ? (
            <Pressable
              disabled={busy}
              onPress={() => useBottomSheet.getState().openSheet("task-schedule")}
              style={[styles.cta, { flexDirection, backgroundColor: busy ? colors.bgSurface : colors.brandPrimary }]}
            >
              <Clock size={16} color={busy ? colors.textPlaceholder : colors.brandOnPrimary} strokeWidth={2} />
              <Text style={{ color: busy ? colors.textPlaceholder : colors.brandOnPrimary, fontWeight: "600" }}>
                {t("tasks.scheduleRun")}
              </Text>
            </Pressable>
          ) : null}

          {runs.length > 0 ? (
            <>
              <Text style={[styles.section, { color: colors.textPlaceholder, textAlign }]}>{t("tasks.earlier")}</Text>
              {runs.map((r) => (
                <Pressable
                  key={r.id}
                  onPress={() => openRun(r.id)}
                  style={[styles.runCard, { flexDirection, backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
                >
                  <Text style={[styles.runText, { color: colors.textPrimary, textAlign }]}>
                    {r.status === "running" || r.status === "cancelling"
                      ? t("tasks.running")
                      : r.status === "scheduled"
                        ? t("tasks.scheduled")
                        : `${r.summary?.applied ?? 0} ${t("tasks.done")}`}
                  </Text>
                </Pressable>
              ))}
            </>
          ) : null}
        </ScrollView>
      )}

      <JobPickerSheet jobs={jobs} onPick={(input) => void add(input)} />
      <ScheduleSheet onSchedule={(iso) => void schedule(iso)} onRunNow={() => void start()} />
    </SafeAreaView>
    </ZoomFromOrigin>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  title: { fontSize: 20, fontWeight: "700", flex: 1 },
  section: { fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", marginTop: 18, marginBottom: 8 },
  runCard: { alignItems: "center", gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 8 },
  runText: { fontSize: 13, flex: 1 },
  offline: { padding: 12, borderRadius: 12, borderWidth: 1, marginTop: 14, gap: 4 },
  offlineText: { fontSize: 14, fontWeight: "600" },
  offlineHint: { fontSize: 12 },
  empty: { paddingVertical: 24, alignItems: "center", gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: "600" },
  emptyHint: { fontSize: 13 },
  addBtn: { alignItems: "center", gap: 6, paddingVertical: 12 },
  cta: { alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 12, marginTop: 6 },
});
