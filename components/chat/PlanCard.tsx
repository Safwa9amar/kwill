import { useEffect, useRef } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { ClipboardList, Check } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import type { PlanPayload, PlanStepProgress } from "@/lib/plan-frames";

interface Props {
  plan: PlanPayload;
  rtl: boolean;
  /** The plan is executing right now — Execute is a spinner and refuses taps. */
  running: boolean;
  /** The run finished. The card stays as the record of what was done. */
  done: boolean;
  /** Which steps are ticked off, sorted by step index — chat-store's `planSteps`
   *  for THIS plan. Live during a run and rebuilt from the stored frames on a
   *  reload, so the card reads the same either way.
   *
   *  ⚠️ Pass the stored array (or NO_PLAN_TICKS), never a fresh literal. */
  ticks: PlanStepProgress[];
  onExecute: () => void;
  onAskChanges: () => void;
}

/**
 * A plan the assistant proposed in Plan mode: its title, its steps in order, and
 * the decision. Same family as ComposerConfirm — Kwill saying what it is about to
 * do and waiting to be told to go — so it borrows that card's language: a titled
 * row with an icon, body copy, then a filled primary and a bordered secondary.
 *
 * "Ask for changes" only calls back; it is the caller that decides what that
 * means (focusing the composer), because the student answering in their own words
 * IS the revision — there is no separate edit-the-plan mode.
 *
 * Once a run starts the steps become a live CHECKLIST: a tick and a struck
 * title on what is finished, a spinner on the one being worked on, its plain
 * number on the rest. The ticks are not derived here and cannot be — they are
 * streamed (and persisted) on the message that EXECUTES the plan, while this
 * card belongs to the message that PROPOSED it. They arrive as `ticks`, out of
 * the store record that joins the two (stores/chat-store.ts, `planSteps`).
 *
 * ⚠️ Executing twice would apply every edit in the plan twice, so the button is
 * latched as well as disabled — see `fired` below.
 */
