import React, { useEffect, useState } from "react";
import { Image, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { CoverFieldSheet } from "@/components/rescue/CoverFieldSheet";
import { SkeletonPage } from "@/components/rescue/SkeletonPage";
import { SheetBody, SheetTitle } from "@/components/rescue/ui";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { hMedium, hSelection } from "@/lib/haptics";
import { getCoverSamples, renderCoverSamples, saveCover, startRescue } from "@/lib/rescue-v2-api";
import {
  COVER_MORE_ROWS,
  COVER_PRIMARY_ROWS,
  coverLabelKey,
  coverMoreOpen,
  coverRow,
  coverSourceWord,
  missingRow,
  pickedCover,
  type CoverRowId,
} from "@/lib/rescue-v2-confirm";
import { STAGE_LAYOUT, scaleFor } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { useConfirmUi } from "@/stores/rescue-confirm-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueCoverChoice, RescueCoverDTO, RescueCoverFieldsDTO } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

type Pictures = { key: string; urls: Partial<Record<RescueCoverChoice, string>> | null; failed: boolean };

/** Sends the cover choice. It shows at once and stays when the save fails: the sheet offers the same save again. */
async function sendChoice(id: string, choice: RescueCoverChoice): Promise<void> {
  const ui = useConfirmUi.getState();
  ui.ensure(id);
  if (!ui.begin()) return;
  try {
    ui.setCoverPending(choice);
    const ok = await useRescueV2Store.getState().apply(() => saveCover(id, { choice }));
    const after = useConfirmUi.getState();
    if (ok && after.key === id) after.setCoverPending(null);
  } finally {
    useConfirmUi.getState().end();
  }
}

/** The one CTA. Refused while the choice is unsaved, so the cover started is the cover the student picked. */
async function startCover(id: string): Promise<void> {
  const ui = useConfirmUi.getState();
  ui.ensure(id);
  if (!ui.begin()) return;
  try {
    const ok = await useRescueV2Store.getState().apply(() => startRescue(id));
    if (ok) hMedium();
  } finally {
    useConfirmUi.getState().end();
  }
}

/** Starts the renders again (a failed first render, or a failed one): one lock, so a double tap sends one. */
async function renderPictures(id: string): Promise<void> {
  const ui = useConfirmUi.getState();
  ui.ensure(id);
  if (!ui.begin()) return;
  try {
    await useRescueV2Store.getState().apply(() => renderCoverSamples(id));
  } finally {
    useConfirmUi.getState().end();
  }
}

/** A row's flash when the server named it as missing: a brand wash that fades. Driven by the error object, so each new refusal flashes again. */
function useFlash(token: unknown) {
  const v = useSharedValue(0);
  useEffect(() => {
    if (!token) return;
    v.value = withSequence(withTiming(1, { duration: 150 }), withTiming(0, { duration: 900 }));
    return () => { cancelAnimation(v); v.value = 0; };
  }, [token, v]);
  return useAnimatedStyle(() => ({ opacity: v.value }));
}

function Stage() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const project = useRescueV2Store((s) => s.project);
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const id = project?.id ?? null;
  const cover = project?.cover ?? null;
  const samplesState = cover?.samples ?? null;
  const hasGenerated = !!cover?.allowedChoices.includes("generated");
  const pending = useConfirmUi((s) => (s.key === id ? s.coverPending : null));
  const busy = useConfirmUi((s) => s.busy);
  const [pictures, setPictures] = useState<Pictures | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The pictures are read once they are ready, and again after each new render (the samples move to ready again).
  useEffect(() => {
    if (!id || samplesState !== "ready") return;
    let alive = true;
    getCoverSamples(id).then(
      (urls) => { if (alive) setPictures({ key: id, urls, failed: false }); },
      () => { if (alive) setPictures({ key: id, urls: null, failed: true }); },
    );
    return () => { alive = false; };
  }, [id, samplesState, attempt]);

  // With no pictures yet, the first render starts on entry. A failed start is shown below, with a retry.
  useEffect(() => {
    if (!id || samplesState !== "none" || !hasGenerated) return;
    void useRescueV2Store.getState().apply(() => renderCoverSamples(id));
  }, [id, samplesState, hasGenerated]);

  if (!project || !cover || !id) return null;
  const layout = STAGE_LAYOUT.cover;
  if (layout.kind !== "pair") return null;
  const s = scaleFor(width);
  const w = layout.each[0] * s;
  const h = layout.each[1] * s;
  const picked = pickedCover(pending, cover);
  const current = pictures && pictures.key === id ? pictures : null;
  const fetchFailed = current?.failed === true;
  const failed = cover.samples === "failed" || fetchFailed;
  const startFailed = hasGenerated && samplesState === "none" && errorCode !== null;

  const retryPictures = () => {
    if (cover.samples === "failed" || samplesState === "none") void renderPictures(id);
    else setAttempt((a) => a + 1);
  };

  return (
    <View style={styles.stage}>
      <View style={styles.pair}>
        {cover.allowedChoices.map((c) => (
          <CoverSlot
            key={c}
            label={t(`rescueV2.cover.${c}`)}
            picked={c === picked}
            width={w}
            height={h}
            // A picture from an earlier render is not shown while a new one is being made: the student sees the skeleton, not the old cover.
            uri={cover.samples === "rendering" ? null : (current?.urls?.[c] ?? null)}
            loading={!failed && (cover.samples === "rendering" || (cover.samples === "none" && hasGenerated) || (cover.samples === "ready" && current === null))}
            disabled={busy}
            onPress={() => {
              if (c === picked) return;
              hSelection();
              void sendChoice(id, c);
            }}
          />
        ))}
      </View>
      {failed || startFailed ? (
        <TouchableOpacity accessibilityRole="button" onPress={retryPictures} hitSlop={8}>
          <Text style={[styles.retry, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * One cover. The picture while it is ready, a skeleton while it renders, and the label only when the picture could not be had. The picked
 * one has a brand outline. Direction is fixed (`ltr` on the pair): the order is the policy's, not the language's.
 */
function CoverSlot({ label, picked, width, height, uri, loading, disabled, onPress }: {
  label: string; picked: boolean; width: number; height: number; uri: string | null; loading: boolean; disabled: boolean; onPress: () => void;
}) {
  const colors = useThemeColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected: picked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.slot, { borderColor: picked ? colors.brandPrimary : colors.bgCard }]}
    >
      {uri ? (
        <Image source={{ uri }} resizeMode="contain" style={{ width, height, backgroundColor: colors.rescuePaper }} />
      ) : loading ? (
        <SkeletonPage width={width} height={height} />
      ) : (
        <View style={[styles.labelPaper, { width, height, backgroundColor: colors.rescuePaper }]}>
          <Text style={[styles.slotLabel, { color: picked ? colors.brandPrimaryLight : colors.rescuePaperInk, fontWeight: picked ? "800" : "500" }]}>{label}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

/** The value of a row as the sheet shows it. */
function valueText(fields: RescueCoverFieldsDTO, id: CoverRowId): string {
  const v = fields[coverRow(id).field];
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x : x.rank ? `${x.name} (${x.rank})` : x.name))
      .join(", ");
  }
  return typeof v === "string" ? v : "";
}

function CoverRowLine({ id, cover, flashToken, disabled, onPress }: {
  id: CoverRowId; cover: RescueCoverDTO; flashToken: unknown; disabled: boolean; onPress: () => void;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const value = valueText(cover.fields, id);
  const source = coverSourceWord(cover.fieldSources[coverRow(id).field]);
  const flash = useFlash(flashToken);
  return (
    <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.row, { borderColor: colors.borderDefault, flexDirection: visualRow(isRTL) }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.flash, { backgroundColor: colors.brandWash }, flash]} />
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{t(coverLabelKey(id))}</Text>
        {value ? (
          <View style={[styles.valueLine, { flexDirection: visualRow(isRTL) }]}>
            <Text numberOfLines={1} style={[styles.rowValue, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{value}</Text>
            {source ? <Text style={[styles.tag, { color: colors.textSecondary }]}>{t(source)}</Text> : null}
          </View>
        ) : (
          <Text style={[styles.rowValue, { color: colors.brandPrimary, textAlign: visualTextAlign(isRTL) }]}>{t("rescueV2.cover.add")}</Text>
        )}
      </View>
      <Text style={[styles.pencil, { color: colors.textSecondary }]}>✎</Text>
    </TouchableOpacity>
  );
}

function Sheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const project = useRescueV2Store((s) => s.project);
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const errorInfo = useRescueV2Store((s) => s.errorInfo);
  const id = project?.id ?? null;
  const pending = useConfirmUi((s) => (s.key === id ? s.coverPending : null));
  const manual = useConfirmUi((s) => (s.key === id ? s.coverMore : null));
  const busy = useConfirmUi((s) => s.busy);
  const setCoverMore = useConfirmUi((s) => s.setCoverMore);
  const setCoverField = useConfirmUi((s) => s.setCoverField);

  useEffect(() => {
    if (id) useConfirmUi.getState().ensure(id);
  }, [id]);

  // A pending choice the server now holds (a retry from the shell landed) is no longer pending.
  const serverChoice = project?.cover?.choice ?? null;
  useEffect(() => {
    const cur = useConfirmUi.getState();
    if (!id || cur.key !== id || cur.coverPending === null) return;
    if (cur.coverPending === serverChoice) cur.setCoverPending(null);
  }, [id, serverChoice]);

  const cover = project?.cover ?? null;
  if (!project || !cover || !id) return null;
  const rtl = thesisIsRtl(project);
  const picked = pickedCover(pending, cover);
  const unsaved = pending !== null && pending !== cover.choice;
  const more = coverMoreOpen(manual, picked, cover.fields);
  const missing = errorCode === "cover_fields_missing" ? (errorInfo?.missing ?? []) : [];
  const neededRow = missing.length > 0 ? missingRow(missing) : null;
  const flashFor = (rowId: CoverRowId) => (missing.length > 0 && missingRow(missing) === rowId ? errorInfo : null);

  const open = (row: CoverRowId) => {
    setCoverField(row);
    useBottomSheet.getState().openSheet("rescue-cover-field");
  };

  return (
    <>
      <SheetTitle>{t(cover.missing.length > 0 ? "rescueV2.cover.titleMissing" : "rescueV2.cover.title")}</SheetTitle>
      {picked !== "generated" ? <SheetBody>{t("rescueV2.cover.formsOnly")}</SheetBody> : null}
      {COVER_PRIMARY_ROWS.map((r) => (
        <CoverRowLine key={r.id} id={r.id} cover={cover} flashToken={flashFor(r.id)} disabled={busy} onPress={() => open(r.id)} />
      ))}
      <TouchableOpacity accessibilityRole="button" onPress={() => setCoverMore(!more)} hitSlop={8} style={styles.more}>
        <Text style={[styles.moreText, { color: colors.brandPrimary, textAlign: visualTextAlign(isRTL) }]}>{t(more ? "rescueV2.cover.less" : "rescueV2.cover.more")}</Text>
      </TouchableOpacity>
      {more ? COVER_MORE_ROWS.map((r) => (
        <CoverRowLine key={r.id} id={r.id} cover={cover} flashToken={flashFor(r.id)} disabled={busy} onPress={() => open(r.id)} />
      )) : null}
      {unsaved && !busy ? (
        <TouchableOpacity accessibilityRole="button" onPress={() => { if (pending) void sendChoice(id, pending); }} hitSlop={8} style={styles.retryRow}>
          <Text style={[styles.moreText, { color: colors.brandPrimary, textAlign: visualTextAlign(isRTL) }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      ) : null}
      {errorCode === "cover_fields_missing" ? (
        <SheetBody>{neededRow ? t("rescueV2.cover.needed", { label: t(coverLabelKey(neededRow)) }) : t("rescueV2.cover.titleMissing")}</SheetBody>
      ) : null}
      <CoverFieldSheet />
    </>
  );
}

function Foot() {
  const { t } = useTranslation();
  const project = useRescueV2Store((s) => s.project);
  const id = project?.id ?? null;
  const busy = useConfirmUi((s) => s.busy);
  const pending = useConfirmUi((s) => (s.key === id ? s.coverPending : null));
  const cover = project?.cover ?? null;
  if (!project || !cover) return null;
  const unsaved = pending !== null && pending !== cover.choice;
  return (
    <Button title={t("rescueV2.cover.cta")} onPress={() => { void startCover(project.id); }} loading={busy} disabled={busy || unsaved} />
  );
}

export const CoverStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  pair: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, direction: "ltr" },
  slot: { borderWidth: 2.5, borderRadius: 4 },
  labelPaper: { alignItems: "center", justifyContent: "center", padding: 8, borderRadius: 3 },
  slotLabel: { fontSize: 13, textAlign: "center" },
  retry: { fontSize: 14, fontWeight: "700", marginTop: 12 },
  row: { alignItems: "center", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  rowMain: { flex: 1 },
  flash: { borderRadius: 10 },
  rowLabel: { fontSize: 12, fontWeight: "600" },
  valueLine: { alignItems: "center", gap: 8 },
  rowValue: { fontSize: 15, fontWeight: "600", marginTop: 2, flexShrink: 1 },
  tag: { fontSize: 11, fontWeight: "700" },
  pencil: { fontSize: 16 },
  more: { alignSelf: "flex-start", paddingVertical: 10 },
  moreText: { fontSize: 14, fontWeight: "700" },
  retryRow: { alignSelf: "flex-start", paddingVertical: 6 },
});
