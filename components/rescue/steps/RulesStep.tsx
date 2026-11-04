import React, { useEffect } from "react";
import { Image, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { MarginOverlay } from "@/components/rescue/MarginOverlay";
import { RuleRow, RuleSwitch } from "@/components/rescue/RuleRow";
import { RulePickerSheet, openRulePicker } from "@/components/rescue/RulePickerSheet";
import { SkeletonPage } from "@/components/rescue/SkeletonPage";
import { Pill, SheetTitle } from "@/components/rescue/ui";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRescuePreview } from "@/hooks/useRescuePreview";
import { hLight } from "@/lib/haptics";
import { saveRules } from "@/lib/rescue-v2-api";
import { groupRuleRows, unsavedRuleEdits, type RuleValue } from "@/lib/rescue-v2-confirm";
import { STAGE_LAYOUT, scaleFor } from "@/lib/rescue-v2-layout";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { NO_EDITS, useConfirmUi } from "@/stores/rescue-confirm-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueRuleFieldId } from "@/types/rescue-v2";
import type { RescueStep } from "./index";

/** The §1.5 defaults for the margins, used only while the server's list has no such field (a fixture, or a list that is not yet read). */
const MARGIN_DEFAULTS = { marginTop: 2.5, marginBottom: 2.5, marginBinding: 3, marginOpposite: 2 };

/**
 * Sends one set of edits. The value moves at once (visual first); it stays on screen when the save fails, and the sheet offers the retry.
 * A value the server refuses as out of range goes back to the server's own value, so the student is not stuck on it.
 */
export async function saveEdits(id: string, edits: Partial<Record<RescueRuleFieldId, RuleValue>>): Promise<void> {
  const ui = useConfirmUi.getState();
  ui.ensure(id);
  if (!ui.begin()) return;
  // The lock is released whatever happens in between: a throw must never leave every confirm button disabled.
  try {
    useConfirmUi.getState().setRulesPending({ ...useConfirmUi.getState().rulesPending, ...edits });
    const ok = await useRescueV2Store.getState().apply(() => saveRules(id, { edits }));
    const after = useConfirmUi.getState();
    if (after.key === id) {
      const store = useRescueV2Store.getState();
      const drop = new Set<string>(ok ? Object.keys(edits) : []);
      if (!ok && store.errorCode === "rule_out_of_range") {
        // The refused field goes back to the server's value. A refusal that names no field drops every edit of this call.
        const refused = store.errorInfo?.fieldId;
        if (refused) drop.add(refused);
        else for (const k of Object.keys(edits)) drop.add(k);
      }
      if (drop.size > 0) {
        const next = { ...after.rulesPending };
        for (const k of drop) delete next[k as RescueRuleFieldId];
        after.setRulesPending(next);
      }
    }
  } finally {
    useConfirmUi.getState().end();
  }
}

/** The one CTA: the rules are right. Refused while an edit is unsaved, so the student confirms what they see. */
async function confirmRules(id: string): Promise<void> {
  const ui = useConfirmUi.getState();
  ui.ensure(id);
  if (!ui.begin()) return;
  try {
    hLight();
    await useRescueV2Store.getState().apply(() => saveRules(id, { confirm: true }));
  } finally {
    useConfirmUi.getState().end();
  }
}

/** The project's fields with the student's unsaved values in place of the server's. */
function useShownFields() {
  const project = useRescueV2Store((s) => s.project);
  const id = project?.id ?? null;
  const pending = useConfirmUi((s) => (s.key === id ? s.rulesPending : NO_EDITS));
  const fields = project?.rules?.fields ?? [];
  return fields.map((f) => ({ ...f, value: pending[f.id] ?? f.value }));
}

function numberOf(fields: { id: RescueRuleFieldId; value: RuleValue }[], id: RescueRuleFieldId): number {
  const f = fields.find((x) => x.id === id);
  if (f && typeof f.value === "number") return f.value;
  return MARGIN_DEFAULTS[id as keyof typeof MARGIN_DEFAULTS] ?? 0;
}

