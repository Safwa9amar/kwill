import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Camera, FileText } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "@/components/BottomSheet";
import { UniversityPicker } from "@/components/UniversityPicker";
import { useThemeColors } from "@/hooks/useThemeColors";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { removeGuide, updateSetup, uploadGuide } from "@/lib/rescue-v2-api";
import { guideMime } from "@/lib/rescue-v2-pick";
import { scaleFor, STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import { PageCarousel } from "../PageCarousel";
import { SkeletonPage } from "../SkeletonPage";
import { SheetBody, SheetTitle, Pill } from "../ui";
import type { RescueStep } from "./index";

const MB = 1024 * 1024;

/** Screen 4, the stage: three small pages of v0, the thesis as it is. */
function Stage() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const versionId = useRescueV2Store((st) => st.project?.originalVersionId ?? null);
  if (!versionId) {
    return (
      <View style={styles.stage}>
        <SkeletonPage width={56 * s} height={80 * s} />
        <SkeletonPage width={80 * s} height={112 * s} />
        <SkeletonPage width={56 * s} height={80 * s} />
      </View>
    );
  }
  return (
    <View style={[styles.stage, { backgroundColor: colors.rescueStageBottom }]}>
      <PageCarousel versionId={versionId} page={1} layout={STAGE_LAYOUT.rules_choice} />
    </View>
  );
}

/** Keyed by project: the profile offer's dismissal and the sheets' state belong to one project. */
function Sheet() {
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  return <RulesChoice key={id ?? "none"} />;
}

function RulesChoice() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  const setup = useRescueV2Store((s) => s.project?.setup ?? null);
  const apply = useRescueV2Store((s) => s.apply);
  const [declined, setDeclined] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removeGate = useRef(false);

  const pickUniversity = (uid: string) => {
    if (!id) return;
    useBottomSheet.getState().closeSheet("rescue-university");
    void apply(() => updateSetup(id, { universityId: uid }));
  };

  const onRemoveGuide = async () => {
    if (removeGate.current || !id) return;
    removeGate.current = true;
    setRemoving(true);
    try {
      await apply(() => removeGuide(id));
    } finally {
      removeGate.current = false;
      setRemoving(false);
    }
  };

  const offer = setup?.profileOffer ?? null;
  const guide = setup?.guide.state ?? "none";

  return (
    <View>
      <SheetTitle>{t("rescueV2.whichRules.title")}</SheetTitle>

      {setup?.universityName ? (
        <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.borderDefault }]}>
          <View style={styles.cardText}>
            <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{setup.universityName}</Text>
            {setup.fromProfile ? <Text style={[styles.sub, { color: colors.textSecondary }]}>{t("rescueV2.whichRules.fromProfile")}</Text> : null}
          </View>
          <Pressable accessibilityRole="button" onPress={() => useBottomSheet.getState().openSheet("rescue-university")} hitSlop={8}>
            <Text style={[styles.link, { color: colors.brandPrimary }]}>{t("rescueV2.whichRules.change")}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => useBottomSheet.getState().openSheet("rescue-university")}
          style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.borderDefault }]}
        >
          <Text style={[styles.cardTitle, { color: colors.brandPrimary }]}>{t("rescueV2.whichRules.pickUniversity")}</Text>
        </Pressable>
      )}

      {offer && declined !== offer.id ? (
        <View style={[styles.card, { backgroundColor: colors.brandWash, borderColor: colors.brandPrimary, flexDirection: "column", alignItems: "stretch" }]}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{t("rescueV2.whichRules.profileOffer", { name: offer.name })}</Text>
          <View style={styles.choices}>
            <Pressable
              accessibilityRole="button"
              onPress={() => { if (id) void apply(() => updateSetup(id, { normProfileId: offer.id })); }}
              style={[styles.choice, { backgroundColor: colors.brandPrimary }]}
            >
              <Text style={[styles.choiceText, { color: colors.bgCard }]}>{t("rescueV2.whichRules.profileYes")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setDeclined(offer.id)}
              style={[styles.choice, { borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgCard }]}
            >
              <Text style={[styles.choiceText, { color: colors.textPrimary }]}>{t("rescueV2.whichRules.profileNo")}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {guide === "reading" ? (
        <View style={[styles.card, { borderStyle: "dashed", borderColor: colors.borderDefault }]}>
          <ActivityIndicator color={colors.brandPrimary} />
          <Text style={[styles.cardTitle, { color: colors.textPrimary, flex: 1 }]}>{t("rescueV2.whichRules.guideReading")}</Text>
        </View>
      ) : guide === "read" ? (
        <View style={[styles.card, { backgroundColor: colors.successWash, borderColor: colors.semanticSuccess }]}>
          <View style={styles.cardText}>
            <Pill label={t("rescueV2.whichRules.guideRead")} tone="success" />
            {setup?.guide.filename ? <Text style={[styles.sub, { color: colors.textSecondary }]}>{setup.guide.filename}</Text> : null}
          </View>
          <Pressable accessibilityRole="button" disabled={removing} onPress={() => { void onRemoveGuide(); }} hitSlop={8}>
            <Text style={[styles.link, { color: colors.brandPrimary, opacity: removing ? 0.5 : 1 }]}>{t("rescueV2.whichRules.guideRemove")}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => useBottomSheet.getState().openSheet("rescue-guide")}
          style={[styles.card, { borderStyle: "dashed", borderColor: colors.borderDefault }]}
        >
          <View style={[styles.guideIcon, { backgroundColor: colors.bgSurface }]}>
            <FileText size={18} color={colors.brandPrimary} strokeWidth={2} />
          </View>
          <View style={styles.cardText}>
            <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{t("rescueV2.whichRules.guideTitle")}</Text>
            <Text style={[styles.sub, { color: colors.textSecondary }]}>
              {guide === "failed" ? t("rescueV2.whichRules.guideFailed") : t("rescueV2.whichRules.guideBody")}
            </Text>
          </View>
          <Pill label={t("rescueV2.whichRules.optional")} />
        </Pressable>
      )}

      <BottomSheet name="rescue-university" snapPoints={["60%", "92%"]} keyboardBehavior="extend">
        <View style={styles.pickerBody}>
          <UniversityPicker sheet value={setup?.universityId ?? null} onChange={(uid) => pickUniversity(uid)} />
        </View>
      </BottomSheet>

      <BottomSheet name="rescue-guide" keyboardBehavior="extend">
        <GuideSheet />
      </BottomSheet>
    </View>
  );
}

