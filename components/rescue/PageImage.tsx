import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const colors = useThemeColors();
  const hash = usePageMeta(versionId, page);
  const url = useRescueV2Store((s) => s.pages[versionId]?.byPage[page]?.url ?? null);
  const pagesReady = useRescuePagesReady();
  const loadPages = useRescueV2Store((s) => s.loadPages);
  // The slot's page is named by its hash and URL together. A picture, or a failure, is kept only for the page it was made for: when the page
  // changes, the slot shows a skeleton at once and can never show another page's picture (fix 10).
  const key = hash && url ? `${hash}|${url}` : null;
  const [done, setDone] = useState<{ key: string; uri: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const uri = key !== null && done?.key === key ? done.uri : null;
  const failed = key !== null && failedKey === key;
  const opacity = useSharedValue(0);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // A page can land while the stage runs, so the ask is repeated whenever the page count moves.
  useEffect(() => {
    if (!hash) void loadPages(versionId, page, page + 11);
  }, [hash, pagesReady, versionId, page, loadPages]);

  useEffect(() => {
    if (!key || !hash || !url) return;
    let alive = true;
    localPageUri(hash, url).then(
      (u) => { if (alive) setDone({ key, uri: u }); },
      // A failed download is shown, never left as a skeleton: the student can try this page again.
      () => { if (alive) setFailedKey(key); },
    );
    return () => { alive = false; };
  }, [key, hash, url, attempt]);

  const paper = [styles.paper, { width, height, backgroundColor: colors.rescuePaper, opacity: dim ? 0.45 : 1, shadowColor: colors.textPrimary }];

  if (failed) {
    return (
      <View style={paper}>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => { setDone(null); setFailedKey(null); setAttempt((a) => a + 1); }}
          style={styles.retry}
        >
          <Text style={[styles.retryText, { color: colors.brandPrimary }]}>{t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!uri) return <SkeletonPage width={width} height={height} />;
  // A file that downloads but will not decode is the same failure as a failed download: onError shows the same calm paper.
  return (
    <View style={paper}>
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={[{ width, height }, fade]}
        onLoad={() => { opacity.value = withTiming(1, { duration: 220 }); }}
        onError={() => { if (key) setFailedKey(key); }}
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
  retry: { flex: 1, alignItems: "center", justifyContent: "center" },
  retryText: { fontSize: 14, fontWeight: "700" },
});
