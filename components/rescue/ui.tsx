import React, { useEffect, type ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { router } from "expo-router";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { rescueBack } from "@/hooks/useRescueBack";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";

/** The sheet's title line. */
export function SheetTitle({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return <Text style={[styles.title, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{children}</Text>;
}

/** A paragraph under the title. */
export function SheetBody({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return <Text style={[styles.body, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{children}</Text>;
}

/** Green-check reassurance rows, e.g. "the diagnosis is free". */
export function TrustList({ items }: { items: string[] }) {
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return (
    <View style={styles.list}>
      {items.map((item) => (
        <View key={item} style={[styles.listRow, { flexDirection: visualRow(isRTL) }]}>
          <View style={[styles.check, { backgroundColor: colors.successWash }]}>
            <Text style={[styles.checkGlyph, { color: colors.semanticSuccess }]}>✓</Text>
          </View>
          <Text style={[styles.listText, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export type StepState = "done" | "current" | "pending";
export interface StepItem { key: string; label: string; state: StepState; eta?: string | null }

/** A progress list: done, current (a spinning ring) and pending rows, with an ETA slot on the trailing side. */
export function StepList({ steps }: { steps: StepItem[] }) {
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return (
    <View style={styles.list}>
      {steps.map((st) => (
        <View key={st.key} style={[styles.listRow, { flexDirection: visualRow(isRTL) }]}>
          <View style={styles.stepIcon}>
            {st.state === "done" ? (
              <Text style={[styles.checkGlyph, { color: colors.semanticSuccess }]}>✓</Text>
            ) : st.state === "current" ? (
              <Spinner color={colors.brandPrimary} />
            ) : (
              <View style={[styles.dot, { borderColor: colors.borderDefault }]} />
            )}
          </View>
          <Text
            numberOfLines={1}
            style={[styles.listText, { flex: 1, color: st.state === "pending" ? colors.textPlaceholder : colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}
          >
            {st.label}
          </Text>
          {st.eta ? <Text style={[styles.eta, { color: colors.textSecondary }]}>{st.eta}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** The one spinning ring of the step list. Its driver is cancelled on unmount. */
function Spinner({ color }: { color: string }) {
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rot);
  }, [rot]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value * 360}deg` }] }));
  return <Animated.View style={[styles.ring, { borderColor: color, borderTopColor: "transparent" }, style]} />;
}

export function Pill({ label, tone = "brand" }: { label: string; tone?: "brand" | "success" }) {
  const colors = useThemeColors();
  return (
    <View style={[styles.pill, { backgroundColor: tone === "brand" ? colors.brandWash : colors.successWash }]}>
      <Text style={[styles.pillText, { color: tone === "brand" ? colors.brandPrimary : colors.semanticSuccess }]}>{label}</Text>
    </View>
  );
}

/** A wrapping row of chips. */
export function ChipRow({ children }: { children: ReactNode }) {
  const { isRTL } = useRTL();
  return <View style={[styles.chipRow, { flexDirection: visualRow(isRTL) }]}>{children}</View>;
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  const colors = useThemeColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: selected ? colors.brandWash : colors.bgSurface, borderColor: selected ? colors.brandPrimary : colors.borderDefault }]}
    >
      <Text style={[styles.chipText, { color: colors.textPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** A tinted card for a single point of emphasis. */
export function WashCard({ tone = "brand", children }: { tone?: "brand" | "success"; children: ReactNode }) {
  const colors = useThemeColors();
  return (
    <View style={[styles.wash, { backgroundColor: tone === "brand" ? colors.brandWash : colors.successWash }]}>{children}</View>
  );
}

/** The ✕ at the leading corner, for the screens with nowhere to step back to. Leaves to the chat. */
export function CloseButton() {
  const colors = useThemeColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      hitSlop={10}
      onPress={() => router.dismissTo("/(app)/chat")}
      style={[styles.round, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
    >
      <Text style={[styles.roundGlyph, { color: colors.textPrimary }]}>✕</Text>
    </TouchableOpacity>
  );
}

/** The ← at the leading corner. Its action is the one shared back (rescueBack), so the button and Android's back never differ. */
export function BackPill() {
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      hitSlop={10}
      onPress={() => { rescueBack(); }}
      style={[styles.round, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
    >
      {/* Directional glyph swapped, never mirrored with scaleX. */}
      <Text style={[styles.roundGlyph, { color: colors.textPrimary }]}>{isRTL ? "→" : "←"}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: "800", lineHeight: 28, marginBottom: 6 },
  body: { fontSize: 15, lineHeight: 22, marginBottom: 12 },
  list: { gap: 10, marginBottom: 12 },
  listRow: { alignItems: "center", gap: 10 },
  listText: { fontSize: 15, lineHeight: 21, flexShrink: 1 },   // a long row wraps instead of running off the screen (screen 18)
  check: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  checkGlyph: { fontSize: 13, fontWeight: "800" },
  stepIcon: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  ring: { width: 18, height: 18, borderRadius: 9, borderWidth: 2 },
  eta: { fontSize: 13 },
  pill: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "700" },
  chipRow: { flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 14, fontWeight: "600" },
  wash: { borderRadius: 16, padding: 14, marginBottom: 12 },
  round: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  roundGlyph: { fontSize: 17, fontWeight: "700" },
});
