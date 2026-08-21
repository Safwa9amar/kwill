import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { visualRow } from "@/lib/rtl-layout";
import { CHAT_MODE_ICONS, chatModeLabelKey, type ChatMode } from "@/lib/chat-modes";

interface Props {
  mode: ChatMode;
  onPress: () => void;
  rtl: boolean;
  disabled?: boolean;
}

/**
 * What this conversation is FOR, sitting in the composer where the student can see
 * it while they type — which is the moment it matters. Tapping opens the picker
 * sheet; this component decides nothing itself.
 *
 * Agent is tinted and the others are not: "no prompts, runs on its own" is the
 * state worth noticing before you press send.
 */
export function ChatModeChip({ mode, onPress, rtl, disabled }: Props) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const Icon = CHAT_MODE_ICONS[mode];
  const accent = mode === "agent" ? colors.brandPrimary : colors.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t(chatModeLabelKey(mode))}
      style={[
        styles.chip,
        {
          flexDirection: visualRow(rtl),
          backgroundColor: colors.bgInput,
          borderColor: mode === "agent" ? colors.brandPrimary : colors.borderDefault,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Icon size={13} color={accent} strokeWidth={2.2} />
      <Text style={[styles.label, { color: accent }]} numberOfLines={1}>
        {t(chatModeLabelKey(mode))}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  label: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
});
