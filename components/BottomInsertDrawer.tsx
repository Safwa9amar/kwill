import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAutocompleteAllowed } from "@/lib/autocomplete-policy";
import { View, Text, Pressable, ScrollView, TextInput, StyleSheet, useWindowDimensions, Keyboard, BackHandler } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedReaction, withSpring, runOnJS, interpolate } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { ImagePlus, Pilcrow, Plus, Type as TypeIcon, Search as SearchIcon, AlignLeft, AlignCenter, AlignRight, AlignJustify, type LucideIcon } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { useInsertMenuStore } from "@/stores/insert-menu-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useEquationSheetStore } from "@/stores/equation-sheet-store";
import { useThesisStore } from "@/stores/thesis-store";
import { useSettingsStore } from "@/stores/settings-store";
import { INSERT_BLOCKS, INSERT_CATEGORIES, filterBlocks, type InsertBlockDef, type InsertCategory } from "@/components/workspace/insert/insert-blocks";
import { pickAndInsertImage } from "@/lib/insert-image";
import { pasteImageFromClipboard } from "@/lib/paste-image";
import { createThesisStyle, getThesisStyles, type ThesisStyle } from "@/lib/thesis-styles";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";

const DRAWER_FRACTION = 0.64;
const SPRING = { damping: 22, stiffness: 240, mass: 0.7 } as const;
const TEXT_KINDS = ["h1", "h2", "h3", "h4", "h5", "h6", "quote", "bullet", "number"];
const PAD = 16;

// Per-category accent — solid foreground + low-alpha background so the tint reads
// on BOTH light and dark drawer backgrounds.
const CAT_COLOR: Record<InsertCategory, { fg: string; bg: string }> = {
  text: { fg: "#3b6bdb", bg: "rgba(59,107,219,0.14)" },
  styles: { fg: "#0d9488", bg: "rgba(13,148,136,0.15)" },
  lists: { fg: "#1f9d52", bg: "rgba(31,157,82,0.16)" },
  media: { fg: "#d9791a", bg: "rgba(217,121,26,0.16)" },
  academic: { fg: "#8b5bd6", bg: "rgba(139,91,214,0.16)" },
  layout: { fg: "#d63384", bg: "rgba(214,51,132,0.15)" },
};

function clamp(v: number, lo: number, hi: number): number {
  "worklet";
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Root-level bottom "push" drawer for the Insert menu — the vertical twin of
 * the navigation drawer. Opening (driven by `insert-menu-store`, from `/` or the dock `+`)
 * slides the insert panel up from the bottom while the whole app recedes behind
 * it. The block index for structural inserts comes from the store's `anchor`;
 * the thesis id is read from the current-thesis store (no per-screen wiring).
 */
export function BottomInsertDrawer({ children }: { children: React.ReactNode }) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const DRAWER_H = Math.round(height * DRAWER_FRACTION);

  const open = useInsertMenuStore((s) => s.open);
  const progress = useSharedValue(0);
  const dragging = useSharedValue(false);
  const openSV = useSharedValue(open);

  const close = () => useInsertMenuStore.getState().close();

  useEffect(() => {
    openSV.value = open;
    if (!open) return;
    // Drop the keyboard the moment the drawer opens — it would otherwise sit
    // under the panel and eat the tiles. Two dismissals are needed: RN's for a
    // native TextInput (AI ask / bubble), and an explicit editor blur for the
    // Lexical Writer, whose caret lives inside a WebView that Keyboard.dismiss()
    // can't reach (this is the common case — the drawer opens from `/` or the
    // dock `+` while the user is typing).
    Keyboard.dismiss();
    if (useLexicalEditorStore.getState().active) useLexicalEditorStore.getState().dispatch("blur");
  }, [open]);

  useAnimatedReaction(
    () => (dragging.value ? -1 : openSV.value ? 1 : 0),
    (target) => {
      if (target >= 0) progress.value = withSpring(target, SPRING);
    },
  );

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const dragPan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          dragging.value = true;
        })
        .onUpdate((e) => {
          progress.value = clamp(1 - e.translationY / DRAWER_H, 0, 1);
        })
        .onEnd((e) => {
          const keep = progress.value > 0.55 && e.velocityY < 800;
          openSV.value = keep;
          dragging.value = false;
          if (!keep) runOnJS(close)();
        })
        .onFinalize(() => {
          dragging.value = false;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [DRAWER_H],
  );

  const appStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -progress.value * (insets.top + 6) },
      { scale: interpolate(progress.value, [0, 1], [1, 0.94]) },
    ],
    borderRadius: progress.value * 16,
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.35 }));
  const drawerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * (DRAWER_H + 40) }] }));

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.app, appStyle]}>{children}</Animated.View>

      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]} pointerEvents={open ? "auto" : "none"}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <Animated.View style={[styles.drawer, { height: DRAWER_H }, drawerStyle]} pointerEvents={open ? "auto" : "none"}>
        <InsertPanel dragPan={dragPan} bottomInset={insets.bottom} />
      </Animated.View>
    </View>
  );
}

