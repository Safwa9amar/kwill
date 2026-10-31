// lib/ribbon-actions.ts
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import type { RibbonTool } from "@/components/workspace/ribbon/ribbon-config";
import { buildToolInstruction } from "@/lib/ribbon-ai-bridge";
import i18n from "@/lib/i18n";
import {
  formatThesis,
  insertThesisCaptionList,
  listThesisCaptions,
  insertThesisImage,
  replaceThesisBlockImage,
  removeThesisBlockBg,
  startThesisBlocksOnNewPage,
  editThesisParagraphs,
  setThesisPageSetup,
} from "@/lib/api";
import { rotateFlipBlockImage, type RotateFlipOp } from "@/lib/thesis-image-edit";
import { useCaptionSheetStore } from "@/stores/caption-sheet-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { engineImageAction, useDocxSurfaceStore } from "@/stores/docx-surface-store";

export interface DispatchDeps {
  thesisId: string;
  /** Current focus selection (document order): block index + heading level + text. */
  selection: { index: number; text: string; level?: number }[];
  /** Refresh the document after a wired edit. */
  onAfterEdit: () => void;
  /** Route an AI-bridge action: fill the AI composer input + switch to AI mode. */
  onAiAction: (instruction: string) => void;
  /** Localized label of the chosen option (for AI instructions), if any. */
  optionLabel?: string;
  /** Show/hide a busy overlay for slow ops. Pass an i18n key, or null to clear. */
  onBusy?: (messageKey: string | null) => void;
  /** Open the interactive crop modal for the given engine block index. */
  onCropImage?: (blockIndex: number) => void;
  /** The document's blocks, so a tool can tell a table from a figure. */
  blocks?: { index: number; kind: string }[];
}

