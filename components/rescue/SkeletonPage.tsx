import React, { createContext, useContext, useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { useThemeColors } from "@/hooks/useThemeColors";

// One shimmer per screen: the stage owns it (ShimmerDriver), and every SkeletonPage under it reads the same value.
const ShimmerContext = createContext<SharedValue<number> | null>(null);

export function ShimmerDriver({ children }: { children: ReactNode }) {
  const sv = useSharedValue(0);
  useEffect(() => {
    sv.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(sv);
  }, [sv]);
  return <ShimmerContext.Provider value={sv}>{children}</ShimmerContext.Provider>;
}

/** A paper-shaped placeholder for a page that has not arrived yet. Layout-shaped, never a spinner. */
export function SkeletonPage({ width, height }: { width: number; height: number }) {
  const colors = useThemeColors();
  const sv = useContext(ShimmerContext);
  const shimmer = useAnimatedStyle(() => ({
    transform: [{ translateX: sv ? interpolate(sv.value, [0, 1], [-width, width]) : 0 }],
  }));
  return (
    <View style={[styles.page, { width, height, backgroundColor: colors.bgSurface }]}>
      <Animated.View style={[StyleSheet.absoluteFill, shimmer]}>
        <LinearGradient
          colors={["transparent", colors.bgCard, "transparent"]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { borderRadius: 3, overflow: "hidden" },
});
