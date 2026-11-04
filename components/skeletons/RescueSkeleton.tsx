import React, { useEffect } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useThemeColors } from "@/hooks/useThemeColors";
import { SHEET_RADIUS, SHEET_TOP_PCT } from "@/lib/rescue-v2-layout";

/**
 * The first load of the living screen: a stage of paper shapes and a sheet of bars, in the places the real content will be.
 * One shimmer driver, cancelled on unmount. Shown on the first load only, never over a refresh.
 */
export function RescueSkeleton() {
  const colors = useThemeColors();
  const { width, height } = useWindowDimensions();
  const sheetTop = height * (SHEET_TOP_PCT.start / 100);
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, true);
    return () => cancelAnimation(pulse);
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: 0.5 + pulse.value * 0.5 }));
  const paper = { backgroundColor: colors.bgSurface };
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.rescueStageTop }]}>
      <Animated.View style={[styles.stage, pulseStyle]}>
        <View style={[styles.side, paper, { width: width * 0.36, height: width * 0.5, marginTop: 46 }]} />
        <View style={[styles.mid, paper, { width: width * 0.52, height: width * 0.72, marginTop: 30 }]} />
        <View style={[styles.side, paper, { width: width * 0.36, height: width * 0.5, marginTop: 46 }]} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { top: sheetTop, borderTopLeftRadius: SHEET_RADIUS, borderTopRightRadius: SHEET_RADIUS, backgroundColor: colors.bgCard }, pulseStyle]}>
        <View style={[styles.bar, paper, { width: "60%", height: 22 }]} />
        <View style={[styles.bar, paper, { width: "90%", height: 14 }]} />
        <View style={[styles.bar, paper, { width: "75%", height: 14 }]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flexDirection: "row", alignItems: "flex-start", justifyContent: "center", gap: 12, paddingTop: 40 },
  side: { borderRadius: 3 },
  mid: { borderRadius: 3 },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 22, gap: 12 },
  bar: { borderRadius: 7 },
});
