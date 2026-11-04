import React, { useEffect } from "react";
import { I18nManager, Image, StyleSheet, View } from "react-native";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

interface Props {
  /** The page as it was: the underlay. */
  before: string;
  /** The page after the repair, watermarked: the top image, revealed by the sweep. */
  after: string;
  width: number;
  height: number;
  /** True reveals `after`; false hides it again. The change animates. */
  on: boolean;
  /** The THESIS' direction (thesisIsRtl), not the app's: the sweep starts from the page's start edge. */
  rtl: boolean;
}

/**
 * The before/after cross-fade of screen 8: the after image is clipped by an animated width, so the sweep reveals it from the page's start
 * edge. The clip and the image share one anchor, so the revealed part is always the matching part of the page.
 *
 * The anchor is a physical edge chosen from the thesis direction. I18nManager mirrors a literal left/right when the app is forced RTL,
 * so the key is flipped in that case, the same rule as useRTL's `start`. `direction: "ltr"` keeps the moving node out of the mirror.
 */
export function SweepFade({ before, after, width, height, on, rtl }: Props) {
  const w = useSharedValue(0);
  useEffect(() => {
    w.value = withTiming(on ? width : 0, { duration: 600, easing: Easing.inOut(Easing.ease) });
    return () => cancelAnimation(w);
  }, [on, width, w]);
  const clip = useAnimatedStyle(() => ({ width: w.value }));
  // Typed as two literal objects, so the style keeps its ViewStyle shape.
  const anchor = rtl === I18nManager.isRTL ? { left: 0 } : { right: 0 };
  return (
    <View style={{ width, height, direction: "ltr" }}>
      <Image source={{ uri: before }} style={{ width, height }} />
      <Animated.View style={[styles.clip, anchor, clip]}>
        <Image source={{ uri: after }} style={[styles.after, { width, height }, anchor]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: "absolute", top: 0, bottom: 0, overflow: "hidden" },
  after: { position: "absolute", top: 0 },
});
