import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, FlatList, TextInput, Image } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  Search,
  X,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsDownUp,
  Table as TableIcon,
  Image as ImageIcon,
} from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useAuthHeader } from "@/hooks/useAuthHeader";
import { useThesisStore } from "@/stores/thesis-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useNavDrawerStore } from "@/stores/nav-drawer-store";
import { useOutlineStore } from "@/stores/outline-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { thesisBlockImageUrl, type OutlineNodeDTO, type DocBlockDTO } from "@/lib/api";
import { normalize } from "@/lib/text-normalize";
import { isFigureBlock } from "@/lib/doc-ornament";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";

// Whether any heading title contains Arabic/Hebrew letters → render right-to-left.
// thesis.language is unreliable for imports, so detect direction from the content.
function isRtlText(s: string): boolean {
  return /[֐-ࣿ]/.test(s);
}

const INDENT_STEP = 16;
type FlatRow = { node: OutlineNodeDTO; depth: number; hasChildren: boolean; collapsed: boolean };

// The three navigator tabs: the heading tree (Contents), the tables list, and the
// figures list. Contents mirrors a Word table-of-contents; Tables/Figures are the
// "list of tables" / "list of figures" front-matter, built live from the document.
type Tab = "toc" | "tables" | "figures";
type ImageBlock = Extract<DocBlockDTO, { kind: "image" }>;
type FigureItem = { index: number; n: number; caption: string; block: ImageBlock };
type TableItem = { index: number; n: number; caption: string; rows: number; cols: number };

// Word table captions are a short paragraph adjacent to the table (usually the line
// just above it, sometimes below) that starts with a "Table"/"Tableau"/"جدول"
// keyword. Figure captions already arrive on the image block from the server; tables
// have no caption field, so we derive one here from the neighbouring paragraph.
function isTableCaption(t: string): boolean {
  if (!t || t.length > 200) return false;
  return /^(table|tableau)\b/i.test(t) || t.startsWith("جدول") || t.startsWith("الجدول");
}
function deriveTableCaption(blocks: DocBlockDTO[], i: number): string {
  for (const j of [i - 1, i + 1]) {
    const b = blocks[j];
    if (b && b.kind === "paragraph") {
      const text = b.text.trim();
      if (isTableCaption(text)) return text;
    }
  }
  return "";
}

// Pre-order DFS → a flat [{ node, depth }] list the FlatList can virtualize. A
// collapsed node contributes its own row but NOT its descendants, so the tree can
// be folded at any level.
function flattenOutline(
  nodes: OutlineNodeDTO[],
  collapsed: Set<number>,
  depth = 0,
  out: FlatRow[] = [],
): FlatRow[] {
  for (const n of nodes) {
    const hasChildren = n.children.length > 0;
    const isCollapsed = collapsed.has(n.index);
    out.push({ node: n, depth, hasChildren, collapsed: isCollapsed });
    if (hasChildren && !isCollapsed) flattenOutline(n.children, collapsed, depth + 1, out);
  }
  return out;
}

// Every node that HAS children — the set that "collapse all" folds.
function collectParents(nodes: OutlineNodeDTO[], out: number[] = []): number[] {
  for (const n of nodes) {
    if (n.children.length) {
      out.push(n.index);
      collectParents(n.children, out);
    }
  }
  return out;
}

