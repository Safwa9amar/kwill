import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNetworkStatus } from "@/lib/network";
import { useThemeColors } from "@/hooks/useThemeColors";
import { WifiOff } from "lucide-react-native";

export function NetworkBanner() {
  const { t } = useTranslation();
  const { isOffline } = useNetworkStatus();
  const colors = useThemeColors();
  // Mounted above the navigator, where no screen's safe area applies: the banner pads itself past the status bar and Dynamic Island.
  const insets = useSafeAreaInsets();

  if (!isOffline) return null;

  return (
    <View style={[styles.banner, { paddingTop: insets.top + 8, backgroundColor: colors.semanticWarning + "20" }]}>
      <WifiOff size={14} color={colors.semanticWarning} strokeWidth={2} />
      <Text style={[styles.text, { color: colors.semanticWarning }]}>{t("common.offlineSaved")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingBottom: 8, paddingHorizontal: 16 },
  text: { fontSize: 12, fontFamily: "Inter_500Medium" },
});
