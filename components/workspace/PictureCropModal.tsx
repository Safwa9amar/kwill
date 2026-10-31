import { useEffect, useMemo, useState } from "react";
import {
  Modal, View, Text, Pressable, Image, ActivityIndicator, StyleSheet, useWindowDimensions,
} from "react-native";
import { GestureDetector, Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useSharedValue, useAnimatedStyle } from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { downloadBlockImage, cropLocalImage } from "@/lib/thesis-image-edit";
import { replaceThesisBlockImage } from "@/lib/api";
import { useDocxSurfaceStore } from "@/stores/docx-surface-store";

const HANDLE = 28; // corner hit target
const MIN = 48; // min crop size (display px)

/**
 * Interactive crop for the selected figure block. Downloads the block's current
 * image, lets the student drag the crop rectangle (body to move, corners to
 * resize), then crops on-device and uploads the result. `blockIndex` null = closed.
 */
export function PictureCropModal({
  thesisId,
  blockIndex,
  onClose,
  onDone,
}: {
  thesisId: string;
  blockIndex: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { width: winW, height: winH } = useWindowDimensions();

  const [uri, setUri] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  // Crop rect + drag-start snapshot, all in DISPLAY px (worklet-driven).
  const cx = useSharedValue(0), cy = useSharedValue(0), cw = useSharedValue(0), ch = useSharedValue(0);
  const sx = useSharedValue(0), sy = useSharedValue(0), sw = useSharedValue(0), sh = useSharedValue(0);

  // Fit the image into the available area (below header, above footer).
  const disp = useMemo(() => {
    if (!nat) return null;
    const availW = winW - 32;
    const availH = winH - 220;
    const ratio = nat.w / nat.h;
    let w = availW;
    let h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }
    return { w: Math.round(w), h: Math.round(h) };
  }, [nat, winW, winH]);

  // Load the block image when opened; reset when closed.
  useEffect(() => {
    let alive = true;
    if (blockIndex == null) { setUri(null); setNat(null); setError(false); setSaving(false); return; }
    setUri(null); setNat(null); setError(false);
    (async () => {
      try {
        const local = await downloadBlockImage(thesisId, blockIndex);
        if (!alive) return;
        setUri(local);
        Image.getSize(
          local,
          (w, h) => { if (alive) setNat({ w, h }); },
          () => { if (alive) setError(true); },
        );
      } catch {
        if (alive) setError(true);
      }
    })();
    return () => { alive = false; };
  }, [blockIndex, thesisId]);

  // Initialise the crop rect to the full image once we know the display size.
  useEffect(() => {
    if (!disp) return;
    cx.value = 0; cy.value = 0; cw.value = disp.w; ch.value = disp.h;
  }, [disp, cx, cy, cw, ch]);

  const imgW = disp?.w ?? 0;
  const imgH = disp?.h ?? 0;

  const clampW = (v: number, lo: number, hi: number) => { "worklet"; return Math.min(Math.max(v, lo), hi); };

  const body = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => { sx.value = cx.value; sy.value = cy.value; })
        .onUpdate((e) => {
          "worklet";
          cx.value = clampW(sx.value + e.translationX, 0, imgW - cw.value);
          cy.value = clampW(sy.value + e.translationY, 0, imgH - ch.value);
        }),
    [imgW, imgH, cx, cy, cw, ch, sx, sy],
  );

  // One corner gesture builder: `left`/`top` say which edges this corner moves.
  const corner = (left: boolean, top: boolean) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useMemo(
      () =>
        Gesture.Pan()
          .onBegin(() => { sx.value = cx.value; sy.value = cy.value; sw.value = cw.value; sh.value = ch.value; })
          .onUpdate((e) => {
            "worklet";
            if (left) {
              const nx = clampW(sx.value + e.translationX, 0, sx.value + sw.value - MIN);
              cx.value = nx; cw.value = sx.value + sw.value - nx;
            } else {
              cw.value = clampW(sw.value + e.translationX, MIN, imgW - cx.value);
            }
            if (top) {
              const ny = clampW(sy.value + e.translationY, 0, sy.value + sh.value - MIN);
              cy.value = ny; ch.value = sy.value + sh.value - ny;
            } else {
              ch.value = clampW(sh.value + e.translationY, MIN, imgH - cy.value);
            }
          }),
      [imgW, imgH],
    );
  const gTL = corner(true, true);
  const gTR = corner(false, true);
  const gBL = corner(true, false);
  const gBR = corner(false, false);

  const rectStyle = useAnimatedStyle(() => ({
    left: cx.value, top: cy.value, width: cw.value, height: ch.value,
  }));

  const apply = async () => {
    if (!nat || !disp || blockIndex == null) return;
    setSaving(true);
    // The docx surface marks the picture as working until the reload shows the crop.
    const settle = useDocxSurfaceStore.getState().beginPending(blockIndex);
    try {
      const scale = nat.w / disp.w; // display px → natural px
      const rect = {
        originX: Math.round(cx.value * scale),
        originY: Math.round(cy.value * scale),
        width: Math.round(cw.value * scale),
        height: Math.round(ch.value * scale),
      };
      const edited = await cropLocalImage(uri!, rect);
      if (!edited.data) throw new Error("empty");
      await replaceThesisBlockImage(thesisId, blockIndex, edited);
      settle();
      onDone();
      onClose();
    } catch {
      settle(false);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const ready = !!uri && !!disp && !error;

  return (
    <Modal visible={blockIndex != null} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <X size={24} color="#fff" />
          </Pressable>
          <Text style={styles.title}>{t("workspace.cropTitle", { defaultValue: "Crop image" })}</Text>
          <Pressable
            onPress={apply}
            disabled={!ready || saving}
            hitSlop={10}
            style={[styles.apply, { backgroundColor: colors.brandPrimary, opacity: !ready || saving ? 0.5 : 1 }]}
            accessibilityRole="button"
          >
            {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.applyText}>{t("workspace.cropApply", { defaultValue: "Apply" })}</Text>}
          </Pressable>
        </View>

        <View style={styles.stage}>
          {!ready ? (
            error ? (
              <Text style={styles.err}>{t("workspace.imageError", { defaultValue: "Couldn't update the image." })}</Text>
            ) : (
              <ActivityIndicator size="large" color="#fff" />
            )
          ) : (
            <View style={{ width: disp!.w, height: disp!.h }}>
              <Image source={{ uri: uri! }} style={{ width: disp!.w, height: disp!.h }} resizeMode="contain" />
              {/* Crop rectangle: body drags to move; corners resize. */}
              <GestureDetector gesture={body}>
                <Animated.View style={[styles.rect, rectStyle]}>
                  <GestureDetector gesture={gTL}><Animated.View style={[styles.handle, styles.tl]} /></GestureDetector>
                  <GestureDetector gesture={gTR}><Animated.View style={[styles.handle, styles.tr]} /></GestureDetector>
                  <GestureDetector gesture={gBL}><Animated.View style={[styles.handle, styles.bl]} /></GestureDetector>
                  <GestureDetector gesture={gBR}><Animated.View style={[styles.handle, styles.br]} /></GestureDetector>
                </Animated.View>
              </GestureDetector>
            </View>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)" },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 16,
  },
  title: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  apply: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, minWidth: 72, alignItems: "center" },
  applyText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  err: { color: "#fff", fontSize: 14, fontFamily: "Inter_400Regular", paddingHorizontal: 32, textAlign: "center" },
  rect: {
    position: "absolute", borderWidth: 2, borderColor: "#fff",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  handle: {
    position: "absolute", width: HANDLE, height: HANDLE, borderRadius: HANDLE / 2,
    backgroundColor: "#fff", borderWidth: 2, borderColor: "rgba(0,0,0,0.35)",
  },
  tl: { left: -HANDLE / 2, top: -HANDLE / 2 },
  tr: { right: -HANDLE / 2, top: -HANDLE / 2 },
  bl: { left: -HANDLE / 2, bottom: -HANDLE / 2 },
  br: { right: -HANDLE / 2, bottom: -HANDLE / 2 },
});
