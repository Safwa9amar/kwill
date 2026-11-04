import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { CompareSlider } from "@/components/rescue/CompareSlider";
import { SkeletonPage } from "@/components/rescue/SkeletonPage";
import { SheetBody, SheetTitle } from "@/components/rescue/ui";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { compareVersions } from "@/lib/rescue-v2-api";
import { changeItemKey } from "@/lib/rescue-v2-finish";
import { changesOnPage, orderPair } from "@/lib/rescue-v2-history";
import { scaleFor, STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { firstStrongDirection } from "@/lib/text-direction";
import { useHistoryUi } from "@/stores/rescue-history-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueVersionSummaryDTO } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

/** The pair on show, the earlier version first. Null while the versions it names are not in the list. */
function usePair(): { loId: string; hiId: string; lo: RescueVersionSummaryDTO; hi: RescueVersionSummaryDTO; pairKey: string } | null {
  const aId = useRescueV2Store((s) => s.nav.versionId);
  const bId = useRescueV2Store((s) => s.nav.compareWithId);
  const versions = useRescueV2Store((s) => s.versions);
  if (!aId || !bId) return null;
  const x = versions.find((v) => v.id === aId);
  const y = versions.find((v) => v.id === bId);
  if (!x || !y) return null;
  const [lo, hi] = orderPair(x, y);
  return { loId: lo.id, hiId: hi.id, lo, hi, pairKey: `${lo.id}|${hi.id}` };
}

/** The pager's index, and the reply for it. Both belong to one pair and one project: another value reads as the start. */
function usePagerIndex(pid: string | null, pairKey: string | null): number {
  return useHistoryUi((s) => (s.key === pid && pairKey !== null && s.comparePair === pairKey ? s.comparePage : 0));
}

/**
 * H4's stage: the first page of the pager's place, the two saved images under the slider. The page is the server's `pages[0]` for this
 * index, so it is the page the sheet names. Nothing is converted and nothing waits on a conversion.
 */
function Stage() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { width: windowWidth } = useWindowDimensions();
  const pid = useRescueV2Store((s) => s.projectId);
  const pair = usePair();
  const index = usePagerIndex(pid, pair?.pairKey ?? null);
  const reply = useHistoryUi((s) => (s.key === pid && pair && s.compare.slot === `${pair.pairKey}|${index}` ? s.compare : null));
  const layout = STAGE_LAYOUT.compare;
  if (!pair || layout.kind !== "big") return null;
  const s = scaleFor(windowWidth);
  const w = layout.page[0] * s;
  const h = layout.page[1] * s;
  if (reply?.state === "ok" && reply.value && reply.value.total === 0) return null;
  const page = reply?.state === "ok" && reply.value ? reply.value.pages[0] ?? null : null;
  return (
    <View style={styles.stage}>
      <View style={[styles.labels, { width: w, direction: "ltr" }]}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>{t("rescueV2.common.version", { n: pair.lo.n })}</Text>
        <Text style={[styles.label, { color: colors.textSecondary }]}>{t("rescueV2.common.version", { n: pair.hi.n })}</Text>
      </View>
      {page ? (
        <CompareSlider a={page.aUrl ? { hash: page.aHash, url: page.aUrl } : null} b={{ hash: page.bHash, url: page.bUrl }} width={w} height={h} />
      ) : reply?.state === "failed" ? (
        <View style={{ width: w, height: h, backgroundColor: colors.rescuePaper, borderRadius: 3 }} />
      ) : (
        <SkeletonPage width={w} height={h} />
      )}
    </View>
  );
}

