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
  const { width, height } = useWindowDimensions();
  const scale = scaleFor(width);
  const top = SHEET_TOP_PCT[screen];
  // One detent, changed per step: gorhom re-targets on a snap-point change, and that move IS the spring. In points, not a percentage:
  // `topInset` below shortens gorhom's container, and a percentage of it would lower every sheet; this keeps the sheet's top at `top`% of
  // the screen, the same line the stages measure from.
  const snapPoints = useMemo(() => [(height * (100 - top)) / 100], [height, top]);
  const animationConfigs = useBottomSheetSpringConfigs({ damping: 26, stiffness: 240, mass: 1, overshootClamping: false });
  const renderFooter = useCallback((p: BottomSheetFooterProps) => step.Foot ? (
    // The Foot gets the body's side padding and the sheet's colour, so its CTA never meets the screen's edges and no row
    // shows beside or under it, down to the screen's bottom edge (the safe area is padding, not a gap).
    // Over a scrolling body the rows run on under the Foot at rest: a hairline marks its edge, so a card cut there reads as going under it,
    // not as the CTA's links sitting inside the card (screen 15's pack). The body's end is padded by the Foot's height (with its safe area).
    <BottomSheetFooter {...p}>
      <View style={[styles.foot, { backgroundColor: colors.bgCard, paddingBottom: insets.bottom }, step.scrollable && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault, paddingTop: 8 }]}><step.Foot /></View>
    </BottomSheetFooter>
  ) : null, [step, insets.bottom, colors.bgCard, colors.borderDefault]);
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
      // With the keyboard up the sheet rises by its height, and a tall sheet (screen 5) went up under the status bar: it stops below it.
      topInset={insets.top}
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
  foot: { paddingHorizontal: 20 },
});
