import React, { useEffect, useRef, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { hSuccess } from "@/lib/haptics";
import { loadImpact } from "@/lib/rescue-v2-impact";
import { editedWarningShown, restoreImpactLine } from "@/lib/rescue-v2-history";
import { visualTextAlign } from "@/lib/rtl-layout";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useHistoryUi } from "@/stores/rescue-history-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

interface Props {
  visible: boolean;
  versionId: string;
  /** The version being brought back. */
  versionN: number;
  /** The number the restored copy will carry: it lands on top of the history. */
  nextN: number;
  thesisId: string | null;
  onClose(): void;
}

/**
 * H6. Bringing a version back adds a new version on top and deletes nothing, but it does move the thesis, so it waits for the student's
 * confirmation here. What the dialog says is read fresh each time it opens: whether the student edited in the workspace since the last
 * version (`edited`, since the project's own flag can be stale), and whether saved choices would be set back (the impact). A read that fails
 * shows its warning rather than hiding it.
 *
 * A failed restore says so in the dialog and changes nothing: the dialog stays open, the history is not touched, and the student can cancel or
 * try again. That failure is not the line's to repeat: only this dialog's own confirm repeats a restore. A transparent Modal, not a sheet: a
 * dialog over the living screen, dismissed by Android's back.
 */
export function RestoreDialog({ visible, versionId, versionN, nextN, thesisId, onClose }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const pid = useRescueV2Store((s) => s.projectId);
  const projectEdited = useRescueV2Store((s) => s.project?.editedInKwill ?? false);
  const edited = useRescueV2Store((s) => s.edited);
  const restoreVersion = useRescueV2Store((s) => s.restoreVersion);
  const setNav = useRescueV2Store((s) => s.setNav);
  const loadVersions = useRescueV2Store((s) => s.loadVersions);
  const impact = useHistoryUi((s) => (s.key === pid ? s.impact : null));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"unsaved" | "failed" | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // A ref closes the gate before the state re-renders, so a second tap in the same frame sends one restore.
  const gate = useRef(false);
  const align = { textAlign: visualTextAlign(isRTL) };

  // Read again each time the dialog opens. The read for this project stands even if the dialog closes meanwhile: its answer is the project's.
  useEffect(() => {
    if (!visible || !pid) return;
    let shown = true;
    setFailed(null);
    setRefreshFailed(false);
    void loadVersions().then((ok) => { if (shown) setRefreshFailed(!ok); });
    void loadImpact(pid, () => useRescueV2Store.getState().projectId === pid);
    return () => { shown = false; };
  }, [visible, pid, loadVersions]);

  const warnEdited = editedWarningShown(projectEdited, edited ? { edited: edited.edited } : null, refreshFailed);
  const showChoices = restoreImpactLine(impact);

  const confirm = async () => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setFailed(null);
    try {
      const outcome = await restoreVersion(versionId);
      if (outcome !== "restored") {
        setFailed(outcome === "unsaved" ? "unsaved" : "failed");
        return;
      }
      hSuccess();
      void loadVersions();
      if (thesisId) void useThesisDocStore.getState().revalidate(thesisId);
      onClose();
      setNav({ overlay: "timeline", versionId: null, compareWithId: null });
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
      <View style={styles.scrim}>
        <View style={[styles.card, { backgroundColor: colors.bgCard }]}>
          <View style={[styles.tile, { backgroundColor: colors.brandWash }]}>
            <Text style={[styles.glyph, { color: colors.brandPrimary }]}>↺</Text>
          </View>
          <Text style={[styles.title, { color: colors.textPrimary }, align]}>{t("rescueV2.restore.title", { n: versionN })}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }, align]}>{t("rescueV2.restore.body", { next: nextN })}</Text>
          {warnEdited ? (
            <Text style={[styles.body, { color: colors.textSecondary }, align]}>{t("rescueV2.restore.bodyEdited")}</Text>
          ) : null}
          {showChoices ? (
            <Text style={[styles.body, { color: colors.textSecondary }, align]}>{t("rescueV2.restore.choicesReset")}</Text>
          ) : null}
          {failed ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: colors.semanticError }, align]}>
              {t(failed === "unsaved" ? "rescueV2.restore.unsaved" : "rescueV2.restore.failed")}
            </Text>
          ) : null}
          <Button title={t("rescueV2.restore.confirm")} onPress={() => { void confirm(); }} loading={busy} disabled={busy} />
          <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onClose} hitSlop={8} style={styles.cancel}>
            <Text style={[styles.cancelText, { color: colors.brandPrimary }]}>{t("rescueV2.restore.cancel")}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 380, borderRadius: 22, padding: 22, gap: 10 },
  tile: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  glyph: { fontSize: 24, fontWeight: "700" },
  title: { fontSize: 18, fontWeight: "800", lineHeight: 24 },
  body: { fontSize: 14, lineHeight: 21 },
  error: { fontSize: 13, lineHeight: 18 },
  cancel: { alignSelf: "center", paddingVertical: 10 },
  cancelText: { fontSize: 15, fontWeight: "700" },
});
