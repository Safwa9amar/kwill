import React, { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useThemeColors } from "@/hooks/useThemeColors";
import { SPRING } from "@/lib/motion";
import { marginLines } from "@/lib/rescue-v2-confirm";

interface Props {
  /** The page's size on screen. */
  width: number;
  height: number;
  /** The margins in cm, as the rules hold them (the values the student sees, unsaved edits included). */
  top: number;
  bottom: number;
  binding: number;
  opposite: number;
  bindingSide: "left" | "right";
}

/**
 * Four dashed lines on the page where the margins fall. The page is laid out `direction: "ltr"`, so `start` and `end` are the physical left and
 * right whatever the app's language, and the numbers are read in their own direction. Each line springs to its place when a value changes.
 */
export function MarginOverlay({ width, height, top, bottom, binding, opposite, bindingSide }: Props) {
  const colors = useThemeColors();
  const want = marginLines({ top, bottom, binding, opposite }, bindingSide);
  const pTop = useSharedValue(want.top * height);
  const pBottom = useSharedValue((1 - want.bottom) * height);
  const pStart = useSharedValue(want.start * width);
  const pEnd = useSharedValue(want.end * width);

  useEffect(() => {
    pTop.value = withSpring(want.top * height, SPRING);
    pBottom.value = withSpring((1 - want.bottom) * height, SPRING);
    pStart.value = withSpring(want.start * width, SPRING);
    pEnd.value = withSpring(want.end * width, SPRING);
  }, [want.top, want.bottom, want.start, want.end, width, height, pTop, pBottom, pStart, pEnd]);

  useEffect(() => () => {
    cancelAnimation(pTop);
    cancelAnimation(pBottom);
    cancelAnimation(pStart);
    cancelAnimation(pEnd);
  }, [pTop, pBottom, pStart, pEnd]);

  const topStyle = useAnimatedStyle(() => ({ top: pTop.value }));
  const bottomStyle = useAnimatedStyle(() => ({ top: pBottom.value }));
  const startStyle = useAnimatedStyle(() => ({ start: pStart.value }));
  const endStyle = useAnimatedStyle(() => ({ end: pEnd.value }));
  const topLabel = useAnimatedStyle(() => ({ top: pTop.value - 14 }));
  const bottomLabel = useAnimatedStyle(() => ({ top: pBottom.value + 2 }));
  const startLabel = useAnimatedStyle(() => ({ start: pStart.value + 2 }));
  const endLabel = useAnimatedStyle(() => ({ end: pEnd.value + 2 }));

  const line = { borderColor: colors.semanticWarning };
  const label = { color: colors.semanticWarning };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { direction: "ltr" }]}>
      <Animated.View style={[styles.horizontal, line, { left: 0, right: 0 }, topStyle]} />
      <Animated.View style={[styles.horizontal, line, { left: 0, right: 0 }, bottomStyle]} />
      <Animated.View style={[styles.vertical, line, { top: 0, bottom: 0 }, startStyle]} />
      <Animated.View style={[styles.vertical, line, { top: 0, bottom: 0 }, endStyle]} />
      <Animated.Text style={[styles.label, label, topLabel, { start: width / 2 - 8 }]}>{String(top)}</Animated.Text>
      <Animated.Text style={[styles.label, label, bottomLabel, { start: width / 2 - 8 }]}>{String(bottom)}</Animated.Text>
      <Animated.Text style={[styles.label, label, startLabel, { top: height / 2 - 6 }]}>{String(bindingSide === "left" ? binding : opposite)}</Animated.Text>
      <Animated.Text style={[styles.label, label, endLabel, { top: height / 2 - 6 }]}>{String(bindingSide === "right" ? binding : opposite)}</Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  horizontal: { position: "absolute", height: 0, borderTopWidth: 1, borderStyle: "dashed" },
  vertical: { position: "absolute", width: 0, borderStartWidth: 1, borderStyle: "dashed" },
  label: { position: "absolute", fontSize: 10, fontWeight: "700" },
});
