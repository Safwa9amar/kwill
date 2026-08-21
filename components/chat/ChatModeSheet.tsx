import { useEffect, useRef } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { CHAT_MODES, CHAT_MODE_ICONS, chatModeLabelKey, chatModeHintKey, type ChatMode } from "@/lib/chat-modes";

interface Props {
  open: boolean;
  mode: ChatMode;
  rtl: boolean;
  onSelect: (m: ChatMode) => void;
  onClose: () => void;
}

/**
 * Bottom sheet listing the four chat modes — icon, label, one-line hint, and a
 * check on whichever the conversation is in now. Picking a mode applies it and
 * dismisses the sheet; nothing here decides what a mode DOES, only what it's
 * called and shows.
 *
 * Unmounted whenever `open` is false, exactly like HistorySheet — @gorhom's
 * BottomSheetModal left mounted-but-hidden stops responding to the next
 * present(). Presented with one requestAnimationFrame, re-presented only after
 * onDismiss has fired (which is also how a select or a backdrop tap gets back
 * to the caller: both go through dismiss() → onDismiss → onClose).
 */
export function ChatModeSheet({ open, mode, rtl, onSelect, onClose }: Props) {
  if (!open) return null;
  return <ChatModeSheetContent mode={mode} rtl={rtl} onSelect={onSelect} onClose={onClose} />;
}

function ChatModeSheetContent({ mode, rtl, onSelect, onClose }: Omit<Props, "open">) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const ref = useRef<BottomSheetModal>(null);
  const align = visualTextAlign(rtl);

  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.present());
    return () => cancelAnimationFrame(id);
  }, []);

  const choose = (m: ChatMode) => {
    onSelect(m);
    ref.current?.dismiss();
  };

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={["50%"]}
      enableDynamicSizing={false}
      onDismiss={onClose}
      backdropComponent={(props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
      )}
      backgroundStyle={{ backgroundColor: colors.bgModal }}
      handleIndicatorStyle={{ backgroundColor: colors.borderDefault }}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary, textAlign: align }]}>{t("chatModes.title")}</Text>
      </View>
      <BottomSheetView style={styles.list}>
        {CHAT_MODES.map((m) => {
          const Icon = CHAT_MODE_ICONS[m];
          const active = m === mode;
          return (
            <Pressable
              key={m}
              onPress={() => choose(m)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t(chatModeLabelKey(m))}
              style={[styles.row, { flexDirection: visualRow(rtl), borderColor: colors.borderSubtle }]}
            >
              <View style={[styles.iconWrap, { backgroundColor: colors.bgInput }]}>
                <Icon size={18} color={active ? colors.brandPrimary : colors.textSecondary} strokeWidth={2.2} />
              </View>
              <View style={styles.rowBody}>
                <Text style={[styles.rowLabel, { color: colors.textPrimary, textAlign: align }]}>
                  {t(chatModeLabelKey(m))}
                </Text>
                <Text style={[styles.rowHint, { color: colors.textSecondary, textAlign: align }]}>
                  {t(chatModeHintKey(m))}
                </Text>
              </View>
              {active && <Check size={18} color={colors.brandPrimary} strokeWidth={2.4} />}
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 4 },
  row: { alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  iconWrap: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  rowHint: { fontSize: 12, fontFamily: "Inter_400Regular" },
});
