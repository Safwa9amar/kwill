import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import type { RescueNoteChipDTO, RescueNoteConflictDTO, RescueNoteDTO } from "@/types/rescue-v2";
import { ChipRow } from "./ui";

interface NoteChipsProps {
  chips: RescueNoteChipDTO[];
  /** Lines for what the note asked that Kwill will not do, under the chips and never under "what we understood" (P-45). */
  refused?: RescueNoteDTO["refused"];
  /** Clashes between the note and the department guide that the student has not settled. */
  conflicts?: RescueNoteConflictDTO[];
  /** Disables the chip and conflict buttons while a request is in flight. */
  busy?: boolean;
  onRemove?: (chipId: string) => void;
  onResolve?: (conflictId: string, choice: "note" | "guide") => void;
}

const REFUSED_KEY: Record<RescueNoteDTO["refused"][number]["reason"], string> = {
  "changes-words": "notes.refusedWords",
  "skips-checks": "notes.refusedChecks",
  "breaks-deposit": "notes.refusedDeposit",
  "not-supported": "notes.refusedUnsupported",
};

/**
 * The note's read-back, in one place so the notes screen and the history screen show the same thing. A value is shown as its own word when
 * the rule has one (`rules.values`), otherwise as it is written.
 */
function valueWord(t: (k: string) => string, i18nExists: (k: string) => boolean, v: string | number | boolean): string {
  const key = `rescueV2.rules.values.${String(v)}`;
  return typeof v === "string" && i18nExists(key) ? t(key) : String(v);
}

/** The chips a student can remove, the lines for what was refused, and the conflicts still open. */
export function NoteChips({ chips, refused, conflicts, busy, onRemove, onResolve }: NoteChipsProps) {
  const colors = useThemeColors();
  const { t, i18n } = useTranslation();
  const { isRTL } = useRTL();
  const open = (conflicts ?? []).filter((c) => c.choice === null);
  const exists = (k: string) => i18n.exists(k);
  const tr = (k: string, o?: Record<string, string>) => t(`rescueV2.${k}`, o);

  return (
    <View>
      {chips.length > 0 ? (
        <View>
          <Text style={[styles.heading, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{tr("notes.understood")}</Text>
          <ChipRow>
            {chips.map((c) => (
              <View key={c.id} style={[styles.chip, { backgroundColor: colors.successWash, borderColor: colors.semanticSuccess, flexDirection: visualRow(isRTL) }]}>
                <Text style={[styles.chipText, { color: colors.textPrimary }]}>✓ {c.label}</Text>
                {onRemove ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={tr("common.cancel")}
                    disabled={busy}
                    onPress={() => onRemove(c.id)}
                    hitSlop={8}
                  >
                    <Text style={[styles.remove, { color: colors.textSecondary }]}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </ChipRow>
        </View>
      ) : null}

      {(refused ?? []).map((r, i) => (
        <Text key={`${r.reason}-${i}`} style={[styles.refused, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>
          {tr(REFUSED_KEY[r.reason], { label: r.label })}
        </Text>
      ))}

      {open.map((c) => {
        const label = t(`rescueV2.rules.fields.${c.fieldId}`);
        const noteValue = valueWord(t, exists, c.noteValue);
        const guideValue = valueWord(t, exists, c.guideValue);
        return (
          <View key={c.id} style={[styles.warn, { backgroundColor: colors.semanticWarning + "1F" }]}>
            <Text style={[styles.conflict, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>
              {tr("notes.conflict", { label, guide: guideValue, note: noteValue })}
            </Text>
            <View style={[styles.choices, { flexDirection: visualRow(isRTL) }]}>
              <Pressable
                accessibilityRole="button"
                disabled={busy || !onResolve}
                onPress={() => onResolve?.(c.id, "note")}
                style={[styles.choice, { borderColor: colors.brandPrimary, backgroundColor: colors.bgCard }]}
              >
                <Text style={[styles.choiceText, { color: colors.brandPrimary }]}>{tr("notes.conflictMine", { value: noteValue })}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy || !onResolve}
                onPress={() => onResolve?.(c.id, "guide")}
                style={[styles.choice, { borderColor: colors.borderDefault, backgroundColor: colors.bgCard }]}
              >
                <Text style={[styles.choiceText, { color: colors.textPrimary }]}>{tr("notes.conflictGuide", { value: guideValue })}</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 14, fontWeight: "700", marginBottom: 6 },
  chip: { alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: "600" },
  remove: { fontSize: 13, fontWeight: "700" },
  refused: { fontSize: 13, lineHeight: 19, marginBottom: 6 },
  conflict: { fontSize: 14, lineHeight: 20, fontWeight: "600", marginBottom: 10 },
  warn: { borderRadius: 16, padding: 14, marginBottom: 12 },
  choices: { gap: 8 },
  choice: { flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 8, alignItems: "center" },
  choiceText: { fontSize: 13, fontWeight: "700" },
});
