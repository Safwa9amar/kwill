import React, { useState } from "react";
import { Alert, Text, View } from "react-native";
import {
  BarChart3,
  BarChart4,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Hash,
  LineChart,
  Palette,
  PieChart,
  Percent,
  RectangleHorizontal,
  Tag,
  Trash2,
  Type,
} from "lucide-react-native";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useDocxSurfaceStore } from "@/stores/docx-surface-store";
import { useToolbarStore } from "@/stores/toolbar-store";
import { brand } from "@/constants/colors";
import { useCaptionSheetStore } from "@/stores/caption-sheet-store";
import { updateThesisChart, type ChartKind, type ThesisChartPatch } from "@/lib/api";
import { AnimatedChip } from "../AnimatedChip";
import { useChipKit, useTools } from "./context";
import { toolStyles } from "./styles";

/**
 * A NATIVE Word chart (an image block carrying `svg` — see resolveBubbleKind).
 *
 * These are real chart objects out of `word/charts/chartN.xml`, so unlike a
 * picture they are genuinely editable: kind, legend, data labels and colours all
 * change the chart itself, and Word keeps it a chart. Every edit is
 * POSITIONAL-SAFE — no block is added or removed — so the server's rebuilt
 * `document` (with the chart's new `svg`) can be applied straight to the store
 * without re-anchoring the selection.
 *
 * Not here: editing the numbers. That needs a grid, which belongs in a sheet
 * rather than the pill; the endpoint and the AI's set_chart_data already do it.
 */

/** The kinds the pill offers, in the order they read as a progression. */
const KINDS: { kind: ChartKind; Icon: typeof PieChart; label: string; fallback: string }[] = [
  { kind: "pie", Icon: PieChart, label: "chart.pie", fallback: "Pie" },
  { kind: "doughnut", Icon: CircleDashed, label: "chart.doughnut", fallback: "Doughnut" },
  { kind: "bar", Icon: BarChart3, label: "chart.bar", fallback: "Columns" },
  { kind: "barH", Icon: RectangleHorizontal, label: "chart.barH", fallback: "Bars" },
  { kind: "line", Icon: LineChart, label: "chart.line", fallback: "Line" },
  { kind: "area", Icon: BarChart4, label: "chart.area", fallback: "Area" },
];

const LEGEND_POS = [
  { pos: "t", label: "chart.legendTop", fallback: "Legend top" },
  { pos: "b", label: "chart.legendBottom", fallback: "Legend bottom" },
  { pos: "l", label: "chart.legendLeft", fallback: "Legend left" },
  { pos: "r", label: "chart.legendRight", fallback: "Legend right" },
  { pos: "none", label: "chart.legendNone", fallback: "No legend" },
] as const;

/** Recolour presets. Applied across the slices/series from the first entry on. */
const PALETTES: { key: string; colors: string[] }[] = [
  { key: "office", colors: ["#4F81BD", "#C0504D", "#9BBB59", "#8064A2", "#4BACC6", "#F79646"] },
  { key: "brand", colors: [brand.primary, "#33D6A6", "#4C8DFF", "#FF5959", brand.primaryLight, "#9C6BFF"] },
  { key: "cool", colors: ["#2E5A88", "#3F8EA8", "#63B7B0", "#98D6C4", "#C9E9DB", "#E8F5EE"] },
  { key: "warm", colors: ["#8C2F1E", "#C1502E", "#E08B3C", "#EFBB57", "#F5DC9A", "#FAEFD3"] },
  { key: "mono", colors: ["#1F2933", "#3E4C59", "#616E7C", "#9AA5B1", "#CBD2D9", "#E4E7EB"] },
];

/** The selected chart's live facts, straight off the DTO the writer is rendering. */
function useChart() {
  const { thesisId, soleIndex, selectedBlock } = useTools();
  const isChart = selectedBlock?.kind === "image" && !!selectedBlock.svg;
  return { thesisId, index: soleIndex, isChart };
}

/**
 * One chart edit: PATCH, then apply the returned document. The server rebuilds the
 * DTO for us, so there is no optimistic guess to reconcile — a chart's SVG is
 * produced server-side and the app has no way to predict it.
 */
