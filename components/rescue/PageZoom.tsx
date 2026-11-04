import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useThemeColors } from "@/hooks/useThemeColors";
import { SPRING } from "@/lib/motion";
import { ZOOM_SCALE, zoomFor } from "@/lib/rescue-v2-confirm";
import { PageImage } from "./PageImage";

interface Props {
  /** The version whose page this is (the original, for a question: the questions point at its pages). */
  versionId: string;
  page: number;
  /** Where the line sits on the page, 0 at the top to 1 at the foot. */
  topPct: number;
  /** The page's size on screen before the zoom. */
  pageW: number;
  pageH: number;
}

/**
 * The page of one question, zoomed onto its line. It starts unzoomed and springs to the zoom once the stage has been measured, so the student
 * sees the page, then the line. The highlight band is drawn on the page itself, so it zooms with it. Mount it with a key per question: the
 * spring then starts again for each one.
 */
export function PageZoom({ versionId, page, topPct, pageW, pageH }: Props) {
  const colors = useThemeColors();
  const [stageH, setStageH] = useState(0);
  const scale = useSharedValue(1);
  const ty = useSharedValue(0);
  const target = stageH > 0 ? zoomFor(pageH, stageH, topPct, ZOOM_SCALE) : null;
  const targetScale = target?.scale ?? 1;
  const targetY = target?.translateY ?? 0;

  useEffect(() => {
    if (stageH <= 0) return;
    scale.value = withSpring(targetScale, SPRING);
    ty.value = withSpring(targetY, SPRING);
  }, [stageH, targetScale, targetY, scale, ty]);

  useEffect(() => () => {
    cancelAnimation(scale);
    cancelAnimation(ty);
  }, [scale, ty]);

  const zoom = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }, { scale: scale.value }] }));
  const bandTop = topPct * pageH - pageH * 0.015;

  return (
    <View style={styles.stage} onLayout={(e) => setStageH(e.nativeEvent.layout.height)}>
      <Animated.View style={[{ width: pageW, height: pageH, direction: "ltr" }, zoom]}>
        <PageImage versionId={versionId} page={page} width={pageW} height={pageH} />
        <View
          pointerEvents="none"
          style={[styles.band, { top: bandTop, height: pageH * 0.03, borderColor: colors.semanticWarning }]}
        >
          <View style={[StyleSheet.absoluteFill, styles.bandFill, { backgroundColor: colors.semanticWarning }]} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center", width: "100%" },
  band: { position: "absolute", left: 0, right: 0, borderWidth: 1.5, borderRadius: 2 },
  bandFill: { opacity: 0.22 },
});