// A single heading row: [collapse chevron?] [bullet] [title], indented by depth.
// Top-level headings are emphasised; the active one is the "you are here" highlight.
function OutlineRow({
  node,
  depth,
  rtl,
  active,
  hasChildren,
  collapsed,
  showChevron,
  colors,
  onPress,
  onToggle,
}: {
  node: OutlineNodeDTO;
  depth: number;
  rtl: boolean;
  active: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  showChevron: boolean;
  colors: ReturnType<typeof useThemeColors>;
  onPress: (index: number, title: string) => void;
  onToggle: (index: number) => void;
}) {
  const isTop = depth === 0;
  // Align EACH heading by its OWN script, not the panel-wide flag: an Arabic heading
  // always renders right-to-left (and a Latin one left-to-right), even in a mixed thesis.
  const rowRtl = isRtlText(node.title);
  const indent = depth * INDENT_STEP;
  const bulletColor = active || isTop ? colors.brandPrimary : colors.textSecondary;
  const textColor = active ? colors.brandPrimary : isTop ? colors.textPrimary : colors.textSecondary;
  const Collapsed = rowRtl ? ChevronLeft : ChevronRight;
  return (
    <Pressable
      onPress={() => onPress(node.index, node.title)}
      style={[
        styles.row,
        active && { backgroundColor: colors.brandPrimary + "14", borderRadius: 8 },
        {
          flexDirection: visualRow(rowRtl),
          paddingLeft: rowRtl ? 0 : indent,
          paddingRight: rowRtl ? indent : 0,
        },
      ]}
    >
      {showChevron && hasChildren ? (
        <Pressable onPress={() => onToggle(node.index)} hitSlop={8} style={styles.chevronBtn}>
          {collapsed ? (
            <Collapsed size={16} color={colors.textSecondary} />
          ) : (
            <ChevronDown size={16} color={colors.textSecondary} />
          )}
        </Pressable>
      ) : (
        showChevron && <View style={styles.chevronBtn} />
      )}
      <View
        style={[
          styles.bullet,
          {
            backgroundColor: bulletColor,
            width: active || isTop ? 7 : 5,
            height: active || isTop ? 7 : 5,
            borderRadius: active || isTop ? 3.5 : 2.5,
            opacity: active || isTop ? 1 : 0.55,
          },
        ]}
      />
      <Text
        style={[
          isTop ? styles.rowTitleTop : styles.rowTitle,
          active && styles.rowTitleActive,
          { color: textColor, textAlign: visualTextAlign(rowRtl) },
        ]}
        numberOfLines={2}
      >
        {node.title}
      </Text>
    </Pressable>
  );
}

// A small live thumbnail of a figure, reusing the same dataUri/authed-media path as
// the document view. Falls back to a picture-icon tile until the token/bytes resolve
// or if the load fails, so a row never renders blank.
function FigureThumb({
  block,
  thesisId,
  tick,
  colors,
}: {
  block: ImageBlock;
  thesisId: string;
  tick: number;
  colors: ReturnType<typeof useThemeColors>;
}) {
  const authHeader = useAuthHeader();
  const [failed, setFailed] = useState(false);
  const needsAuth = !block.dataUri;
  const uri = block.dataUri ?? (block.hasMedia ? thesisBlockImageUrl(thesisId, block.index, tick) : undefined);
  if (!uri || failed || (needsAuth && !authHeader)) {
    return (
      <View style={[styles.thumb, styles.thumbTile, { backgroundColor: colors.bgInput }]}>
        <ImageIcon size={18} color={colors.textSecondary} />
      </View>
    );
  }
  return (
    <Image
      source={needsAuth && authHeader ? { uri, headers: authHeader } : { uri }}
      resizeMode="cover"
      onError={() => setFailed(true)}
      style={[styles.thumb, { backgroundColor: colors.bgInput }]}
    />
  );
}

