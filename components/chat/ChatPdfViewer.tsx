import { useEffect, useState } from "react";
import { View, Text, Modal, Pressable, ActivityIndicator, StyleSheet, Alert } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets, initialWindowMetrics } from "react-native-safe-area-context";
import { X, Download } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { PdfView } from "@/components/workspace/PdfView";
import { getThesisPdf, deleteThesisPdf, type ThesisPdfDTO } from "@/lib/api";
import { downloadExport } from "@/lib/download-export";

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
            <ActivityIndicator size="large" color="#FFFFFF" />
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
