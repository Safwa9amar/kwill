import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useLocalSearchParams } from "expo-router";
import { useThemeColors } from "@/hooks/useThemeColors";
import { BackButton } from "@/components/BackButton";
import { useThesisStore } from "@/stores/thesis-store";
import { supabase } from "@/lib/supabase";

// TRIAL screen: the eigenpal docx-editor, hosted from the WEB app in a WebView.
// Reached from Settings → Developer → Word Editor (dev builds only), the same
// way the Lexical spikes are.
//
// Why a WebView onto the web app rather than the editor bundled in here: the
// editor is ~16MB of ESM-only packages plus a HarfBuzz wasm and font bytes that
// have to resolve from a local origin. Bundling it through Metro is a project;
// pointing at the page that already runs it is an afternoon, and it puts the
// EXACT build the web app ships under a real phone's finger — which is the only
// question this trial asks. Nothing here is integrated with the AI, the op
// queue or block indices; see the header of the web WordEditorTrial for what
// that costs.
//
// ⚠️ The editor saves WHOLE BYTES, last-writer-wins. Do not run an AI turn on
// the same thesis while this screen is open.

const WEB_URL = (process.env.EXPO_PUBLIC_WEB_URL ?? "").replace(/\/$/, "");

export default function WordTrialScreen() {
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ thesisId?: string }>();
  const [thesisId, setThesisId] = useState<string | null>(params.thesisId ?? null);

  // The URL is built ASYNCHRONOUSLY (it needs a fresh token), so it is state
  // rather than a memo, and null until it is ready.
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Zustand: a primitive selector. `s => s.theses` is the store's own array
  // reference, stable between sets — a projection like `{list: s.theses}` would
  // be a fresh object every render and blow the update depth.
  const theses = useThesisStore((s) => s.theses);
  const refreshTheses = useThesisStore((s) => s.refreshTheses);

  useEffect(() => {
    if (!thesisId) void refreshTheses();
  }, [thesisId, refreshTheses]);

  const openThesis = useCallback((id: string) => {
    setUri(null);
    setError(null);
    setThesisId(id);
  }, []);

  useEffect(() => {
    if (!thesisId) return;
    if (!WEB_URL) {
      setError(
        "EXPO_PUBLIC_WEB_URL is not set. Point it at the machine running `next dev` " +
          "in ~/kwill-dashboard — a phone cannot reach localhost.",
      );
      return;
    }

    let cancelled = false;
    void (async () => {
      // getSession, not the auth store's cached copy: this refreshes an expired
      // access token first. A stale one would reach the bridge and fail there,
      // where the only remedy on offer is a login form.
      const { data, error: err } = await supabase.auth.getSession();
      if (cancelled) return;
      const session = data.session;
      if (err || !session) {
        setError(err?.message ?? "No session — sign in again.");
        return;
      }

      // Tokens ride in the FRAGMENT. A fragment is never sent to a server, so
      // it cannot land in an access log or a Referer header the way a query
      // string would. The bridge (/app/session) reads it, calls setSession to
      // write the SSR cookies the web app is gated on, then forwards to `next`.
      const frag = new URLSearchParams({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        next: `/app/${thesisId}/word`,
      });
      setUri(`${WEB_URL}/app/session#${frag.toString()}`);
    })();

    return () => {
      cancelled = true;
    };
  }, [thesisId]);

  const header = (
    <View style={[styles.header, { borderBottomColor: colors.borderDefault }]}>
      <BackButton />
      <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
        Word Editor (trial)
      </Text>
    </View>
  );

  const body = useMemo(() => {
    if (error) {
      return (
        <View style={styles.centered}>
          <Text style={[styles.error, { color: colors.semanticError }]}>{error}</Text>
        </View>
      );
    }

    // No thesis chosen yet — pick one.
    if (!thesisId) {
      return (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            Choose a thesis to open in the docx-editor. Only a live .docx will render;
            anything else reports so on the page.
          </Text>
          {theses.length === 0 ? (
            <ActivityIndicator color={colors.brandPrimary} style={styles.spinner} />
          ) : (
            theses.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => openThesis(t.id)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    backgroundColor: pressed ? colors.bgSurface : colors.bgCard,
                    borderColor: colors.borderDefault,
                  },
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
      );
    }

    if (!uri) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      );
    }

    return (
      <WebView
        source={{ uri }}
        style={styles.web}
        // The editor is a full web app: it needs storage for its own state, and
        // the session the bridge writes is a COOKIE, which must survive the
        // in-page redirect from /app/session to the editor route.
        domStorageEnabled
        javaScriptEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        // It paints its own pages and manages its own scrolling; letting the
        // WebView also bounce would fight the paginator.
        bounces={false}
        // Surfaces the page's console in Metro — the editor reports a failed
        // font load or a wasm fallback there, and a silent fallback would make
        // this trial measure nothing.
        onMessage={() => {}}
        renderLoading={() => (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.brandPrimary} />
          </View>
        )}
        startInLoadingState
        onError={(e) => setError(e.nativeEvent.description ?? "WebView failed to load")}
        onHttpError={(e) =>
          setError(`${e.nativeEvent.statusCode} from ${e.nativeEvent.url}`)
        }
      />
    );
  }, [error, thesisId, uri, theses, colors, openThesis]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      {header}
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 16, fontWeight: "600" },
  web: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  list: { padding: 16, gap: 10 },
  hint: { fontSize: 13, lineHeight: 18, marginBottom: 6 },
  spinner: { marginTop: 24 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 14, gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: "500" },
  rowMeta: { fontSize: 12 },
});
