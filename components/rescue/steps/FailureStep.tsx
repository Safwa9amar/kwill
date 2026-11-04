import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { TrustList } from "@/components/rescue/ui";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hWarn } from "@/lib/haptics";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { ackVersion } from "@/lib/rescue-v2-api";
import { failureBody, failureTrust } from "@/lib/rescue-v2-finish";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

/**
 * Screen 18: an honest failure. A full page, no sheet, and the one way out is the shell's (LivingScreen draws it). The body says what
 * happened to the file and to any payment, and only what is true: a trust row is shown only when its fact holds. Says nothing about money on
 * iOS beyond status words (P-23). `hWarn` once on arrival.
 */
export function FailureStep() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const project = useRescueV2Store((s) => s.project);
  const apply = useRescueV2Store((s) => s.apply);
  const reset = useRescueV2Store((s) => s.reset);
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const warned = useRef(false);

  useEffect(() => {
    if (warned.current) return;
    warned.current = true;
    hWarn();
  }, []);

  const failure = project?.failure ?? null;
  if (!project || !failure) return null;

  const body = failureBody(failure.code, failure.page);
  const trust = failureTrust({
    ios: PURCHASES_HIDDEN,
    refund: failure.refund,
    purchaseState: project.entitlement.purchase.state,
    previousVersionN: failure.previousVersionN,
    rescueRun: failure.versionId !== project.originalVersionId,
  });
  // A file the converter would not open, on the free original: a new file is the way on.
  const tryAnother = (failure.code === "not_docx" || failure.code === "word_refused") && failure.versionId === project.originalVersionId;

  // The acknowledgement is sent once. With a previous version the phase falls to done and the screen follows it; with none, the student is
  // taken to chat. A failed acknowledgement stays here, on the error line.
  const ok = async () => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    try {
      const acked = await apply(() => ackVersion(failure.versionId));
      if (acked && failure.previousVersionN === null) router.dismissTo("/(app)/chat");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={[styles.page, { backgroundColor: colors.bgPrimary, paddingTop: insets.top + 64, paddingBottom: insets.bottom + 20 }]}>
      <View style={[styles.shield, { backgroundColor: colors.successWash }]}>
        <Text style={[styles.shieldGlyph, { color: colors.semanticSuccess }]}>✓</Text>
      </View>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescueV2.failure.title")}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{t(`rescueV2.${body.key}`, body.params)}</Text>
      <View style={styles.trust}>
        <TrustList items={trust.map((r) => t(`rescueV2.${r.key}`, r.params))} />
      </View>
      <View style={styles.actions}>
        <Button title={t("rescueV2.failure.ok")} onPress={() => { void ok(); }} loading={busy} disabled={busy} />
        {tryAnother ? (
          <Button title={t("rescueV2.failure.tryAnother")} variant="secondary" disabled={busy} onPress={() => reset()} />
        ) : null}
        <TouchableOpacity accessibilityRole="button" onPress={() => router.push("/(app)/support")} hitSlop={8} style={styles.link}>
          <Text style={[styles.linkText, { color: colors.brandPrimary }]}>{t("rescueV2.common.contactSupport")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  shield: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", marginBottom: 20 },
  shieldGlyph: { fontSize: 34, fontWeight: "800" },
  title: { fontSize: 22, fontWeight: "800", textAlign: "center", marginBottom: 10 },
  body: { fontSize: 15, lineHeight: 22, textAlign: "center", marginBottom: 18 },
  trust: { alignSelf: "stretch", marginBottom: 18 },
  actions: { alignSelf: "stretch", gap: 10 },
  link: { alignSelf: "center", paddingVertical: 10 },
  linkText: { fontSize: 14, fontWeight: "700" },
});
