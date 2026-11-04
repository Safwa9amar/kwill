import React, { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { DiagnosisDots } from "@/components/rescue/DiagnosisDots";
import { SegSwitch } from "@/components/rescue/SegSwitch";
import { Chip, ChipRow, SheetBody, SheetTitle } from "@/components/rescue/ui";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hSelection } from "@/lib/haptics";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { continueRescue } from "@/lib/rescue-v2-api";
import { chipsWithDots, problemSentence, visibleDots } from "@/lib/rescue-v2-diagnosis";
import { STAGE_LAYOUT, scaleFor } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { useDiagnosisView } from "@/stores/rescue-diagnosis-view";
import { usePaymentUi } from "@/stores/rescue-payment-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueDotDTO } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

const NO_DOTS: RescueDotDTO[] = [];

/** Continue asks the server for the rescue. 200: the project is entitled and the phase moves on. 402: the student pays (`paying`). */
function isPaymentRequired(e: unknown): boolean {
  return (e as { status?: unknown } | null)?.status === 402;
}

/**
 * The one Continue of screens 7 and 8. A second tap while the call is out is refused by the shared lock. A 402 is not an error: it opens
 * the payment step, so the shell's error line is never shown for it. Any other failure goes to the shell's line, and its Retry repeats this call.
 */
export function ContinueFoot() {
  const { t, i18n } = useTranslation();
  const project = useRescueV2Store((s) => s.project);
  const apply = useRescueV2Store((s) => s.apply);
  const busy = usePaymentUi((s) => s.busy);
  const id = project?.id ?? null;

  const onPress = () => {
    if (!id) return;
    const ui = usePaymentUi.getState();
    ui.ensure(id);
    if (!ui.begin()) return;
    ui.setRefusal(null);
    void apply(() =>
      continueRescue(id).catch((e: unknown) => {
        const current = useRescueV2Store.getState().project;
        if (!isPaymentRequired(e) || !current) throw e;
        // The code is kept for the payment sheet: an allowance spent this month reads differently from a first purchase (P-58).
        const code = (e as { code?: unknown }).code;
        usePaymentUi.getState().setRefusal(typeof code === "string" ? code : null);
        useRescueV2Store.getState().setNav({ paying: true });
        // The same project, unchanged: the land clears the error, and the phase (still `diagnosed`) keeps `paying`.
        return current;
      }),
    ).finally(() => usePaymentUi.getState().end());
  };

  return (
    <View>
      <Button
        title={t(PURCHASES_HIDDEN ? "rescueV2.diagnosis.ctaStatus" : "rescueV2.diagnosis.cta")}
        onPress={onPress}
        loading={busy}
        disabled={busy || !id}
      />
      {/* iOS gets no fine print: it names a payment's terms, which the App Store rules keep off the screen. */}
      {PURCHASES_HIDDEN ? null : <Text style={styles.fine}>{t("rescueV2.diagnosis.fine")}</Text>}
    </View>
  );
}

