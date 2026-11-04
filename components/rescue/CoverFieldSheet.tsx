import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "@/components/BottomSheet";
import { SheetBody, SheetTitle } from "@/components/rescue/ui";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { renderCoverSamples, saveCover } from "@/lib/rescue-v2-api";
import { coverFieldsAfter, coverLabelKey, coverRow, type CoverRowId, type JuryDraft } from "@/lib/rescue-v2-confirm";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { useConfirmUi } from "@/stores/rescue-confirm-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

/**
 * Edits one row of the cover. The draft lives in this sheet: a failed save keeps it on screen, and Save is the retry. A saved row closes the
 * sheet, and then the pictures render again once (not once per letter): the server marks the cover dirty itself if a render is running.
 */
export function CoverFieldSheet() {
  const row = useConfirmUi((s) => s.coverField);
  const setCoverField = useConfirmUi((s) => s.setCoverField);
  return (
    <BottomSheet name="rescue-cover-field" scrollable onDismiss={() => setCoverField(null)}>
      {row ? <FieldBody key={row} row={row} /> : null}
    </BottomSheet>
  );
}

function FieldBody({ row: rowId }: { row: CoverRowId }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const project = useRescueV2Store((s) => s.project);
  const busy = useConfirmUi((s) => s.busy);
  // Only a save this sheet made says so here: another action's failure is on the shell's line, not on this sheet.
  const [saveFailed, setSaveFailed] = useState(false);
  const row = coverRow(rowId);
  const cover = project?.cover ?? null;
  const current = cover?.fields ?? {};
  const rtl = project ? thesisIsRtl(project) : false;

  const [text, setText] = useState(() => (row.kind === "text" ? ((current[row.field] as string | undefined) ?? "") : ""));
  const [list, setList] = useState<string[]>(() => (row.kind === "list" ? [...((current[row.field] as string[] | undefined) ?? [])] : []));
  const [jury, setJury] = useState<JuryDraft[]>(() =>
    row.kind === "jury" ? (current.jury ?? []).map((m) => ({ name: m.name, rank: m.rank ?? "" })) : [],
  );

  if (!project || !cover) return null;
  const pid = project.id;

  const save = async () => {
    const ui = useConfirmUi.getState();
    if (!ui.begin()) return;
    // The lock is released whatever happens in between: a throw must never leave every confirm button disabled.
    try {
      const value = row.kind === "text" ? text : row.kind === "list" ? list : jury;
      const fields = coverFieldsAfter(cover.fields, rowId, value);
      const ok = await useRescueV2Store.getState().apply(() => saveCover(pid, { fields }));
      setSaveFailed(!ok);
      if (ok && useConfirmUi.getState().key === pid) {
        useConfirmUi.getState().setCoverField(null);
        useBottomSheet.getState().closeSheet("rescue-cover-field");
        // One render per close, and only when the samples are not already rendering: the server marks a save made mid-render itself.
        const after = useRescueV2Store.getState().project?.cover;
        if (after && after.allowedChoices.includes("generated") && after.samples !== "rendering") {
          await useRescueV2Store.getState().apply(() => renderCoverSamples(pid));
        }
      }
    } finally {
      useConfirmUi.getState().end();
    }
  };

  const direction: "rtl" | "ltr" = rtl ? "rtl" : "ltr";
  const inputStyle = [styles.input, { color: colors.textPrimary, borderColor: colors.borderDefault, backgroundColor: colors.bgSurface, textAlign: visualTextAlign(rtl), writingDirection: direction }];
  const placeholder = t(coverLabelKey(rowId));

  return (
    <>
      <SheetTitle>{t("rescueV2.cover.editTitle", { label: placeholder })}</SheetTitle>
      {row.kind === "text" ? (
        <BottomSheetTextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.textPlaceholder}
          editable={!busy}
          style={inputStyle}
        />
      ) : null}
      {row.kind === "list" ? (
        <>
          {list.map((name, i) => (
            <View key={i} style={[styles.line, { flexDirection: visualRow(isRTL) }]}>
              <BottomSheetTextInput
                value={name}
                onChangeText={(v) => setList((l) => l.map((x, j) => (j === i ? v : x)))}
                placeholder={placeholder}
                placeholderTextColor={colors.textPlaceholder}
                editable={!busy}
                style={[inputStyle, styles.grow]}
              />
              <TouchableOpacity accessibilityRole="button" hitSlop={8} onPress={() => setList((l) => l.filter((_, j) => j !== i))}>
                <Text style={[styles.remove, { color: colors.textSecondary }]}>{t("rescueV2.cover.remove")}</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity accessibilityRole="button" hitSlop={8} onPress={() => setList((l) => [...l, ""])} style={styles.add}>
            <Text style={[styles.addText, { color: colors.brandPrimary, textAlign: visualTextAlign(isRTL) }]}>{t("rescueV2.cover.add")}</Text>
          </TouchableOpacity>
        </>
      ) : null}
      {row.kind === "jury" ? (
        <>
          {jury.map((m, i) => (
            <View key={i} style={styles.juryBlock}>
              <View style={[styles.line, { flexDirection: visualRow(isRTL) }]}>
                <BottomSheetTextInput
                  value={m.name}
                  onChangeText={(v) => setJury((j) => j.map((x, k) => (k === i ? { ...x, name: v } : x)))}
                  placeholder={t("rescueV2.cover.juryName")}
                  placeholderTextColor={colors.textPlaceholder}
                  editable={!busy}
                  style={[inputStyle, styles.grow]}
                />
                <TouchableOpacity accessibilityRole="button" hitSlop={8} onPress={() => setJury((j) => j.filter((_, k) => k !== i))}>
                  <Text style={[styles.remove, { color: colors.textSecondary }]}>{t("rescueV2.cover.remove")}</Text>
                </TouchableOpacity>
              </View>
              <BottomSheetTextInput
                value={m.rank}
                onChangeText={(v) => setJury((j) => j.map((x, k) => (k === i ? { ...x, rank: v } : x)))}
                placeholder={t("rescueV2.cover.juryRank")}
                placeholderTextColor={colors.textPlaceholder}
                editable={!busy}
                style={inputStyle}
              />
            </View>
          ))}
          <TouchableOpacity accessibilityRole="button" hitSlop={8} onPress={() => setJury((j) => [...j, { name: "", rank: "" }])} style={styles.add}>
            <Text style={[styles.addText, { color: colors.brandPrimary, textAlign: visualTextAlign(isRTL) }]}>{t("rescueV2.cover.add")}</Text>
          </TouchableOpacity>
        </>
      ) : null}
      {saveFailed && !busy ? <SheetBody>{t("rescueV2.common.somethingWrong")}</SheetBody> : null}
      <View style={styles.foot}>
        <Button title={t("rescueV2.cover.save")} onPress={() => { void save(); }} loading={busy} disabled={busy} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 10 },
  line: { alignItems: "center", gap: 10 },
  grow: { flex: 1 },
  remove: { fontSize: 13, fontWeight: "600" },
  add: { paddingVertical: 8 },
  addText: { fontSize: 14, fontWeight: "700" },
  juryBlock: { marginBottom: 8 },
  foot: { marginTop: 8 },
});
