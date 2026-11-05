import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { listRescueProjects } from "@/lib/rescue-v2-api";
import { homeCard, type HomeCard } from "@/lib/rescue-v2-home";

/**
 * The chat's welcome card for rescue (plan A9 step 2): the start, the project in progress, or the finished one. A server that is off or
 * unreachable shows no card at all, so the chat is never blocked by it. iOS gets the status wording, with no price and no buy word (P-23).
 */
export function RescueHomeCard() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const { flexDirection } = useRTL();
  const [card, setCard] = useState<HomeCard | null>(null);

  useEffect(() => {
    let live = true;
    listRescueProjects()
      .then((r) => { if (live) setCard(homeCard(r.projects)); })
      // Not an error the student can act on here: the card is an entry point, and the rescue screens say what is wrong when opened.
      .catch(() => { if (live) setCard(null); });
    return () => { live = false; };
  }, []);

  if (!card) return null;
  const route = card.kind === "none" ? "/(app)/rescue" : `/(app)/rescue?projectId=${encodeURIComponent(card.id)}`;
  const label = card.kind === "none" ? t("rescueV2.card.cta") : card.kind === "continue" ? t("rescueV2.card.continue") : t("rescueV2.card.ready");
  const body = card.kind === "none" ? t(PURCHASES_HIDDEN ? "rescueV2.card.bodyStatus" : "rescueV2.card.body") : null;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={() => router.push(route as never)}
      activeOpacity={0.6}
      style={[styles.card, { flexDirection, backgroundColor: colors.brandPrimary + "14", borderColor: colors.brandPrimary }]}
    >
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescueV2.card.title")}</Text>
      {body ? <Text style={[styles.body, { color: colors.textSecondary }]}>{body}</Text> : null}
      <Text style={[styles.label, { color: colors.brandPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: "stretch", borderWidth: 1, borderRadius: 16, padding: 14, gap: 6 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  body: { fontSize: 13, lineHeight: 19 },
  label: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
