import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { backFor, type RescueScreen } from "@/lib/rescue-v2-screen";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import { BackPill, CloseButton } from "./ui";

/**
 * The way out of every step, and the one error line for the route. It sits at the leading corner, under the safe area, on every screen,
 * so no step draws its own. The error line's retry repeats the call that failed (`retryLast`); with nothing recorded it re-reads the project.
 */
export function StageChrome({ screen }: { screen: RescueScreen }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const nav = useRescueV2Store((s) => s.nav);
  const project = useRescueV2Store((s) => s.project);
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const retryLast = useRescueV2Store((s) => s.retryLast);
  const hasBack = backFor(screen, nav, project) !== null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 8 }]}>
      {hasBack ? <BackPill /> : <CloseButton />}
      {errorCode ? (
        <View style={[styles.error, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
          <Text numberOfLines={2} style={[styles.errorText, { color: colors.textPrimary }]}>{t("rescueV2.common.somethingWrong")}</Text>
          <TouchableOpacity accessibilityRole="button" onPress={() => { void retryLast(); }} hitSlop={8}>
            <Text style={[styles.errorRetry, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", start: 12, end: 12, gap: 8, alignItems: "flex-start" },
  error: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, maxWidth: "100%" },
  errorText: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  errorRetry: { fontSize: 13, fontWeight: "700" },
});
