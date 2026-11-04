import React, { useRef, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { hSuccess } from "@/lib/haptics";
import { restoreVersion } from "@/lib/rescue-v2-api";
import { visualTextAlign } from "@/lib/rtl-layout";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

interface Props {
  visible: boolean;
  versionId: string;
  /** The version being brought back. */
  versionN: number;
  /** The number the restored copy will carry: it lands on top of the history. */
  nextN: number;
  editedInKwill: boolean;
  thesisId: string | null;
  onClose(): void;
}

/**
 * H6. Bringing a version back adds a new version on top and deletes nothing, but it does move the thesis, so it waits for the student's
 * confirmation here. A failed restore says so in the dialog and changes nothing: the dialog stays open, the history is not touched, and the
 * student can cancel or try again. A transparent Modal, not a sheet: a dialog over the living screen, dismissed by Android's back.
 */
export function RestoreDialog({ visible, versionId, versionN, nextN, editedInKwill, thesisId, onClose }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const apply = useRescueV2Store((s) => s.apply);
  const setNav = useRescueV2Store((s) => s.setNav);
  const loadVersions = useRescueV2Store((s) => s.loadVersions);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A ref closes the gate before the state re-renders, so a second tap in the same frame sends one restore.
  const gate = useRef(false);
  const align = { textAlign: visualTextAlign(isRTL) };

  const confirm = async () => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const ok = await apply(() => restoreVersion(versionId));
      if (!ok) {
        setFailed(true);
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
          {editedInKwill ? (
            <Text style={[styles.body, { color: colors.textSecondary }, align]}>{t("rescueV2.restore.bodyEdited")}</Text>
          ) : null}
          {failed ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: colors.semanticError }, align]}>{t("rescueV2.restore.failed")}</Text>
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
