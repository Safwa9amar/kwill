// app/(app)/rescue-norms.tsx
// One question before the file: which faculty's norms? Same chip list the
// combine flow uses (combine-arrange.tsx) — the profiles live in
// thesis-store and are lazy-loaded the same way. Picking one launches the
// document picker immediately; diagnose runs the instant a file is chosen.
import { useEffect } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useThesisStore } from "@/stores/thesis-store";
import { useRescueStore } from "@/stores/rescue-store";
import { BackButton } from "@/components/BackButton";

export default function RescueNormsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const normProfiles = useThesisStore((s) => s.normProfiles);

  useEffect(() => {
    useThesisStore.getState().loadNormProfiles();
  }, []);

  const pick = async (id: string) => {
    const store = useRescueStore.getState();
    store.setNormProfileId(id);
    // onPicked fires the moment a valid .docx is chosen — the working screen
    // takes over from there, so only a failure BEFORE it fires (a dead
    // picker, a non-.docx) is this screen's to show; a failure after is the
    // working screen's own status effect (same navigated-guard pattern as
    // the drawer's old handleImport/handleCombine).
    let navigated = false;
    const result = await store.pickAndDiagnose({
      onPicked: () => {
        navigated = true;
        router.replace("/(app)/rescue-working" as any);
      },
    });
    if (result === "ok") {
      router.replace("/(app)/rescue-verdict" as any);
    } else if (result === "error" && !navigated) {
      Alert.alert(
        t("rescue.title"),
        t(`rescue.error.${useRescueStore.getState().errorMessage ?? "generic"}`, {
          defaultValue: t("thesis.genericError"),
        }),
      );
    }
    // canceled: stay here — the student can re-pick or back out.
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.header}>
        <BackButton />
      </View>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescue.pickNorms")}</Text>
      <ScrollView contentContainerStyle={styles.list}>
        {normProfiles.map((np) => (
          <Pressable
            key={np.id}
            onPress={() => pick(np.id)}
            style={[styles.chip, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
          >
            <Text style={{ color: colors.textPrimary }}>{np.name}</Text>
            {np.university ? (
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{np.university}</Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 },
  title: { fontSize: 20, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  list: { padding: 16, gap: 10 },
  chip: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 2 },
});
