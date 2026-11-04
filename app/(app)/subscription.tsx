import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useTranslation } from "react-i18next";
import * as WebBrowser from "expo-web-browser";
import { useThemeColors } from "@/hooks/useThemeColors";
import { BackButton } from "@/components/BackButton";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Check, Sparkles } from "lucide-react-native";
import { useBillingStore } from "@/stores/billing-store";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { startCheckout, fetchManualPaymentDetails, fetchManualPaymentStatus } from "@/lib/api";
import type { ManualPaymentDetails, ManualPaymentStatus } from "@/lib/api";
import type { PlanCode, PlanOffer } from "@/types/billing";

// The paywall.
//
// Every price and allowance on this screen comes from GET /api/payment/plans.
// Nothing is hardcoded: a price baked in here drifts from the server's the first
// time one changes, and the student is then shown one number and charged another.

/** Where openAuthSessionAsync stops following the payment page. */
const RETURN_SCHEME = "kwill://payment";

/**
 * How long to keep re-reading the counter after a successful payment.
 *
 * The allowance is granted by Chargily's WEBHOOK, not by the browser coming
 * back, so the two race and the browser usually wins. Without this the student
 * lands on a screen that still says they have nothing, right after paying.
 */
const GRANT_POLL_MS = [400, 1200, 2500, 5000];

function formatDzd(n: number): string {
  return n.toLocaleString("en-US");
}

