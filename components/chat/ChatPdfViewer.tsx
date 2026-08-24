import { useEffect, useState } from "react";
import { View, Text, Modal, Pressable, ActivityIndicator, StyleSheet, Alert } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets, initialWindowMetrics } from "react-native-safe-area-context";
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from "react-native-reanimated";
import { X, Download } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { PdfView } from "@/components/workspace/PdfView";
import { getThesisPdf, deleteThesisPdf, type ThesisPdfDTO } from "@/lib/api";
import { downloadExport } from "@/lib/download-export";
import { formatElapsed } from "@/lib/thinking";

/**
 * Full-screen PDF preview reachable from the chat's ⋯ menu, without leaving
 * the conversation for the Writer. Same throwaway-preview contract as the
 * workspace's PDF tab (thesis-pdf.ts): converted on open, discarded on close —
 * nothing here is a persisted artifact.
 *
 * Body lives under the Modal-local SafeAreaProvider — a Modal renders in its
 * own native window, so the ROOT provider's insets don't reach it. Same
 * arrangement as ChatImageViewer/MessageViewer.
 */
export function ChatPdfViewer({
  visible,
  thesisId,
  title,
  onClose,
}: {
  visible: boolean;
  thesisId: string | null;
  title?: string;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible && !!thesisId}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        {/* Keyed on thesisId so opening a DIFFERENT thesis remounts the body —
            otherwise the previous PDF's doc/loading state would flash first. */}
        <ViewerBody key={thesisId ?? "none"} thesisId={thesisId} title={title} onClose={onClose} />
      </SafeAreaProvider>
    </Modal>
  );
}

// Converting a real thesis through Word takes 15-40+ seconds (a synchronous,
// single round trip — the server has no incremental progress to report), so a
// bare spinner reads as a hang well before it's actually done. This estimates
// instead of lying about real progress: the fill EASES toward 92% over
// ESTIMATED_MS and holds there — never claims 100% while still waiting — then
// the caller animates the rest of the way in on success. The status line
// escalates in step, so a document that genuinely runs long still reads as
// "still working" rather than "broken".
const ESTIMATED_MS = 22_000;
const HOLD_AT = 0.92;

function ConversionProgress({ ink, accent }: { ink: string; accent: string }) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const fill = useSharedValue(0);

  useEffect(() => {
    fill.value = withTiming(HOLD_AT, { duration: ESTIMATED_MS, easing: Easing.out(Easing.cubic) });
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const barStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }));

  const label =
    elapsed >= 35_000
      ? t("workspace.pdfConvertingLong", { defaultValue: "Still converting — a long thesis can take a bit longer." })
      : t("workspace.pdfConverting", { defaultValue: "Converting your thesis to PDF…" });

  return (
    <View style={styles.progressWrap}>
      <Text style={[styles.progressLabel, { color: ink }]}>{label}</Text>
      <View style={[styles.progressTrack, { backgroundColor: "rgba(255,255,255,0.15)" }]}>
        <Animated.View style={[styles.progressFill, { backgroundColor: accent }, barStyle]} />
      </View>
      <Text style={[styles.progressClock, { color: ink }]}>{formatElapsed(elapsed)}</Text>
    </View>
  );
}

function ViewerBody({ thesisId, title, onClose }: { thesisId: string | null; title?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [doc, setDoc] = useState<ThesisPdfDTO | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!thesisId) return;
    let cancelled = false;
    setDoc(undefined);
    getThesisPdf(thesisId)
      .then((d) => { if (!cancelled) setDoc(d); })
      .catch(() => { if (!cancelled) setDoc({ available: false, reason: "failed" }); });
    return () => {
      cancelled = true;
      // Best-effort — a missed delete just leaves the single preview slot for
      // the next render to overwrite, same as the workspace's PDF tab.
      deleteThesisPdf(thesisId).catch(() => {});
    };
  }, [thesisId]);

  async function handleDownload() {
    if (!doc?.available || downloading) return;
    setDownloading(true);
    try {
      await downloadExport({ url: doc.url, filename: doc.filename, format: "pdf", title });
    } catch {
      Alert.alert(t("common.error"), t("preview.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.body}>
        {doc === undefined ? (
          <View style={styles.centered}>
            <ConversionProgress ink="#FFFFFF" accent={colors.brandPrimaryLight} />
          </View>
        ) : doc.available ? (
          <PdfView url={doc.url} />
        ) : (
          <View style={styles.centered}>
            <Text style={styles.errText}>
              {doc.reason === "failed"
                ? t("workspace.pdfFailed", { defaultValue: "Couldn't generate the PDF. Please try again." })
                : t("workspace.pdfUnavailable", { defaultValue: "PDF preview isn't available for this document." })}
            </Text>
          </View>
        )}
      </View>
      <View style={[styles.bar, { top: insets.top }]} pointerEvents="box-none">
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t("common.close", { defaultValue: "Close" })}
          style={styles.barButton}
        >
          <X size={22} color="#FFFFFF" strokeWidth={2} />
        </Pressable>
        <Pressable
          onPress={() => void handleDownload()}
          disabled={!doc?.available || downloading}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t("chat.downloadFormat", { format: "PDF", defaultValue: "Download PDF" })}
          style={[styles.barButton, (!doc?.available || downloading) && styles.barButtonDisabled]}
        >
          {downloading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Download size={20} color="#FFFFFF" strokeWidth={2} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000000" },
  body: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  errText: { color: "#FFFFFF", fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
  progressWrap: { width: "100%", maxWidth: 280, alignItems: "center" },
  progressLabel: { fontSize: 14, fontFamily: "Inter_500Medium", textAlign: "center", marginBottom: 16 },
  progressTrack: { width: "100%", height: 4, borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 2 },
  // Digits stay LTR in every locale, same rule as AiWorkingNote's clock — a
  // running m:ss must never reorder in an Arabic build.
  progressClock: {
    marginTop: 10,
    fontSize: 11.5,
    fontFamily: "Inter_400Regular",
    fontVariant: ["tabular-nums"],
    writingDirection: "ltr",
    opacity: 0.7,
  },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  barButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  barButtonDisabled: { opacity: 0.5 },
});