function Stage() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const project = useRescueV2Store((s) => s.project);
  const preview = useRescuePreview(project?.id ?? null, !!project?.previewReady);
  const shown = useShownFields();
  const layout = STAGE_LAYOUT.rules;
  if (!project?.rules || layout.kind !== "big") return null;
  const s = scaleFor(width);
  const pw = layout.page[0] * s;
  const ph = layout.page[1] * s;
  // The chapter's first page, as the student has it now: the margins are drawn on it. Without one, a blank page carries the lines.
  const chapterUri = preview.status === "ready" ? preview.data?.chapter?.beforeUrl ?? null : null;
  const side = shown.find((f) => f.id === "bindingSide")?.value === "left" ? "left" : "right";
  return (
    <View style={styles.stage}>
      <View style={[styles.page, { width: pw, height: ph }]}>
        {chapterUri ? (
          <Image source={{ uri: chapterUri }} resizeMode="contain" style={{ width: pw, height: ph }} />
        ) : preview.status === "loading" ? (
          <SkeletonPage width={pw} height={ph} />
        ) : (
          <View style={[styles.blank, { width: pw, height: ph, backgroundColor: colors.rescuePaper }]} />
        )}
        <MarginOverlay
          width={pw}
          height={ph}
          top={numberOf(shown, "marginTop")}
          bottom={numberOf(shown, "marginBottom")}
          binding={numberOf(shown, "marginBinding")}
          opposite={numberOf(shown, "marginOpposite")}
          bindingSide={side}
        />
      </View>
      {preview.status === "failed" ? (
        <TouchableOpacity accessibilityRole="button" onPress={preview.retry} hitSlop={8}>
          <Text style={[styles.retry, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function Sheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const project = useRescueV2Store((s) => s.project);
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const errorInfo = useRescueV2Store((s) => s.errorInfo);
  const id = project?.id ?? null;
  const pending = useConfirmUi((s) => (s.key === id ? s.rulesPending : NO_EDITS));
  const busy = useConfirmUi((s) => s.busy);
  const pickerRow = useConfirmUi((s) => (s.key === id ? s.pickerRow : null));
  const setPickerRow = useConfirmUi((s) => s.setPickerRow);
  const shown = useShownFields();

  useEffect(() => {
    if (id) useConfirmUi.getState().ensure(id);
  }, [id]);

  // A pending value the server now holds (a retry from the shell landed, or a note changed it) is no longer pending: it must not shadow
  // what the server says from here on.
  const serverFields = project?.rules?.fields ?? null;
  useEffect(() => {
    const cur = useConfirmUi.getState();
    if (!id || !serverFields || cur.key !== id) return;
    const kept: Partial<Record<RescueRuleFieldId, RuleValue>> = {};
    for (const [k, v] of Object.entries(cur.rulesPending)) {
      const f = serverFields.find((x) => x.id === k);
      if (!(f && f.value === v)) kept[k as RescueRuleFieldId] = v;
    }
    if (Object.keys(kept).length !== Object.keys(cur.rulesPending).length) cur.setRulesPending(kept);
  }, [id, serverFields]);

  const rules = project?.rules ?? null;
  if (!project || !rules) return null;
  const unsaved = unsavedRuleEdits(rules.fields, pending);
  const hasUnsaved = Object.keys(unsaved).length > 0;
  const groups = groupRuleRows(shown);
  const captions = project.diagnosis?.captionNumbersToAdd ?? 0;
  const outOfRangeId = errorCode === "rule_out_of_range" ? (errorInfo?.fieldId as RescueRuleFieldId | undefined) ?? null : null;

  return (
    <>
      <SheetTitle>{t("rescueV2.rules.title")}</SheetTitle>
      {rules.fromGuide ? <Pill label={t("rescueV2.rules.fromGuide")} tone="success" /> : null}
      {hasUnsaved && !busy ? (
        <TouchableOpacity accessibilityRole="button" onPress={() => { void saveEdits(project.id, unsaved); }} hitSlop={8} style={styles.retryRow}>
          <Text style={[styles.retry, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      ) : null}
      {groups.map((g) => g.row === "additions" ? (
        <View key="additions" style={styles.additions}>
          <Text style={[styles.additionsTitle, { color: colors.textSecondary }]}>{t("rescueV2.rules.rows.additions")}</Text>
          {g.fields.map((f) => (
            <RuleSwitch
              key={f.id}
              field={f}
              value={f.value === true}
              disabled={busy}
              captionsToAdd={f.id === "captionNumbers" ? captions : undefined}
              onChange={(v) => { void saveEdits(project.id, { [f.id]: v }); }}
            />
          ))}
        </View>
      ) : (
        <RuleRow key={g.row} row={g.row} fields={g.fields} onPress={() => openRulePicker(g.row, setPickerRow)} />
      ))}
      <RulePickerSheet
        row={pickerRow}
        fields={shown}
        busy={busy}
        outOfRangeId={outOfRangeId}
        onEdit={(fid, v) => { void saveEdits(project.id, { [fid]: v }); }}
        onClose={() => { setPickerRow(null); useBottomSheet.getState().closeSheet("rescue-rule-picker"); }}
        onDismiss={() => setPickerRow(null)}
      />
    </>
  );
}

function Foot() {
  const { t } = useTranslation();
  const project = useRescueV2Store((s) => s.project);
  const id = project?.id ?? null;
  const busy = useConfirmUi((s) => s.busy);
  const pending = useConfirmUi((s) => (s.key === id ? s.rulesPending : NO_EDITS));
  if (!project?.rules) return null;
  const blocked = busy || Object.keys(unsavedRuleEdits(project.rules.fields, pending)).length > 0;
  return (
    <Button
      title={t("rescueV2.rules.cta")}
      onPress={() => { void confirmRules(project.id); }}
      loading={busy}
      disabled={blocked}
    />
  );
}

export const RulesStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  page: { direction: "ltr", borderRadius: 3, overflow: "hidden", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 3 },
  blank: { borderRadius: 3 },
  retry: { fontSize: 14, fontWeight: "700", marginTop: 10 },
  retryRow: { alignSelf: "flex-start", marginBottom: 8 },
  additions: { marginTop: 4, marginBottom: 6 },
  additionsTitle: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
});
