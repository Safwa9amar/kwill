import React, { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { PageZoom } from "@/components/rescue/PageZoom";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hLight } from "@/lib/haptics";
import { resumeVersion, saveAnswer } from "@/lib/rescue-v2-api";
import { currentQuestionIndex } from "@/lib/rescue-v2-confirm";
import { STAGE_LAYOUT, scaleFor } from "@/lib/rescue-v2-layout";
import { useRTL } from "@/hooks/useRTL";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { firstStrongDirection } from "@/lib/text-direction";
import { useConfirmUi, type AnswerValue } from "@/stores/rescue-confirm-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueProjectDTO } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

/** A re-run's questions wait for a resume once the last one is answered (§1.1, await_answers). A first rescue's questions move on by themselves. */
function resumeTarget(p: Pick<RescueProjectDTO, "activeVersionId" | "originalVersionId">): string | null {
  return p.activeVersionId && p.activeVersionId !== p.originalVersionId ? p.activeVersionId : null;
}

/**
 * Sends one answer. It shows at once and stays on screen when the save fails: the sheet offers the retry, and the answer is never lost.
 * The last answer of a re-run resumes its version.
 */
async function answer(id: string, questionKey: string, a: AnswerValue): Promise<void> {
  const ui = useConfirmUi.getState();
  ui.ensure(id);
  if (!ui.begin()) return;
  try {
    hLight();
    useConfirmUi.getState().setAnswerPending({ questionKey, answer: a });
    const ok = await useRescueV2Store.getState().apply(() => saveAnswer(id, questionKey, a));
    const after = useConfirmUi.getState();
    if (ok && after.key === id) after.setAnswerPending(null);
    const p = useRescueV2Store.getState().project;
    if (ok && p && p.id === id && currentQuestionIndex(p.questions) < 0) {
      const vid = resumeTarget(p);
      if (vid) await useRescueV2Store.getState().apply(() => resumeVersion(vid));
    }
  } finally {
    useConfirmUi.getState().end();
  }
}

/** The resume on its own, for the case where the last answer saved and the resume did not: the sheet's button repeats it. */
async function resumeNow(id: string, versionId: string): Promise<void> {
  const ui = useConfirmUi.getState();
  ui.ensure(id);
  if (!ui.begin()) return;
  try {
    await useRescueV2Store.getState().apply(() => resumeVersion(versionId));
  } finally {
    useConfirmUi.getState().end();
  }
}

/** The question to show: the first unanswered one; once all are answered (a re-run waiting on its resume), the last. */
function useShownQuestion() {
  const project = useRescueV2Store((s) => s.project);
  if (!project || project.questions.length === 0) return null;
  const qi = currentQuestionIndex(project.questions);
  const index = qi >= 0 ? qi : project.questions.length - 1;
  return { project, index, question: project.questions[index], answered: qi < 0 };
}

function Stage() {
  const { width } = useWindowDimensions();
  const shown = useShownQuestion();
  const layout = STAGE_LAYOUT.question;
  if (!shown || layout.kind !== "big") return null;
  const { project, question: q } = shown;
  const s = scaleFor(width);
  const pw = layout.page[0] * s;
  const ph = layout.page[1] * s;
  // A question with a page points at the original's page. A new block of a re-run has no page yet (P-29): its excerpt stands on a blank paper.
  if (q.page !== null) {
    return <PageZoom key={q.key} versionId={project.originalVersionId} page={q.page} topPct={q.topPct ?? 0.5} pageW={pw} pageH={ph} />;
  }
  return <ExcerptPaper key={q.key} excerpt={q.excerpt} width={pw} height={ph} rtl={thesisIsRtl(project)} />;
}

/** A paper with the excerpt in the highlight band, for a question with no page yet. Its direction is the excerpt's own. */
function ExcerptPaper({ excerpt, width, height, rtl }: { excerpt: string; width: number; height: number; rtl: boolean }) {
  const colors = useThemeColors();
  const dir = firstStrongDirection(excerpt, rtl ? "rtl" : "ltr");
  return (
    <View style={styles.stage}>
      <View style={[styles.paper, { width, height, backgroundColor: colors.rescuePaper }]}>
        <View style={[styles.excerptBand, { borderColor: colors.semanticWarning }]}>
          <View style={[StyleSheet.absoluteFill, styles.excerptFill, { backgroundColor: colors.semanticWarning }]} />
          <Text style={[styles.excerptText, { color: colors.rescuePaperInk, textAlign: visualTextAlign(dir === "rtl"), writingDirection: dir }]}>
            {excerpt}
          </Text>
        </View>
      </View>
    </View>
  );
}

function AnswerButton({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  const colors = useThemeColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.answer, { borderColor: selected ? colors.brandPrimary : colors.borderDefault, backgroundColor: selected ? colors.brandWash : colors.bgSurface }]}
    >
      <Text style={[styles.answerText, { color: colors.textPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Sheet() {
  const { isRTL: ui } = useRTL();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const shown = useShownQuestion();
  const id = shown?.project.id ?? null;
  const pending = useConfirmUi((s) => (s.key === id ? s.answerPending : null));
  const busy = useConfirmUi((s) => s.busy);

  useEffect(() => {
    if (id) useConfirmUi.getState().ensure(id);
  }, [id]);

  // A pending answer the server now holds (a retry from the shell landed) is no longer pending.
  const questions = shown?.project.questions ?? null;
  useEffect(() => {
    const cur = useConfirmUi.getState();
    if (!id || !questions || cur.key !== id || !cur.answerPending) return;
    const key = cur.answerPending.questionKey;
    if (questions.some((x) => x.key === key && x.answer !== null)) cur.setAnswerPending(null);
  }, [id, questions]);

  if (!shown || !id) return null;
  const { project, index, question: q, answered } = shown;
  const rtl = thesisIsRtl(project);
  // The question is in the student's language and takes its direction from its own text; the sheet's chrome (counter, answers row,
  // "Kwill decides", retry) follows the UI, as every sheet does: a French UI over an Arabic thesis reads left to right.
  const textDir = firstStrongDirection(q.text, rtl ? "rtl" : "ltr");
  const chosen = pending && pending.questionKey === q.key ? pending : null;
  const resume = answered ? resumeTarget(project) : null;

  return (
    <Animated.View key={q.key} entering={FadeIn.duration(220)}>
      <Text style={[styles.counter, { color: colors.textSecondary, textAlign: visualTextAlign(ui) }]}>
        {t("rescueV2.question.counter", { n: index + 1, total: project.questions.length })}
      </Text>
      <Text style={[styles.question, { color: colors.textPrimary, textAlign: visualTextAlign(textDir === "rtl"), writingDirection: textDir }]}>
        {q.text}
      </Text>
      {!answered ? (
        <View style={[styles.answers, { flexDirection: visualRow(ui) }]}>
          {q.options.map((o) => (
            <AnswerButton
              key={o.role}
              label={o.label}
              selected={chosen !== null && "role" in chosen.answer && chosen.answer.role === o.role}
              disabled={busy}
              onPress={() => { void answer(id, q.key, { role: o.role }); }}
            />
          ))}
        </View>
      ) : null}
      {resume ? (
        <Button title={t("rescueV2.question.resume")} onPress={() => { void resumeNow(id, resume); }} loading={busy} disabled={busy} />
      ) : null}
      {!answered ? (
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void answer(id, q.key, { decide: true }); }} hitSlop={8} style={styles.decide}>
          <Text style={[styles.decideText, { color: busy ? colors.textPlaceholder : colors.brandPrimary, textAlign: visualTextAlign(ui) }]}>
            {t("rescueV2.question.decide")}
          </Text>
        </TouchableOpacity>
      ) : null}
      {chosen && !busy ? (
        // The answer did not save: it stays on screen, and this repeats the same save.
        <TouchableOpacity accessibilityRole="button" onPress={() => { void answer(id, chosen.questionKey, chosen.answer); }} hitSlop={8} style={styles.decide}>
          <Text style={[styles.decideText, { color: colors.brandPrimary, textAlign: visualTextAlign(ui) }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
}

export const QuestionStep: RescueStep = { Stage, Sheet };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center", width: "100%" },
  paper: { borderRadius: 3, justifyContent: "center", padding: 12, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 3 },
  excerptBand: { borderWidth: 1.5, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 10 },
  excerptFill: { opacity: 0.22 },
  excerptText: { fontSize: 13, lineHeight: 19 },
  counter: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  question: { fontSize: 18, fontWeight: "800", lineHeight: 24, marginBottom: 12 },
  answers: { gap: 8, marginBottom: 10 },
  answer: { flex: 1, minHeight: 52, borderWidth: 1.5, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  answerText: { fontSize: 15, fontWeight: "700", textAlign: "center" },
  decide: { paddingVertical: 8 },
  decideText: { fontSize: 14, fontWeight: "700" },
});
