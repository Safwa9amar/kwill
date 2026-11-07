import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";

interface Option<T extends string> {
  key: T;
  label: string;
  disabled?: boolean;
}

/** Two (or more) segments, one selected. The selected segment cannot be tapped again; a disabled one cannot be tapped at all. */
export function SegSwitch<T extends string>({ options, value, onChange }: { options: Option<T>[]; value: T; onChange: (key: T) => void }) {
  const colors = useThemeColors();
  const { flexDirection } = useRTL();
  return (
    <View style={[styles.wrap, { flexDirection, backgroundColor: colors.bgSurface, borderColor: colors.borderDefault }]}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <TouchableOpacity
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled: !!o.disabled }}
            disabled={on || o.disabled}
            onPress={() => onChange(o.key)}
            style={[styles.seg, on ? { backgroundColor: colors.bgCard } : null, o.disabled ? styles.off : null]}
          >
            <Text style={[styles.label, { color: on ? colors.textPrimary : colors.textSecondary }]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Drawn over its siblings: on a short screen, or with a dot's tip open, the stage's page is taller than its slot and its top
  // edge rose over the switch, hiding "Before / After" (W7, screens 7 and 8).
  wrap: { alignSelf: "center", borderWidth: 1, borderRadius: 999, padding: 3, zIndex: 2 },
  seg: { paddingHorizontal: 18, paddingVertical: 7, borderRadius: 999 },
  off: { opacity: 0.45 },
  label: { fontSize: 14, fontWeight: "700" },
});