function Stage() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const project = useRescueV2Store((st) => st.project);
  const setNav = useRescueV2Store((st) => st.setNav);
  const id = project?.id ?? null;
  const dots = project?.diagnosis?.dots ?? NO_DOTS;
  const v0 = project?.originalVersionId ?? null;
  const rtl = thesisIsRtl(project);
  const page = useDiagnosisView((st) => st.page);
  const chip = useDiagnosisView((st) => st.chip);
  const selectedN = useDiagnosisView((st) => st.selectedN);
  const goTo = useDiagnosisView((st) => st.goTo);
  const select = useDiagnosisView((st) => st.select);

  // The view belongs to one project. A different project starts over; the same one keeps the student's place.
  useEffect(() => {
    if (id) useDiagnosisView.getState().ensure(id, dots);
  }, [id, dots]);

  const layout = STAGE_LAYOUT.diagnosis;
  if (!project || !project.diagnosis || !v0 || layout.kind !== "three") return null;
  const [mw, mh] = [layout.mid[0] * s, layout.mid[1] * s];
  const onPage = visibleDots(dots, page, chip);
  const sel = dots.find((d) => d.n === selectedN && d.page === page) ?? null;
  const tr = (k: string, o?: Record<string, string | number>) => t(k, o);
  const sentence = (code: string, params: Record<string, string | number>) =>
    problemSentence(tr, (k) => i18n.exists(k), code, params);

  return (
    <View style={[styles.stage, { paddingTop: insets.top + 12 }]}>
      <SegSwitch
        options={[
          { key: "before", label: t("rescueV2.diagnosis.before") },
          { key: "after", label: t("rescueV2.diagnosis.after"), disabled: !project.previewReady },
        ]}
        value="before"
        onChange={(k) => setNav({ diagnosisTab: k })}
      />
      <View style={styles.middle}>
        <PageCarousel
          versionId={v0}
          page={page}
          layout={layout}
          interactive
          onChange={(p) => goTo(p, dots)}
          overlay={
            <DiagnosisDots
              dots={onPage}
              selectedN={selectedN}
              onSelect={select}
              width={mw}
              height={mh}
              label={(d) => sentence(d.code, d.params)}
            />
          }
        />
      </View>
      {sel ? (
        <View style={[styles.tip, { backgroundColor: colors.textPrimary }]}>
          <Text style={[styles.tipText, { color: colors.bgCard }]}>{sentence(sel.code, sel.params)}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Sheet() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const project = useRescueV2Store((st) => st.project);
  const chip = useDiagnosisView((st) => st.chip);
  const pickChip = useDiagnosisView((st) => st.pickChip);
  const goTo = useDiagnosisView((st) => st.goTo);
  const diagnosis = project?.diagnosis ?? null;
  const dots = project?.diagnosis?.dots ?? NO_DOTS;

  if (!project || !diagnosis) {
    return <SheetBody>{t("rescueV2.common.somethingWrong")}</SheetBody>;
  }

  const tr = (k: string, o?: Record<string, string | number>) => t(k, o);
  const sentence = (code: string, params: Record<string, string | number>) =>
    problemSentence(tr, (k) => i18n.exists(k), code, params);

  return (
    <>
      <SheetTitle>{t("rescueV2.diagnosis.title", { count: diagnosis.total })}</SheetTitle>
      <SheetBody>{t("rescueV2.diagnosis.sub")}</SheetBody>
      <ChipRow>
        {chipsWithDots(diagnosis.chips).map((c) => (
          <Chip
            key={c.key}
            label={`${t(`rescueV2.diagnosis.chips.${c.key}`)} ${c.count}`}
            selected={chip === c.key}
            onPress={() => { hSelection(); pickChip(c.key, dots); }}
          />
        ))}
      </ChipRow>
      {diagnosis.studentItems.length > 0 ? (
        <View style={styles.yours}>
          <Text style={[styles.yoursTitle, { color: colors.textSecondary }]}>{t("rescueV2.diagnosis.yours")}</Text>
          {diagnosis.studentItems.map((item, i) => {
            const text = sentence(item.code, item.section ? { section: item.section } : {});
            const first = item.pages[0];
            // An item with a page jumps to its first page on a tap; one without a page is only read.
            if (first === undefined) {
              return <Text key={`${item.code}-${i}`} style={[styles.yoursText, { color: colors.textPrimary }]}>{text}</Text>;
            }
            return (
              <TouchableOpacity
                key={`${item.code}-${i}`}
                accessibilityRole="button"
                onPress={() => { hSelection(); goTo(first, dots); }}
              >
                <Text style={[styles.yoursText, { color: colors.textPrimary }]}>{text}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </>
  );
}

export const DiagnosisStep: RescueStep = { Stage, Sheet, Foot: ContinueFoot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center" },
  middle: { flex: 1, justifyContent: "center", alignItems: "center", width: "100%" },
  tip: { alignSelf: "center", maxWidth: "88%", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 14 },
  tipText: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  fine: { fontSize: 12, textAlign: "center", marginTop: 8 },
  yours: { gap: 8, marginTop: 4 },
  yoursTitle: { fontSize: 13, fontWeight: "700" },
  yoursText: { fontSize: 14, lineHeight: 20 },
});
