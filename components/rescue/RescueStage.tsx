import React, { type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { useThemeColors } from "@/hooks/useThemeColors";
import { ShimmerDriver } from "./SkeletonPage";

interface Props {
  animatedPosition: SharedValue<number>;
  children: ReactNode;
}

/** The top half. It follows the sheet: its height is the sheet's top edge plus 22, so the sheet's rounded corner sits over it. */
export function RescueStage({ animatedPosition, children }: Props) {
  const colors = useThemeColors();
  const style = useAnimatedStyle(() => ({ height: Math.max(0, animatedPosition.value) + 22 }));
  return (
    <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" }, style]}>
      <LinearGradient colors={[colors.rescueStageTop, colors.rescueStageBottom]} style={StyleSheet.absoluteFill} />
      <ShimmerDriver>{children}</ShimmerDriver>
    </Animated.View>
  );
}
