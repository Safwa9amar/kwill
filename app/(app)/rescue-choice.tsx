// app/(app)/rescue-choice.tsx
// The three doors, asked once, BEFORE the picker opens.
//
// Asking first rather than after the file is chosen means each door opens the
// picker exactly once and both existing lanes stay whole: repair and rebuild go
// through the rescue store, import-only through the import store that already
// owns that flow. It is also the honest order — which door you want is a policy
// choice about your own document, not something you decide by looking at it.
//
// PRODUCT RULE: the card is dismissible, and dismissing means IMPORT ONLY —
// the least destructive of the three, and the only free one.
import { useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Wrench, Sparkles, FolderUp } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescueStore } from "@/stores/rescue-store";
import { useImportStore } from "@/stores/import-store";
import { BackButton } from "@/components/BackButton";

type Door = "repair" | "rebuild" | "import";

export default function RescueChoiceScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const normProfileId = useRescueStore((s) => s.normProfileId);
  // Two taps on the same card must not open two pickers.
  const [busy, setBusy] = useState(false);

  const fail = (key: string) => {
    Alert.alert(t("rescue.title"), t(`rescue.error.${key}`, { defaultValue: t("thesis.genericError") }));
  };

  const choose = async (door: Door) => {
    if (busy) return;
    setBusy(true);
    try {
      if (door === "import") {
        // The pre-existing import lane, untouched: it picks, uploads, analyses
        // and lands on its own screen. No rescue run, no diagnosis, no spend.
        const store = useImportStore.getState();
        store.setNormProfileId(normProfileId);
        let navigated = false;
        const res = await store.pickAndImport({
          onPicked: () => { navigated = true; router.replace("/(app)/import-analysis" as any); },
        });
        if (res === "error" && !navigated) fail(useImportStore.getState().errorMessage ?? "generic");
        return;
      }

      const store = useRescueStore.getState();
      let navigated = false;
      const res = await store.pickAndDiagnose({
        mode: door,
        // Fires the instant a valid .docx is chosen — the working screen takes
        // over from there, so only a failure BEFORE it fires is ours to show.
        onPicked: () => { navigated = true; router.replace("/(app)/rescue-working" as any); },
      });
      if (res === "ok") router.replace("/(app)/rescue-verdict" as any);
      else if (res === "error" && !navigated) fail(useRescueStore.getState().errorMessage ?? "generic");
      // canceled: stay here — the student can pick another door.
    } finally {
      setBusy(false);
    }
  };

  const DOORS: Array<{ key: Door; Icon: typeof Wrench; accent: string }> = [
    { key: "repair", Icon: Wrench, accent: colors.brandPrimary },
    { key: "rebuild", Icon: Sparkles, accent: colors.brandPrimary },
    { key: "import", Icon: FolderUp, accent: colors.textSecondary },
  ];

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.header}>
        <BackButton />
      </View>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescue.choice.title")}</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t("rescue.choice.subtitle")}</Text>

      <ScrollView contentContainerStyle={styles.list}>
        {DOORS.map(({ key, Icon, accent }) => (
          <Pressable
            key={key}
            disabled={busy}
            onPress={() => choose(key)}
            style={[
              styles.card,
              { backgroundColor: colors.bgCard, borderColor: colors.borderDefault, opacity: busy ? 0.6 : 1 },
            ]}
          >
            <View style={styles.cardHead}>
              <Icon size={20} color={accent} />
              <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>
                {t(`rescue.choice.${key}.title`)}
              </Text>
            </View>
            <Text style={[styles.cardBody, { color: colors.textSecondary }]}>
              {t(`rescue.choice.${key}.body`)}
            </Text>
            {/* What it COSTS, said plainly: the student is choosing before they
                have been shown a verdict, so the trade has to be on the card. */}
            <Text style={[styles.cardCost, { color: colors.textSecondary }]}>
              {t(`rescue.choice.${key}.cost`)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 },
  title: { fontSize: 20, fontWeight: "700", textAlign: "center" },
  subtitle: { fontSize: 13, textAlign: "center", marginTop: 4, paddingHorizontal: 24 },
  list: { padding: 16, gap: 12 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: "700", flexShrink: 1 },
  cardBody: { fontSize: 13, lineHeight: 19 },
  cardCost: { fontSize: 12, fontStyle: "italic", marginTop: 2 },
});
