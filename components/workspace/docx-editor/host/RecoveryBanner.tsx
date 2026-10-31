// "We kept a copy of your unsaved edits" — Restore / Discard (Task 28). Sticky:
// unlike the save banner it does not time out, because the copy waits on a choice.

import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { typography } from "@/constants/typography";

export function RecoveryBanner({ onRestore, onDiscard }: { onRestore: () => void; onDiscard: () => void }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View style={[styles.wrap, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
      <Text style={[styles.text, { color: colors.textPrimary }]}>
        {t("workspace.keptUnsavedCopy", { defaultValue: "We kept a copy of your unsaved edits" })}
      </Text>
      <View style={styles.actions}>
        <Pressable onPress={onDiscard} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.action, { color: colors.textSecondary }]}>
            {t("workspace.discardCopy", { defaultValue: "Discard" })}
          </Text>
        </Pressable>
        <Pressable onPress={onRestore} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.action, { color: colors.brandPrimaryLight }]}>
            {t("workspace.restoreCopy", { defaultValue: "Restore" })}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Above the transient save banner (bottom: 12), which a 412 also raises.
  wrap: {
    position: "absolute", bottom: 52, left: 16, right: 16, alignSelf: "center",
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
  },
  // Weight comes from the Inter face, not fontWeight (inert on a pre-weighted family).
  text: { flex: 1, fontSize: typography.bodySmall.fontSize, fontFamily: "Inter_500Medium" },
  actions: { flexDirection: "row", gap: 18 },
  action: { fontSize: typography.label.fontSize, fontFamily: "Inter_600SemiBold" },
});
