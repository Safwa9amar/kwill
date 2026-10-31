import React, { useRef, useState } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  ChevronDown,
  ChevronUp,
  Crop,
  FlipHorizontal2,
  RefreshCw,
  RotateCw,
  Tag,
  Trash2,
  WandSparkles,
} from "lucide-react-native";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { engineImageAction, useDocxSurfaceStore } from "@/stores/docx-surface-store";
import { useToolbarStore } from "@/stores/toolbar-store";
import { useCaptionSheetStore } from "@/stores/caption-sheet-store";
import { removeThesisBlockBg } from "@/lib/api";
import { rotateFlipBlockImage, type RotateFlipOp } from "@/lib/thesis-image-edit";
import { useChipKit, useTools } from "./context";

/**
 * A real figure (an image block WITH media bytes — a chart placeholder gets the
 * minimal toolbar instead). Picture ops are primary; no text tools apply.
 *
 * Compact: replace / move / delete. Full: adds the advanced ops — rotate and flip
 * run ON-DEVICE (download the bytes, transform, swap them back through the durable
 * `replaceImage` op), crop opens the interactive modal (the shell renders it from
 * the store's cropIndex), and background removal happens SERVER-side via the rembg
 * sidecar, so no pixels travel through the app.
 */
export function ImageTools({ full }: { full: boolean }) {
  const { chip, sep, moreChip, t } = useChipKit();
  const { thesisId, soleIndex, canUp, canDown, move, del } = useTools();
  const setCropIndex = useToolbarStore((s) => s.setCropIndex);

  // Guards the async ops (disables those chips while one runs). Local to this
  // toolbar: it dies with the selection, exactly as before.
  const [busy, setBusy] = useState(false);
  const pickingRef = useRef(false);

  const moveDeleteChips = (base: number) => [
    chip({ keyProp: "img-up", Icon: ChevronUp, accessibilityLabel: t("blockBar.moveUp", { defaultValue: "Move up" }), disabled: !canUp, enterIndex: base, onPress: () => move("up") }),
    chip({ keyProp: "img-down", Icon: ChevronDown, accessibilityLabel: t("blockBar.moveDown", { defaultValue: "Move down" }), disabled: !canDown, enterIndex: base + 1, onPress: () => move("down") }),
    chip({ keyProp: "img-del", Icon: Trash2, accessibilityLabel: t("common.delete", { defaultValue: "Delete" }), enterIndex: base + 2, onPress: del }),
  ];

  // Pick a new image and swap the selected figure's bytes IN PLACE (durable
  // replaceImage op → optimistic instant repaint + reconcile).
  const replaceImage = async () => {
    if (soleIndex == null || pickingRef.current) return;
    pickingRef.current = true;
    let res: ImagePicker.ImagePickerResult;
    try {
      res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.85 });
    } catch {
      Alert.alert(t("workspace.imageError", { defaultValue: "Couldn't update the image." }));
      return;
    } finally {
      pickingRef.current = false;
    }
    const asset = res.canceled ? null : res.assets[0];
    if (!asset?.base64) return;
    const mime = asset.mimeType ?? "";
    const format = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : "jpeg";
    void useThesisDocStore.getState().mutate(thesisId, {
      type: "replaceImage",
      index: soleIndex,
      data: asset.base64,
      format,
      width: asset.width,
      height: asset.height,
    });
  };

  const rotateFlip = async (op: RotateFlipOp) => {
    if (soleIndex == null || busy) return;
    // The docx surface turns the picture in the engine — on the page at once, and
    // its save persists it. Elsewhere: re-encode on device and swap the bytes.
    if (useDocxSurfaceStore.getState().imageTransform?.(soleIndex, engineImageAction(op))) return;
    setBusy(true);
    try {
      const edited = await rotateFlipBlockImage(thesisId, soleIndex, op);
      if (!edited.data) throw new Error("empty image");
      void useThesisDocStore.getState().mutate(thesisId, {
        type: "replaceImage",
        index: soleIndex,
        data: edited.data,
        format: edited.format,
        width: edited.width,
        height: edited.height,
      });
    } catch {
      Alert.alert(t("workspace.imageError", { defaultValue: "Couldn't update the image." }));
    } finally {
      setBusy(false);
    }
  };

  // Direct endpoint (bypasses the op queue), so revalidate the doc store afterward
  // to repaint. Fails cleanly when the sidecar isn't running.
  const removeBg = async () => {
    if (soleIndex == null || busy) return;
    setBusy(true);
    // Server-only (rembg): mark the picture as working on the page until the reload.
    const settle = useDocxSurfaceStore.getState().beginPending(soleIndex);
    try {
      await removeThesisBlockBg(thesisId, soleIndex);
      await useThesisDocStore.getState().revalidate(thesisId);
      settle();
    } catch {
      settle(false);
      Alert.alert(
        t("common.error", { defaultValue: "Error" }),
        t("workspace.bgError", { defaultValue: "Couldn't remove the background. Please try again." }),
      );
    } finally {
      setBusy(false);
    }
  };

  const replaceChip = chip({
    keyProp: "img-replace",
    Icon: RefreshCw,
    accessibilityLabel: t("blockBar.replaceImage", { defaultValue: "Replace image" }),
    enterIndex: 0,
    onPress: () => void replaceImage(),
  });

  // Word's Insert Caption, on the figure it captions. A sheet rather than a
  // sub-panel: a caption carries a label, a position and the whole numbering
  // dialog, none of which fits in the pill (see components/CaptionSheet).
  const captionChip = chip({
    keyProp: "img-caption",
    Icon: Tag,
    accessibilityLabel: t("blockBar.caption", { defaultValue: "Caption" }),
    enterIndex: 1,
    onPress: () => {
      if (soleIndex != null) useCaptionSheetStore.getState().openInsert({ thesisId, index: soleIndex, kind: "figure" });
    },
  });

  if (!full) {
    return (
      <>
        {replaceChip}
        {captionChip}
        {moveDeleteChips(2)}
        {moreChip("img-more", 5)}
      </>
    );
  }

  return (
    <>
      {replaceChip}
      {captionChip}
      {moveDeleteChips(2)}
      {sep("is1")}
      {chip({ keyProp: "img-rotate", Icon: RotateCw, accessibilityLabel: t("blockBar.rotate", { defaultValue: "Rotate" }), disabled: busy, enterIndex: 5, onPress: () => void rotateFlip("rotateRight") })}
      {chip({ keyProp: "img-flip", Icon: FlipHorizontal2, accessibilityLabel: t("blockBar.flip", { defaultValue: "Flip" }), disabled: busy, enterIndex: 6, onPress: () => void rotateFlip("flipH") })}
      {chip({ keyProp: "img-crop", Icon: Crop, accessibilityLabel: t("blockBar.crop", { defaultValue: "Crop" }), disabled: busy, enterIndex: 7, onPress: () => { if (soleIndex != null) setCropIndex(soleIndex); } })}
      {chip({ keyProp: "img-bg", Icon: WandSparkles, accessibilityLabel: t("blockBar.removeBg", { defaultValue: "Remove background" }), disabled: busy, enterIndex: 8, onPress: () => void removeBg() })}
    </>
  );
}

/**
 * Chart placeholders and raw "other" OOXML blocks: move up / down / delete and
 * nothing else — no text tools apply, and (unlike a real picture) there are no
 * media bytes for the picture ops either.
 */
export function MinimalTools() {
  const { chip, t } = useChipKit();
  const { canUp, canDown, move, del } = useTools();
  return (
    <>
      {chip({ keyProp: "img-up", Icon: ChevronUp, accessibilityLabel: t("blockBar.moveUp", { defaultValue: "Move up" }), disabled: !canUp, enterIndex: 0, onPress: () => move("up") })}
      {chip({ keyProp: "img-down", Icon: ChevronDown, accessibilityLabel: t("blockBar.moveDown", { defaultValue: "Move down" }), disabled: !canDown, enterIndex: 1, onPress: () => move("down") })}
      {chip({ keyProp: "img-del", Icon: Trash2, accessibilityLabel: t("common.delete", { defaultValue: "Delete" }), enterIndex: 2, onPress: del })}
    </>
  );
}