function CompareSheet() {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const pid = useRescueV2Store((s) => s.projectId);
  const pair = usePair();
  const versions = useRescueV2Store((s) => s.versions);
  const loadVersions = useRescueV2Store((s) => s.loadVersions);
  const rtl = useRescueV2Store((s) => thesisIsRtl(s.project));
  const index = usePagerIndex(pid, pair?.pairKey ?? null);
  const reply = useHistoryUi((s) => (s.key === pid && pair && s.compare.slot === `${pair.pairKey}|${index}` ? s.compare : null));
  const setComparePage = useHistoryUi((s) => s.setComparePage);
  const [attempt, setAttempt] = useState(0);
  const align = { textAlign: visualTextAlign(isRTL) };

  // The list is read here too: a sheet opened straight from the link has no pair until it is.
  useEffect(() => { if (versions.length === 0) void loadVersions(); }, [versions.length, loadVersions]);

  const loId = pair?.loId ?? null;
  const hiId = pair?.hiId ?? null;
  const pairKey = pair?.pairKey ?? null;
  // One reply per pair and index, asked again on a retry. A reply for a pair the student has left is dropped by its slot.
  useEffect(() => {
    if (!pid || !loId || !hiId || !pairKey) return;
    const slot = `${pairKey}|${index}`;
    let alive = true;
    useHistoryUi.getState().setCompare(pid, slot, "loading", null);
    compareVersions(loId, hiId, index, 6).then(
      (value) => { if (alive && useRescueV2Store.getState().projectId === pid) useHistoryUi.getState().setCompare(pid, slot, "ok", value); },
      () => { if (alive && useRescueV2Store.getState().projectId === pid) useHistoryUi.getState().setCompare(pid, slot, "failed", null); },
    );
    return () => { alive = false; };
  }, [pid, loId, hiId, pairKey, index, attempt]);

  if (!pid || !pair) return null;
  const title = t("rescueV2.compare.title", { a: pair.lo.n, b: pair.hi.n });

  if (!reply || reply.state === "loading") {
    // Layout-shaped while the pages' list is read: grey bars where the count and the rows will be.
    return (
      <>
        <SheetTitle>{title}</SheetTitle>
        {[0.6, 0.9].map((w, i) => (
          <View key={i} style={[styles.placeholder, { width: `${w * 100}%`, backgroundColor: colors.bgSurface }]} />
        ))}
      </>
    );
  }
  if (reply.state === "failed" || !reply.value) {
    return (
      <>
        <SheetTitle>{title}</SheetTitle>
        <SheetBody>{t("rescueV2.common.somethingWrong")}</SheetBody>
        <TouchableOpacity accessibilityRole="button" onPress={() => setAttempt((n) => n + 1)} hitSlop={8} style={styles.retry}>
          <Text style={[styles.retryText, { color: colors.brandPrimary }, align]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      </>
    );
  }

  const { total, pages, changes } = reply.value;
  // Nothing differs by hash: the two versions are the same, and no change is claimed.
  if (total === 0) {
    return (
      <>
        <SheetTitle>{title}</SheetTitle>
        <SheetBody>{t("rescueV2.compare.same")}</SheetBody>
      </>
    );
  }

  const pg = pages[0] ?? null;
  const rows = pg ? changesOnPage(changes, pg.page) : [];
  const exists = (k: string) => i18n.exists(k);
  const prevGlyph = isRTL ? "›" : "‹";
  const nextGlyph = isRTL ? "‹" : "›";

  return (
    <>
      <SheetTitle>{title}</SheetTitle>
      <Text style={[styles.count, { color: colors.textPrimary }, align]}>{t("rescueV2.compare.changedCount", { count: total })}</Text>
      <View style={[styles.pager, { flexDirection: visualRow(isRTL) }]}>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={index === 0}
          onPress={() => { if (pid && pairKey) setComparePage(pid, pairKey, index - 1); }}
          hitSlop={10}
          style={styles.step}
        >
          <Text style={[styles.stepGlyph, { color: index === 0 ? colors.textPlaceholder : colors.brandPrimary }]}>{prevGlyph}</Text>
        </TouchableOpacity>
        {pg ? (
          <Text style={[styles.pagerText, { color: colors.textPrimary }]}>{t("rescueV2.compare.pager", { page: pg.page, i: index + 1, total })}</Text>
        ) : null}
        <TouchableOpacity
          accessibilityRole="button"
          disabled={index + 1 >= total}
          onPress={() => { if (pid && pairKey) setComparePage(pid, pairKey, index + 1); }}
          hitSlop={10}
          style={styles.step}
        >
          <Text style={[styles.stepGlyph, { color: index + 1 >= total ? colors.textPlaceholder : colors.brandPrimary }]}>{nextGlyph}</Text>
        </TouchableOpacity>
      </View>
      {rows.map((item, i) => {
        // What the later version did on this page that the earlier did not (the server's own words, never a guess).
        const key = changeItemKey(item.code, exists);
        const sentence = t(`rescueV2.${key}`, { ...item.params, count: item.count });
        const dir = firstStrongDirection(sentence, rtl ? "rtl" : "ltr");
        return (
          <Text key={`${item.code}-${i}`} style={[styles.row, { color: colors.textPrimary, borderColor: colors.borderSubtle, textAlign: visualTextAlign(dir === "rtl"), writingDirection: dir }]}>
            {sentence}
          </Text>
        );
      })}
    </>
  );
}

export const CompareStep: RescueStep = { Stage, Sheet: CompareSheet, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  labels: { flexDirection: "row", justifyContent: "space-between", direction: "ltr" },
  label: { fontSize: 12, fontWeight: "700" },
  placeholder: { height: 14, borderRadius: 7, marginBottom: 12 },
  count: { fontSize: 14, fontWeight: "700", marginBottom: 8 },
  pager: { alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  step: { paddingHorizontal: 10, paddingVertical: 4 },
  stepGlyph: { fontSize: 24, fontWeight: "700" },
  pagerText: { fontSize: 13, fontWeight: "600" },
  row: { fontSize: 14, lineHeight: 20, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  retry: { alignSelf: "flex-start", paddingVertical: 8 },
  retryText: { fontSize: 14, fontWeight: "700" },
});
