import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { SheetTitle } from "@/components/rescue/ui";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { CHANGE_MORE_ROWS, changeItemKey, orderedGroups, visibleRows } from "@/lib/rescue-v2-finish";
import { STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { firstStrongDirection } from "@/lib/text-direction";
import { useChangedUi } from "@/stores/rescue-changed-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueChangeItemDTO } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

/** The version the page shows: the one the overlay was opened for (the timeline's), else the current one (the result's). */
function useTargetVersion(): string | null {
  return useRescueV2Store((s) => s.nav.versionId ?? s.project?.currentVersion?.id ?? null);
}

/** Screen 16, the stage: one page, the page of the item tapped (page 1 to start). */
function Stage() {
  const vid = useTargetVersion();
  const key = useChangedUi((s) => s.key);
  const stored = useChangedUi((s) => s.page);
  const ensure = useChangedUi((s) => s.ensure);
  useEffect(() => { if (vid) ensure(vid); }, [vid, ensure]);
  const layout = STAGE_LAYOUT.changed;
  if (!vid || layout.kind !== "big") return null;
  // A page from another version is never shown: until `ensure` has run, the page is 1.
  const page = key === vid ? stored : 1;
  return (
    <View style={styles.stage}>
      <PageCarousel versionId={vid} page={page} layout={layout} />
    </View>
  );
}

/** One change: its page tag (LTR), then its sentence. A row with a page jumps the stage to it; a whole-document rule has none. */
function ChangeRow({ item, rtl, onJump }: { item: RescueChangeItemDTO; rtl: boolean; onJump: (page: number) => void }) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const key = changeItemKey(item.code, (k) => i18n.exists(k));
  const sentence = t(`rescueV2.${key}`, { ...item.params, count: item.count });
  // Heading excerpts (and every sentence) take the direction of their own first strong character, so an Arabic heading inside an
  // English sentence keeps its own order.
  const dir = firstStrongDirection(sentence, rtl ? "rtl" : "ltr");
  const tag = item.page !== null ? t("rescueV2.changed.pageTag", { page: item.page }) : null;
  return (
    <TouchableOpacity
      accessibilityRole={item.page !== null ? "button" : "text"}
      disabled={item.page === null}
      onPress={() => { if (item.page !== null) onJump(item.page); }}
      style={[styles.row, { flexDirection: visualRow(isRTL), borderColor: colors.borderSubtle }]}
    >
      {tag ? <Text style={[styles.tag, { color: colors.brandPrimary, writingDirection: "ltr" }]}>{tag}</Text> : null}
      <Text style={[styles.sentence, { color: colors.textPrimary, textAlign: visualTextAlign(dir === "rtl"), writingDirection: dir }]}>{sentence}</Text>
    </TouchableOpacity>
  );
}

/** Screen 16's sheet. Keyed by the version, so a group's "show more" count never carries to another version. */
function Sheet() {
  const vid = useTargetVersion();
  return <ChangedSheet key={vid ?? "none"} />;
}

function ChangedSheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const vid = useTargetVersion();
  const rtl = useRescueV2Store((s) => thesisIsRtl(s.project));
  const detail = useRescueV2Store((s) => (vid ? s.details[vid] ?? null : null));
  const loadDetail = useRescueV2Store((s) => s.loadDetail);
  const setPage = useChangedUi((s) => s.setPage);
  const [shown, setShown] = useState<Partial<Record<string, number>>>({});

  // A failed read is the shell's error line, and its Retry repeats this read. The effect does not loop: it runs when the version changes.
  useEffect(() => {
    if (vid && !detail) void loadDetail(vid);
  }, [vid, detail, loadDetail]);

  if (!vid) return null;
  if (!detail) {
    // Layout-shaped while the report loads: grey bars where the groups will be, never a spinner.
    return (
      <View>
        <SheetTitle>{t("rescueV2.changed.title")}</SheetTitle>
        {[0.9, 0.7, 0.8].map((w, i) => (
          <View key={i} style={[styles.placeholder, { width: `${w * 100}%`, backgroundColor: colors.bgSurface }]} />
        ))}
      </View>
    );
  }
  const changes = detail.changes;
  if (!changes || changes.total === 0) {
    return (
      <View>
        <SheetTitle>{t("rescueV2.changed.title")}</SheetTitle>
        <Text style={[styles.none, { color: colors.textSecondary }]}>{t("rescueV2.changed.none")}</Text>
      </View>
    );
  }

  return (
    <View>
      <SheetTitle>{t("rescueV2.changed.title")}</SheetTitle>
      {orderedGroups(changes.groups).map((g) => {
        const n = visibleRows(shown[g.key], g.items.length);
        return (
          <View key={g.key} style={styles.group}>
            <View style={styles.groupHead}>
              <Text style={[styles.groupTitle, { color: colors.textPrimary }]}>{t(`rescueV2.changed.groups.${g.key}`)}</Text>
              <Text style={[styles.count, { color: colors.textSecondary }]}>{g.count}</Text>
            </View>
            {g.items.slice(0, n).map((item, i) => (
              <ChangeRow key={`${g.key}-${i}`} item={item} rtl={rtl} onJump={setPage} />
            ))}
            {g.items.length > n ? (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setShown((prev) => ({ ...prev, [g.key]: n + CHANGE_MORE_ROWS }))}
                hitSlop={8}
                style={styles.more}
              >
                <Text style={[styles.moreText, { color: colors.brandPrimary }]}>{t("rescueV2.changed.more")}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export const ChangedStep: RescueStep = { Stage, Sheet, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  placeholder: { height: 14, borderRadius: 7, marginBottom: 12 },
  none: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
  group: { marginBottom: 14 },
  groupHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  groupTitle: { fontSize: 14, fontWeight: "800" },
  count: { fontSize: 13, fontWeight: "700" },
  row: { alignItems: "center", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 9 },
  tag: { fontSize: 12, fontWeight: "800", minWidth: 36 },
  sentence: { flex: 1, fontSize: 14, lineHeight: 20 },
  more: { alignSelf: "flex-start", paddingVertical: 8 },
  moreText: { fontSize: 13, fontWeight: "700" },
});
