import React, { useEffect, useMemo, useState } from "react";
import { I18nManager, Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useTranslation } from "react-i18next";
import { SkeletonPage } from "@/components/rescue/SkeletonPage";
import { useThemeColors } from "@/hooks/useThemeColors";
import { localPageUri } from "@/lib/rescue-v2-page-cache";

const HANDLE = 28;

interface PageRef { hash: string; url: string }
interface Props {
  /** The older version's page, or null when that version has no such page (an extra page on the other side). */
  a: PageRef | null;
  b: PageRef;
  width: number;
  height: number;
}

interface Local { uri: string | null; failed: boolean; loading: boolean; retry(): void }

/** One saved page on this device. Downloaded once per hash (P-12); a failed download is shown with a retry, never left as a skeleton. */
function useLocalPage(ref: PageRef | null): Local {
  const hash = ref?.hash ?? null;
  const url = ref?.url ?? null;
  const key = hash && url ? `${hash}|${url}` : null;
  const [got, setGot] = useState<{ key: string; uri: string | null }>({ key: "", uri: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!hash || !url) return;
    const k = `${hash}|${url}`;
    let alive = true;
    localPageUri(hash, url).then(
      (uri) => { if (alive) setGot({ key: k, uri }); },
      () => { if (alive) setGot({ key: k, uri: null }); },
    );
    return () => { alive = false; };
  }, [hash, url, attempt]);
  const settled = key !== null && got.key === key;
  return {
    uri: settled ? got.uri : null,
    failed: settled && got.uri === null,
    loading: key !== null && !settled,
    retry: () => { setGot({ key: "", uri: null }); setAttempt((n) => n + 1); },
  };
}

function Slot({ page, width, height }: { page: Local; width: number; height: number }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  if (page.uri) return <Image source={{ uri: page.uri }} resizeMode="contain" style={{ width, height }} />;
  if (page.failed) {
    return (
      <TouchableOpacity accessibilityRole="button" onPress={page.retry} style={[styles.paper, { width, height, backgroundColor: colors.rescuePaper }]}>
        <Text style={[styles.retry, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
      </TouchableOpacity>
    );
  }
  return <SkeletonPage width={width} height={height} />;
}

/**
 * Two saved pages, one over the other, split by a handle the student drags. The older page is on the left, whatever the language: the
 * stage is forced left to right, and the clip is anchored to the physical left edge in both directions (`left` is mirrored by RN under
 * forced RTL, so the RTL value is `right`). Both pages are the version's own saved images: nothing is converted or waited for.
 */
export function CompareSlider({ a, b, width, height }: Props) {
  const colors = useThemeColors();
  const aPage = useLocalPage(a);
  const bPage = useLocalPage(b);
  const x = useSharedValue(width / 2);
  const start = useSharedValue(0);
  const pan = useMemo(() => {
    const g = Gesture.Pan();
    g.onBegin(() => { "worklet"; start.value = x.value; });
    g.onUpdate((e) => { "worklet"; x.value = Math.min(width, Math.max(0, start.value + e.translationX)); });
    return g;
  }, [width, start, x]);
  const clip = useAnimatedStyle(() => ({ width: x.value }));
  // The line is 2 px wide, centred on the split; the knob is centred on it too, at the middle of the stage.
  const line = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - 1 }] }));
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - HANDLE / 2 }] }));
  const anchor = I18nManager.isRTL ? { right: 0 } : { left: 0 };

  return (
    <GestureDetector gesture={pan}>
      <View style={{ width, height, direction: "ltr" }}>
        <Slot page={bPage} width={width} height={height} />
        {a ? (
          <Animated.View style={[styles.clip, { height }, anchor, clip]}>
            <Slot page={aPage} width={width} height={height} />
          </Animated.View>
        ) : null}
        {a ? (
          <Animated.View style={[styles.line, { height, backgroundColor: colors.brandPrimary }, anchor, line]} />
        ) : null}
        {a ? (
          <Animated.View style={[styles.knob, { top: height / 2 - HANDLE / 2, backgroundColor: colors.brandPrimary, borderColor: colors.bgCard }, anchor, knob]} />
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  clip: { position: "absolute", top: 0, overflow: "hidden" },
  line: { position: "absolute", top: 0, width: 2 },
  knob: { position: "absolute", width: HANDLE, height: HANDLE, borderRadius: HANDLE / 2, borderWidth: 2 },
  paper: { alignItems: "center", justifyContent: "center", borderRadius: 3 },
  retry: { fontSize: 14, fontWeight: "700" },
});
