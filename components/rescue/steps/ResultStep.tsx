import React, { useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { DoneBadge } from "@/components/rescue/DoneBadge";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { SheetTitle, WashCard } from "@/components/rescue/ui";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { downloadExport } from "@/lib/download-export";
import { getVersionFile } from "@/lib/rescue-v2-api";
import { packView, type PackView } from "@/lib/rescue-v2-finish";
import { scaleFor, STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useThesisStore } from "@/stores/thesis-store";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueStep } from "./index";

/** Screen 15, the stage: the new version's pages, interactive. The page on show starts at the second page, per version. */
function Stage() {
  const versionId = useRescueV2Store((s) => s.project?.currentVersion?.id ?? null);
  const [view, setView] = useState<{ key: string; page: number } | null>(null);
  const layout = STAGE_LAYOUT.result;
  if (!versionId || layout.kind !== "three") return null;
  const page = view && view.key === versionId ? view.page : 2;
  return (
    <View style={styles.stage}>
      <PageCarousel
        versionId={versionId}
        page={page}
        layout={layout}
        interactive
        onChange={(p) => setView({ key: versionId, page: p })}
        midDecor={<DoneBadge />}
      />
    </View>
  );
}

/** Fetches one file by its kind and hands it to the OS. Any failure throws: the caller shows that it failed, never that it was saved. */
async function fetchAndShare(versionId: string, kind: "pdf" | "docx" | "deposit"): Promise<void> {
  const file = await getVersionFile(versionId, kind);
  await downloadExport(file);
}

