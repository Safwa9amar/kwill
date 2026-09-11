import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { useThemeColors } from "@/hooks/useThemeColors";
import { BackButton } from "@/components/BackButton";
import DocxEditorDom from "@/components/workspace/docx-editor/DocxEditorDom";
import { getThesisDocument } from "@/lib/api";
import { useThesisStore } from "@/stores/thesis-store";

// The docx-editor running INSIDE the app (Expo DOM component), as opposed to
// the WebView-onto-the-web-app trial in word-trial.tsx. Dev-only for now:
// Settings → Developer → Word Editor (native).
//
// What is wired: opening a thesis and rendering it at real geometry. What is
// NOT: saving, the AI, block indices, modk:// links, the op queue. Editing here
// changes nothing on the server yet.
export default function WordNativeScreen() {
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ thesisId?: string }>();
  // Opened from Settings there is no thesis yet, so this screen picks one the
  // same way word-trial.tsx does rather than dead-ending on an error.
  const [thesisId, setThesisId] = useState<string | null>(params.thesisId ?? null);
  const [docxUrl, setDocxUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Zustand: primitive selectors only — a projected object literal would be a
  // new reference every render.
  const theses = useThesisStore((s) => s.theses);
  const refreshTheses = useThesisStore((s) => s.refreshTheses);

  useEffect(() => {
    if (!thesisId) void refreshTheses();
  }, [thesisId, refreshTheses]);

  useEffect(() => {
    if (!thesisId) return;
    let cancelled = false;
    void (async () => {
      try {
        const doc = await getThesisDocument(thesisId);
        if (cancelled) return;
        if (!doc.available) {
          setError("This thesis is not a live Word document.");
          return;
        }
        setDocxUrl(doc.downloadUrl);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [thesisId]);

  const onReady = useCallback(async () => setReady(true), []);
  const onError = useCallback(async (m: string) => setError(m), []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: colors.borderDefault }]}>
        <BackButton />
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          Word Editor (native)
        </Text>
      </View>

      {error ? (
        <View style={styles.centered}>
          <Text style={[styles.error, { color: colors.semanticError }]}>{error}</Text>
        </View>
      ) : !thesisId ? (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            Choose a thesis to open in the bundled docx-editor.
          </Text>
          {theses.length === 0 ? (
            <ActivityIndicator color={colors.brandPrimary} style={styles.spinner} />
          ) : (
            theses.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setThesisId(t.id)}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? colors.bgSurface : colors.bgCard, borderColor: colors.borderDefault },
                ]}
              >
                <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={2}>
                  {t.title}
                </Text>
                <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
                  {t.language} · {t.pageCount} pages
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      ) : !docxUrl ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : (
        <View style={styles.fill}>
          <DocxEditorDom
            docxUrl={docxUrl}
            onReady={onReady}
            onError={onError}
            // The DOM component is a WebView: it needs a real box to paint in,
            // and it must NOT try to size itself to its contents — the document
            // is taller than the screen and owns its own scrolling.
            dom={{ style: { flex: 1 }, scrollEnabled: true }}
          />
          {!ready && (
            <View style={[styles.overlay, { backgroundColor: colors.bgPrimary }]}>
              <ActivityIndicator color={colors.brandPrimary} />
            </View>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  fill: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 16, fontWeight: "600" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 10 },
  hint: { fontSize: 13, lineHeight: 18, marginBottom: 6 },
  spinner: { marginTop: 24 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 14, gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: "500" },
  rowMeta: { fontSize: 12 },
});
