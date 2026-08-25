import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  TextInput,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import * as ImagePicker from "expo-image-picker";
import * as Clipboard from "expo-clipboard";
import { useThemeColors } from "@/hooks/useThemeColors";
import { BackButton } from "@/components/BackButton";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Copy, Phone, Image as ImageIcon } from "lucide-react-native";
import { fetchManualPaymentDetails, submitManualPayment } from "@/lib/api";
import type { ManualPaymentDetails } from "@/lib/api";
import type { PlanCode } from "@/types/billing";

function guessMime(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType) return asset.mimeType;
  const ext = asset.uri.split(".").pop()?.toLowerCase() ?? "";
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

export default function PaymentManualScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const { plan, kind, amountDzd } = useLocalSearchParams<{ plan?: PlanCode; kind?: "topup"; amountDzd: string }>();

  const [details, setDetails] = useState<ManualPaymentDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [reference, setReference] = useState("");
  const [image, setImage] = useState<{ base64: string; mimeType: string; uri: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchManualPaymentDetails()
      .then(setDetails)
      .finally(() => setLoadingDetails(false));
  }, []);

  const copy = async (value: string) => {
    await Clipboard.setStringAsync(value);
  };

  const pickScreenshot = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        t("payment.manualPhotoPermissionTitle", { defaultValue: "Photo access needed" }),
        t("payment.manualPhotoPermissionMessage", {
          defaultValue: "Allow photo access in Settings to attach your transfer screenshot.",
        }),
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7, base64: true });
    // A cancel is the student choosing to back out — silent, not an error.
    if (result.canceled) return;
    if (!result.assets?.[0]?.base64) {
      Alert.alert(
        t("payment.manualPhotoPermissionTitle", { defaultValue: "Photo access needed" }),
        t("payment.checkoutFailedBody"),
      );
      return;
    }
    const asset = result.assets[0];
    setImage({ base64: asset.base64!, mimeType: guessMime(asset), uri: asset.uri });
  };

  const submit = async () => {
    if (!reference.trim() || !image) return;
    setSubmitting(true);
    try {
      await submitManualPayment({
        base64: image.base64,
        mimeType: image.mimeType,
        referenceNumber: reference.trim(),
        plan: kind === "topup" ? undefined : plan,
        kind: kind === "topup" ? "topup" : undefined,
      });
      router.replace("/(app)/payment-manual-submitted" as any);
    } catch (e: any) {
      Alert.alert(t("payment.manualSubmitFailedTitle"), e?.message || t("payment.checkoutFailedBody"));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingDetails) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
        <View style={styles.centre}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!details) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
        <View style={styles.header}>
          <BackButton />
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t("payment.payManual")}</Text>
          <View style={{ width: 30 }} />
        </View>
        <View style={styles.centre}>
          <Text style={{ color: colors.textSecondary }}>{t("payment.unavailable")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={styles.header}>
        <BackButton />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t("payment.payManual")}</Text>
        <View style={{ width: 30 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Card style={styles.amountCard} borderColor={colors.borderSubtle}>
          <Text style={[styles.amountLabel, { color: colors.textSecondary }]}>{t("payment.manualAmountLabel")}</Text>
          <Text style={[styles.amountValue, { color: colors.textPrimary }]}>{amountDzd} DZD</Text>
        </Card>

        <Card style={styles.detailsCard} borderColor={colors.borderSubtle}>
          {[
            { label: t("payment.manualRip"), value: details.rip },
            { label: t("payment.manualBaridimobPhone"), value: details.baridimobPhone },
            { label: t("payment.manualHolderName"), value: details.holderName },
          ].map((row) => (
            <Pressable key={row.label} onPress={() => copy(row.value)} style={styles.detailRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{row.label}</Text>
                <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{row.value}</Text>
              </View>
              <Copy size={18} color={colors.textSecondary} />
            </Pressable>
          ))}
          {details.contactPhone && (
            <Pressable onPress={() => Linking.openURL(`tel:${details.contactPhone}`)} style={styles.detailRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{t("payment.manualCallUs")}</Text>
                <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{details.contactPhone}</Text>
              </View>
              <Phone size={18} color={colors.brandPrimary} />
            </Pressable>
          )}
        </Card>

        <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{t("payment.manualReferenceLabel")}</Text>
        <TextInput
          value={reference}
          onChangeText={setReference}
          placeholder={t("payment.manualReferencePlaceholder")}
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.borderSubtle }]}
        />

        <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: 20 }]}>
          {t("payment.manualScreenshotLabel")}
        </Text>
        <Pressable onPress={pickScreenshot} style={[styles.pickButton, { borderColor: colors.borderSubtle }]}>
          {image ? (
            <Image source={{ uri: image.uri }} style={styles.previewImage} />
          ) : (
            <>
              <ImageIcon size={24} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, marginTop: 8 }}>{t("payment.manualPickScreenshot")}</Text>
            </>
          )}
        </Pressable>

        <Button
          title={t("payment.manualSubmit")}
          onPress={submit}
          loading={submitting}
          disabled={!reference.trim() || !image || submitting}
          style={{ marginTop: 24 }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontSize: 18, fontFamily: "Inter_600SemiBold" },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  amountCard: { marginBottom: 16, alignItems: "center", paddingVertical: 16 },
  amountLabel: { fontSize: 13, fontFamily: "Inter_500Medium" },
  amountValue: { fontSize: 24, fontFamily: "Inter_700Bold", marginTop: 4 },
  detailsCard: { marginBottom: 20, padding: 4 },
  detailRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12 },
  detailLabel: { fontSize: 12, fontFamily: "Inter_400Regular" },
  detailValue: { fontSize: 15, fontFamily: "Inter_600SemiBold", marginTop: 2 },
  sectionLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", marginBottom: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, fontFamily: "Inter_400Regular" },
  pickButton: { borderWidth: 1, borderStyle: "dashed", borderRadius: 12, alignItems: "center", justifyContent: "center", paddingVertical: 24 },
  previewImage: { width: "100%", height: 180, borderRadius: 10 },
});
