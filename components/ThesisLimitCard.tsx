import { useEffect } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useThesisStore } from "@/stores/thesis-store";
import { useThesisLimit, useThesesUsed } from "@/stores/billing-store";
import { thesisLimitTitle, thesisLimitBody } from "@/lib/thesis-limit";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";

// Why the student cannot start another thesis, said BEFORE they invest anything
// in one.
//
// A free plan holds one. The server refuses at all four creation doors — the
// wizard, a .docx import, a combine, and the assistant's create_thesis — but a
// wall you only meet at the end of a wizard is a wall that wasted your afternoon,
// so this sits at the top of the starting-point screen with its choices disabled
// underneath.
//
// It names the way OUT, not just the limit: the thesis they already have (by
// title, and tappable), and the plans. "Delete it to start another" is honest
// advice — deletion frees the slot for real.

export function ThesisLimitCard() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();

  const limit = useThesisLimit();
  const used = useThesesUsed();
  const theses = useThesisStore((s) => s.theses);

  // The list is otherwise loaded at sign-in and refreshed by the drawer, and this
  // card can be reached without either (the name sheet routes straight here). One
  // best-effort refresh, so "the thesis you already have" can actually be named
  // rather than silently degrading to a bare paywall.
  useEffect(() => {
    if (theses.length === 0) void useThesisStore.getState().refreshTheses();
    // Once per mount: an empty list after a refresh is an answer, not a retry cue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rtl = i18n.language === "ar";
  // The one they already have. With a limit of one there is exactly one to name;
  // above that, naming a single title would be misleading, so the count speaks.
  const only = limit === 1 && theses.length === 1 ? theses[0] : null;

  return (
    <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.brandPrimary }]}>
      {/* The wording lives in lib/thesis-limit so this card, the two alerts and
          the import/combine error states can never drift apart. */}
      <Text style={[styles.title, { color: colors.textPrimary, textAlign: visualTextAlign(rtl) }]}>
        {thesisLimitTitle({ limit, used })}
      </Text>
      <Text style={[styles.body, { color: colors.textSecondary, textAlign: visualTextAlign(rtl) }]}>
        {thesisLimitBody({ limit, used })}
      </Text>

      {only ? (
        <Pressable
          onPress={() => {
            // The thesis is selected BEFORE navigating — the chat screen stays
            // mounted between visits and reads it out of the store, so setting it
            // afterwards would leave it on the previous thesis's thread.
            useThesisStore.getState().setCurrentThesis(only.id);
            router.dismissTo("/(app)/chat" as any);
          }}
          style={[styles.existing, { borderColor: colors.borderSubtle, flexDirection: visualRow(rtl) }]}
        >
          <FileText size={15} color={colors.textSecondary} strokeWidth={2} />
          <Text
            style={[styles.existingText, { color: colors.textPrimary, textAlign: visualTextAlign(rtl) }]}
            numberOfLines={1}
          >
            {only.title}
          </Text>
        </Pressable>
      ) : null}

      <Pressable
        onPress={() => router.push("/(app)/subscription" as any)}
        style={[styles.cta, { backgroundColor: colors.brandPrimary }]}
      >
        <Text style={styles.ctaText}>{t(PURCHASES_HIDDEN ? "payment.myPlan" : "payment.viewPlans")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: 16, padding: 14, gap: 8 },
  title: { fontSize: 15, fontFamily: "Inter_700Bold" },
  body: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19 },
  existing: { alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 2 },
  existingText: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  cta: { borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 2 },
  ctaText: { color: "#FFFFFF", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
