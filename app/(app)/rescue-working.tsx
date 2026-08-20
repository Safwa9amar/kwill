// app/(app)/rescue-working.tsx
// Live progress from the ACTUAL rescue run — never a fake bar. The long POST
// (diagnose, then later repair) does the work; this screen just watches the
// run's status and step list. Both phases land here: the norms picker routes
// in the moment a file is chosen (diagnose), and rescue-verdict/rescue-
// questions route in again once the student starts the paid repair.
import { useEffect } from "react";
import { View, StyleSheet, BackHandler, Alert } from "react-native";
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
  const errorMessage = useRescueStore((s) => s.errorMessage);
  const refresh = useRescueStore((s) => s.refresh);

  const isBusy = status === "repairing" || status === "diagnosing" || status === "uploading";

  // The run is writing (or about to write) a thesis server-side — a repair is
  // paid work in flight. Leaving mid-run can't take it back, same rule as
  // combine-arrange and import-analysis while THEY are busy.
  useEffect(() => {
    if (!isBusy) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [isBusy]);

  useEffect(() => {
    if (!isBusy) return;
    const id = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [isBusy, refresh]);

  // refresh() is what flips "repairing" to "done"/"error" (polling GET /:id);
  // startRepair()'s own resolution can also carry "payment" straight away.
  // Either way this screen reacts to the store rather than to whichever call
  // happened to trigger it — a defensive net alongside the callers that also
  // check startRepair()'s return value.
  useEffect(() => {
    if (status === "done") router.replace("/(app)/rescue-result" as any);
    else if (status === "payment") router.replace("/(app)/subscription" as any);
    else if (status === "error") {
      // errorMessage is either a rescue error CODE (looked up below) or, for
      // the thesis-limit case, an already-human sentence from thesisLimitBody()
      // — a sentence never matches a translation key, so the defaultValue is
      // what actually shows for it. Retry re-fires startRepair in place (the
      // server's claim accepts a failed run, and the runner redoes only the
      // failed steps); Close returns to the app root — the verdict screen was
      // evicted from the stack when the repair began.
      Alert.alert(
        t("rescue.title"),
        t(`rescue.error.${errorMessage}`, { defaultValue: errorMessage ?? t("thesis.genericError") }),
        [
          { text: t("common.close"), style: "cancel", onPress: () => router.back() },
          {
            text: t("common.retry"),
            onPress: () => {
              void useRescueStore.getState().startRepair();
            },
          },
        ],
      );
    }
  }, [status, errorMessage, router, t]);

  // A server "failed" step still surfaces as "done" here — the progress list
  // is not where a student debugs a broken run; the failure itself reaches
  // them through the status effect above (refresh() turns it into "error").
  const visible: ProcessingStep[] = steps
    .filter((s) => s.status !== "skipped")
    .map((s) => ({
      key: s.id,
      label: t(`rescue.step.${s.id}`),
      status:
        s.status === "done" || s.status === "failed"
          ? "done"
          : s.status === "running"
            ? "active"
            : "pending",
    }));

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={styles.body}>
        <ProcessingSteps
          title={t("rescue.workingTitle")}
          subtitle={fileName}
          steps={visible}
          note={t("combine.keepOpen")}
          liveness={`${status}:${steps.filter((s) => s.status === "done").length}`}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, justifyContent: "center" },
});