export default function SubscriptionScreen() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();

  // Primitives only — a fresh object literal from this store re-renders forever.
  const catalogue = useBillingStore((s) => s.catalogue);
  const catalogueFailed = useBillingStore((s) => s.catalogueFailed);
  const quota = useBillingStore((s) => s.quota);
  const refreshAll = useBillingStore((s) => s.refreshAll);
  const refreshQuota = useBillingStore((s) => s.refreshQuota);
  const clearBlocked = useBillingStore((s) => s.setBlocked);

  const [selected, setSelected] = useState<PlanCode>("monthly");
  const [busy, setBusy] = useState<string | null>(null);
  const [manualDetails, setManualDetails] = useState<ManualPaymentDetails | null>(null);
  const [manualStatus, setManualStatus] = useState<ManualPaymentStatus | null>(null);

  useFocusEffect(
    useCallback(() => {
      void refreshAll();
      // On iOS the manual-payment path does not exist, so its state is never
      // fetched — a pending-review banner would name a way to pay.
      if (PURCHASES_HIDDEN) return;
      void fetchManualPaymentDetails().then(setManualDetails).catch(() => setManualDetails(null));
      // The endpoint returns the one latest pending or rejected transfer of any kind. A rescue transfer belongs to its own screen, so it is
      // read as nothing here: its pending state would otherwise hide this screen's plan and top-up buttons.
      void fetchManualPaymentStatus().then((s) => setManualStatus(s?.kind === "rescue" ? null : s)).catch(() => setManualStatus(null));
    }, [refreshAll]),
  );

  // Arriving here means the student is dealing with the limit — the blocking
  // banner over the chat has done its job and should not still be up behind this.
  useEffect(() => clearBlocked(null), [clearBlocked]);

  /**
   * Buy something.
   *
   * openAuthSessionAsync rather than openBrowserAsync: it intercepts the return
   * redirect itself, so the payment page closes on its own and control comes
   * straight back here. With a plain browser the student is left looking at a
   * "you may close this tab" page, wondering whether it worked.
   */
  const buy = async (input: { plan: PlanCode } | { kind: "topup" }, key: string) => {
    if (!catalogue?.paymentsEnabled) return;
    setBusy(key);
    try {
      const { checkoutUrl } = await startCheckout(input, i18n.language);
      const result = await WebBrowser.openAuthSessionAsync(checkoutUrl, RETURN_SCHEME);

      if (result.type !== "success") {
        // 'cancel' / 'dismiss' — the student backed out. Not an error, and not
        // necessarily a decision: they may have paid and closed the tab early,
        // so the counter is re-read anyway rather than assumed unchanged.
        await refreshQuota();
        return;
      }

      const paid = result.url.includes("payment-success");
      if (!paid) {
        router.push("/(app)/payment-failed" as any);
        return;
      }

      // Wait for the webhook to land, then show what they actually got.
      for (const wait of GRANT_POLL_MS) {
        await new Promise((r) => setTimeout(r, wait));
        await refreshQuota();
        const q = useBillingStore.getState().quota;
        if (q && q.available > 0) break;
      }
      router.push("/(app)/payment-success" as any);
    } catch (e: any) {
      Alert.alert(t("payment.checkoutFailedTitle"), e?.message || t("payment.checkoutFailedBody"));
    } finally {
      setBusy(null);
    }
  };

  const goManual = (input: { plan: PlanCode } | { kind: "topup" }, amountDzd: number) => {
    const params =
      "plan" in input
        ? { plan: input.plan, amountDzd: String(amountDzd) }
        : { kind: "topup", amountDzd: String(amountDzd) };
    router.push({ pathname: "/(app)/payment-manual", params } as any);
  };

  // ── loading / failed ───────────────────────────────────────────────────────
  // Two distinct states. A spinner that never resolves is indistinguishable
  // from a hang, and it is what this screen did against a server that predates
  // the /plans endpoint.
  if (!catalogue) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
        <View style={styles.header}>
          <BackButton />
          <Text style={[styles.title, { color: colors.textPrimary }]}>
            {t(PURCHASES_HIDDEN ? "payment.myPlan" : "payment.plansTitle")}
          </Text>
          <View style={{ width: 30 }} />
        </View>
        <View style={styles.centre}>
          {catalogueFailed ? (
            <>
              <Text style={[styles.failedTitle, { color: colors.textPrimary }]}>
                {t("payment.plansLoadFailed")}
              </Text>
              <Text style={[styles.failedBody, { color: colors.textSecondary }]}>
                {t("payment.checkoutFailedBody")}
              </Text>
              <Button title={t("payment.tryAgain")} onPress={() => void refreshAll()} style={styles.retryBtn} />
            </>
          ) : (
            <ActivityIndicator color={colors.brandPrimary} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  const planLabel = (code: PlanCode) => t(`payment.plan_${code}`);

  // iOS: plan STATUS only — see lib/purchases.ts. No plan cards, no prices, no
  // top-up, no manual path, and nothing that says where purchasing happens.
  if (PURCHASES_HIDDEN) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
        <View style={styles.header}>
          <BackButton />
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t("payment.myPlan")}</Text>
          <View style={{ width: 30 }} />
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {quota && (
            <Card style={styles.quotaCard} borderColor={colors.borderSubtle}>
              <Text style={[styles.quotaLabel, { color: colors.textSecondary }]}>
                {t("payment.currentPlan", { plan: planLabel(quota.plan) })}
              </Text>
              <Text style={[styles.quotaBig, { color: colors.textPrimary }]}>
                {t("payment.messagesLeft", { count: quota.available })}
              </Text>
              {quota.topupRemaining > 0 && (
                <Text style={[styles.quotaSub, { color: colors.textSecondary }]}>
                  {t("payment.includingTopup", { count: quota.topupRemaining })}
                </Text>
              )}
            </Card>
          )}
          <Text style={[styles.disabledNote, { color: colors.textSecondary }]}>
            {t("payment.accountLinkedNote")}
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const features = (p: PlanOffer): string[] => {
    const list = [
      t("payment.featMessages", { count: p.messages }),
      p.theses === null ? t("payment.featThesesUnlimited") : t("payment.featTheses", { count: p.theses }),
      t("payment.featTools"),
    ];
    // Only worth saying on a pooled plan, where it is a real constraint.
    if (p.monthlyCap) list.push(t("payment.featMonthlyCap", { count: p.monthlyCap }));
    if (p.months > 1) list.push(t("payment.featPerMonth", { price: formatDzd(p.pricePerMonthDzd) }));
    return list;
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={styles.header}>
        <BackButton />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t("payment.plansTitle")}</Text>
        <View style={{ width: 30 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* What they have now — the reason they are on this screen. */}
        {quota && (
          <Card style={styles.quotaCard} borderColor={colors.borderSubtle}>
            <Text style={[styles.quotaLabel, { color: colors.textSecondary }]}>
              {t("payment.currentPlan", { plan: planLabel(quota.plan) })}
            </Text>
            <Text style={[styles.quotaBig, { color: colors.textPrimary }]}>
              {t("payment.messagesLeft", { count: quota.available })}
            </Text>
            {quota.topupRemaining > 0 && (
              <Text style={[styles.quotaSub, { color: colors.textSecondary }]}>
                {t("payment.includingTopup", { count: quota.topupRemaining })}
              </Text>
            )}
          </Card>
        )}

        {manualStatus?.status === "pending" && (
          <Card style={styles.manualBanner} borderColor={colors.borderSubtle}>
            <Text style={[styles.manualBannerText, { color: colors.textSecondary }]}>
              {t("payment.manualUnderReview")}
            </Text>
          </Card>
        )}
        {manualStatus?.status === "rejected" && (
          <Card style={styles.manualBanner} borderColor={colors.semanticError}>
            <Text style={[styles.manualBannerText, { color: colors.textPrimary }]}>
              {t("payment.manualRejectedNote", { reason: manualStatus.rejectReason ?? "" })}
            </Text>
          </Card>
        )}

        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t("payment.plansSubtitle")}</Text>

        {catalogue.plans.map((p) => {
          const active = selected === p.code;
          // The middle term is the one to steer toward: paid up front, and it
          // matches how long a thesis actually takes.
          const recommended = p.code === "quarterly";
          return (
            <Pressable key={p.code} onPress={() => setSelected(p.code)}>
              <Card
                style={[styles.planCard, active && { borderWidth: 2, borderColor: colors.brandPrimary }]}
                borderColor={active ? colors.brandPrimary : colors.borderSubtle}
              >
                <View style={styles.planHeader}>
                  <Text style={[styles.planName, { color: colors.textPrimary }]}>{planLabel(p.code)}</Text>
                  {recommended && (
                    <View style={[styles.badge, { backgroundColor: colors.brandPrimary }]}>
                      <Text style={styles.badgeText}>{t("payment.recommended")}</Text>
                    </View>
                  )}
                </View>

                <Text style={[styles.price, { color: colors.textPrimary }]}>
                  {formatDzd(p.priceDzd)} {catalogue.currency}
                </Text>
                <Text style={[styles.perMonth, { color: colors.textSecondary }]}>
                  {p.months === 1 ? t("payment.perMonth") : t("payment.forMonths", { count: p.months })}
                </Text>

                <View style={styles.featuresList}>
                  {features(p).map((f, i) => (
                    <View key={i} style={styles.featureRow}>
                      <Check size={16} color={colors.semanticSuccess} strokeWidth={3} />
                      <Text style={[styles.featureText, { color: colors.textSecondary }]}>{f}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            </Pressable>
          );
        })}

        {manualStatus?.status !== "pending" &&
          (catalogue.paymentsEnabled || manualDetails ? (
            <View style={styles.paymentMethodRow}>
              {catalogue.paymentsEnabled && (
                <Button
                  title={t("payment.payByCard")}
                  onPress={() => buy({ plan: selected }, selected)}
                  loading={busy === selected}
                  disabled={!!busy}
                  style={{ ...styles.subscribeBtn, flex: 1 }}
                />
              )}
              {manualDetails && (
                <Button
                  title={t("payment.payManual")}
                  variant="secondary"
                  onPress={() =>
                    goManual({ plan: selected }, catalogue.plans.find((p) => p.code === selected)?.priceDzd ?? 0)
                  }
                  disabled={!!busy}
                  style={{ ...styles.subscribeBtn, flex: 1 }}
                />
              )}
            </View>
          ) : (
            // Never show a button that opens a checkout the server cannot honour.
            <Text style={[styles.disabledNote, { color: colors.textSecondary }]}>
              {t("payment.unavailable")}
            </Text>
          ))}

        {/* Top-up: for someone mid-thesis who just needs a few more. */}
        <View style={styles.topupBlock}>
          <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{t("payment.topupTitle")}</Text>
          <Card borderColor={colors.borderSubtle}>
            <View style={styles.topupRow}>
              <Sparkles size={20} color={colors.brandAccent} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.topupName, { color: colors.textPrimary }]}>
                  {t("payment.topupMessages", { count: catalogue.topup.messages })}
                </Text>
                <Text style={[styles.topupHint, { color: colors.textSecondary }]}>
                  {t("payment.topupNeverExpires")}
                </Text>
              </View>
              <Text style={[styles.topupPrice, { color: colors.textPrimary }]}>
                {formatDzd(catalogue.topup.priceDzd)}
              </Text>
            </View>
            {manualStatus?.status !== "pending" && (catalogue.paymentsEnabled || manualDetails) && (
              <View style={styles.paymentMethodRow}>
                {catalogue.paymentsEnabled && (
                  <Button
                    title={t("payment.payByCard")}
                    variant="secondary"
                    onPress={() => buy({ kind: "topup" }, "topup")}
                    loading={busy === "topup"}
                    disabled={!!busy}
                    style={{ ...styles.topupBtn, flex: 1 }}
                  />
                )}
                {manualDetails && (
                  <Button
                    title={t("payment.payManual")}
                    variant="secondary"
                    onPress={() => goManual({ kind: "topup" }, catalogue.topup.priceDzd)}
                    disabled={!!busy}
                    style={{ ...styles.topupBtn, flex: 1 }}
                  />
                )}
              </View>
            )}
          </Card>
        </View>

        <Text style={[styles.securedBy, { color: colors.textSecondary }]}>{t("payment.securedBy")}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  failedTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", textAlign: "center" },
  failedBody: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8 },
  retryBtn: { marginTop: 20, alignSelf: "stretch" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontSize: 18, fontFamily: "Inter_600SemiBold" },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  quotaCard: { marginBottom: 20, alignItems: "center", paddingVertical: 20 },
  quotaLabel: { fontSize: 13, fontFamily: "Inter_500Medium" },
  quotaBig: { fontSize: 26, fontFamily: "Inter_700Bold", marginTop: 6 },
  quotaSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 4 },
  subtitle: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 20 },
  planCard: { marginBottom: 16 },
  planHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  planName: { fontSize: 18, fontFamily: "Inter_700Bold" },
  badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontFamily: "Inter_700Bold", color: "#fff" },
  price: { fontSize: 30, fontFamily: "Inter_700Bold" },
  perMonth: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 16 },
  featuresList: { gap: 10 },
  featureRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  featureText: { fontSize: 14, fontFamily: "Inter_400Regular", flex: 1 },
  subscribeBtn: { marginTop: 8 },
  paymentMethodRow: { flexDirection: "row", gap: 10 },
  manualBanner: { marginBottom: 16, padding: 14 },
  manualBannerText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  disabledNote: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 12 },
  topupBlock: { marginTop: 28 },
  sectionLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", marginBottom: 12 },
  topupRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  topupName: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  topupHint: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  topupPrice: { fontSize: 17, fontFamily: "Inter_700Bold" },
  topupBtn: { marginTop: 14 },
  securedBy: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 24 },
});
