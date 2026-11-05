import React, { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useTranslation } from "react-i18next";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { SheetBody, SheetTitle, TrustList } from "@/components/rescue/ui";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { startCheckout } from "@/lib/api";
import { hSuccess } from "@/lib/haptics";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { GRANT_POLL_MS, RESCUE_RETURN_SCHEME, checkoutRefusal, paymentNoteKey, paymentReturn, paymentView, type PaymentMethod, type PaymentView } from "@/lib/rescue-v2-payment";
import { STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { usePaymentUi, type PaymentNotice } from "@/stores/rescue-payment-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueStep } from "./index";

/** The sheet's view, decided once by paymentView for both the sheet and the foot. Null until the config is read. */
function usePaymentView(): PaymentView | null {
  const project = useRescueV2Store((s) => s.project);
  const config = useRescueV2Store((s) => s.config);
  if (!project || !config) return null;
  return paymentView({
    ios: PURCHASES_HIDDEN,
    state: project.entitlement.purchase.state,
    // Not for sale when the price is off: an offer with no price is never shown.
    forSale: project.entitlement.forSale && project.entitlement.priceDzd !== null,
    manualEnabled: config.manualEnabled,
    cardEnabled: config.paymentsEnabled,
  });
}

/**
 * A card payment, as subscription.tsx's buy: the checkout opens in an auth session, and the browser's return is not trusted on its own.
 * The grant is read back from the project, which the webhook sets. The lock is held for the whole of it (the caller ends it), so a second
 * tap cannot open a second checkout while the first can still be paid.
 */
async function payByCard(projectId: string, locale: string) {
  // A notice is only for the project it was asked about: the student may have switched while the browser was open.
  const notify = (n: PaymentNotice) => {
    if (usePaymentUi.getState().key === projectId) usePaymentUi.getState().setNotice(n);
  };
  try {
    const { checkoutUrl } = await startCheckout({ kind: "rescue", projectId }, locale);
    const r = await WebBrowser.openAuthSessionAsync(checkoutUrl, RESCUE_RETURN_SCHEME);
    // A return names its project (kwill://payment-<status>?rescue=<id>); a return for another project is not this one's answer.
    const back = r.type === "success" ? paymentReturn(r.url, projectId) : "unfinished";
    if (back !== "paid") {
      // Cancel or dismiss: nothing is decided here. The project is re-read, and a finished-but-unreturned payment still grants by webhook.
      await useRescueV2Store.getState().refresh();
      if (back === "unfinished" && r.type === "success") notify("payment.cardNotFinished");
      return;
    }
    for (const wait of GRANT_POLL_MS) {
      await new Promise((res) => setTimeout(res, wait));
      await useRescueV2Store.getState().refresh();
      const p = useRescueV2Store.getState().project;
      if (p?.id === projectId && p.entitlement.kind) { hSuccess(); return; }
    }
  } catch (e) {
    // A refused checkout is said as the server means it (S14). Any other failure is the generic line; the project is re-read either way,
    // so a state the server already moved is shown.
    const code = (e as { code?: unknown } | null)?.code;
    const refusal = typeof code === "string" ? checkoutRefusal(code) : null;
    if (refusal) {
      if (refusal.notice) notify(refusal.notice);
    } else {
      notify("payment.cardFailed");
    }
    void useRescueV2Store.getState().refresh();
  }
}

function Stage() {
  const project = useRescueV2Store((s) => s.project);
  const v0 = project?.originalVersionId ?? null;
  const layout = STAGE_LAYOUT.payment;
  if (!v0 || layout.kind !== "three") return null;
  // The student's own pages, the cover on one side and the page after it: the file as it is now, before any payment.
  return (
    <View style={styles.stage}>
      <PageCarousel versionId={v0} page={2} layout={layout} />
    </View>
  );
}

function MethodRow({ label, sub, on, onPress }: { label: string; sub: string; on: boolean; onPress: () => void }) {
  const colors = useThemeColors();
  const { flexDirection } = useRTL();
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={[styles.method, { flexDirection, borderColor: on ? colors.brandPrimary : colors.borderDefault }]}
    >
      <View style={[styles.radio, { borderColor: on ? colors.brandPrimary : colors.borderDefault }]}>
        {on ? <View style={[styles.radioOn, { backgroundColor: colors.brandPrimary }]} /> : null}
      </View>
      <View style={styles.methodText}>
        <Text style={[styles.methodLabel, { color: colors.textPrimary }]}>{label}</Text>
        <Text style={[styles.methodSub, { color: colors.textSecondary }]}>{sub}</Text>
      </View>
    </TouchableOpacity>
  );
}

function Sheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const project = useRescueV2Store((s) => s.project);
  const config = useRescueV2Store((s) => s.config);
  const loadConfig = useRescueV2Store((s) => s.loadConfig);
  const setNav = useRescueV2Store((s) => s.setNav);
  const view = usePaymentView();
  const method = usePaymentUi((s) => s.method);
  const notice = usePaymentUi((s) => s.notice);
  const setMethod = usePaymentUi((s) => s.setMethod);
  const id = project?.id ?? null;

  useEffect(() => {
    if (id) usePaymentUi.getState().ensure(id);
  }, [id]);

  if (!project) return null;
  if (!config) {
    // The config is read on open; a failed read is not a sheet error in the store, so this sheet names it and reads it again.
    return (
      <>
        <SheetBody>{t("rescueV2.common.somethingWrong")}</SheetBody>
        <TouchableOpacity accessibilityRole="button" onPress={() => { void loadConfig(); }} hitSlop={8}>
          <Text style={[styles.link, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      </>
    );
  }
  if (!view) return null;

  const noticeLine = notice ? <SheetBody>{t(`rescueV2.${notice}`)}</SheetBody> : null;

  switch (view.kind) {
    case "status":
      // iOS: what the student has, and how to see it again. No price, no method, no mention of email (P-23).
      return (
        <>
          <SheetTitle>{t("rescueV2.payment.statusTitle")}</SheetTitle>
          <SheetBody>{t("rescueV2.payment.statusBody")}</SheetBody>
          <TouchableOpacity accessibilityRole="button" onPress={() => setNav({ paying: false })} hitSlop={8}>
            <Text style={[styles.link, { color: colors.brandPrimary }]}>{t("rescueV2.payment.statusBack")}</Text>
          </TouchableOpacity>
        </>
      );
    case "offer": {
      const selected = method ?? view.defaultMethod;
      return (
        <>
          <SheetTitle>{t("rescueV2.payment.title")}</SheetTitle>
          <View style={styles.priceRow}>
            <Text style={[styles.price, { color: colors.textPrimary }]}>
              {t("rescueV2.payment.price", { price: project.entitlement.priceDzd ?? 0 })}
            </Text>
            <Text style={[styles.once, { color: colors.textSecondary }]}>{t("rescueV2.payment.once")}</Text>
          </View>
          <TrustList items={[t("rescueV2.payment.inc1"), t("rescueV2.payment.inc2"), t("rescueV2.payment.inc3"), t("rescueV2.payment.inc4")]} />
          {view.methods.includes("manual") ? (
            <MethodRow label={t("rescueV2.payment.manual")} sub={t("rescueV2.payment.manualSub")} on={selected === "manual"} onPress={() => setMethod("manual")} />
          ) : null}
          {view.methods.includes("card") ? (
            <MethodRow label={t("rescueV2.payment.card")} sub={t("rescueV2.payment.cardSub")} on={selected === "card"} onPress={() => setMethod("card")} />
          ) : null}
          <SheetBody>{t("rescueV2.payment.safe")}</SheetBody>
          {noticeLine}
        </>
      );
    }
    case "notForSale":
      return <SheetBody>{t("rescueV2.payment.notForSale")}</SheetBody>;
    case "underReview":
      return (
        <>
          <SheetTitle>{t("rescueV2.payment.underReviewTitle")}</SheetTitle>
          <SheetBody>{t("rescueV2.payment.underReviewBody")}</SheetBody>
        </>
      );
    case "rejected":
      return (
        <>
          <SheetTitle>{t("rescueV2.payment.rejectedTitle")}</SheetTitle>
          {project.entitlement.purchase.rejectReason ? <SheetBody>{project.entitlement.purchase.rejectReason}</SheetBody> : null}
          {noticeLine}
        </>
      );
    case "confirming":
      return (
        <>
          <SheetTitle>{t("rescueV2.payment.confirming")}</SheetTitle>
          {noticeLine}
        </>
      );
    case "refundDue":
      return <SheetTitle>{t("rescueV2.failure.refundDue")}</SheetTitle>;
  }
}

/** The one CTA of the payment sheet, for the views that have one. Its lock is the shared one, so a double tap is refused. */
function PayFoot() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const project = useRescueV2Store((s) => s.project);
  const refresh = useRescueV2Store((s) => s.refresh);
  const view = usePaymentView();
  const method = usePaymentUi((s) => s.method);
  const busy = usePaymentUi((s) => s.busy);
  const refusal = usePaymentUi((s) => s.refusal);
  if (!project || !view) return null;

  const pay = (m: PaymentMethod) => {
    const price = project.entitlement.priceDzd;
    if (price === null) return;
    const ui = usePaymentUi.getState();
    if (!ui.begin()) return;
    ui.setNotice(null);
    if (m === "manual") {
      // The manual form takes the transfer; its own submit is the one charge, and it is guarded there.
      ui.end();
      router.push({
        pathname: "/(app)/payment-manual",
        params: { kind: "rescue", rescueProjectId: project.id, amountDzd: String(price) },
      } as never);
      return;
    }
    void payByCard(project.id, i18n.language).finally(() => usePaymentUi.getState().end());
  };

  if (view.kind === "status") {
    // iOS: a refresh of the status only. The store's own error line names a failed refresh.
    const onRefresh = () => {
      const ui = usePaymentUi.getState();
      if (!ui.begin()) return;
      void refresh().finally(() => usePaymentUi.getState().end());
    };
    return <Button title={t("rescueV2.payment.statusRefresh")} onPress={onRefresh} loading={busy} disabled={busy} />;
  }
  if (view.kind === "offer") {
    const noteKey = paymentNoteKey({ ios: PURCHASES_HIDDEN, refusal });
    return (
      <View>
        <Button title={t("rescueV2.payment.cta")} onPress={() => pay(method ?? view.defaultMethod)} loading={busy} disabled={busy} />
        {noteKey ? <Text style={styles.fine}>{t(noteKey)}</Text> : null}
      </View>
    );
  }
  if (view.kind === "rejected" && view.cta && view.defaultMethod) {
    const m = view.defaultMethod;
    return <Button title={t("rescueV2.payment.tryAgain")} onPress={() => pay(m)} loading={busy} disabled={busy} />;
  }
  return null;
}

export const PaymentStep: RescueStep = { Stage, Sheet, Foot: PayFoot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 12 },
  price: { fontSize: 20, fontWeight: "800" },
  once: { fontSize: 13 },
  method: { alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioOn: { width: 8, height: 8, borderRadius: 4 },
  methodText: { flex: 1 },
  methodLabel: { fontSize: 15, fontWeight: "700" },
  methodSub: { fontSize: 12, marginTop: 2 },
  link: { fontSize: 14, fontWeight: "700", marginTop: 8 },
  fine: { fontSize: 12, textAlign: "center", marginTop: 8 },
});
