import React from "react";
import { StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Pill } from "@/components/rescue/ui";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import type { RescueRuleFieldDTO, RescueRuleFieldId, RescueRuleRowId } from "@/types/rescue-v2";

/** The fields a row's line names, in the order it names them. Additions have no line: its switches sit inline. */
const SUMMARY_FIELDS: Partial<Record<RescueRuleRowId, RescueRuleFieldId[]>> = {
  font: ["bodyFont", "bodySize"],
  spacing: ["alignment", "lineSpacing"],
  headings: ["h1Size", "h2Size", "h3Size"],
  margins: ["marginTop", "marginBottom", "marginBinding", "marginOpposite"],
  numbering: ["frontMatter", "pagePosition"],
  footnotes: ["footnoteSize"],
  deposit: ["deposit"],
};

/** Font names are not translated: they are shown as the font is called. */
const FONT_FIELDS: ReadonlySet<RescueRuleFieldId> = new Set<RescueRuleFieldId>(["bodyFont", "secondFont"]);

/** The words for rules, with an enum's value turned into its label. A value with no word is shown as it is, never as a key. */
export function useRuleWords() {
  const { t, i18n } = useTranslation();
  const enumLabel = (id: RescueRuleFieldId, v: string | number | boolean): string => {
    if (FONT_FIELDS.has(id)) return String(v);
    const key = `rescueV2.rules.values.${String(v)}`;
    return i18n.exists(key) ? t(key) : String(v);
  };
  return { t, i18n, enumLabel };
}

/** A field's value as a short piece of a row's line. */
function short(words: ReturnType<typeof useRuleWords>, f: RescueRuleFieldDTO): string {
  if (f.kind === "enum") return words.enumLabel(f.id, f.value);
  return String(f.value);
}

interface RowProps {
  row: RescueRuleRowId;
  /** The row's fields with the student's unsaved edits already in their values. */
  fields: RescueRuleFieldDTO[];
  onPress: () => void;
}

/** One line of the rules sheet: the row's name, the values, and a chevron into its picker. A value from the student's note is tinted and tagged. */
export function RuleRow({ row, fields, onPress }: RowProps) {
  const words = useRuleWords();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const ids = SUMMARY_FIELDS[row] ?? [];
  const shown = ids.map((id) => fields.find((f) => f.id === id)).filter((f): f is RescueRuleFieldDTO => !!f);
  // An RTL UI starts the line with an RLM: iOS takes a line's direction from its first strong letter, so "18 · 16 · 14" (no
  // letter) and "i ii iii ثم 1 2 3 · …" (a Latin one) were laid out left to right and an Arabic reader met the values last first.
  const line = (isRTL ? "\u200F" : "") + shown.map((f) => short(words, f)).join(" · ");
  const fromNote = fields.some((f) => f.source === "note");
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, { flexDirection: visualRow(isRTL), backgroundColor: fromNote ? colors.successWash : colors.bgSurface, borderColor: colors.borderDefault }]}
    >
      <View style={styles.main}>
        <View style={[styles.head, { flexDirection: visualRow(isRTL) }]}>
          <Text style={[styles.name, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{words.t(`rescueV2.rules.rows.${row}`)}</Text>
          {fromNote ? <Pill label={words.t("rescueV2.rules.fromNote")} tone="success" /> : null}
        </View>
        <Text numberOfLines={1} style={[styles.value, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{line}</Text>
      </View>
      {/* A directional glyph chosen by direction, never mirrored with scaleX. */}
      <Text style={[styles.chevron, { color: colors.textSecondary }]}>{isRTL ? "‹" : "›"}</Text>
    </TouchableOpacity>
  );
}

interface SwitchProps {
  field: RescueRuleFieldDTO;
  value: boolean;
  disabled: boolean;
  /** Number of captions D-22 will number, shown under the caption switch when above 0. */
  captionsToAdd?: number;
  onChange: (v: boolean) => void;
}

/** A switch on its own line, with its hint when there is one. Used inline for the additions, and in a picker for the rest. */
export function RuleSwitch({ field, value, disabled, captionsToAdd, onChange }: SwitchProps) {
  const words = useRuleWords();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const hintKey = `rescueV2.rules.hints.${field.id}`;
  const hint = words.i18n.exists(hintKey) ? words.t(hintKey) : null;
  return (
    <View style={[styles.switchRow, { flexDirection: visualRow(isRTL), borderColor: colors.borderDefault }]}>
      <View style={styles.main}>
        <View style={[styles.head, { flexDirection: visualRow(isRTL) }]}>
          <Text style={[styles.name, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{words.t(`rescueV2.rules.fields.${field.id}`)}</Text>
          {field.source === "note" ? <Pill label={words.t("rescueV2.rules.fromNote")} tone="success" /> : null}
        </View>
        {hint ? <Text style={[styles.hint, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{hint}</Text> : null}
        {field.id === "captionNumbers" && captionsToAdd && captionsToAdd > 0 ? (
          <Text style={[styles.hint, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>
            {words.t("rescueV2.rules.hints.captionNumbersCount", { count: captionsToAdd })}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: colors.borderDefault, true: colors.brandPrimary }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10 },
  main: { flex: 1 },
  head: { alignItems: "center", gap: 8, flexWrap: "wrap" },
  name: { fontSize: 13, fontWeight: "600" },
  value: { fontSize: 15, fontWeight: "700", marginTop: 2 },
  chevron: { fontSize: 22, fontWeight: "400" },
  switchRow: { alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});
