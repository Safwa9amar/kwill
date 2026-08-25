import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { Button } from "@/components/ui/Button";
import { CheckCircle2 } from "lucide-react-native";

export default function PaymentManualSubmittedScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.content}>
        <CheckCircle2 size={64} color={colors.semanticSuccess} />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t("payment.manualSubmittedTitle")}</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>{t("payment.manualSubmittedBody")}</Text>
        <Button
          title={t("payment.manualSubmittedCta")}
          onPress={() => router.replace("/(app)/subscription" as any)}
          style={{ marginTop: 24, alignSelf: "stretch" }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  title: { fontSize: 20, fontFamily: "Inter_700Bold", marginTop: 20, textAlign: "center" },
  body: { fontSize: 14, fontFamily: "Inter_400Regular", marginTop: 10, textAlign: "center" },
});
