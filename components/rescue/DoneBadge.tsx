import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useThemeColors } from "@/hooks/useThemeColors";

/** The green check on a finished page (the mock's `okb`). Drawn over a page's corner by its parent, never on the page's own picture. */
export function DoneBadge() {
  const colors = useThemeColors();
  return (
    <View pointerEvents="none" style={[styles.badge, { backgroundColor: colors.semanticSuccess, borderColor: colors.bgCard }]}>
      <Text style={[styles.glyph, { color: colors.bgCard }]}>✓</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: "absolute",
    top: -8,
    end: -8,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  glyph: { fontSize: 12, fontWeight: "800" },
});
