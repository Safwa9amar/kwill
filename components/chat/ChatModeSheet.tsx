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
      // 60%, the same height HistorySheet uses. The four rows carry a two-line
      // hint in every language the app speaks (the French "Assist" hint wraps on
      // any phone), which puts the content near 390dp — over 50% of a 720p-class
      // screen. A BottomSheetView does not scroll, so a snap point that is too
      // short does not scroll the last row into reach, it CUTS it.
      snapPoints={["60%"]}
      enableDynamicSizing={false}
      onDismiss={onClose}
      backdropComponent={(props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
      )}
      backgroundStyle={{ backgroundColor: colors.bgModal }}
      handleIndicatorStyle={{ backgroundColor: colors.borderDefault }}
    >
      {/* Everything lives INSIDE the BottomSheetView. It is not a plain child of
          the sheet: gorhom styles it `position: absolute; top: 0`, so a header
          rendered as its SIBLING is not stacked above it — it is drawn UNDER it
          at the same y, which is how the title came to sit on top of the first
          row. (HistorySheet gets away with a sibling header only because a
          BottomSheetFlatList is a scrollable, and scrollables do flow.) */}
      <BottomSheetView style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.textPrimary, textAlign: align }]}>{t("chatModes.title")}</Text>
        </View>
        <View style={styles.list}>
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
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  // The handle's own box already ends 10dp below the indicator; 8 more is the
  // rhythm the rest of this sheet is on, and the difference between a list that
  // starts under the handle and one that starts against it.
  content: { paddingTop: 8 },
  header: { paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 4 },
  row: { alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  iconWrap: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  rowHint: { fontSize: 12, fontFamily: "Inter_400Regular" },
});