/** Run a ribbon tool. `optionValue` is the chosen preset/segment value (if any). */
export async function dispatchRibbonAction(
  tool: RibbonTool,
  optionValue: string | undefined,
  deps: DispatchDeps,
): Promise<void> {
  const first = deps.selection[0];
  const selText = deps.selection.map((s) => s.text).filter(Boolean).join("\n\n");

  // AI-bridge path: any non-wired tool.
  const toAi = () =>
    deps.onAiAction(buildToolInstruction(tool, { optionValue, optionLabel: deps.optionLabel, selectionText: selText }));

  if (tool.status !== "wired") return toAi();

  try {
    switch (tool.actionKey) {
      case "design.thesisReady":
        await formatThesis(deps.thesisId);
        deps.onAfterEdit();
        return;

      case "insert.pageBreak":
      case "layout.breaks": {
        if (!first) return toAi(); // no anchor block → let AI decide placement
        const breakType = (optionValue as "nextPage" | "evenPage" | "oddPage") ?? "nextPage";
        await startThesisBlocksOnNewPage(deps.thesisId, [first.index], breakType);
        deps.onAfterEdit();
        return;
      }

      case "insert.picture": {
        const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.7 });
        const asset = res.canceled ? null : res.assets[0];
        if (!asset?.base64) return;
        const mime = asset.mimeType ?? "";
        const format = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : "jpeg";
        await insertThesisImage(deps.thesisId, {
          data: asset.base64, format, width: asset.width, height: asset.height,
          afterIndex: first ? first.index : -1,
        });
        deps.onAfterEdit();
        return;
      }

      case "heading.promote":
      case "heading.demote": {
        if (!first) return;
        if ((first.level ?? 0) < 1) return toAi(); // not a heading → let AI handle it
        const cur = first.level ?? 0;
        // promote = smaller number (toward H1); demote = larger. Clamp 0..6.
        const next = tool.actionKey === "heading.promote" ? Math.max(1, cur - 1) : Math.min(6, cur + 1);
        await editThesisParagraphs(deps.thesisId, [first.index], { level: next });
        deps.onAfterEdit();
        return;
      }

      case "layout.margins": {
        // MARGIN_OPTS values: normal | narrow | moderate | wide | mirrored
        if (!optionValue) return toAi();
        await setThesisPageSetup(deps.thesisId, { marginPreset: optionValue as any });
        deps.onAfterEdit();
        return;
      }

      case "layout.orientation": {
        // ORIENT_OPTS values: portrait | landscape
        if (optionValue !== "portrait" && optionValue !== "landscape") return toAi();
        await setThesisPageSetup(deps.thesisId, { orientation: optionValue });
        deps.onAfterEdit();
        return;
      }

      case "layout.size": {
        // SIZE_OPTS values: A4 | USLetter | USLegal | A3 | A5
        if (!optionValue) return toAi();
        await setThesisPageSetup(deps.thesisId, { pageSize: optionValue as any });
        deps.onAfterEdit();
        return;
      }

      case "layout.columns": {
        // COLUMN_OPTS values: "1" | "2" | "3" (arrive as strings)
        const count = Number(optionValue);
        if (!(count === 1 || count === 2 || count === 3)) return toAi();
        await setThesisPageSetup(deps.thesisId, { columns: count as 1 | 2 | 3 });
        deps.onAfterEdit();
        return;
      }

      case "picture.removeBg": {
        // Server-side (rembg sidecar) — slow, so show a busy overlay. No pixels
        // travel through the app; the server re-embeds a transparent PNG.
        if (!first) return;
        deps.onBusy?.("workspace.removingBg");
        // The docx surface marks the picture as working until the reload shows it.
        const settle = useDocxSurfaceStore.getState().beginPending(first.index);
        try {
          await removeThesisBlockBg(deps.thesisId, first.index);
          deps.onAfterEdit();
          settle();
        } catch {
          settle(false);
          Alert.alert(i18n.t("common.error", { defaultValue: "Error" }), i18n.t("workspace.bgError", { defaultValue: "Couldn't remove the background. Please try again." }));
        } finally {
          deps.onBusy?.(null);
        }
        return;
      }

      case "picture.replace": {
        // Pick a new image and swap the selected figure's bytes in place.
        if (!first) return;
        const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.85 });
        const asset = res.canceled ? null : res.assets[0];
        if (!asset?.base64) return;
        deps.onBusy?.("workspace.updatingImage");
        try {
          const mime = asset.mimeType ?? "";
          const format = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : "jpeg";
          await replaceThesisBlockImage(deps.thesisId, first.index, {
            data: asset.base64, format, width: asset.width, height: asset.height,
          });
          deps.onAfterEdit();
        } catch {
          Alert.alert(i18n.t("common.error", { defaultValue: "Error" }), i18n.t("workspace.imageError", { defaultValue: "Couldn't update the image." }));
        } finally {
          deps.onBusy?.(null);
        }
        return;
      }

      case "picture.rotate": {
        // ROTATE_OPTS values: rotateRight | rotateLeft | flipH | flipV. Manipulate
        // on-device, then send the new bytes to the same replace endpoint.
        if (!first) return;
        const op = optionValue as RotateFlipOp | undefined;
        if (op !== "rotateRight" && op !== "rotateLeft" && op !== "flipH" && op !== "flipV") return toAi();
        // The docx surface turns it in the engine — instant; its save persists it.
        if (useDocxSurfaceStore.getState().imageTransform?.(first.index, engineImageAction(op))) return;
        deps.onBusy?.("workspace.updatingImage");
        try {
          const edited = await rotateFlipBlockImage(deps.thesisId, first.index, op);
          if (!edited.data) throw new Error("empty image");
          await replaceThesisBlockImage(deps.thesisId, first.index, edited);
          deps.onAfterEdit();
        } catch {
          Alert.alert(i18n.t("common.error", { defaultValue: "Error" }), i18n.t("workspace.imageError", { defaultValue: "Couldn't update the image." }));
        } finally {
          deps.onBusy?.(null);
        }
        return;
      }

      // ── Captions (Word's References → Insert Caption) ──────────────────────
      // Interactive: a caption needs a label, a position and the numbering options,
      // so these hand off to the Caption sheet rather than guessing.
      case "ref.caption":
      case "picture.caption": {
        if (!first) return toAi(); // nothing selected → let the AI find the figure
        const kind = deps.blocks?.find((b) => b.index === first.index)?.kind;
        useCaptionSheetStore.getState().openInsert({
          thesisId: deps.thesisId,
          index: first.index,
          kind: kind === "table" ? "table" : "figure",
        });
        return;
      }

      // References → Insert Table of Figures, for the label this thesis actually
      // uses (an Arabic thesis's figures are "الشكل", not "Figure").
      case "ref.figuresList": {
        const { labels, captions } = await listThesisCaptions(deps.thesisId);
        const FIGURE = /^(figure|fig\.?|illustration|schéma|schema|الشكل|شكل|رسم)/i;
        const label =
          labels.find((l) => l.count > 0 && FIGURE.test(l.label))?.label ??
          labels.find((l) => l.count > 0)?.label;
        if (!label || !captions.length) {
          Alert.alert(
            i18n.t("workspace.caption.noneTitle", { defaultValue: "No captions yet" }),
            i18n.t("workspace.caption.noneBody", { defaultValue: "Caption your figures first — the list collects them." }),
          );
          return;
        }
        const res = await insertThesisCaptionList(deps.thesisId, {
          label,
          title: i18n.t("workspace.caption.listOfFigures", { defaultValue: "List of Figures" }),
          // Where the student is, like Word; the front matter when nothing is selected.
          atIndex: first?.index ?? 0,
        });
        if (res.document) useThesisDocStore.getState().setDoc(deps.thesisId, res.document);
        deps.onAfterEdit();
        return;
      }

      case "picture.crop": {
        // Interactive — hand off to the crop modal (owned by the composer sheet).
        if (!first) return;
        deps.onCropImage?.(first.index);
        return;
      }

      default:
        // Marked wired but unhandled → fail safe to AI.
        return toAi();
    }
  } catch {
    Alert.alert(
      i18n.t("common.error", { defaultValue: "Error" }),
      i18n.t("workspace.bulkEditError", { defaultValue: "Could not apply the change." }),
    );
  }
}
