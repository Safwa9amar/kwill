import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useThemeColors } from "@/hooks/useThemeColors";
import { localPageUri } from "@/lib/rescue-v2-page-cache";
import { useRescuePagesReady, usePageMeta, useRescueV2Store } from "@/stores/rescue-v2-store";
import { SkeletonPage } from "./SkeletonPage";

interface Props {
  versionId: string;
  page: number;
  width: number;
  height: number;
  /** Screen 13's grey pages. */
  dim?: boolean;
}

/** One page of a version, from the local cache once downloaded. Asks the store for the page when it is missing. */
export function PageImage({ versionId, page, width, height, dim }: Props) {
  const colors = useThemeColors();
  const hash = usePageMeta(versionId, page);
  const url = useRescueV2Store((s) => s.pages[versionId]?.byPage[page]?.url ?? null);
  const pagesReady = useRescuePagesReady();
  const loadPages = useRescueV2Store((s) => s.loadPages);
  const [uri, setUri] = useState<string | null>(null);
  const opacity = useSharedValue(0);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // A page can land while the stage runs, so the ask is repeated whenever the page count moves.
  useEffect(() => {
    if (!hash) void loadPages(versionId, page, page + 11);
  }, [hash, pagesReady, versionId, page, loadPages]);

  useEffect(() => {
    if (!hash || !url) return;
    let alive = true;
    localPageUri(hash, url).then((u) => { if (alive) setUri(u); }).catch(() => {});
    return () => { alive = false; };
  }, [hash, url]);

  if (!uri) return <SkeletonPage width={width} height={height} />;
  return (
    <View style={[styles.paper, { width, height, backgroundColor: colors.rescuePaper, opacity: dim ? 0.45 : 1, shadowColor: colors.textPrimary }]}>
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={[{ width, height }, fade]}
        onLoad={() => { opacity.value = withTiming(1, { duration: 220 }); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  paper: {
    borderRadius: 3,
    overflow: "hidden",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 3,
  },
});
