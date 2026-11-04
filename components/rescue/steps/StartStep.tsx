import React, { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { ArrowUp } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hSelection } from "@/lib/haptics";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { listRescueProjects } from "@/lib/rescue-v2-api";
import { keepDocx, partsRefusal } from "@/lib/rescue-v2-pick";
import { scaleFor } from "@/lib/rescue-v2-layout";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import { SheetBody, SheetTitle, TrustList } from "../ui";
import { SkeletonPage } from "../SkeletonPage";
import type { RescueStep } from "./index";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Screen 1: the picker's one job. A dashed page where the file will land, two skeleton pages either side. */
function Stage() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  return (
    <View style={styles.stage}>
      <View style={[styles.side, { opacity: 0.5 }]}><SkeletonPage width={84 * s} height={120 * s} /></View>
      <View
        style={[
          styles.drop,
          { width: 122 * s, height: 170 * s, borderColor: colors.borderDefault },
        ]}
      >
        <View style={[styles.arrowTile, { backgroundColor: colors.brandPrimary }]}>
          <ArrowUp size={20} color={colors.bgCard} strokeWidth={2.5} />
        </View>
      </View>
      <View style={[styles.side, { opacity: 0.5 }]}><SkeletonPage width={84 * s} height={120 * s} /></View>
    </View>
  );
}

function Sheet() {
  const { t } = useTranslation();
  const trust = PURCHASES_HIDDEN
    ? [t("rescueV2.start.trustFreeStatus"), t("rescueV2.start.trustWords"), t("rescueV2.start.trustOriginal")]
    : [t("rescueV2.start.trustFree"), t("rescueV2.start.trustWords"), t("rescueV2.start.trustOriginal")];
  return (
    <View>
      <SheetTitle>{t("rescueV2.start.title")}</SheetTitle>
      <SheetBody>{t(PURCHASES_HIDDEN ? "rescueV2.start.bodyStatus" : "rescueV2.start.body")}</SheetBody>
      <TrustList items={trust} />
    </View>
  );
}

/**
 * The one CTA. Every refusal the student can act on is said here, in place: a wrong type, too many parts, a part too big. A failed
 * request is said by the shell's error line, which words the code (`errorWord`). A tap cannot fire twice: the ref closes the gate before
 * the picker opens, and the button shows it is busy.
 */
function Foot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const config = useRescueV2Store((s) => s.config);
  const begin = useRescueV2Store((s) => s.begin);
  const uploading = useRescueV2Store((s) => s.upload !== null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const gate = useRef(false);

  // A config that never loaded does not hold the CTA: the server enforces the same limits, and its answer lands on the error line.
  const disabled = config?.enabled === false || uploading || pending;

  /** `rescue_one_in_progress`: open the project the student already has, and fall back to the list when the answer names none. */
  const openInProgress = async () => {
    const st = useRescueV2Store.getState();
    if (st.errorCode !== "rescue_one_in_progress") return;
    let pid = st.errorInfo?.projectId ?? null;
    if (!pid) {
      try {
        const r = await listRescueProjects();
        pid = r.projects.find((p) => p.phase !== "done")?.id ?? null;
      } catch {
        pid = null;
      }
    }
    if (pid) void st.open(pid);   // a switch clears the error line, and the project's own screen takes over
    else setNotice(t("rescueV2.start.inProgress"));
  };

  const onPress = async () => {
    if (gate.current || disabled) return;
    gate.current = true;
    setPending(true);
    hSelection();
    setNotice(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: [DOCX_MIME], multiple: true, copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return;
      const files = keepDocx(res.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size ?? 0 })));
      if (files.length === 0) {
        setNotice(t("rescueV2.start.notDocx"));
        return;
      }
      const refusal = config ? partsRefusal(files, config.limits) : null;
      if (refusal?.key === "tooMany") { setNotice(t("rescueV2.start.tooMany")); return; }
      if (refusal?.key === "tooLarge") { setNotice(t("rescueV2.start.tooLarge", { mb: refusal.mb })); return; }
      const ok = await begin(files, "picker");
      if (!ok) await openInProgress();
    } catch {
      setNotice(t("rescueV2.common.somethingWrong"));
    } finally {
      gate.current = false;
      setPending(false);
    }
  };

  return (
    <View style={styles.foot}>
      {notice ? <Text style={[styles.notice, { color: colors.semanticError }]}>{notice}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => { void onPress(); }}
        style={[styles.cta, { backgroundColor: colors.brandPrimary, opacity: disabled ? 0.5 : 1 }]}
      >
        <Text style={[styles.ctaText, { color: colors.bgCard }]}>{t("rescueV2.start.cta")}</Text>
      </Pressable>
      {config && !config.enabled ? <Text style={[styles.fine, { color: colors.textSecondary }]}>{t("rescueV2.unavailable")}</Text> : null}
      <Text style={[styles.fine, { color: colors.textSecondary }]}>{t("rescueV2.start.share")}</Text>
      <Text style={[styles.fine, { color: colors.textSecondary }]}>{t("rescueV2.start.severalHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  side: { alignSelf: "center" },
  drop: { borderWidth: 2, borderStyle: "dashed", borderRadius: 3, alignItems: "center", justifyContent: "center" },
  arrowTile: { width: 40, height: 40, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  foot: { gap: 6, paddingBottom: 10 },
  notice: { fontSize: 13, lineHeight: 18 },
  cta: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  ctaText: { fontSize: 16, fontWeight: "800" },
  fine: { fontSize: 12, textAlign: "center" },
});

export const StartStep: RescueStep = { Stage, Sheet, Foot };
