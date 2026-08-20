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
  // `s.verdict` is a stable object (or null) between renders — deriving `total`/
  // `issues` from it below avoids the fresh-array-every-render trap that a
  // `s.verdict?.issues ?? []` selector would fall into.
  const verdict = useRescueStore((s) => s.verdict);
  const degraded = useRescueStore((s) => s.degraded);
  const questionCount = useRescueStore((s) => s.questions.length);
  const startRepair = useRescueStore((s) => s.startRepair);

  const total = verdict?.total ?? 0;
  const issues = verdict?.issues ?? [];

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
        <Pressable onPress={onRepair} style={[styles.cta, { backgroundColor: colors.brandPrimary }]}>
          <Wrench size={18} color={colors.brandOnPrimary} />
          <Text style={[styles.ctaText, { color: colors.brandOnPrimary }]}>
            {t(total === 0 ? "rescue.formatAnyway" : "rescue.repairCta")}
          </Text>
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
  ctaText: { fontSize: 16, fontWeight: "600" },
});
