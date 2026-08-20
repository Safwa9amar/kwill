// app/(app)/rescue-result.tsx
// Download is the hero — the deadline student's exit. Open-in-editor is the
// quiet door into Kwill. Undo restores the pre-formatting snapshot (never
// gated — see doc-history-ai-confirm: undo is always allowed).
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescueStore } from "@/stores/rescue-store";
import { useThesisStore } from "@/stores/thesis-store";
import { undoThesisHistory } from "@/lib/api";
import { CheckCircle, Download, PenLine, Undo2 } from "lucide-react-native";

export default function RescueResultScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const thesisId = useRescueStore((s) => s.thesisId);
  const ok = useRescueStore((s) => s.conformityOk);
  const total = useRescueStore((s) => s.conformityTotal);
  const reset = useRescueStore((s) => s.reset);

  // export.tsx reads its thesis id from route params (see
  // ThesisHeaderMenu.tsx's own push into it), not from the store — pass it
  // the same way that caller does.
  const openExport = () => {
    if (!thesisId) return;
    useThesisStore.getState().setCurrentThesis(thesisId);
    router.replace({ pathname: "/(app)/export", params: { thesisId } } as any);
  };

  // thesis-workspace, by contrast, always reads the CURRENT thesis id off the
  // store (combine-arrange and import-analysis both hand off to it the same
  // way: set the id, then a bare replace with no params).
  const openEditor = () => {
    if (!thesisId) return;
    useThesisStore.getState().setCurrentThesis(thesisId);
    router.replace("/(app)/thesis-workspace" as any);
  };

  const onUndo = () => {
    if (!thesisId) return;
    Alert.alert(t("rescue.undoTitle"), t("rescue.undoBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("rescue.undoConfirm"),
        style: "destructive",
        onPress: async () => {
          await undoThesisHistory(thesisId);
          reset();
          // dismissTo, not back: a `back()` here would land the student on the
          // now-stale verdict/working screen underneath — the lane is finished,
          // there is nothing left in it to return to. Same call AppDrawer uses
          // to always land on the app root.
          router.dismissTo("/(app)/chat" as any);
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.body}>
        <CheckCircle size={56} color={colors.semanticSuccess} />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t("rescue.doneTitle")}</Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {t("rescue.conformity", { ok, total })}
        </Text>
        <Pressable
          onPress={openExport}
          style={[styles.cta, { backgroundColor: colors.brandPrimary }]}
        >
          <Download size={18} color={colors.brandOnPrimary} />
          <Text style={[styles.ctaText, { color: colors.brandOnPrimary }]}>{t("rescue.download")}</Text>
        </Pressable>
        <Pressable onPress={openEditor} style={styles.secondary}>
          <PenLine size={16} color={colors.textPrimary} />
          <Text style={{ color: colors.textPrimary }}>{t("rescue.openEditor")}</Text>
        </Pressable>
        <Pressable onPress={onUndo} style={styles.secondary}>
          <Undo2 size={16} color={colors.textSecondary} />
          <Text style={{ color: colors.textSecondary }}>{t("rescue.undo")}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 },
  title: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  sub: { fontSize: 14, textAlign: "center" },
  cta: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignSelf: "stretch",
    marginTop: 10,
  },
  ctaText: { fontSize: 16, fontWeight: "600" },
  secondary: { flexDirection: "row", gap: 8, alignItems: "center", padding: 10 },
});
