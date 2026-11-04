import React, { useCallback, useMemo } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import GorhomBottomSheet, {
  BottomSheetFooter,
  BottomSheetScrollView,
  BottomSheetView,
  useBottomSheetSpringConfigs,
  type BottomSheetFooterProps,
} from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "@/hooks/useThemeColors";
import { SHEET_RADIUS, SHEET_TOP_PCT, scaleFor } from "@/lib/rescue-v2-layout";
import type { RescueScreen } from "@/lib/rescue-v2-screen";
import type { RescueStep } from "./steps";

interface Props {
  screen: Exclude<RescueScreen, "failure">;
  step: RescueStep;
  animatedPosition: SharedValue<number>;
}

// Persistent, never dismissed; same props as WorkspaceComposerSheet.tsx:555.
export function LivingSheet({ screen, step, animatedPosition }: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const scale = scaleFor(width);
  const top = SHEET_TOP_PCT[screen];
  // One detent, changed per step: gorhom re-targets on a snap-point change, and that move IS the spring.
  const snapPoints = useMemo(() => [`${100 - top}%`], [top]);
  const animationConfigs = useBottomSheetSpringConfigs({ damping: 26, stiffness: 240, mass: 1, overshootClamping: false });
  const renderFooter = useCallback((p: BottomSheetFooterProps) => step.Foot ? (
    <BottomSheetFooter {...p} bottomInset={insets.bottom}><step.Foot /></BottomSheetFooter>
  ) : null, [step, insets.bottom]);
  // gorhom's BottomSheetView is absolutely positioned with no bottom edge and honours only `style`: `contentContainerStyle` belongs to the
  // scroll views alone. A step that owns its gestures or scrolls itself (screen 2's reorderable list, the university picker) gets a plain
  // `flex: 1` View, so its list has a bounded height and can scroll, and `enableFooterMarginAdjustment` keeps the Foot off the last rows.
  const bodyProps = step.scrollable
    ? { Body: BottomSheetScrollView, props: { contentContainerStyle: styles.body, enableFooterMarginAdjustment: true } }
    : step.ownsGestures
      ? { Body: View, props: { style: [styles.body, { flex: 1 }] } }
      : { Body: BottomSheetView, props: { style: styles.body, enableFooterMarginAdjustment: true } };
  const Body = bodyProps.Body as React.ComponentType<any>;
  return (
    <GorhomBottomSheet
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}   // MUST stay false: see WorkspaceComposerSheet's note
      enablePanDownToClose={false}
      enableOverDrag={false}
      enableContentPanningGesture={!step.ownsGestures}
      animatedPosition={animatedPosition}
      animationConfigs={animationConfigs}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{ backgroundColor: colors.bgCard, borderTopLeftRadius: SHEET_RADIUS * scale, borderTopRightRadius: SHEET_RADIUS * scale }}
      handleIndicatorStyle={{ backgroundColor: colors.borderDefault }}
      footerComponent={renderFooter}
    >
      {/* key: one stable identity per screen, so children's entering animations fire. */}
      <Body key={screen} {...bodyProps.props}><step.Sheet /></Body>
    </GorhomBottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 4 },
});