export function PlanCard({ plan, rtl, running, done, ticks, onExecute, onAskChanges }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const align = visualTextAlign(rtl);
  const row = visualRow(rtl);

  // `disabled` alone cannot stop a double tap: it only goes true once the CALLER
  // has re-rendered with running=true, and a caller that awaits anything before
  // flipping it leaves the button live for those frames. The latch closes on the
  // press itself, in the same tick, and reopens only when a run has ended without
  // finishing (a failure the student may retry). A caller that never flips
  // `running` leaves it shut — a dead button is the cheap failure here, a thesis
  // edited twice is not.
  const fired = useRef(false);
  useEffect(() => {
    if (!running) fired.current = false;
  }, [running]);

  const press = () => {
    if (running || done || fired.current) return;
    fired.current = true;
    onExecute();
  };

  const busy = running || done;

  // The steps as a CHECKLIST. `ticks` is sorted by step index but is not dense —
  // the assistant can finish step 3 before step 2 — so look each step up rather
  // than assuming a prefix is done.
  const tickAt = (i: number) => ticks.find((t) => t.index === i);
  // While a run is in flight, the first step with no tick is the one being
  // worked on. -1 when idle, and -1 once every step is ticked (a run whose last
  // frame has landed but whose prose is still streaming must not spin on a step
  // that does not exist).
  const activeIndex = running ? plan.steps.findIndex((_, i) => !tickAt(i)) : -1;

  return (
    <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
      <View style={[styles.titleRow, { flexDirection: row }]}>
        <ClipboardList size={16} color={colors.brandPrimary} strokeWidth={2.2} />
        <Text style={[styles.title, { color: colors.textPrimary, textAlign: align }]}>{plan.title}</Text>
      </View>

      <View style={styles.steps}>
        {plan.steps.map((step, i) => {
          const tick = tickAt(i);
          const isDone = !!tick;
          const isActive = i === activeIndex;
          return (
            <View
              key={`${plan.id}-${i}`}
              style={[styles.step, { flexDirection: row }]}
              accessibilityLabel={
                isDone
                  ? t("chatModes.plan.stepDone", { defaultValue: "Done" })
                  : isActive
                    ? t("chatModes.plan.stepRunning", { defaultValue: "In progress" })
                    : undefined
              }
            >
              {/* The badge carries the state: a tick when the step is done, a
                  spinner on the one being worked on, its plain number until
                  then. Same 22pt circle in all three so the list never reflows
                  as a run walks down it. */}
              <View style={[styles.badge, { backgroundColor: colors.bgInput }]}>
                {isDone ? (
                  <Check size={13} color={colors.semanticSuccess} strokeWidth={3} />
                ) : isActive ? (
                  <ActivityIndicator size="small" color={colors.brandPrimary} />
                ) : (
                  <Text style={[styles.badgeText, { color: colors.textSecondary }]}>{i + 1}</Text>
                )}
              </View>
              <View style={styles.stepBody}>
                {/* Struck AND dimmed: the strike is what reads as "done" at a
                    glance, and dropping to textSecondary keeps it comfortably
                    legible on the dark card rather than fading it out. */}
                <Text
                  style={[
                    styles.stepTitle,
                    { color: isDone ? colors.textSecondary : colors.textPrimary, textAlign: align },
                    isDone && styles.stepTitleDone,
                  ]}
                >
                  {step.title}
                </Text>
                {!!step.detail && (
                  <Text style={[styles.stepDetail, { color: colors.textSecondary, textAlign: align }]}>{step.detail}</Text>
                )}
                {/* What was actually done, in the student's own language. Sits
                    under the step it belongs to and takes the success colour —
                    it is the only line on the card written after the fact. */}
                {!!tick?.note && (
                  <Text style={[styles.stepNote, { color: colors.semanticSuccess, textAlign: align }]}>{tick.note}</Text>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {done ? (
        <View style={[styles.doneRow, { flexDirection: row }]}>
          <Check size={15} color={colors.semanticSuccess} strokeWidth={2.6} />
          <Text style={[styles.doneText, { color: colors.semanticSuccess, textAlign: align }]}>
            {t("chatModes.plan.done", { defaultValue: "Done" })}
          </Text>
        </View>
      ) : (
        <View style={[styles.actions, { flexDirection: row }]}>
          <Pressable
            onPress={press}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy, busy: running }}
            style={[
              styles.btn,
              styles.executeBtn,
              { flexDirection: row, backgroundColor: colors.brandPrimary },
              running && styles.btnBusy,
            ]}
          >
            {running && <ActivityIndicator size="small" color={colors.brandOnPrimary} />}
            <Text style={[styles.executeText, { color: colors.brandOnPrimary }]}>
              {running
                ? t("chatModes.plan.running", { defaultValue: "Working…" })
                : t("chatModes.plan.execute", { defaultValue: "Execute" })}
            </Text>
          </Pressable>
          <Pressable
            onPress={onAskChanges}
            disabled={running}
            accessibilityRole="button"
            style={[
              styles.btn,
              styles.changesBtn,
              { borderColor: colors.borderDefault, backgroundColor: colors.bgCard },
              running && styles.btnBusy,
            ]}
          >
            <Text style={[styles.changesText, { color: colors.textPrimary }]}>
              {t("chatModes.plan.askChanges", { defaultValue: "Ask for changes" })}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12, padding: 14, borderRadius: 14, borderWidth: 1 },
  titleRow: { alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  steps: { gap: 10 },
  step: { gap: 10 },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  stepBody: { flex: 1, gap: 2 },
  stepTitle: { fontSize: 14, fontFamily: "Inter_500Medium" },
  stepTitleDone: { textDecorationLine: "line-through" },
  stepDetail: { fontSize: 12, fontFamily: "Inter_400Regular" },
  stepNote: { fontSize: 12, fontFamily: "Inter_400Regular" },
  // Wraps because the secondary label is long in the languages that matter:
  // "Demander des modifications" beside "Exécuter" is wider than a card on a
  // 360dp screen, and ComposerConfirm never had to survive that (Approve/Cancel
  // are two short words). A second line beats a clipped button.
  actions: { gap: 10, alignItems: "center", flexWrap: "wrap" },
  btn: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 12 },
  executeBtn: { alignItems: "center", gap: 8 },
  changesBtn: { borderWidth: 1 },
  btnBusy: { opacity: 0.6 },
  executeText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  changesText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  doneRow: { alignItems: "center", gap: 6 },
  doneText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
