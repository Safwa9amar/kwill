import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { BottomSheet } from "@/components/BottomSheet";
import { ChipRow, Chip, Pill, SheetBody, SheetTitle } from "@/components/rescue/ui";
import { RuleSwitch, useRuleWords } from "@/components/rescue/RuleRow";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { stepRuleNumber, type RuleValue } from "@/lib/rescue-v2-confirm";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueRuleFieldDTO, RescueRuleFieldId, RescueRuleRowId } from "@/types/rescue-v2";

interface Props {
  /** The row being edited, or null when the picker is not open. */
  row: RescueRuleRowId | null;
  /** The row's fields with unsaved edits in their values. */
  fields: RescueRuleFieldDTO[];
  busy: boolean;
  /** The field the server refused as out of range, when it did. */
  outOfRangeId: RescueRuleFieldId | null;
  /** A choice: sends that one edit. */
  onEdit: (id: RescueRuleFieldId, value: RuleValue) => void;
  onClose: () => void;
  onDismiss: () => void;
}

/**
 * The picker of one row: every field of the row. Enums are a list of choices, numbers a stepper inside their own range, switches a switch.
 * A choice sends its one edit at once; the picker stays open so a row with several fields can be done in one visit.
 */
export function RulePickerSheet({ row, fields, busy, outOfRangeId, onEdit, onClose, onDismiss }: Props) {
  return (
    <BottomSheet name="rescue-rule-picker" scrollable onDismiss={onDismiss}>
      {row ? <PickerBody row={row} fields={fields} busy={busy} outOfRangeId={outOfRangeId} onEdit={onEdit} onClose={onClose} /> : null}
    </BottomSheet>
  );
}

function PickerBody({ row, fields, busy, outOfRangeId, onEdit, onClose }: Omit<Props, "onDismiss"> & { row: RescueRuleRowId }) {
  const words = useRuleWords();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const own = fields.filter((f) => f.row === row);
  const refused = outOfRangeId !== null && own.some((f) => f.id === outOfRangeId);
  // A save that failed for any other reason is named here too: the sheet covers the stage, where the shell's error line sits. Only a save
  // this sheet made counts: its failed edit stays on screen, so its value is not the server's. Another action's error is not this sheet's.
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const serverFields = useRescueV2Store((s) => s.project?.rules?.fields ?? null);
  const unsaved = own.some((f) => {
    const server = serverFields?.find((x) => x.id === f.id);
    return server !== undefined && server.value !== f.value;
  });
  return (
    <>
      <SheetTitle>{words.t(`rescueV2.rules.rows.${row}`)}</SheetTitle>
      {refused ? <SheetBody>{words.t("rescueV2.rules.outOfRange")}</SheetBody> : null}
      {!refused && unsaved && errorCode && !busy ? <SheetBody>{words.t("rescueV2.common.somethingWrong")}</SheetBody> : null}
      {own.map((f) => (
        <FieldControl key={f.id} field={f} busy={busy} onEdit={(v) => onEdit(f.id, v)} />
      ))}
      <TouchableOpacity accessibilityRole="button" onPress={onClose} hitSlop={8} style={[styles.done, { alignSelf: isRTL ? "flex-start" : "flex-end" }]}>
        <Text style={[styles.doneText, { color: colors.brandPrimary, textAlign: visualTextAlign(isRTL) }]}>{words.t("rescueV2.rules.done")}</Text>
      </TouchableOpacity>
    </>
  );
}

function FieldControl({ field, busy, onEdit }: { field: RescueRuleFieldDTO; busy: boolean; onEdit: (v: RuleValue) => void }) {
  const words = useRuleWords();
  const colors = useThemeColors();
  const { isRTL } = useRTL();

  if (field.kind === "switch") {
    return (
      <RuleSwitch field={field} value={field.value === true} disabled={busy} onChange={(v) => onEdit(v)} />
    );
  }

  const label = (
    <View style={[styles.labelRow, { flexDirection: visualRow(isRTL) }]}>
      <Text style={[styles.label, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{words.t(`rescueV2.rules.fields.${field.id}`)}</Text>
      {field.source === "note" ? <Pill label={words.t("rescueV2.rules.fromNote")} tone="success" /> : null}
    </View>
  );

  if (field.kind === "enum") {
    const options = field.options ?? [];
    return (
      <View style={styles.block}>
        {label}
        <ChipRow>
          {options.map((o) => (
            <Chip
              key={String(o)}
              label={words.enumLabel(field.id, o)}
              selected={field.value === o}
              onPress={() => { if (!busy && field.value !== o) onEdit(o); }}
            />
          ))}
        </ChipRow>
      </View>
    );
  }

  // A number: a stepper inside its own range. A field the server sent with no range keeps its value (no step is invented).
  const min = field.min ?? Number(field.value);
  const max = field.max ?? Number(field.value);
  const step = field.step ?? 1;
  const current = Number(field.value);
  const range = { min, max, step };
  const canDown = !busy && stepRuleNumber(current, -1, range) !== current;
  const canUp = !busy && stepRuleNumber(current, 1, range) !== current;
  return (
    <View style={[styles.block, styles.stepperRow, { flexDirection: visualRow(isRTL) }]}>
      <View style={styles.stepperLabel}>{label}</View>
      <View style={[styles.stepper, { flexDirection: visualRow(isRTL), borderColor: colors.borderDefault }]}>
        <TouchableOpacity accessibilityRole="button" disabled={!canDown} onPress={() => onEdit(stepRuleNumber(current, -1, range))} hitSlop={8} style={styles.stepBtn}>
          <Text style={[styles.stepGlyph, { color: canDown ? colors.brandPrimary : colors.textPlaceholder }]}>−</Text>
        </TouchableOpacity>
        <Text style={[styles.stepValue, { color: colors.textPrimary }]}>{String(field.value)}</Text>
        <TouchableOpacity accessibilityRole="button" disabled={!canUp} onPress={() => onEdit(stepRuleNumber(current, 1, range))} hitSlop={8} style={styles.stepBtn}>
          <Text style={[styles.stepGlyph, { color: canUp ? colors.brandPrimary : colors.textPlaceholder }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** Opens the picker of a row. The row is set first, so the sheet has its content when it presents. */
export function openRulePicker(row: RescueRuleRowId, setRow: (r: RescueRuleRowId | null) => void) {
  setRow(row);
  useBottomSheet.getState().openSheet("rescue-rule-picker");
}

const styles = StyleSheet.create({
  block: { marginBottom: 14 },
  labelRow: { alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" },
  label: { fontSize: 14, fontWeight: "700" },
  stepperRow: { alignItems: "center", justifyContent: "space-between", gap: 12 },
  stepperLabel: { flex: 1 },
  stepper: { alignItems: "center", borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, gap: 6 },
  stepBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  stepGlyph: { fontSize: 22, fontWeight: "700" },
  stepValue: { minWidth: 44, textAlign: "center", fontSize: 16, fontWeight: "700" },
  done: { paddingVertical: 10, marginTop: 4 },
  doneText: { fontSize: 15, fontWeight: "700" },
});
