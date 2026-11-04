import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import ReorderableList, { useReorderableDrag, type ReorderableListReorderEvent } from "react-native-reorderable-list";
import { GripVertical } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hLight, hSelection } from "@/lib/haptics";
import { confirmPartOrder } from "@/lib/rescue-v2-api";
import { scaleFor } from "@/lib/rescue-v2-layout";
import { visualTextAlign } from "@/lib/rtl-layout";
import { firstStrongDirection } from "@/lib/text-direction";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescuePartDTO } from "@/types/rescue-v2";
import { MiniTextPage } from "../MiniTextPage";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { SheetBody, SheetTitle } from "../ui";
import type { RescueStep } from "./index";

/**
 * The order being edited, shared by the list (Sheet) and its CTA (Foot), which gorhom renders in two different trees. Seeded when the list
 * mounts and cleared when it leaves, so a project switch (the list is keyed by project) starts clean.
 */
interface PartOrder {
  rows: RescuePartDTO[];
  /** Part index → "continues the part above" (set by the student, starts from the DTO). */
  joined: Record<number, boolean>;
  /** Measured height of the Foot, so the last row is never behind the CTA. */
  footHeight: number;
  seed(parts: RescuePartDTO[]): void;
  move(from: number, to: number): void;
  toggle(index: number): void;
  setFootHeight(h: number): void;
}

const usePartOrder = create<PartOrder>()((set) => ({
  rows: [],
  joined: {},
  footHeight: 0,
  seed: (parts) => set({ rows: parts, joined: Object.fromEntries(parts.map((p) => [p.index, p.continuesPrevious])) }),
  move: (from, to) => set((s) => {
    const next = [...s.rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return { rows: next };
  }),
  toggle: (index) => set((s) => ({ joined: { ...s.joined, [index]: !s.joined[index] } })),
  setFootHeight: (h) => set({ footHeight: h }),
}));

/** A part joins the row above only when it is not the first row: the first has nothing above it to continue. */
function isJoined(joined: Record<number, boolean>, rows: RescuePartDTO[], i: number): boolean {
  return i > 0 && !!joined[rows[i].index];
}

/** Screen 2: the stage shows the first three parts as small pages, in the order the list will confirm. */
function Stage() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const parts = useRescueV2Store((st) => st.project?.parts);
  const sorted = useMemo(() => [...(parts ?? [])].sort((a, b) => a.order - b.order).slice(0, 3), [parts]);
  return (
    <View style={[styles.stage, { backgroundColor: colors.rescueStageBottom }]}>
      {sorted.map((p) => (
        <MiniTextPage key={p.index} text={p.openingText} width={42 * s} height={58 * s} />
      ))}
    </View>
  );
}

/** Keyed by project and by the proposal: a new project, or a proposal that lands, starts from its own order. */
function Sheet() {
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  const proposing = useRescueV2Store((s) => s.project?.phase === "proposing_order");
  const parts = useRescueV2Store((s) => s.project?.parts) ?? EMPTY;
  return <PartsList key={`${id}:${proposing ? "proposing" : "order"}`} proposing={proposing} parts={parts} />;
}

const EMPTY: RescuePartDTO[] = [];

function PartsList({ proposing, parts }: { proposing: boolean; parts: RescuePartDTO[] }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const rows = usePartOrder((s) => s.rows);
  const joined = usePartOrder((s) => s.joined);
  const footHeight = usePartOrder((s) => s.footHeight);
  const seed = usePartOrder((s) => s.seed);
  const move = usePartOrder((s) => s.move);
  const toggle = usePartOrder((s) => s.toggle);
  const sorted = useMemo(() => [...parts].sort((a, b) => a.order - b.order), [parts]);

  useEffect(() => {
    seed(sorted);
    return () => seed([]);
  }, [sorted, seed]);

  const onReorder = ({ from, to }: ReorderableListReorderEvent) => {
    move(from, to);
    hLight();
  };

  const renderRow = ({ item, index }: { item: RescuePartDTO; index: number }) => (
    <PartRow
      part={item}
      index={index}
      joinedAbove={isJoined(joined, rows, index)}
      canJoin={index > 0}
      proposing={proposing}
      onToggle={() => { hSelection(); toggle(item.index); }}
      nextJoined={index + 1 < rows.length && isJoined(joined, rows, index + 1)}
    />
  );

  return (
    <ReorderableList
      data={rows}
      keyExtractor={(p: RescuePartDTO) => String(p.index)}
      onReorder={proposing ? () => {} : onReorder}
      renderItem={renderRow}
      // The student sees the title and the body first; the list scrolls itself (gorhom's content pan is off for this step).
      ListHeaderComponent={
        <View style={styles.header}>
          <SheetTitle>{t("rescueV2.parts.title")}</SheetTitle>
          <SheetBody>{t(proposing ? "rescueV2.parts.proposing" : "rescueV2.parts.body")}</SheetBody>
        </View>
      }
      contentContainerStyle={{ paddingBottom: footHeight + 16, paddingHorizontal: 0 }}
      style={{ flex: 1, backgroundColor: colors.bgCard }}
    />
  );
}