function useChartEdit(thesisId: string, index: number | null) {
  const [busy, setBusy] = useState(false);
  const run = async (patch: ThesisChartPatch, onError: string) => {
    if (index == null || busy) return;
    setBusy(true);
    // On the docx surface the chart shimmers from the tap until the echo lands — and
    // the echo's SVG goes straight onto the chart overlay, so the mark drops then
    // rather than waiting for the bytes to reload behind it.
    const settle = useDocxSurfaceStore.getState().beginPending(index);
    try {
      const res = await updateThesisChart(thesisId, index, patch);
      // The echoed document is the source of truth: a chart's SVG is produced
      // server-side, so there is nothing the app could have guessed optimistically.
      if (res.document) useThesisDocStore.getState().setDoc(thesisId, res.document);
      else await useThesisDocStore.getState().revalidate(thesisId);
      settle(false);
    } catch {
      settle(false);
      Alert.alert(onError);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function ChartTools({ full }: { full: boolean }) {
  const { chip, categoryChip, sep, moreChip, t } = useChipKit();
  const { canUp, canDown, move, del } = useTools();
  const { thesisId, index, isChart } = useChart();
  const { busy, run } = useChartEdit(thesisId, index);

  const err = t("chart.error", { defaultValue: "Couldn't update the chart." });

  const typeChip = categoryChip("chartType", BarChart3, t("chart.type", { defaultValue: "Chart type" }), 0);
  // The one edit worth a direct chip: a survey pie almost always wants its shares
  // shown, and it is a single tap rather than a panel.
  const percentChip = chip({
    keyProp: "chart-pct",
    Icon: Percent,
    accessibilityLabel: t("chart.togglePercent", { defaultValue: "Show percentages" }),
    disabled: busy || !isChart,
    enterIndex: 1,
    onPress: () => void run({ showPercent: true, showValues: false }, err),
  });
  const captionChip = chip({
    keyProp: "chart-caption",
    Icon: Tag,
    accessibilityLabel: t("blockBar.caption", { defaultValue: "Caption" }),
    enterIndex: 2,
    onPress: () => {
      if (index != null) useCaptionSheetStore.getState().openInsert({ thesisId, index, kind: "figure" });
    },
  });

  const moveDelete = (base: number) => [
    chip({ keyProp: "chart-up", Icon: ChevronUp, accessibilityLabel: t("blockBar.moveUp", { defaultValue: "Move up" }), disabled: !canUp, enterIndex: base, onPress: () => move("up") }),
    chip({ keyProp: "chart-down", Icon: ChevronDown, accessibilityLabel: t("blockBar.moveDown", { defaultValue: "Move down" }), disabled: !canDown, enterIndex: base + 1, onPress: () => move("down") }),
    chip({ keyProp: "chart-del", Icon: Trash2, accessibilityLabel: t("common.delete", { defaultValue: "Delete" }), enterIndex: base + 2, onPress: del }),
  ];

  if (!full) {
    return (
      <>
        {typeChip}
        {percentChip}
        {captionChip}
        {sep("chart-s1")}
        {moveDelete(3)}
        {moreChip("chart-more", 6)}
      </>
    );
  }

  return (
    <>
      {typeChip}
      {categoryChip("chartLegend", Hash, t("chart.legend", { defaultValue: "Legend" }), 1)}
      {categoryChip("chartLabels", Type, t("chart.labels", { defaultValue: "Data labels" }), 2)}
      {categoryChip("chartColor", Palette, t("chart.colors", { defaultValue: "Colours" }), 3)}
      {percentChip}
      {captionChip}
      {sep("chart-s1")}
      {moveDelete(6)}
    </>
  );
}

export function ChartPanel() {
  const { iconOpt, optPill, colors, t } = useChipKit();
  const { thesisId, index, isChart } = useChart();
  const { busy, run } = useChartEdit(thesisId, index);
  const category = useToolbarStore((s) => s.category);
  const err = t("chart.error", { defaultValue: "Couldn't update the chart." });

  // The panel outlives a selection change by a frame; render nothing rather than
  // send an edit to whatever is selected now.
  if (!isChart || index == null) return null;

  if (category === "chartType") {
    return (
      <>
        {KINDS.map((k, i) =>
          iconOpt(`ct-${k.kind}`, k.Icon, t(k.label, { defaultValue: k.fallback }), i, () => void run({ type: k.kind }, err), {
            disabled: busy,
          }),
        )}
      </>
    );
  }

  if (category === "chartLegend") {
    return (
      <>
        {LEGEND_POS.map((l, i) => (
          <AnimatedChip
            key={`cl-${l.pos}`}
            enterIndex={i}
            disabled={busy}
            onPress={() => void run({ legend: l.pos }, err)}
            accessibilityLabel={t(l.label, { defaultValue: l.fallback })}
            style={optPill(false, busy)}
          >
            <Text style={[toolStyles.optText, { color: colors.textPrimary }]}>
              {t(l.label, { defaultValue: l.fallback })}
            </Text>
          </AnimatedChip>
        ))}
      </>
    );
  }

  if (category === "chartLabels") {
    const opts: { key: string; patch: ThesisChartPatch; label: string; fallback: string }[] = [
      { key: "pct", patch: { showPercent: true, showValues: false }, label: "chart.showPercent", fallback: "Percent" },
      { key: "val", patch: { showValues: true, showPercent: false }, label: "chart.showValues", fallback: "Values" },
      { key: "cat", patch: { showCategories: true }, label: "chart.showCategories", fallback: "Names" },
      { key: "off", patch: { showPercent: false, showValues: false, showCategories: false }, label: "chart.showNone", fallback: "None" },
    ];
    return (
      <>
        {opts.map((o, i) => (
          <AnimatedChip
            key={`cd-${o.key}`}
            enterIndex={i}
            disabled={busy}
            onPress={() => void run(o.patch, err)}
            accessibilityLabel={t(o.label, { defaultValue: o.fallback })}
            style={optPill(false, busy)}
          >
            <Text style={[toolStyles.optText, { color: colors.textPrimary }]}>
              {t(o.label, { defaultValue: o.fallback })}
            </Text>
          </AnimatedChip>
        ))}
      </>
    );
  }

  if (category === "chartColor") {
    return (
      <>
        {PALETTES.map((p, i) => (
          <AnimatedChip
            key={`cc-${p.key}`}
            enterIndex={i}
            disabled={busy}
            // A palette is applied to as many slices/series as the chart has; the
            // server ignores entries past the end, so sending six is safe.
            onPress={() => void run({ colors: p.colors }, err)}
            accessibilityLabel={t(`chart.palette.${p.key}`, { defaultValue: p.key })}
            style={optPill(false, busy)}
          >
            <View style={{ flexDirection: "row", gap: 2 }}>
              {p.colors.slice(0, 4).map((c) => (
                <View key={c} style={{ width: 10, height: 14, borderRadius: 2, backgroundColor: c }} />
              ))}
            </View>
          </AnimatedChip>
        ))}
      </>
    );
  }

  return null;
}