// One "list of figures" row: a thumbnail + the caption (or a native "Figure N" when
// the figure has no caption — the thumbnail is then the visual identifier).
function FigureRow({
  item,
  rtl,
  colors,
  thesisId,
  tick,
  onPress,
  numberLabel,
}: {
  item: FigureItem;
  rtl: boolean;
  colors: ReturnType<typeof useThemeColors>;
  thesisId: string;
  tick: number;
  onPress: (index: number, label: string) => void;
  numberLabel: string;
}) {
  const label = item.caption || numberLabel;
  const align = visualTextAlign(rtl);
  return (
    <Pressable
      onPress={() => onPress(item.index, label)}
      style={[styles.mediaRow, { flexDirection: visualRow(rtl) }]}
    >
      <FigureThumb block={item.block} thesisId={thesisId} tick={tick} colors={colors} />
      <View style={styles.mediaText}>
        <Text style={[styles.mediaLabel, { color: colors.textPrimary, textAlign: align }]} numberOfLines={2}>
          {label}
        </Text>
        {item.caption ? (
          <Text style={[styles.mediaSub, { color: colors.textSecondary, textAlign: align }]} numberOfLines={1}>
            {numberLabel}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// One "list of tables" row: a table-icon tile + the caption (or a native "Table N")
// with the grid size as a subtitle.
function TableRow({
  item,
  rtl,
  colors,
  onPress,
  numberLabel,
  sizeLabel,
}: {
  item: TableItem;
  rtl: boolean;
  colors: ReturnType<typeof useThemeColors>;
  onPress: (index: number, label: string) => void;
  numberLabel: string;
  sizeLabel: string;
}) {
  const label = item.caption || numberLabel;
  const sub = item.caption ? `${numberLabel} · ${sizeLabel}` : sizeLabel;
  const align = visualTextAlign(rtl);
  return (
    <Pressable
      onPress={() => onPress(item.index, label)}
      style={[styles.mediaRow, { flexDirection: visualRow(rtl) }]}
    >
      <View style={[styles.thumb, styles.thumbTile, { backgroundColor: colors.bgInput }]}>
        <TableIcon size={18} color={colors.textSecondary} />
      </View>
      <View style={styles.mediaText}>
        <Text style={[styles.mediaLabel, { color: colors.textPrimary, textAlign: align }]} numberOfLines={2}>
          {label}
        </Text>
        <Text style={[styles.mediaSub, { color: colors.textSecondary, textAlign: align }]} numberOfLines={1}>
          {sub}
        </Text>
      </View>
    </Pressable>
  );
}

// Placeholder rows for the short window where the drawer is reachable but its cache
// read (or, from chat, its first fetch) hasn't landed yet — honest about "not here
// yet" instead of claiming the document has no headings.
function ListSkeleton({
  colors,
  rtl,
  rows = 8,
}: {
  colors: ReturnType<typeof useThemeColors>;
  rtl: boolean;
  rows?: number;
}) {
  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.skelRow, { flexDirection: visualRow(rtl) }]}>
          <View style={[styles.skelDot, { backgroundColor: colors.borderDefault }]} />
          <View
            style={[styles.skelBar, { backgroundColor: colors.borderDefault, width: `${86 - (i % 3) * 18}%` }]}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * The Thesis Structure navigator's CONTENTS — a three-tab drawer:
 *   • Contents — the heading tree (table of contents), virtualized + collapsible.
 *   • Tables   — every table in the document ("list of tables").
 *   • Figures  — every figure/image ("list of figures"), with thumbnails.
 * Headings come from the cached `outline-store`; tables & figures from the cached
 * `thesis-doc-store` blocks. Each entry labels itself by its caption when present,
 * else a native "Table N"/"Figure N". Tapping any entry closes the drawer and
 * scrolls the workspace to that block. Hosted by the root drawer, as the second
 * view of `AppDrawer`.
 */
/**
 * The thesis structure (Contents / Tables / Figures). It no longer owns the root
 * drawer — it's the "outline" view of `AppDrawer`, so `onBack` returns to the app
 * index. Rendered without `onBack` it behaves as the standalone panel it was.
 */
export function ThesisOutlinePanel({ onBack }: { onBack?: () => void } = {}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const thesis = useThesisStore((s) => s.getCurrentThesis());
  // "Visible", not merely "drawer open": the drawer now hosts an app index too, and
  // this panel stays mounted behind it. Everything gated below is gated on being on
  // screen, so the app view must not wake the outline's scroll-driven selectors.
  const open = useNavDrawerStore((s) => s.open && s.view === "outline");
  // Stable-ref selector (the stored object, or undefined) → no zustand loop.
  const outline = useOutlineStore((s) => (thesis ? s.byId[thesis.id] : undefined));
  // Live document (blocks) for the Tables/Figures tabs. Stable ref + primitive tick.
  const doc = useThesisDocStore((s) => (thesis ? s.byId[thesis.id] : undefined));
  const docTick = useThesisDocStore((s) => (thesis ? s.tick[thesis.id] ?? 0 : 0));
  // "You are here" anchor: the caret's block while inline-editing, else the block
  // at the top of the doc view (from the outline view's scroll). Primitive selectors,
  // GATED ON `open`: this panel is always mounted (it lives in the root drawer's
  // content, which the navigator keeps rendered and merely `display: none`s),
  // and `activeBlockIndex` is rewritten on every viewability change while the reader
  // scrolls — subscribing unconditionally re-rendered the whole invisible drawer
  // (flatten + every visible row) on each of those. While closed the selectors
  // return a constant, so zustand never wakes us; the live values are picked up in
  // the same render that opens the drawer.
  const activeBlockIndex = useWorkspaceStore((s) => (open ? s.activeBlockIndex : null));
  const editingBlockIndex = useWorkspaceStore((s) => (open ? s.editingBlockIndex : null));
  const listRef = useRef<FlatList<FlatRow>>(null);

  const [tab, setTab] = useState<Tab>("toc");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  // Fresh state per thesis; drop the query + tab each time the drawer closes.
  useEffect(() => {
    setQuery("");
    setTab("toc");
    setCollapsed(new Set());
  }, [thesis?.id]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setTab("toc");
    }
  }, [open]);

  // Warm the panel's data the moment the drawer becomes REACHABLE — a thesis is
  // current and we're on a surface that hosts it — never on open. Doing this on
  // open meant the first swipe kicked off a SQLite read and, from chat, an outline
  // + document FETCH: the drawer slid in empty and filled a beat (or a round-trip)
  // later. Cache-first; one network sync only when nothing is cached at all, and
  // skipped while local edits are unsynced — with edits queued on-device the server
  // outline is stale by definition, so we stick to the local copy until the
  // document itself syncs (the workspace drain effect re-syncs it then).
  const reachable = !!thesis && !!pathname && (pathname.includes("thesis-workspace") || pathname.includes("chat"));
  useEffect(() => {
    if (!reachable || !thesis) return;
    const store = useOutlineStore.getState();
    void store.hydrate(thesis.id).then(() => {
      const unsynced = (useThesisDocStore.getState().pending[thesis.id] ?? 0) > 0;
      if (!unsynced && useOutlineStore.getState().byId[thesis.id] === undefined) void store.sync(thesis.id);
    });
    // The Tables/Figures tabs read the live document blocks — hydrate them from the
    // SQLite cache (and revalidate) if the workspace hasn't already loaded them.
    if (useThesisDocStore.getState().byId[thesis.id] === undefined) void useThesisDocStore.getState().load(thesis.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachable, thesis?.id]);

  const liveOutline = outline?.available ? outline : null;
  // Stable empty ref when there's no outline yet, so the memos below don't churn.
  const nodes: OutlineNodeDTO[] = liveOutline ? liveOutline.nodes : EMPTY_NODES;
  const sectionCount = liveOutline ? liveOutline.sectionCount : 0;
  const chapterCount = liveOutline ? liveOutline.chapterCount : 0;
  // Nothing cached AND nothing fetched yet — distinct from "this document has no
  // headings", which is what the empty state used to claim while the first read
  // was still in flight.
  const outlineLoading = outline === undefined;
  const docLoading = doc === undefined;

  const blocks: DocBlockDTO[] = doc?.available ? doc.blocks : EMPTY_BLOCKS;

  // Figures & tables in document order, each 1-based numbered. Figure captions ride
  // the image block (server-derived); table captions are derived from a neighbour.
  const figures = useMemo<FigureItem[]>(() => {
    const out: FigureItem[] = [];
    let n = 0;
    for (const b of blocks) {
      // Page ornaments are decoration, not figures — listing one would show a
      // full-page frame as "Figure 1" and shift every real figure's number.
      if (isFigureBlock(b)) {
        n += 1;
        out.push({ index: b.index, n, caption: (b.caption ?? "").trim(), block: b });
      }
    }
    return out;
  }, [blocks]);

  const tables = useMemo<TableItem[]>(() => {
    const out: TableItem[] = [];
    let n = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind !== "table") continue;
      n += 1;
      const rows = b.rows.length;
      const cols = rows > 0 ? Math.max(...b.rows.map((r) => r.length)) : 0;
      out.push({ index: b.index, n, caption: deriveTableCaption(blocks, i), rows, cols });
    }
    return out;
  }, [blocks]);

  // Direction from the document's own text (headings first — the most reliable —
  // then captions), so the whole drawer flips as one for an Arabic thesis. Memoized:
  // it walks every heading and caption, and used to rebuild those strings on each
  // render of a panel that re-rendered on every scroll.
  const rtl = useMemo(
    () =>
      isRtlText(nodes.map((n) => n.title).join(" ")) ||
      isRtlText(figures.map((f) => f.caption).join(" ") + " " + tables.map((tb) => tb.caption).join(" ")),
    [nodes, figures, tables],
  );

  const numberLabel = (kind: "table" | "figure", n: number) =>
    kind === "table"
      ? t("thesis.tableN", { n, defaultValue: `Table ${n}` })
      : t("thesis.figureN", { n, defaultValue: `Figure ${n}` });
  const sizeLabel = (rows: number, cols: number) =>
    t("thesis.tableSize", { rows, cols, defaultValue: `${rows} × ${cols}` });

  // Fully-expanded flatten drives search + the active-heading calc (both ignore
  // the collapse state). Browsing uses the collapsed flatten. Both memoized — a
  // full DFS of the heading tree per render is wasted work on a long thesis.
  const allRows = useMemo(() => flattenOutline(nodes, EMPTY_SET), [nodes]);
  const collapsedRows = useMemo(() => flattenOutline(nodes, collapsed), [nodes, collapsed]);
  const q = normalize(query);
  const searching = q.length > 0;
  const visibleRows = useMemo(
    () => (searching ? allRows.filter((r) => normalize(r.node.title).includes(q)) : collapsedRows),
    [searching, q, allRows, collapsedRows],
  );

  // Tables/Figures search by caption OR native number label (so "figure 3" matches).
  const visibleFigures = searching
    ? figures.filter((f) => normalize(`${f.caption} ${numberLabel("figure", f.n)}`).includes(q))
    : figures;
  const visibleTables = searching
    ? tables.filter((tb) => normalize(`${tb.caption} ${numberLabel("table", tb.n)}`).includes(q))
    : tables;

  // The active heading = the last heading whose block index is ≤ the anchor. Rows
  // are document-ordered (pre-order DFS → increasing index), so scan-keep-last.
  const anchor = editingBlockIndex ?? activeBlockIndex;
  let activeNodeIndex: number | null = null;
  if (anchor != null) {
    for (const r of allRows) {
      if (r.node.index <= anchor) activeNodeIndex = r.node.index;
      else break;
    }
  }

  // When the drawer opens on the Contents tab, bring the active ("you are here")
  // heading into view. Only on the open transition — never on scroll updates, or
  // the list would jump around under the reader.
  useEffect(() => {
    if (!open || tab !== "toc" || activeNodeIndex == null) return;
    const pos = visibleRows.findIndex((r) => r.node.index === activeNodeIndex);
    if (pos < 0) return;
    const id = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: pos, viewPosition: 0.35, animated: false });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleCollapse = (index: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  // Collapse-all folds every parent to top level; if anything's already folded,
  // the button expands all instead.
  const collapseAllToggle = () =>
    setCollapsed((prev) => (prev.size > 0 ? new Set() : new Set(collectParents(nodes))));

  // Tap any entry (heading / table / figure) → close the drawer and bring that
  // block into view.
  function handleEntryPress(index: number, label: string) {
    if (!thesis) return;
    useNavDrawerStore.getState().closeDrawer();
    const ws = useWorkspaceStore.getState();
    ws.selectBlock(index, label);
    ws.requestScrollToBlock(index);
    // Already in the workspace → scroll in place; else navigate there.
    if (pathname?.includes("thesis-workspace")) return;
    router.push({
      pathname: "/(app)/thesis-workspace",
      params: { thesisId: thesis.id, blockIndex: String(index) },
    });
  }

  const searchPlaceholder =
    tab === "tables"
      ? t("thesis.searchTables", { defaultValue: "Search tables" })
      : tab === "figures"
        ? t("thesis.searchFigures", { defaultValue: "Search figures" })
        : t("thesis.searchHeadings", { defaultValue: "Search headings" });

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "toc", label: t("thesis.tabContents", { defaultValue: "Contents" }), count: allRows.length },
    { key: "tables", label: t("thesis.tabTables", { defaultValue: "Tables" }), count: tables.length },
    { key: "figures", label: t("thesis.tabFigures", { defaultValue: "Figures" }), count: figures.length },
  ];

  return (
    <View style={[styles.panel, { backgroundColor: colors.bgModal }]}>
      {/* Sticky header: title + close, the tab switcher, and the search field. */}
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={[styles.titleRow, { flexDirection: visualRow(rtl) }]}>
          {onBack && (
            <Pressable
              onPress={onBack}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t("common.back", { defaultValue: "Back" })}
              style={styles.iconBtn}
            >
              {rtl ? (
                <ChevronRight size={24} color={colors.textPrimary} />
              ) : (
                <ChevronLeft size={24} color={colors.textPrimary} />
              )}
            </Pressable>
          )}
          <Text
            style={[styles.title, { color: colors.textPrimary, textAlign: visualTextAlign(rtl) }]}
            numberOfLines={1}
          >
            {t("thesis.thesisStructure")}
          </Text>
          <Pressable
            onPress={() => useNavDrawerStore.getState().closeDrawer()}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t("common.close", { defaultValue: "Close" })}
            style={styles.iconBtn}
          >
            <X size={24} color={colors.textPrimary} />
          </Pressable>
        </View>

        {/* Tab switcher: Contents / Tables / Figures (segmented, RTL-aware). */}
        <View style={[styles.tabBar, { backgroundColor: colors.bgInput, flexDirection: visualRow(rtl) }]}>
          {tabs.map((it) => {
            const active = it.key === tab;
            return (
              <Pressable
                key={it.key}
                onPress={() => {
                  setTab(it.key);
                  setQuery("");
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.tabItem, active && { backgroundColor: colors.bgModal }]}
              >
                <Text
                  style={[styles.tabLabel, { color: active ? colors.brandPrimary : colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {it.label}
                  {it.count > 0 ? `  ${it.count}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {tab === "toc" && (
          <View style={[styles.statusRow, { flexDirection: visualRow(rtl) }]}>
            <View style={[styles.statusBadges, { flexDirection: visualRow(rtl) }]}>
              <View style={styles.statusBadge}>
                <View style={[styles.statusDot, { backgroundColor: colors.brandPrimary }]} />
                <Text style={[styles.statusText, { color: colors.textSecondary }]}>{sectionCount} {t("home.sections")}</Text>
              </View>
              <View style={styles.statusBadge}>
                <View style={[styles.statusDot, { backgroundColor: colors.brandAccent }]} />
                <Text style={[styles.statusText, { color: colors.textSecondary }]}>{chapterCount} {t("home.chapters")}</Text>
              </View>
            </View>
            {nodes.length > 0 && (
              <Pressable
                onPress={collapseAllToggle}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t("thesis.collapseAll", { defaultValue: "Collapse all" })}
                style={styles.iconBtn}
              >
                <ChevronsDownUp size={18} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
        )}

        <View
          style={[
            styles.searchBox,
            { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, flexDirection: visualRow(rtl) },
          ]}
        >
          <Search size={16} color={colors.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={searchPlaceholder}
            placeholderTextColor={colors.textPlaceholder}
            style={[styles.searchInput, { color: colors.textPrimary, textAlign: visualTextAlign(rtl) }]}
            returnKeyType="search"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery("")} hitSlop={8}>
              <X size={16} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
      </View>

      {tab === "toc" && (
        <FlatList
          ref={listRef}
          data={visibleRows}
          keyExtractor={(item) => String(item.node.index)}
          renderItem={({ item }) => (
            <OutlineRow
              node={item.node}
              depth={searching ? 0 : item.depth}
              rtl={rtl}
              active={item.node.index === activeNodeIndex}
              hasChildren={item.hasChildren}
              collapsed={item.collapsed}
              showChevron={!searching}
              colors={colors}
              onPress={handleEntryPress}
              onToggle={toggleCollapse}
            />
          )}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator={false}
          initialNumToRender={16}
          windowSize={11}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
          }}
          ListEmptyComponent={
            outlineLoading && !searching ? (
              <ListSkeleton colors={colors} rtl={rtl} />
            ) : (
              <Text style={[styles.emptyText, { color: colors.textSecondary, textAlign: visualTextAlign(rtl) }]}>
                {searching
                  ? t("thesis.noMatches", { defaultValue: "No headings match your search." })
                  : t("thesis.noChapters", { defaultValue: "No headings found in this document yet." })}
              </Text>
            )
          }
        />
      )}

      {tab === "tables" && (
        <FlatList
          data={visibleTables}
          keyExtractor={(item) => String(item.index)}
          renderItem={({ item }) => (
            <TableRow
              item={item}
              rtl={rtl}
              colors={colors}
              onPress={handleEntryPress}
              numberLabel={numberLabel("table", item.n)}
              sizeLabel={sizeLabel(item.rows, item.cols)}
            />
          )}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator={false}
          initialNumToRender={16}
          windowSize={11}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListEmptyComponent={
            docLoading && !searching ? (
              <ListSkeleton colors={colors} rtl={rtl} rows={5} />
            ) : (
              <Text style={[styles.emptyText, { color: colors.textSecondary, textAlign: visualTextAlign(rtl) }]}>
                {searching
                  ? t("thesis.noMatches", { defaultValue: "No matches for your search." })
                  : t("thesis.noTables", { defaultValue: "No tables in this document yet." })}
              </Text>
            )
          }
        />
      )}

      {tab === "figures" && (
        <FlatList
          data={visibleFigures}
          keyExtractor={(item) => String(item.index)}
          renderItem={({ item }) => (
            <FigureRow
              item={item}
              rtl={rtl}
              colors={colors}
              thesisId={thesis?.id ?? ""}
              tick={docTick}
              onPress={handleEntryPress}
              numberLabel={numberLabel("figure", item.n)}
            />
          )}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator={false}
          initialNumToRender={12}
          windowSize={11}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListEmptyComponent={
            docLoading && !searching ? (
              <ListSkeleton colors={colors} rtl={rtl} rows={5} />
            ) : (
              <Text style={[styles.emptyText, { color: colors.textSecondary, textAlign: visualTextAlign(rtl) }]}>
                {searching
                  ? t("thesis.noMatches", { defaultValue: "No matches for your search." })
                  : t("thesis.noFigures", { defaultValue: "No figures in this document yet." })}
              </Text>
            )
          }
        />
      )}
    </View>
  );
}

// Shared empty set for the fully-expanded flatten (never mutated).
const EMPTY_SET: Set<number> = new Set();
// Shared empty outline, so a not-yet-loaded thesis doesn't churn the memos.
const EMPTY_NODES: OutlineNodeDTO[] = [];
// Shared empty blocks list, so a not-yet-loaded document doesn't churn the memos.
const EMPTY_BLOCKS: DocBlockDTO[] = [];

const styles = StyleSheet.create({
  panel: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 10 },
  titleRow: { alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  title: { flex: 1, fontSize: 20, fontFamily: "Inter_700Bold" },
  iconBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  tabBar: { padding: 3, borderRadius: 12, gap: 3, marginBottom: 12 },
  tabItem: { flex: 1, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  tabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  statusRow: { alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  statusBadges: { flexDirection: "row", alignItems: "center", gap: 16 },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  searchBox: {
    alignItems: "center",
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", padding: 0 },
  content: { paddingHorizontal: 20, paddingTop: 6 },
  chevronBtn: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  row: { alignItems: "center", gap: 10, paddingVertical: 9 },
  bullet: { flexShrink: 0 },
  rowTitleTop: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold", lineHeight: 21 },
  rowTitle: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19 },
  rowTitleActive: { fontFamily: "Inter_600SemiBold" },
  emptyText: { fontSize: 13, fontFamily: "Inter_400Regular", paddingVertical: 24 },
  // Loading placeholders — same rhythm as a real heading row.
  skelRow: { alignItems: "center", gap: 10, paddingVertical: 9 },
  skelDot: { width: 7, height: 7, borderRadius: 3.5, opacity: 0.6 },
  skelBar: { height: 11, borderRadius: 6, opacity: 0.5 },
  // Tables / figures rows.
  mediaRow: { alignItems: "center", gap: 12, paddingVertical: 8 },
  thumb: { width: 44, height: 44, borderRadius: 8, flexShrink: 0 },
  thumbTile: { alignItems: "center", justifyContent: "center" },
  mediaText: { flex: 1, gap: 2 },
  mediaLabel: { fontSize: 14, fontFamily: "Inter_500Medium", lineHeight: 19 },
  mediaSub: { fontSize: 12, fontFamily: "Inter_400Regular" },
});
