import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Check, Clock } from "lucide-react-native";
import { useBillingStore } from "@/stores/billing-store";

// Everything shown here is read back from the server.
//
// This screen used to print a fixed plan name, amount, date and transaction id.
// A receipt that is not the real transaction is worse than no receipt: it is
// what a student screenshots and quotes back when something is wrong.

/**
 * The allowance is granted by Chargily's WEBHOOK, which races the browser
 * returning — and usually loses. So the screen opens in a waiting state and
 * re-reads the counter until it moves, rather than telling someone who has just
 * paid that they have nothing.
 */
const POLL_MS = [0, 600, 1500, 3000, 5000, 8000];

function formatDate(iso: string | undefined, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export default function PaymentSuccessScreen() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  // A rescue payment comes back here only through the deep link: its grant is read from the project, not the plan's allowance.
  const { rescue } = useLocalSearchParams<{ rescue?: string }>();

  const quota = useBillingStore((s) => s.quota);
  const refreshQuota = useBillingStore((s) => s.refreshQuota);
  const [settling, setSettling] = useState(true);

  const poll = useCallback(async () => {
    for (const wait of POLL_MS) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      await refreshQuota();
      const q = useBillingStore.getState().quota;
      if (q && q.available > 0) break;
    }
    setSettling(false);
  }, [refreshQuota]);

  useEffect(() => {
    if (!rescue) void poll();
  }, [poll, rescue]);

  const granted = !!quota && quota.available > 0;

  if (rescue) return <Redirect href={`/(app)/rescue?projectId=${encodeURIComponent(rescue)}` as never} />;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={styles.centered}>
        <View
          style={[
            styles.iconCircle,
            { backgroundColor: (granted ? colors.semanticSuccess : colors.textSecondary) + "20" },
          ]}
        >
          {granted ? (
            <Check size={40} color={colors.semanticSuccess} strokeWidth={3} />
          ) : (
            <Clock size={40} color={colors.textSecondary} strokeWidth={2.5} />
          )}
        </View>

        <Text style={[styles.title, { color: colors.textPrimary }]}>
          {granted ? t("payment.paymentSuccessful") : t("payment.confirming")}
        </Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          {granted ? t("payment.successDescription") : t("payment.confirmingBody")}
        </Text>

        {settling && !granted && <ActivityIndicator color={colors.brandPrimary} style={styles.spinner} />}

        {quota && (
          <Card style={styles.receiptCard}>
            <View style={styles.receiptRow}>
              <Text style={[styles.receiptLabel, { color: colors.textSecondary }]}>{t("payment.plan")}</Text>
              <Text style={[styles.receiptValue, { color: colors.textPrimary }]}>
                {t(`payment.plan_${quota.plan}`)}
              </Text>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
            <View style={styles.receiptRow}>
              <Text style={[styles.receiptLabel, { color: colors.textSecondary }]}>
                {t("payment.messagesAvailable")}
              </Text>
              <Text style={[styles.receiptValue, { color: colors.textPrimary }]}>{quota.available}</Text>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
            <View style={styles.receiptRow}>
              <Text style={[styles.receiptLabel, { color: colors.textSecondary }]}>
                {t("payment.renewsOn")}
              </Text>
              <Text style={[styles.receiptValue, { color: colors.textPrimary }]}>
                {formatDate(quota.periodEnd, i18n.language)}
              </Text>
            </View>
          </Card>
        )}

        <Button
          title={t("payment.startBuilding")}
          onPress={() => router.replace("/" as any)}
          style={styles.button}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  iconCircle: { width: 80, height: 80, borderRadius: 40, alignItems: "center", justifyContent: "center", marginBottom: 24 },
  title: { fontSize: 24, fontFamily: "Inter_700Bold", marginBottom: 8, textAlign: "center" },
  description: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 24 },
  spinner: { marginBottom: 16 },
  receiptCard: { width: "100%", marginBottom: 32 },
  receiptRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 10 },
  receiptLabel: { fontSize: 13, fontFamily: "Inter_400Regular" },
  receiptValue: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  divider: { height: 1 },
  button: { width: "100%" },
});