function DownloadCard({ tile, color, label, busy, disabled, onPress }: {
  tile: string; color: string; label: string; busy: boolean; disabled: boolean; onPress: () => void;
}) {
  const colors = useThemeColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.borderDefault, opacity: disabled && !busy ? 0.5 : 1 }]}
    >
      <View style={[styles.tile, { backgroundColor: color }]}>
        <Text style={[styles.tileText, { color: colors.bgCard }]}>{tile}</Text>
      </View>
      <Text style={[styles.cardLabel, { color: colors.textPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Screen 15's sheet. Keyed by the project, so a download's failure and busy state never carry to another project. */
function Sheet() {
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  return <ResultSheet key={id ?? "none"} />;
}

function ResultSheet() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const project = useRescueV2Store((s) => s.project);
  const beginRerun = useRescueV2Store((s) => s.beginRerun);
  const cv = project?.currentVersion ?? null;
  const [busy, setBusy] = useState<"pdf" | "docx" | "deposit" | "rebuild" | null>(null);
  const [failed, setFailed] = useState(false);
  // A ref closes the gate before the state re-renders, so a second tap in the same frame cannot start a second download.
  const gate = useRef(false);
  if (!project || !cv) return null;

  const exists = (k: string) => i18n.exists(k);
  const pack: PackView | null = packView(cv.pack, exists);

  const download = async (kind: "pdf" | "docx" | "deposit") => {
    if (gate.current) return;
    gate.current = true;
    setBusy(kind);
    setFailed(false);
    try {
      await fetchAndShare(cv.id, kind);
    } catch {
      setFailed(true);
    } finally {
      gate.current = false;
      setBusy(null);
    }
  };

  const rebuild = async () => {
    if (gate.current) return;
    gate.current = true;
    setBusy("rebuild");
    try {
      // A pack_rebuilt re-run: free, from deposit on. The shell shows a failure; the repair itself is screen 13.
      await beginRerun([]);
    } finally {
      gate.current = false;
      setBusy(null);
    }
  };

  const align = { textAlign: visualTextAlign(isRTL) };
  const lockedOut = busy !== null;

  return (
    <>
      <SheetTitle>{t("rescueV2.result.title")}</SheetTitle>
      <Text style={[styles.stats, { color: colors.textPrimary }, align]}>{t("rescueV2.result.stats", { pages: cv.pages, fixes: cv.fixes })}</Text>
      <Text style={[styles.muted, { color: colors.textSecondary }, align]}>{t("rescueV2.result.words")}</Text>

      <View style={[styles.cards, { flexDirection: visualRow(isRTL) }]}>
        <DownloadCard tile="PDF" color={colors.semanticError} label={t("rescueV2.result.packFiles.thesis-pdf")} busy={busy === "pdf"} disabled={lockedOut} onPress={() => { void download("pdf"); }} />
        <DownloadCard tile="DOCX" color={colors.brandPrimary} label={t("rescueV2.result.packFiles.thesis-docx")} busy={busy === "docx"} disabled={lockedOut} onPress={() => { void download("docx"); }} />
      </View>
      {failed ? <Text style={[styles.error, { color: colors.semanticError }, align]}>{t("rescueV2.result.downloadFailed")}</Text> : null}

      {pack ? (
        <WashCard>
          <Text style={[styles.packTitle, { color: colors.textPrimary }, align]}>{t("rescueV2.result.packTitle")}</Text>
          {pack.mode !== "missing" && pack.files.length > 0 ? (
            <Text style={[styles.packLine, { color: colors.textPrimary }, align]}>{pack.files.map((k) => t(k)).join(" · ")}</Text>
          ) : null}
          {pack.noAbstracts ? <Text style={[styles.muted, { color: colors.textSecondary }, align]}>{t("rescueV2.result.packNoAbstracts")}</Text> : null}
          {pack.zipTooLarge ? <Text style={[styles.packLine, { color: colors.textPrimary }, align]}>{t("rescueV2.result.packZipTooLarge")}</Text> : null}
          {pack.mode === "partial" && pack.omitted ? (
            <Text style={[styles.packLine, { color: colors.textPrimary }, align]}>{t("rescueV2.result.packOmitted", { files: pack.omitted.map((k) => t(k)).join(" · ") })}</Text>
          ) : null}
          {pack.mode === "missing" || (pack.mode === "partial" && !pack.omitted) ? (
            <Text style={[styles.packLine, { color: colors.textPrimary }, align]}>{t("rescueV2.result.packMissing")}</Text>
          ) : null}
          <View style={[styles.packRow, { flexDirection: visualRow(isRTL) }]}>
            {pack.share ? (
              <Button
                title={t("rescueV2.result.share")}
                variant="secondary"
                loading={busy === "deposit"}
                disabled={lockedOut && busy !== "deposit"}
                onPress={() => { void download("deposit"); }}
              />
            ) : null}
            {pack.rebuild ? (
              <Button
                title={t("rescueV2.result.packRebuild")}
                variant="secondary"
                loading={busy === "rebuild"}
                disabled={lockedOut && busy !== "rebuild"}
                onPress={() => { void rebuild(); }}
              />
            ) : null}
          </View>
        </WashCard>
      ) : null}

      {!cv.published ? (
        <WashCard>
          <Text style={[styles.packLine, { color: colors.textPrimary }, align]}>{t("rescueV2.result.notPublished")}</Text>
        </WashCard>
      ) : null}
    </>
  );
}

/** The links to what changed, the history and the supervisor's page, and the way back into the workspace. */
function Foot() {
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  return <ResultFoot key={id ?? "none"} />;
}

function ResultFoot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const project = useRescueV2Store((s) => s.project);
  const setNav = useRescueV2Store((s) => s.setNav);
  const cv = project?.currentVersion ?? null;
  const thesisId = project?.thesisId ?? null;
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const gate = useRef(false);
  if (!project || !cv) return null;

  // The order matters: the workspace reads its params and redirects to chat without them (thesis-workspace.tsx:628). After a re-run or a
  // restore the working copy is revalidated too, because every index moved (P-66).
  const open = async () => {
    if (gate.current || !thesisId) return;
    gate.current = true;
    setOpening(true);
    setOpenFailed(false);
    try {
      await useThesisStore.getState().refreshTheses();
      useThesisStore.getState().setCurrentThesis(thesisId);
      void useThesisDocStore.getState().revalidate(thesisId);
      router.push({ pathname: "/(app)/thesis-workspace", params: { thesisId } });
    } catch {
      setOpenFailed(true);
    } finally {
      gate.current = false;
      setOpening(false);
    }
  };

  const links: { label: string; onPress: () => void }[] = [
    { label: t("rescueV2.result.changed", { count: cv.fixes }), onPress: () => setNav({ overlay: "changed" }) },
    { label: t("rescueV2.result.history"), onPress: () => setNav({ overlay: "timeline" }) },
    { label: t("rescueV2.result.revisions"), onPress: () => setNav({ overlay: "revisions" }) },
  ];

  return (
    <View style={styles.foot}>
      <View style={[styles.links, { flexDirection: visualRow(isRTL) }]}>
        {links.map((l) => (
          <TouchableOpacity key={l.label} accessibilityRole="button" onPress={l.onPress} hitSlop={6}>
            <Text style={[styles.link, { color: colors.brandPrimary }]}>{l.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {thesisId ? <Button title={t("rescueV2.result.open")} onPress={() => { void open(); }} loading={opening} /> : null}
      {openFailed ? <Text style={[styles.error, { color: colors.semanticError }]}>{t("rescueV2.result.openFailed")}</Text> : null}
    </View>
  );
}

export const ResultStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  stats: { fontSize: 15, lineHeight: 21, fontWeight: "600", marginBottom: 4 },
  muted: { fontSize: 13, lineHeight: 19, marginBottom: 12 },
  cards: { gap: 10, marginBottom: 12 },
  card: { flex: 1, borderWidth: 1, borderRadius: 16, padding: 12, gap: 8, alignItems: "flex-start" },
  tile: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  tileText: { fontSize: 12, fontWeight: "800" },
  cardLabel: { fontSize: 14, fontWeight: "700" },
  error: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  packTitle: { fontSize: 14, fontWeight: "800", marginBottom: 6 },
  packLine: { fontSize: 13, lineHeight: 19, marginBottom: 6 },
  packRow: { gap: 8, marginTop: 6, flexWrap: "wrap" },
  foot: { gap: 8, paddingBottom: 10 },
  links: { gap: 16, justifyContent: "center", flexWrap: "wrap" },
  link: { fontSize: 14, fontWeight: "700" },
});
