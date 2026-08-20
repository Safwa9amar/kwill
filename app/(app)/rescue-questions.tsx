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
import { getTextDirection } from "@/lib/text-direction";
import { visualTextAlign } from "@/lib/rtl-layout";

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

  // A "noise" candidate (a typed page number, a stray running header line) is
  // a different question from "is this a heading" — asking it the heading way
  // reads as a non-sequitur next to a line with no chapter-title shape at all.
  const isNoise = q.suggested.role === "noise";

  // Question text is the student's own document — its direction follows the
  // content, not the app locale (same rule as a chat message; see
  // components/chat/MessageBubble.tsx). The context lines are often too short
  // to carry a strong character of their own, so they fall back to the target
  // line's direction rather than flipping to LTR on their own.
  const headDir = getTextDirection(q.textHead);
  const beforeDir = getTextDirection(q.before, headDir);
  const afterDir = getTextDirection(q.after, headDir);
  const headStyle = { textAlign: visualTextAlign(headDir === "rtl"), writingDirection: headDir } as const;
  const beforeStyle = { textAlign: visualTextAlign(beforeDir === "rtl"), writingDirection: beforeDir } as const;
  const afterStyle = { textAlign: visualTextAlign(afterDir === "rtl"), writingDirection: afterDir } as const;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.header}>
        <BackButton />
        <Text style={[styles.progress, { color: colors.textSecondary }]}>
          {t("rescue.questionsLeft", { count: questions.length })}
        </Text>
      </View>
      <View style={styles.body}>
        <Text style={[styles.ask, { color: colors.textPrimary }]}>
          {t(isNoise ? "rescue.isThisNoise" : "rescue.isThisAHeading")}
        </Text>
        <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
          <Text style={[styles.ctx, beforeStyle, { color: colors.textSecondary }]} numberOfLines={1}>{q.before}</Text>
          <Text style={[styles.target, headStyle, { color: colors.textPrimary }]}>{q.textHead}</Text>
          <Text style={[styles.ctx, afterStyle, { color: colors.textSecondary }]} numberOfLines={1}>{q.after}</Text>
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
            <Text style={{ color: colors.textSecondary }}>
              {t(isNoise ? "rescue.keepIt" : "rescue.notAHeading")}
            </Text>
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