function PartRow({
  part, index, joinedAbove, canJoin, proposing, onToggle, nextJoined,
}: {
  part: RescuePartDTO; index: number; joinedAbove: boolean; canJoin: boolean; proposing: boolean; onToggle: () => void; nextJoined: boolean;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const drag = useReorderableDrag();
  const dir = firstStrongDirection(part.filename, "ltr");
  return (
    <View
      style={[
        styles.row,
        {
          borderColor: colors.borderDefault,
          backgroundColor: colors.bgCard,
          marginLeft: joinedAbove ? 20 : 0,
          borderTopWidth: joinedAbove ? 0 : 1,
          borderTopLeftRadius: joinedAbove ? 0 : 14,
          borderTopRightRadius: joinedAbove ? 0 : 14,
          borderBottomWidth: nextJoined ? 0 : 1,
          borderBottomLeftRadius: nextJoined ? 0 : 14,
          borderBottomRightRadius: nextJoined ? 0 : 14,
          marginBottom: nextJoined ? 0 : 8,
          borderStyle: joinedAbove ? "dashed" : "solid",
        },
      ]}
    >
      <MiniTextPage text={part.openingText} width={42 * s} height={58 * s} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.filename, { color: colors.textPrimary, textAlign: visualTextAlign(dir === "rtl") }]}>
          {part.filename}
        </Text>
        {part.role ? (
          <Text style={[styles.role, { color: colors.textSecondary }]}>{t(`rescueV2.parts.roles.${part.role}`)}</Text>
        ) : null}
        {canJoin ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: joinedAbove, disabled: proposing }}
            disabled={proposing}
            onPress={onToggle}
            hitSlop={6}
            style={[
              styles.pill,
              { backgroundColor: joinedAbove ? colors.brandWash : colors.bgSurface, borderColor: joinedAbove ? colors.brandPrimary : colors.borderDefault },
            ]}
          >
            <Text style={[styles.pillText, { color: joinedAbove ? colors.brandPrimary : colors.textSecondary }]}>{t("rescueV2.parts.continues")}</Text>
          </Pressable>
        ) : null}
      </View>
      {proposing ? (
        <SkeletonBlock width={18} height={18} radius={9} />
      ) : (
        <Pressable onLongPress={drag} delayLongPress={150} hitSlop={8}>
          <GripVertical size={20} color={colors.textSecondary} />
        </Pressable>
      )}
    </View>
  );
}

/** The CTA. Its height is measured into the store, so the list's bottom padding clears it. */
function Foot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  const proposing = useRescueV2Store((s) => s.project?.phase === "proposing_order");
  const apply = useRescueV2Store((s) => s.apply);
  const rows = usePartOrder((s) => s.rows);
  const joined = usePartOrder((s) => s.joined);
  const setFootHeight = usePartOrder((s) => s.setFootHeight);
  const [pending, setPending] = useState(false);
  const gate = useRef(false);
  useEffect(() => () => setFootHeight(0), [setFootHeight]);

  const disabled = !id || proposing || rows.length === 0 || pending;

  const onPress = async () => {
    if (gate.current || disabled || !id) return;
    gate.current = true;
    setPending(true);
    const order = rows.map((p) => p.index);
    const continuesPrevious = rows.filter((p, i) => isJoined(joined, rows, i)).map((p) => p.index);
    try {
      await apply(() => confirmPartOrder(id, order, continuesPrevious));
    } finally {
      gate.current = false;
      setPending(false);
    }
  };

  return (
    <View
      style={[styles.foot, { backgroundColor: colors.bgCard }]}
      onLayout={(e) => setFootHeight(Math.ceil(e.nativeEvent.layout.height))}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => { void onPress(); }}
        style={[styles.cta, { backgroundColor: colors.brandPrimary, opacity: disabled ? 0.5 : 1 }]}
      >
        <Text style={[styles.ctaText, { color: colors.bgCard }]}>{t("rescueV2.parts.cta")}</Text>
      </Pressable>
      <Text style={[styles.fine, { color: colors.textSecondary }]}>{t("rescueV2.parts.nothingAdded")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  header: { paddingHorizontal: 20, paddingTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, marginHorizontal: 20, padding: 10 },
  rowText: { flex: 1, gap: 4, alignItems: "flex-start" },
  filename: { fontSize: 14, fontWeight: "600", alignSelf: "stretch" },
  role: { fontSize: 12 },
  pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: "700" },
  foot: { gap: 6, paddingTop: 8, paddingBottom: 10, paddingHorizontal: 20 },
  cta: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  ctaText: { fontSize: 16, fontWeight: "800" },
  fine: { fontSize: 12, textAlign: "center" },
});

export const PartsStep: RescueStep = { Stage, Sheet, Foot, ownsGestures: true };