/**
 * The guide's two ways in: a photo or a file. Mounted only while open, so its failure line and busy state start clean each time. The sheet
 * closes only once the guide is accepted; a refusal stays on screen with the way to try again.
 */
function GuideSheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  const guideMb = useRescueV2Store((s) => s.config?.limits.guideMb ?? null);
  const apply = useRescueV2Store((s) => s.apply);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const gate = useRef(false);

  const send = async (uri: string, name: string, type: string, size: number) => {
    if (!id) return;
    if (guideMb !== null && size > guideMb * MB) {
      setFailure(t("rescueV2.start.tooLarge", { mb: guideMb }));
      return;
    }
    gate.current = true;
    setPending(true);
    setFailure(null);
    try {
      const ok = await apply(() => uploadGuide(id, uri, name, type));
      // A refused or failed guide stays on this sheet, with its own line, so the student sees why and can try again.
      if (ok) useBottomSheet.getState().closeSheet("rescue-guide");
      else setFailure(t("rescueV2.whichRules.guideFailed"));
    } finally {
      gate.current = false;
      setPending(false);
    }
  };

  const onCamera = async () => {
    if (gate.current) return;
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { setFailure(t("rescueV2.whichRules.guideFailed")); return; }
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      const name = a.fileName ?? "guide.jpg";
      await send(a.uri, name, guideMime(name, a.mimeType), 0);
    } catch {
      setFailure(t("rescueV2.whichRules.guideFailed"));
    }
  };

  const onFile = async () => {
    if (gate.current) return;
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*"], multiple: false, copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      await send(a.uri, a.name, guideMime(a.name, a.mimeType), a.size ?? 0);
    } catch {
      setFailure(t("rescueV2.whichRules.guideFailed"));
    }
  };

  return (
    <View style={styles.guideBody}>
      <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{t("rescueV2.whichRules.guideTitle")}</Text>
      <SheetBody>{t("rescueV2.whichRules.guideBody")}</SheetBody>
      {failure ? <Text style={[styles.sub, { color: colors.semanticError }]}>{failure}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={pending}
        onPress={() => { void onCamera(); }}
        style={[styles.guideRow, { borderColor: colors.borderDefault, backgroundColor: colors.bgSurface, opacity: pending ? 0.5 : 1 }]}
      >
        <Camera size={18} color={colors.brandPrimary} strokeWidth={2} />
        <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{t("rescueV2.whichRules.guideCamera")}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={pending}
        onPress={() => { void onFile(); }}
        style={[styles.guideRow, { borderColor: colors.borderDefault, backgroundColor: colors.bgSurface, opacity: pending ? 0.5 : 1 }]}
      >
        <FileText size={18} color={colors.brandPrimary} strokeWidth={2} />
        <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{t("rescueV2.whichRules.guideFile")}</Text>
      </Pressable>
      {pending ? <Text style={[styles.sub, { color: colors.textSecondary }]}>{t("rescueV2.whichRules.guideReading")}</Text> : null}
    </View>
  );
}

/** The CTA only moves to the notes; nothing starts until the student's notes step asks. */
function Foot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const setNav = useRescueV2Store((s) => s.setNav);
  return (
    <View style={styles.foot}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setNav({ setupStep: "notes" })}
        style={[styles.cta, { backgroundColor: colors.brandPrimary }]}
      >
        <Text style={[styles.ctaText, { color: colors.bgCard }]}>
          {t(PURCHASES_HIDDEN ? "rescueV2.whichRules.ctaStatus" : "rescueV2.whichRules.cta")}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  card: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10 },
  cardText: { flex: 1, gap: 2 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  sub: { fontSize: 12, lineHeight: 17 },
  link: { fontSize: 13, fontWeight: "700" },
  guideIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  choices: { flexDirection: "row", gap: 8, marginTop: 10 },
  choice: { flex: 1, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  choiceText: { fontSize: 13, fontWeight: "700" },
  pickerBody: { height: 520 },
  guideBody: { gap: 10, paddingBottom: 8 },
  guideRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, padding: 14 },
  foot: { paddingBottom: 10 },
  cta: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  ctaText: { fontSize: 16, fontWeight: "800" },
});

export const WhichRulesStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };
