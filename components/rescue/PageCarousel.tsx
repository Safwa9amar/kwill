import React, { useCallback, useState, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import Animated, { runOnJS } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { layoutSpring } from "@/lib/motion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SHEET_RADIUS, SHEET_TOP_PCT, nextRoom, roomScale, scaleFor, stageFit, tallestMock, type StageLayout } from "@/lib/rescue-v2-layout";
import { pageIsInRange, thesisIsRtl } from "@/lib/rescue-v2-screen";
import { useRescueScreen, useRescueV2Store } from "@/stores/rescue-v2-store";
import { PageImage } from "./PageImage";

interface Props {
  versionId: string;
  page: number;
  layout: StageLayout;
  onChange?: (page: number) => void;
  interactive?: boolean;
  overlay?: ReactNode;
  /** Drawn over the middle page only (a done badge, a brand outline). Three-page layouts only. */
  midDecor?: ReactNode;
  /** The height the pages may take, when the stage stacks rows with them and places itself (stageRoom). Without it, stageFit decides. */
  room?: number;
}

/** Breathing room kept between a measured slot and the page in it. */
const SLOT_MARGIN = 8;

/**
 * The height a stage's pages may take, MEASURED off the slot they sit in (screens 7 and 8: between the before/after switch and the tip or
 * the sheet). Null until the slot has been laid out; a stage draws no page until then, so a page never shows at a size it then leaves.
 */
export function useSlotRoom(): [number | null, (e: LayoutChangeEvent) => void] {
  const [room, setRoom] = useState<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height - SLOT_MARGIN;
    setRoom((prev) => nextRoom(prev, h, 8) ?? prev);
  }, []);
  return [room, onLayout];
}

/** Points past which a horizontal drag turns the page. */
const TURN_PX = 40;

/**
 * The pages of a version in a physical row: `direction: "ltr"` keeps the order on screen. An Arabic thesis reads right to left, so its
 * next page sits on the left. Pages are placed by their own sizes; a size change between steps springs (layoutSpring).
 */
export function PageCarousel({ versionId, page, layout, onChange, interactive, overlay, midDecor, room }: Props) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const screen = useRescueScreen();
  // Scaled by the width as the mocks are, then fitted under the status bar on a short stage (stageFit).
  const stageH = screen === "failure" ? null : (height * SHEET_TOP_PCT[screen]) / 100 + SHEET_RADIUS;
  const tallest = tallestMock(layout) * scaleFor(width);
  const fit = room !== undefined
    ? { factor: 1, shift: 0 }
    : stageH === null ? { factor: 1, shift: 0 } : stageFit(stageH, tallest, insets.top);
  // With a room, the same scale a stage uses for what it draws over the page (roomScale), so a dot stays on its line.
  const s = room !== undefined ? roomScale(width, layout, room) : scaleFor(width) * fit.factor;
  const rtl = useRescueV2Store((st) => thesisIsRtl(st.project));
  // null until the page list is loaded: an unknown count shows skeletons, a known zero shows none (fix 9).
  const count = useRescueV2Store((st) => st.pages[versionId]?.count ?? null);

  const go = (delta: number) => {
    if (!onChange) return;
    const next = page + delta;
    if (next < 1 || (count !== null && next > count)) return;
    onChange(next);
  };

  // The sign of a drag that reveals the next page: right-to-left reveals it on the left, so a drag to the right.
  const toward = rtl ? 1 : -1;
  const pan = Gesture.Pan()
    .enabled(!!interactive)
    .activeOffsetX([-12, 12])
    .onEnd((e) => {
      "worklet";
      const v = e.translationX * toward;
      if (v > TURN_PX) runOnJS(go)(1);
      else if (v < -TURN_PX) runOnJS(go)(-1);
    });

  const slots: { key: string; page: number; w: number; h: number }[] = [];
  if (layout.kind === "three") {
    const [mw, mh] = [layout.mid[0] * s, layout.mid[1] * s];
    const [sw, sh] = [layout.side[0] * s, layout.side[1] * s];
    slots.push({ key: "prev", page: page - 1, w: sw, h: sh }, { key: "cur", page, w: mw, h: mh }, { key: "next", page: page + 1, w: sw, h: sh });
  } else if (layout.kind === "pair") {
    const [w, h] = [layout.each[0] * s, layout.each[1] * s];
    slots.push({ key: "cur", page, w, h }, { key: "next", page: page + 1, w, h });
  } else if (layout.kind === "big") {
    const [w, h] = [layout.page[0] * s, layout.page[1] * s];
    slots.push({ key: "cur", page, w, h });
  } else {
    return null;
  }
  const ordered = rtl && layout.kind !== "big" ? [...slots].reverse() : slots;
  const inRange = (p: number) => pageIsInRange(p, count);

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.wrap, fit.shift ? { transform: [{ translateY: fit.shift }] } : null]}>
        <View style={[styles.row, { direction: "ltr" }]}>
          {ordered.map((sl) => (
            <Animated.View key={sl.key} layout={layoutSpring} style={{ width: sl.w, height: sl.h }}>
              {inRange(sl.page)
                ? <PageImage versionId={versionId} page={sl.page} width={sl.w} height={sl.h} />
                : <View style={{ width: sl.w, height: sl.h }} />}
              {sl.key === "cur" && layout.kind === "three" ? midDecor : null}
            </Animated.View>
          ))}
        </View>
        {overlay}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
});