type TabKey = "all" | InsertCategory;

/** Drawer contents: grab handle, title, search, segmented category tabs, and a
 *  grid of colour-coded block tiles (recently-used pinned first on the All tab). */
function InsertPanel({ dragPan, bottomInset }: { dragPan: ReturnType<typeof Gesture.Pan>; bottomInset: number }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const rtl = useRTL().isRTL;
  const rowDir = visualRow(rtl);
  const textAlign = visualTextAlign(rtl);
  const { width } = useWindowDimensions();

  const open = useInsertMenuStore((s) => s.open);
  const query = useInsertMenuStore((s) => s.query);
  const recents = useInsertMenuStore((s) => s.recents);
  const aiEnabled = useAutocompleteAllowed();
  const thesisId = useThesisStore((s) => s.currentThesisId);
  const [tab, setTab] = useState<TabKey>("all");
  // The real Word styles defined in THIS thesis (word/styles.xml), fetched lazily.
  const [docStyles, setDocStyles] = useState<ThesisStyle[]>([]);
  const loadedFor = useRef<string | null>(null);
  // Inline "create a new style" form state.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBold, setNewBold] = useState(false);
  const [newItalic, setNewItalic] = useState(false);
  const [savingStyle, setSavingStyle] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<number | null>(null);
  const [align, setAlign] = useState<"left" | "center" | "right" | "both" | null>(null);
  const [lineSp, setLineSp] = useState<number | null>(null);
  const [spBefore, setSpBefore] = useState<number | null>(null);
  const [spAfter, setSpAfter] = useState<number | null>(null);
  const [indent, setIndent] = useState<number | null>(null);
  const resetCreate = () => {
    setNewName("");
    setNewBold(false);
    setNewItalic(false);
    setFontSize(null);
    setAlign(null);
    setLineSp(null);
    setSpBefore(null);
    setSpAfter(null);
    setIndent(null);
    setCreateErr(null);
  };

  // Reset to All (and clear any stale search) each time the drawer opens.
  useEffect(() => {
    if (open) setTab("all");
  }, [open]);

  // Fetch the thesis's real styles the first time the drawer opens for a thesis.
  // Failures fall back silently to the hardcoded Styles palette.
  useEffect(() => {
    if (!open || !thesisId || loadedFor.current === thesisId) return;
    loadedFor.current = thesisId;
    getThesisStyles(thesisId)
      .then(setDocStyles)
      .catch(() => {
        loadedFor.current = null;
      });
  }, [open, thesisId]);

  const label = (d: InsertBlockDef) => t(`insertMenu.block.${d.labelKey}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- label closes over t (stable per session)
  const filtered = useMemo(() => filterBlocks(query, label), [query]);
  const searching = query.trim().length > 0;

  // 3-column tile width (drawer is full-width): total padding 2*PAD, two 8px gaps,
  // and — easy to miss — the panel's own hairline border on each side. Measuring
  // from the bare window width overshot the panel's INNER width by that fraction
  // of a dp, and Yoga wrapped the third tile onto its own row: a 2-up grid with a
  // dead column on the end.
  const tileW = Math.floor((width - StyleSheet.hairlineWidth * 2 - PAD * 2 - 16) / 3);

  const pick = async (d: InsertBlockDef) => {
    if (d.status !== "ready") return;
    const a = useInsertMenuStore.getState().anchor;
    useInsertMenuStore.getState().pushRecent(d.kind);
    useInsertMenuStore.getState().close();
    const lex = useLexicalEditorStore.getState();
    if (d.styleId) {
      // Word named paragraph style → clear the /query, then set styleId on the
      // current block via a format op (shows in Preview/PDF/export).
      lex.dispatch("insert", JSON.stringify({ kind: "clearSlash" }));
      await lex.flushEdits?.();
      if (a && thesisId) await useThesisDocStore.getState().mutate(thesisId, { type: "format", indices: [a.index], changes: { styleId: d.styleId } });
      return;
    }
    if (TEXT_KINDS.includes(d.kind)) {
      lex.dispatch("insert", JSON.stringify({ kind: d.kind }));
      return;
    }
    lex.dispatch("insert", JSON.stringify({ kind: "clearSlash" }));
    await lex.flushEdits?.();
    if (!a || !thesisId) return;
    if (d.kind === "pageBreak") await useThesisDocStore.getState().mutate(thesisId, { type: "startOnNewPage", indices: [a.index] });
    else if (d.kind === "figure") await pickAndInsertImage(thesisId, a.index);
    else if (d.kind === "pasteImage") await pasteImageFromClipboard(thesisId, a.index);
    // An equation can't be inserted from here directly — it has to be WRITTEN
    // first. The sheet takes the formula (with a live preview of what will land on
    // the page) and does the insert itself, anchored to this same block.
    else if (d.kind === "equation") useEquationSheetStore.getState().openInsert({ thesisId, index: a.index });
  };

  // Apply a Word paragraph styleId (from a fetched thesis style) to the current block.
  const applyStyleId = async (styleId: string) => {
    const a = useInsertMenuStore.getState().anchor;
    useInsertMenuStore.getState().close();
    const lex = useLexicalEditorStore.getState();
    lex.dispatch("insert", JSON.stringify({ kind: "clearSlash" }));
    await lex.flushEdits?.();
    if (a && thesisId) await useThesisDocStore.getState().mutate(thesisId, { type: "format", indices: [a.index], changes: { styleId } });
  };

  // Create a new custom paragraph style and add it to the list (does not close the drawer).
  const doCreateStyle = async () => {
    if (!newName.trim() || !thesisId || savingStyle) return;
    setSavingStyle(true);
    setCreateErr(null);
    try {
      const s = await createThesisStyle(thesisId, {
        name: newName.trim(),
        bold: newBold,
        italic: newItalic,
        sizePt: fontSize ?? undefined,
        alignment: align ?? undefined,
        lineSpacing: lineSp ?? undefined,
        spacingBeforePt: spBefore ?? undefined,
        spacingAfterPt: spAfter ?? undefined,
        indentLeftCm: indent ?? undefined,
      });
      setDocStyles((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s]));
      setCreating(false);
      resetCreate();
    } catch (e: any) {
      setCreateErr(e?.message ?? "Failed to create style");
    } finally {
      setSavingStyle(false);
    }
  };

  const Tile = ({ Icon, text, fg, bg, ready, onPress }: { Icon: LucideIcon; text: string; fg: string; bg: string; ready: boolean; onPress?: () => void }) => (
    <Pressable
      onPress={onPress}
      disabled={!ready}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ disabled: !ready }}
      style={({ pressed }) => [styles.tile, { width: tileW, backgroundColor: pressed && ready ? colors.bgSurface : "transparent", opacity: ready ? 1 : 0.6 }]}
    >
      <View style={[styles.tileIcon, { backgroundColor: ready ? bg : colors.bgSurface }]}>
        <Icon size={21} color={ready ? fg : colors.textPlaceholder} />
      </View>
      <Text numberOfLines={1} style={[styles.tileLabel, { color: colors.textPrimary }]}>{text}</Text>
      {!ready ? <Text style={[styles.tileSoon, { color: colors.textPlaceholder }]}>{t("insertMenu.comingSoon")}</Text> : null}
    </Pressable>
  );

  const Section = ({ header, items, showHeader }: { header: string; items: InsertBlockDef[]; showHeader: boolean }) => {
    if (!items.length) return null;
    return (
      <View>
        {showHeader ? <Text style={[styles.cat, { color: colors.textPlaceholder, textAlign }]}>{header}</Text> : <View style={{ height: 8 }} />}
        <View style={styles.tilesWrap}>
          {items.map((d) => {
            const col = CAT_COLOR[d.category];
            return <Tile key={d.kind} Icon={d.Icon} text={label(d)} fg={col.fg} bg={col.bg} ready={d.status === "ready"} onPress={() => void pick(d)} />;
          })}
        </View>
      </View>
    );
  };

  const catItems = (c: InsertCategory) => filtered.filter((b) => b.category === c);
  const showAll = searching || tab === "all";
  const showHeaders = searching || tab === "all";

  // Dynamic Styles section from the thesis's real styles (paragraph = applyable,
  // character = shown disabled). Falls back to the hardcoded palette when none loaded.
  const q = query.trim().toLowerCase();
  const stylesForView = searching ? docStyles.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) : docStyles;
  const alignOpts: Array<["left" | "center" | "right" | "both", LucideIcon]> = [["left", AlignLeft], ["center", AlignCenter], ["right", AlignRight], ["both", AlignJustify]];
  const Stepper = ({ label, value, unit, min, max, step, def, set }: { label: string; value: number | null; unit: string; min: number; max: number; step: number; def: number; set: (n: number | null) => void }) => (
    <View style={[styles.stepRow, { flexDirection: rowDir }]}>
      <Text style={[styles.stepLabel, { color: colors.textSecondary, textAlign }]}>{label}</Text>
      <View style={[styles.stepper, { borderColor: colors.borderSubtle, flexDirection: rowDir }]}>
        <Pressable hitSlop={6} onPress={() => set(value == null ? min : Math.max(min, +(value - step).toFixed(2)))} style={styles.stepBtn}>
          <Text style={[styles.stepSign, { color: colors.textPrimary }]}>−</Text>
        </Pressable>
        <Text style={[styles.stepVal, { color: colors.textPrimary }]}>{value == null ? "—" : `${value}${unit}`}</Text>
        <Pressable hitSlop={6} onPress={() => set(value == null ? def : Math.min(max, +(value + step).toFixed(2)))} style={styles.stepBtn}>
          <Text style={[styles.stepSign, { color: colors.textPrimary }]}>+</Text>
        </Pressable>
      </View>
    </View>
  );
  const StylesSection = ({ showHeader }: { showHeader: boolean }) => {
    const dyn = [...stylesForView.filter((s) => s.type === "paragraph"), ...stylesForView.filter((s) => s.type !== "paragraph")];
    const useDyn = docStyles.length > 0;
    const fallback = useDyn ? [] : catItems("styles");
    const col = CAT_COLOR.styles;
    // Nothing to show while searching (and not creating) → skip the section.
    if (searching && !creating && (useDyn ? !dyn.length : !fallback.length)) return null;
    return (
      <View>
        {showHeader ? <Text style={[styles.cat, { color: colors.textPlaceholder, textAlign }]}>{t("insertMenu.cat.styles")}</Text> : <View style={{ height: 8 }} />}
        {creating ? (
          <View style={[styles.createCard, { borderColor: colors.borderSubtle, backgroundColor: colors.bgSurface }]}>
            <TextInput
              placeholder={t("insertMenu.styleName")}
              placeholderTextColor={colors.textPlaceholder}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              style={[styles.createInput, { color: colors.textPrimary, borderColor: colors.borderSubtle, textAlign }]}
            />
            <View style={[styles.createRow, { flexDirection: rowDir }]}>
              <Pressable onPress={() => setNewBold((v) => !v)} style={[styles.toggleChip, { backgroundColor: newBold ? colors.brandPrimary : colors.bgPrimary, borderColor: colors.borderSubtle }]}>
                <Text style={{ color: newBold ? "#fff" : colors.textSecondary, fontFamily: "Inter_700Bold", fontSize: 12 }}>{t("insertMenu.bold")}</Text>
              </Pressable>
              <Pressable onPress={() => setNewItalic((v) => !v)} style={[styles.toggleChip, { backgroundColor: newItalic ? colors.brandPrimary : colors.bgPrimary, borderColor: colors.borderSubtle }]}>
                <Text style={{ color: newItalic ? "#fff" : colors.textSecondary, fontFamily: "Inter_600SemiBold", fontStyle: "italic", fontSize: 12 }}>{t("insertMenu.italic")}</Text>
              </Pressable>
            </View>
            <View style={[styles.createRow, { flexDirection: rowDir, flexWrap: "wrap" }]}>
              {alignOpts.map(([a, Ic]) => (
                <Pressable key={a} onPress={() => setAlign((v) => (v === a ? null : a))} style={[styles.alignChip, { backgroundColor: align === a ? colors.brandPrimary : colors.bgPrimary, borderColor: colors.borderSubtle }]}>
                  <Ic size={16} color={align === a ? "#fff" : colors.textSecondary} />
                </Pressable>
              ))}
              {[1, 1.5, 2].map((v) => (
                <Pressable key={v} onPress={() => setLineSp((c) => (c === v ? null : v))} style={[styles.alignChip, { minWidth: 46, backgroundColor: lineSp === v ? colors.brandPrimary : colors.bgPrimary, borderColor: colors.borderSubtle }]}>
                  <Text style={{ color: lineSp === v ? "#fff" : colors.textSecondary, fontFamily: "Inter_700Bold", fontSize: 11 }}>{v.toFixed(1)}×</Text>
                </Pressable>
              ))}
            </View>
            <Stepper label={t("insertMenu.size")} value={fontSize} unit="pt" min={6} max={96} step={1} def={12} set={setFontSize} />
            <Stepper label={t("insertMenu.spaceBefore")} value={spBefore} unit="pt" min={0} max={72} step={3} def={6} set={setSpBefore} />
            <Stepper label={t("insertMenu.spaceAfter")} value={spAfter} unit="pt" min={0} max={72} step={3} def={6} set={setSpAfter} />
            <Stepper label={t("insertMenu.indent")} value={indent} unit="cm" min={0} max={5} step={0.5} def={1} set={setIndent} />
            {createErr ? <Text style={{ color: "#d64545", fontSize: 11, paddingHorizontal: 2 }}>{createErr}</Text> : null}
            <View style={[styles.createRow, { flexDirection: rowDir }]}>
              <Pressable onPress={() => void doCreateStyle()} disabled={!newName.trim() || savingStyle} style={[styles.createBtn, { backgroundColor: colors.brandPrimary, opacity: !newName.trim() || savingStyle ? 0.5 : 1 }]}>
                <Text style={{ color: "#fff", fontFamily: "Inter_700Bold", fontSize: 13 }}>{savingStyle ? t("insertMenu.creating") : t("insertMenu.create")}</Text>
              </Pressable>
              <Pressable onPress={() => { setCreating(false); resetCreate(); }} style={[styles.createBtn, { backgroundColor: colors.bgPrimary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle }]}>
                <Text style={{ color: colors.textSecondary, fontFamily: "Inter_600SemiBold", fontSize: 13 }}>{t("insertMenu.cancel")}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.tilesWrap}>
            {!searching ? (
              <Pressable onPress={() => setCreating(true)} accessibilityRole="button" accessibilityLabel={t("insertMenu.newStyle")} style={[styles.tile, { width: tileW }]}>
                <View style={[styles.tileIcon, { backgroundColor: col.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: col.fg, borderStyle: "dashed" }]}>
                  <Plus size={20} color={col.fg} />
                </View>
                <Text numberOfLines={1} style={[styles.tileLabel, { color: colors.textPrimary }]}>{t("insertMenu.newStyle")}</Text>
              </Pressable>
            ) : null}
            {useDyn
              ? dyn.map((s) => {
                  const isPara = s.type === "paragraph";
                  return <Tile key={s.id} Icon={isPara ? Pilcrow : TypeIcon} text={s.name} fg={col.fg} bg={col.bg} ready={isPara} onPress={isPara ? () => void applyStyleId(s.id) : undefined} />;
                })
              : fallback.map((d) => <Tile key={d.kind} Icon={d.Icon} text={label(d)} fg={col.fg} bg={col.bg} ready={d.status === "ready"} onPress={() => void pick(d)} />)}
          </View>
        )}
      </View>
    );
  };
  const renderCat = (c: InsertCategory, showHeader: boolean) =>
    c === "styles" ? <StylesSection key="styles" showHeader={showHeader} /> : <Section key={c} header={t(`insertMenu.cat.${c}`)} showHeader={showHeader} items={catItems(c)} />;

  const tabLabel = (k: TabKey) => (k === "all" ? t("insertMenu.all") : t(`insertMenu.cat.${k}`));

  return (
    <View style={[styles.panel, { backgroundColor: colors.bgPrimary, borderColor: colors.borderSubtle }]}>
      <GestureDetector gesture={dragPan}>
        <View style={styles.grabZone}>
          <View style={[styles.grab, { backgroundColor: colors.borderDefault }]} />
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t("insertMenu.title")}</Text>
        </View>
      </GestureDetector>

      <View style={[styles.search, { backgroundColor: colors.bgSurface, flexDirection: rowDir }]}>
        <SearchIcon size={17} color={colors.textPlaceholder} />
        <TextInput
          placeholder={t("insertMenu.searchPlaceholder")}
          placeholderTextColor={colors.textPlaceholder}
          accessibilityLabel={t("insertMenu.searchPlaceholder")}
          value={query}
          onChangeText={(q) => useInsertMenuStore.getState().setQuery(q)}
          style={[styles.searchInput, { color: colors.textPrimary, textAlign }]}
        />
      </View>

      {!searching ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={[styles.tabsRow, { flexDirection: rowDir }]}>
          {(["all", ...INSERT_CATEGORIES] as TabKey[]).map((k) => {
            const on = tab === k;
            return (
              <Pressable key={k} onPress={() => setTab(k)} style={[styles.pill, { backgroundColor: on ? colors.brandPrimary : colors.bgSurface }]}>
                <Text style={[styles.pillText, { color: on ? "#fff" : colors.textSecondary }]}>{tabLabel(k)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: bottomInset + 16 }}>
        {showAll ? (
          <>
            {!searching && recents.length > 0 ? (
              <Section header={t("insertMenu.recent")} showHeader items={recents.map((k) => INSERT_BLOCKS.find((b) => b.kind === k)).filter(Boolean) as InsertBlockDef[]} />
            ) : null}
            {INSERT_CATEGORIES.map((c) => renderCat(c, showHeaders))}
          </>
        ) : (
          renderCat(tab as InsertCategory, false)
        )}

        {aiEnabled && tab === "all" && !searching ? (
          <View>
            <Text style={[styles.cat, { color: colors.textPlaceholder, textAlign }]}>{t("insertMenu.aiSuggestions")}</Text>
            <View style={styles.tilesWrap}>
              <Tile Icon={ImagePlus} text={t("insertMenu.block.imageGen")} fg={colors.brandPrimary} bg={colors.bgSurface} ready={false} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  app: { flex: 1, overflow: "hidden", backgroundColor: "transparent" },
  scrim: { backgroundColor: "#000", zIndex: 1 },
  drawer: { position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 2 },
  panel: {
    flex: 1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 20,
  },
  grabZone: { paddingTop: 10, paddingBottom: 6, alignItems: "center" },
  grab: { width: 44, height: 5, borderRadius: 3, marginBottom: 8 },
  title: { fontSize: 15, fontFamily: "Inter_700Bold" },
  search: { alignItems: "center", gap: 9, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginHorizontal: PAD, marginTop: 6, marginBottom: 8 },
  searchInput: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium", padding: 0 },
  tabsScroll: { flexGrow: 0, flexShrink: 0 },
  list: { flex: 1 },
  tabsRow: { gap: 8, paddingHorizontal: PAD, paddingBottom: 10, alignItems: "center" },
  pill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20 },
  pillText: { fontSize: 12.5, fontFamily: "Inter_700Bold" },
  cat: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.7, textTransform: "uppercase", paddingHorizontal: PAD, paddingTop: 14, paddingBottom: 8 },
  tilesWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: PAD },
  tile: { alignItems: "center", gap: 7, paddingVertical: 12, paddingHorizontal: 4, borderRadius: 14 },
  tileIcon: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  tileLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", textAlign: "center" },
  tileSoon: { fontSize: 8.5, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.3 },
  createCard: { marginHorizontal: PAD, marginTop: 4, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 10 },
  createInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: "Inter_500Medium" },
  createRow: { gap: 8, alignItems: "center" },
  toggleChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  createBtn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: "center" },
  alignChip: { minWidth: 40, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  stepRow: { alignItems: "center", justifyContent: "space-between", gap: 10 },
  stepLabel: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  stepper: { alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  stepBtn: { paddingHorizontal: 14, paddingVertical: 6 },
  stepSign: { fontSize: 18, fontFamily: "Inter_700Bold" },
  stepVal: { minWidth: 52, textAlign: "center", fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
