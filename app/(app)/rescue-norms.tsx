// app/(app)/rescue-norms.tsx
// One question before the door: which faculty's norms? Same chip list the
// combine flow uses (combine-arrange.tsx) — the profiles live in thesis-store
// and are lazy-loaded the same way. Picking one leads to rescue-choice, which
// asks what the student actually wants done and opens the picker itself.
import { useEffect } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
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

  // The norms are the only thing asked before the door. Picking one no longer
  // opens the picker: the student chooses repair / rebuild / import-only first,
  // and that screen opens the picker once, for whichever door they took.
  const pick = (id: string) => {
    useRescueStore.getState().setNormProfileId(id);
    router.replace("/(app)/rescue-choice" as any);
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
