import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutocompleteAllowed } from "@/lib/autocomplete-policy";
import { useTranslation } from "react-i18next";
import { View, Text, StyleSheet, AppState, ActivityIndicator, Dimensions, Keyboard, I18nManager } from "react-native";
import { useFocusEffect } from "expo-router";
import { useThemeColors } from "@/hooks/useThemeColors";
import LexicalDomEditor from "@/components/workspace/lexical/LexicalDomEditor";
import type { LexicalCommand, LexicalState } from "@/components/workspace/lexical/editor-components/types";
// type-only — blockLexical is a web-only ('use dom') module; importing the type is
// erased at compile time so no Lexical/DOM globals enter this native bundle.
import type { ChromeData, ChromeKind } from "@/components/workspace/lexical/blockLexical";
import { applyThesisOps, getAuthHeader, type AnchoredShape, type ChromeDrawingDTO, type DocBlockDTO, type DocSectionDTO, type DocumentDTO, type InlineMathDTO } from "@/lib/api";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useEquationSheetStore } from "@/stores/equation-sheet-store";
import { useHfSheetStore } from "@/stores/hf-sheet-store";
import { HF_SHEET_FRACTION } from "@/components/HeaderFooterSheet";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useNavDrawerStore } from "@/stores/nav-drawer-store";
import { useSuggestionStore } from "@/stores/suggestion-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useCompletionStore } from "@/stores/completion-store";
import { useSearchStore } from "@/stores/search-store";
import { useTableSuggestionStore } from "@/stores/table-suggestion-store";
import { diffToOps, layoutDelta } from "@/lib/table-diff";
import { applyOpToDoc } from "@/lib/thesis-ops";
import { planOps, tally } from "@/lib/lexical-writeback";
import { useInsertMenuStore } from "@/stores/insert-menu-store";
import { pasteImageFromClipboard } from "@/lib/paste-image";
import { useEditorScrollStore, type ScrollAnchor } from "@/stores/editor-scroll-store";
import { hLight, hMedium, hSelection } from "@/lib/haptics";
import { geometryFromSection, chromeGeometryFromSection, type AnchorSectionGeometry, type PageSectionInput , type BlockFmt, type ChromePageGeometry } from "@/lib/page-layout";
import { sectionAt, sectionPrints } from "@/lib/section-chrome";

// PHASE 1 of the in-workspace Lexical editor: a real editing surface (Lexical in an
// Expo DOM component) over the live thesis, saving through the batch /ops endpoint
// (one call per Save). It renders as a NON-DESTRUCTIVE additional workspace layer —
// the native Writer, bubble/pill, outline drawer, auto-scroll and inline-AI all stay
// intact and unchanged. Bridging those legacy features TO Lexical (shared selection,
// outline nav, inline suggestions) is Phase 2+. For now the editor carries its own
// native formatting pill (LexicalBubble) and a Save action.

// Drop heavy base64 image bytes before crossing the DOM bridge — the editor shows
// image placeholders (fine for text editing) and, because the baseline uses the
// SAME stripped blocks, images produce no ops on save (the server keeps their bytes).
// Keep inlined image bytes so figures actually RENDER in the editor, but bound the
// total that crosses the DOM bridge — beyond the budget, drop the dataUri (the node
// falls back to the lazy media URL / placeholder). The server already only inlines
// small figures (<=~200KB each) as dataUri; large ones arrive with hasMedia + no
// dataUri. Deterministic (same input → same output) so the save baseline and the
// editor seed use identical blocks → images never produce spurious ops.
const INLINE_MEDIA_BUDGET = 4 * 1024 * 1024; // ~4MB of base64 across the bridge
// Same idea for a pending source-figure PREVIEW: one image, so a tighter budget.
const SUG_IMAGE_PREVIEW_BUDGET = 2 * 1024 * 1024;
function stripMedia(blocks: DocBlockDTO[]): DocBlockDTO[] {
  let budget = INLINE_MEDIA_BUDGET;
  return blocks.map((b) => {
    if (b.kind !== "image" || !b.dataUri) return b;
    if (b.dataUri.length <= budget) { budget -= b.dataUri.length; return b; }
    return { ...b, dataUri: undefined };
  });
}

// How many blocks may be swapped in place before a full reseed is the cheaper,
// safer answer. A restyle from the bubble tools touches one block; the AI's table
// tools a handful. Beyond that the document really did change shape.
const MAX_INPLACE_PATCH = 12;

/**
 * Which blocks a doc change can be applied to IN PLACE — the reseed-free path.
 *
 * A reseed rebuilds EVERY node in the WebView (plus a repagination from scratch and
 * a history clear). On a real thesis that is seconds, and a table restyle used to
 * pay it TWICE: once for the optimistic patch, once for the server echo. Yet all
 * that actually changed was one table's fills. Structural blocks (table / chart /
 * figure / textbox) are opaque decorator nodes whose entire state is their DTO, so
 * swapping the DTO repaints exactly that block — see $patchBlockData.
 *
 * Returns the blocks to swap ([] = the docs are equivalent, do nothing), or null
 * when the change needs a real reseed:
 *  - the block COUNT or the index/kind at any position moved (structure changed);
 *  - a PARAGRAPH changed — it lives in a real editable Lexical node, not a
 *    decorator, and its text/runs/level are the editor's own state;
 *  - more than MAX_INPLACE_PATCH blocks differ.
 * Most positions settle on the reference check: applyOpToDoc shallow-copies, so an
 * optimistic patch shares every untouched block object. A server echo is all fresh
 * objects and pays one structural compare per block — still far below the rebuild
 * it replaces.
 */
function inPlacePatch(prev: DocBlockDTO[], next: DocBlockDTO[]): DocBlockDTO[] | null {
  if (prev.length !== next.length) return null;
  const out: DocBlockDTO[] = [];
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (a.index !== b.index || a.kind !== b.kind) return null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a.kind === "paragraph") return null;
    if (out.length >= MAX_INPLACE_PATCH) return null;
    out.push(b);
  }
  return out;
}

// Build the display-only chrome bands (section header / footer / section-break) that
// $blocksToLexical interleaves into the editor tree by BLOCK INDEX. One "section"
// marker before each section after the first, a "top" band for a section header, and
// a "bottom" band for a footer anchored at the section's LAST block index (so it
// renders after that block). Text is baked native-side (the DOM bundle has no i18n).
function buildChrome(
  sections: DocSectionDTO[] | undefined,
  blocks: DocBlockDTO[],
  rtl: boolean,
  t: (k: string, o?: Record<string, unknown>) => string,
  /**
   * The page view supersedes ALL of this chrome, so when it is on none of it is
   * built. The header and footer bands become literal duplicates — the page view
   * draws the real ones at the top and foot of every page. The `§ New section
   * starts here` marker goes too: a section break is already visible as the page
   * boundary it produces, and showing both reads as two different things
   * happening in the same place.
   */
  pagesOn: boolean,
): ChromeData[] {
  if (pagesOn) return [];
  if (!sections || sections.length === 0 || blocks.length === 0) return [];
  const lastIdx = blocks[blocks.length - 1].index;
  const out: ChromeData[] = [];
  sections.forEach((s, si) => {
    const nextStart = sections[si + 1]?.startBlockIndex ?? lastIdx + 1;
    if (si > 0) {
      out.push({ kind: "section", sectionIndex: si, startBlockIndex: s.startBlockIndex, text: "",
        label: t("workspace.hf.newSectionHere", { defaultValue: "New section" }), rtl });
    }
    if (sectionPrints(s, "top")) {
      out.push({ kind: "top", sectionIndex: si, startBlockIndex: s.startBlockIndex, text: s.header!.text,
        label: t("workspace.hf.topOfPage", { defaultValue: "Top of every page" }), rtl,
        segments: s.header!.segments, border: s.header!.border });
    }
    if (sectionPrints(s, "bottom") && s.footer) {
      const bottomText = s.footer.text || t("workspace.hf.pageNumberValue", { defaultValue: "page number" });
      out.push({ kind: "bottom", sectionIndex: si, startBlockIndex: Math.max(s.startBlockIndex, nextStart - 1),
        text: bottomText, label: t("workspace.hf.bottomOfPage", { defaultValue: "Bottom of every page" }), rtl });
    }
  });
  return out;
}

/** Everything the DOM editor needs to paginate, all serializable. Strings are
 *  localized HERE because t() cannot cross the 'use dom' boundary. */
export type PageSetup = {
  sections: (PageSectionInput & {
    /** Why the page is unnumbered, so the gutter can NAME it correctly.
     *  null when the page is numbered normally. */
    unnumberedKind: "divider" | "ornament" | null;
    /** Word centres this section's content in the MIDDLE of the page
     *  (`w:vAlign="center"` in its sectPr) instead of stacking it from the top.
     *  A chapter divider is exactly this — see buildPageSetup. */
    verticalCenter: boolean;
    textColumnPx: number;
    contentHeightPx: number;
    startsOnNewPage: boolean;
    header: { text: string; segments: string[]; border: { bottom: boolean; color: string | null } | null } | null;
    footer: { text: string; hasPageNumbers: boolean } | null;
    /** Artwork painted behind every page of this section — a decorative cover
     *  frame lives in the header part. Empty for the overwhelming majority of
     *  sections. Only drawings with bytes to draw survive into this list. */
    headerDrawings: ChromeDrawingDTO[];
    /** This section's page geometry as chrome placement needs it (page edges and
     *  the header distance, which `contentHeightPx` alone cannot give). */
    chromeGeo: ChromePageGeometry;
  })[];
  /** "p. {n}" with {n} substituted by the DOM side. */
  gutterNumberTemplate: string;
  /** Names an unnumbered page in the gutter, e.g. "divider page". */
  gutterDividerLabel: string;
  gutterOrnamentLabel: string;
  rtl: boolean;
  /** Effective typography per BLOCK INDEX — what the measuring host paginates
   *  with. null for anything that is not a paragraph (a table, an image) or for
   *  a paragraph from a cache predating the field: those keep the legacy
   *  measurement path. Doubles as the splittable flag on the DOM side — a block
   *  with typography IS a paragraph, and only paragraphs split across pages. */
  blockFmts: (BlockFmt | null)[];
  /** Block indices Word would not leave at the bottom of a page: headings carry
   *  keep-with-next in every built-in style. */
  keepWithNext: number[];
  /** Block indices whose picture is CENTRED ON THE PAGE vertically — a floating
   *  drawing with `positionV relativeFrom="page"` and `align: center`, which is
   *  what set_image_layout writes for "I want the image in the middle of the
   *  page". Word does not lay these out in the flow at all, so the paginator
   *  moves half the page's leftover room ABOVE the block; without that the app
   *  drew the picture hard against the top of the page while Word centred it,
   *  and the student saw nothing happen. */
  pageCentered: number[];
};

/**
 * Per-section geometry for placing FLOATING shapes (`DocBlockDTO.anchors`), in
 * DOCUMENT px. Deliberately NOT part of buildPageSetup: a chapter divider's
 * title must show whether or not the student has the page view turned on, and
 * however large the document is.
 *
 * `startMarginPx` is the margin on the INLINE-START side — the right margin in
 * an RTL thesis — because the overlay places shapes with `inset-inline-start`.
 * Only `x.from: "page"` reads it.
 */
function buildAnchorGeometry(
  sections: DocSectionDTO[] | undefined,
  rtl: boolean,
): AnchorSectionGeometry[] {
  if (!sections || sections.length === 0) return [];
  return sections.map((s) => {
    const m = s.page?.margins;
    const startTwips = (rtl ? m?.right : m?.left) ?? 1440;
    return {
      startBlockIndex: s.startBlockIndex,
      textColumnPx: geometryFromSection(s.page).textColumnPx,
      startMarginPx: (startTwips * 96) / 1440,
    };
  });
}

function buildPageSetup(
  sections: DocSectionDTO[] | undefined,
  blocks: DocBlockDTO[],
  rtl: boolean,
  t: (k: string, o?: Record<string, unknown>) => string,
): PageSetup | null {
  if (!sections || sections.length === 0) return null;
  return {
    blockFmts: blocks.map((b) => (b.kind === "paragraph" ? b.fmt ?? null : null)),
    keepWithNext: blocks.flatMap((b, i) => (b.kind === "paragraph" && b.level > 0 ? [i] : [])),
    // A picture Word centres on the PAGE, not in the flow. Read off the block's
    // own anchors: set_image_layout floats the drawing and writes
    // positionV relativeFrom="page" align="center", which arrives here as
    // `y: { from: "page", align: "center" }`.
    pageCentered: blocks.flatMap((b, i) =>
      (b as { anchors?: AnchoredShape[] }).anchors?.some((a) => a.y.from === "page" && a.y.align === "center")
        ? [i]
        : [],
    ),
    sections: sections.map((s) => {
      const g = geometryFromSection(s.page);
      return {
        startBlockIndex: s.startBlockIndex,
        // A divider page and an ornamented front-matter page carry no number by
        // design — the paper shows nothing and the gutter names them instead.
        unnumbered: !!s.dividerPage || !!s.pageOrnament,
        unnumberedKind: s.dividerPage ? "divider" : s.pageOrnament ? "ornament" : null,
        // A divider's own section always carries `w:vAlign="center"` — the
        // server sets it on every one it builds (`setSectionVerticalAlign` in
        // the server's mcp/divider-pages.ts), and that is the requirement that
        // named the feature: the title sits in the true middle of the page.
        // The DTO carries no vAlign of its own, so the divider flag stands in
        // for it. Deliberately NOT extended to an ornamented front-matter page:
        // add_page_ornament centres one only when the student asks
        // (`verticalCenter`, default off), and assuming it would move a
        // dedication the student left at the top of the page.
        verticalCenter: !!s.dividerPage,
        pageNumberStart: s.footer?.pageNumbers?.startAt ?? null,
        pageNumberFormat: s.footer?.pageNumbers?.format ?? "decimal",
        textColumnPx: g.textColumnPx,
        contentHeightPx: g.contentHeightPx,
        startsOnNewPage: !!s.startsOnNewPage,
        header: s.header
          ? { text: s.header.text, segments: s.header.segments, border: s.header.border }
          : null,
        footer: s.footer ? { text: s.footer.text, hasPageNumbers: !!s.footer.pageNumbers } : null,
        // Only anchored artwork belongs behind the page. An INLINE picture in a
        // header (a university logo in the running head) sits in the header's own
        // text flow, which the band renders — painting it over the page as well
        // would double it.
        headerDrawings: (s.header?.drawings ?? []).filter((d) => d.anchored && !!d.dataUri),
        chromeGeo: chromeGeometryFromSection(s.page),
      };
    }),
    gutterNumberTemplate: t("workspace.pages.gutterPage", { defaultValue: "p. {{n}}" }),
    gutterDividerLabel: t("workspace.pages.dividerPage", { defaultValue: "divider page" }),
    gutterOrnamentLabel: t("workspace.pages.frontMatterPage", { defaultValue: "unnumbered page" }),
    rtl,
  };
}

export function WorkspaceLexicalView({
  thesisId,
  blocks,
  rtl,
  active,
  deepLinkBlock,
}: {
  thesisId: string;
  blocks: DocBlockDTO[];
  rtl: boolean;
  active: boolean;
  /**
   * The block this screen was OPENED ON — a reference tapped in a chat answer,
   * or a heading tapped in the thesis details outline. Present only for that
   * entry; null when the student just opened the writer.
   */
  deepLinkBlock?: number | null;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const baselineRef = useRef<DocBlockDTO[]>(stripMedia(blocks));
  const [seed, setSeed] = useState<DocBlockDTO[]>(baselineRef.current);
  const [seedNonce, setSeedNonce] = useState(0);
  // In-place reconcile trigger (surgical reseed — no remount) for external edits.
  const [reseed, setReseed] = useState<{ blocks: DocBlockDTO[]; chrome?: ChromeData[]; nonce: number } | undefined>(undefined);
  const reseedNonce = useRef(0);
  // Commands (formatting from the native pill + our own serialize) flow through the
  // shared editor store so BlockContextBar can drive Lexical directly.
  const command = useLexicalEditorStore((s) => s.command);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const pendingSave = useRef(false);
  const wasActive = useRef(active);
  // For anchoring the native pill/AI-dock over the WebView: the editor's absolute
  // screen top + the block's reported in-WebView Y = the block's screen Y.
  const wrapRef = useRef<View>(null);
  const editorTopRef = useRef(0);
  // Dedupe the native selection sync on the SET of spanned block indices (joined),
  // not the anchor index — extending a cross-paragraph selection keeps the same
  // anchor while the set grows, so an anchor-only guard would miss the growth.
  const lastSelKeyRef = useRef<string>("");
  // Focused block index + its in-WebView Y — used to overlay the inline-AI suggestion.
  const focusRef = useRef<{ index: number; y: number }>({ index: -1, y: 0 });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // The block this entry was opened ON, while it is still in charge of where we
  // land. Declared up here because both the scroll reporter (which retires it) and
  // the restore trigger (which honours it) need it; the reasoning is at
  // `triggerRestore` below.
  const deepLinkRef = useRef<number | null>(deepLinkBlock ?? null);
  useEffect(() => {
    deepLinkRef.current = deepLinkBlock ?? null;
  }, [deepLinkBlock]);

  // Scroll persistence: remember where the user left off so re-entering the editor
  // (or returning from a Preview) lands there instead of at the top. The editor is
  // re-keyed on `seedNonce`, so capture the anchor to restore at each (re)seed; the
  // store (module-level, not reset on workspace-leave) holds it across screen exits.
  const lastScrollY = useRef(0);
  const onScroll = useCallback((a: ScrollAnchor) => {
    // Reporting is gated off while a jump settles, so this is the student moving
    // under their own steam: a deep link that brought them here has done its job,
    // and from now on it's the reading position that should be restored.
    deepLinkRef.current = null;
    useEditorScrollStore.getState().save(thesisId, a);
    // Auto-hide the top-bar + dock on scroll (issue #6): hide on scroll DOWN past a
    // small threshold, show on scroll UP or near the top. setChromeVisible no-ops when
    // unchanged, so this only re-renders on a flip.
    const y = a.y;
    const prev = lastScrollY.current;
    lastScrollY.current = y;
    // IGNORE scrolls while the keyboard is up: opening/closing it reflows the WebView
    // and fires large spurious deltas, and the resulting chromeVisible re-renders
    // INSIDE the KeyboardAvoidingView break its height restore — the whole page stayed
    // shifted up (with a bottom gap) after a keyboard cycle. Only genuine reading
    // scrolls (keyboard down) drive the auto-hide.
    if (Keyboard.isVisible()) return;
    const ws = useWorkspaceStore.getState();
    if (y <= 24) ws.setChromeVisible(true);
    else if (y - prev > 8) ws.setChromeVisible(false);
    else if (prev - y > 8) ws.setChromeVisible(true);
  }, [thesisId]);
  // Restore is nonce-driven, not mount-driven: inside a native-stack the WebView can
  // reset to the top on re-focus WITHOUT remounting the React tree, so a mount-only
  // restore would never re-fire. `restoreTargetRef` captures the good anchor at the
  // moment we LEAVE (blur / preview) so the fresh view's top-position poll can't
  // overwrite it before we restore. `triggerRestore` bumps the nonce → DOM re-anchors.
  const [scrollRestore, setScrollRestore] = useState<{ anchor: ScrollAnchor; nonce: number } | null>(null);
  const restoreTargetRef = useRef<ScrollAnchor | null>(useEditorScrollStore.getState().get(thesisId));
  const restoreNonce = useRef(0);
  // "Where you left off" and "the place you just tapped a link to" are two answers
  // to the same question, and only one of them can win. A deep link is an EXPLICIT
  // destination — the student asked for THAT paragraph — so for that entry it
  // REPLACES the saved position as the anchor to land on.
  //
  // Replacing rather than merely suppressing is what makes the jump land. The
  // workspace also fires a plain scroll request for the same block, but that is a
  // single scrollIntoView: on a cold open of a long document the page is still
  // laying out under it, so it lands short. The anchor path re-applies itself
  // until layout stops growing (see ScrollSyncPlugin), which is precisely the
  // problem a cold deep link has.
  //
  // It stays in charge until one of two things ends the entry, because restore has
  // several triggers (screen focus, the persisted map finishing its async
  // rehydration) and a late one would yank the reader off the block they came to
  // see: the student scrolling — they have arrived and moved on — or a Preview
  // round-trip, after which the reading position is again the right thing to
  // return to.
  //
  // Loading overlay while the (re)loaded WebView renders this large doc and scrolls
  // to the saved block — otherwise the user watches it load at the top and jump down.
  // Start covered if we already know we'll restore to a non-top position on mount.
  // A deep link never shows it: the student is arriving somewhere they asked for,
  // and the workspace already masks that jump with its own navigation overlay —
  // "Restoring your place…" over it names the wrong thing entirely.
  const initTarget = restoreTargetRef.current;
  const [restoring, setRestoring] = useState<boolean>(
    deepLinkBlock == null && !!initTarget && initTarget.index > 2,
  );
  const triggerRestore = useCallback(() => {
    const deep = deepLinkRef.current;
    const a: ScrollAnchor | null =
      deep != null
        ? { y: 0, index: deep, delta: 0 } // land the block at the top of the viewport
        : restoreTargetRef.current ?? useEditorScrollStore.getState().get(thesisId);
    if (!a || a.index < 0) return;
    setScrollRestore({ anchor: a, nonce: ++restoreNonce.current });
    if (deep == null && a.index > 2) setRestoring(true); // cover the reload + scroll-to-block
  }, [thesisId]);
  // The DOM reached the target (or the user scrolled) → reveal the editor.
  const onScrollRestored = useCallback(() => { setRestoring(false); }, []);
  const captureRestoreTarget = useCallback(() => {
    const a = useEditorScrollStore.getState().get(thesisId);
    if (a && a.index >= 0) restoreTargetRef.current = a;
  }, [thesisId]);
  // Safety: whenever the overlay is up, force it down after 6s (beyond the DOM's own
  // settle cap) so a missed onScrollRestored (dead bridge, no target) can't leave it
  // stuck. Normally the DOM fires onScrollRestored once the scroll actually lands.
  useEffect(() => {
    if (!restoring) return;
    const id = setTimeout(() => setRestoring(false), 7000);
    return () => clearTimeout(id);
  }, [restoring]);
  // The saved position is persisted (AsyncStorage) so it survives an app reload/quit,
  // but rehydration is async — if the workspace mounts before it finishes (e.g. a
  // reload while already here), the focus trigger read nothing. Re-trigger once the
  // persisted map has hydrated.
  useEffect(() => {
    const p = useEditorScrollStore.persist;
    if (p.hasHydrated()) return;
    return p.onFinishHydration(() => triggerRestore());
  }, [triggerRestore]);

  // SYNC LAYER (block model → Lexical): subscribe to this thesis's doc in the
  // store. When it changes because of something OTHER than our own save — the
  // native pill/BlockContextBar, the AI dock (Ask/Improve/Translate), undo/redo —
  // re-seed Lexical so those edits show up here too. `syncedDocRef` tracks the doc
  // Lexical currently matches, so our own save (setDoc) never triggers a reseed.
  const doc = useThesisDocStore((s) => s.byId[thesisId]);
  const syncedDocRef = useRef<DocumentDTO | undefined>(undefined);
  const inited = useRef(false);
  // Global view toggle (from the ✦ dock): show/hide the document-structure indicators
  // (header/footer bands + section markers). Off → no bands, a clean writing view.
  const showChrome = useWorkspaceStore((s) => s.showChrome);
  // Global view toggle (from the ✦ dock "Show pages" chip): the Word-like paginated
  // page view — paper, running headers, page numbers. Also the escape hatch if a
  // device paginates badly.
  const showPages = useWorkspaceStore((s) => s.showPages);
  // Global view toggle (from the ✦ dock "Reorder" pill): arms the gutter-handle
  // one-finger drag-to-reorder gesture in the DOM editor.
  const reorderMode = useWorkspaceStore((s) => s.reorderMode);
  // Global view toggle (from the ✦ dock "Select" chip): a leading checkbox on every
  // block, tap-to-toggle, editor read-only — replaces the OS text-selection drag as
  // the way to build a multi-block selection.
  const selectMode = useWorkspaceStore((s) => s.selectMode);
  // The checkboxes drive the selection without going through onState, so the
  // dedupe key it guards on goes stale while the mode is on: leaving the mode and
  // re-tapping the last block the CARET was on would otherwise match the stale key
  // and skip the re-select (no pill). Clearing it on every mode flip re-arms it.
  useEffect(() => { lastSelKeyRef.current = ""; }, [selectMode]);
  // Block-editing keyboard mode (issue #6): drives the editor's inputmode so a tap
  // selects a block WITHOUT opening the OS keyboard while inactive.
  const keyboardActive = useWorkspaceStore((s) => s.keyboardActive);
  // Display-only section chrome bands, interleaved into the initial seed (below) by
  // block index. Reseeds rebuild their own chrome from the reseeded blocks/sections.
  // Serializable pagination input for the DOM side (Task 10 consumes it). null when
  // the student has turned pages off, or the document is too large to paginate
  // pleasantly — either way the DOM side's pagination plugin dropAll()s.
  const pageSetup = useMemo(
    () => {
      if (!showPages) return null;
      // A very large document paginates too slowly to be pleasant; the student
      // can still turn pages on explicitly from the ✦ dock.
      if (blocks.length > 4000) return null;
      return buildPageSetup(doc?.available ? doc.sections : undefined, blocks, rtl, t);
    },
    [showPages, doc, blocks, rtl, t],
  );
  // Geometry for the floating-shape overlay (a divider page's chapter title).
  // Unconditional — anchors are not part of the page view.
  const anchorGeometry = useMemo(
    () => buildAnchorGeometry(doc?.available ? doc.sections : undefined, rtl),
    [doc, rtl],
  );
  const chrome = useMemo(
    () => (showChrome ? buildChrome(doc?.available ? doc.sections : undefined, blocks, rtl, t, !!pageSetup) : []),
    [showChrome, doc, blocks, rtl, t, pageSetup],
  );
  // Auth token for loading LARGE figures in the WebView (via <img src>?token=). The
  // server accepts the token query param; refreshed on doc change (freshness).
  const [mediaToken, setMediaToken] = useState("");
  useEffect(() => {
    let alive = true;
    getAuthHeader().then((h) => { if (alive) setMediaToken((h.Authorization ?? "").replace(/^Bearer\s+/, "")); }).catch(() => {});
    return () => { alive = false; };
  }, [doc]);
  // The store's `tick` bumps on every reconcile (setDoc) — including an image edit
  // that keeps the same block count (crop/rotate/replace). Use it as the media
  // cache-buster so an edited figure's URL changes and the WebView <img> refetches.
  const docTick = useThesisDocStore((s) => s.tick[thesisId] ?? 0);
  const media = useMemo(
    () => ({ base: process.env.EXPO_PUBLIC_API_URL ?? "", token: mediaToken, thesisId, version: docTick }),
    [mediaToken, thesisId, docTick],
  );
  // Document-search hits → tint them (+ the current one) in the editor. Primitive
  // selectors (no fresh-object loop); the array ref is stable until setMatches.
  const searchOpen = useSearchStore((s) => s.open);
  const searchMatches = useSearchStore((s) => s.matches);
  const searchCurrent = useSearchStore((s) => s.current);
  const search = useMemo(
    () =>
      searchOpen && searchMatches.length
        ? { matches: searchMatches.map((m) => ({ blockIndex: m.blockIndex, start: m.start, end: m.end })), current: searchCurrent }
        : undefined,
    [searchOpen, searchMatches, searchCurrent],
  );
  // Outline-drawer navigation target (heading tapped in the Structure drawer).
  const scrollTarget = useWorkspaceStore((s) => s.scrollTarget);
  // Header/footer sheet: which band to bring into view, and a nonce that re-fires it.
  // The sheet covers the lower two-thirds of the screen, so the band being edited has
  // to be scrolled up into what's left — otherwise the student can't see what changes.
  const hfRegion = useHfSheetStore((s) => s.region);
  const hfIndex = useHfSheetStore((s) => s.index);
  const hfRevealNonce = useHfSheetStore((s) => s.revealNonce);
  // Live band preview — a template / AI proposal drawn on the real band before it's
  // applied. Display-only: chrome bands are excluded from the block model, so this can
  // never reach a save.
  const hfPreview = useHfSheetStore((s) => s.preview);
  // Where in the visible strip the band should land. Aligning it to the very top parks
  // it half under the status bar (the sheet's app-recede transform shifts the whole app
  // up), so aim for a bit under half of whatever the sheet leaves uncovered.
  const hfRevealOffset = Math.round(Dimensions.get("window").height * (1 - HF_SHEET_FRACTION) * 0.45);
  // Persistent highlight for a MULTI-block selection: once the OS text selection is
  // dismissed (e.g. the AI dock opens), keep the chosen blocks visibly marked in the
  // editor. Only for multi-select — a single selected block is the caret/editing case
  // and shouldn't be painted. Primitive subscriptions (no fresh-object selector loop).
  const selectedBlocks = useWorkspaceStore((s) => s.selectedBlocks);
  const multiSelect = useWorkspaceStore((s) => s.multiSelect);
  // Inline-AI: the pending AI proposal (if any) to render as an in-flow node in
  // Lexical. Select the STABLE byIndex ref (a fresh-object selector loops — see
  // the zustand Object.is trap) and derive the proposal in useMemo.
  const byIndex = useSuggestionStore((s) => s.byIndex);
  const range = useSuggestionStore((s) => s.range);
  // Inline AI autocomplete (ghost text): primitive selectors (no fresh-object loop —
  // see the zustand Object.is trap), derive the editor's `completion` prop in useMemo.
  const completionEnabled = useAutocompleteAllowed();
  const compIndex = useCompletionStore((s) => s.index);
  const compText = useCompletionStore((s) => s.text);
  const compStatus = useCompletionStore((s) => s.status);
  const compNonce = useCompletionStore((s) => s.nonce);
  const completion = useMemo(
    () => (compIndex >= 0 ? { text: compText, nonce: compNonce, status: compStatus, index: compIndex } : undefined),
    [compIndex, compText, compStatus, compNonce],
  );
  const suggestion = useMemo(() => {
    const keys = Object.keys(byIndex);
    if (!keys.length) return null;
    const idx = Number(keys[0]);
    const p = byIndex[idx];
    return {
      index: idx,
      original: p.original,
      proposed: p.proposed,
      status: p.status as string,
      instruction: p.instruction,
      label: p.label,
      reasoning: p.reasoning,
      reasoningMs: p.reasoningMs,
      // action "insertTable" → the proposed grid is rendered as a table preview in
      // the inline card (SuggestionView) instead of proposed text.
      action: p.action as string,
      proposedRows: p.proposedRows,
      tableHeader: p.tableHeader,
      tableRtl: p.tableRtl,
      // action "insertSourceImage" → preview the figure copied from the student's
      // uploaded source (only the display URI crosses into the WebView; the bytes the
      // op inserts stay native). Oversized bytes don't cross the bridge at all — the
      // card falls back to a "figure ready" placeholder, and approve is unaffected.
      hasImage: !!p.image,
      imageDataUri:
        p.image && p.image.dataUri.length <= SUG_IMAGE_PREVIEW_BUDGET ? p.image.dataUri : undefined,
      imageWidth: p.image?.width,
      imageHeight: p.image?.height,
      // action "setChart" → the PROPOSED chart, rendered server-side as vector
      // source. Both SVGs cross the bridge as text (a few KB each), so the card can
      // show the new chart and peek at the one it replaces.
      chartSvg: p.chart?.svg,
      chartOriginalSvg: p.chart?.originalSvg,
      // A specific reason the ask couldn't be met (kind "none" / a failed image read),
      // shown on the error card in place of the generic line.
      errorText: p.errorText,
    };
  }, [byIndex]);
  // The range proposal (multi-block dynamic rewrite) passed to the editor as an
  // in-flow node covering the whole selected range.
  const rangeSuggestion = useMemo(() => {
    if (!range) return undefined;
    return {
      start: range.start,
      end: range.end,
      originalBlocks: range.originalBlocks,
      original: range.original,
      proposed: range.proposed,
      status: range.status as string,
      instruction: range.instruction,
      reasoning: range.reasoning,
      reasoningMs: range.reasoningMs,
    };
  }, [range]);
  const suggestionActiveRef = useRef(false);
  // Any pending proposal (per-block OR range) suppresses the sync-layer reseed and
  // the auto-save serialize, so the proposal isn't clobbered / serialized mid-flight.
  suggestionActiveRef.current = !!suggestion || !!range;
  // Persistent highlight for a MULTI-block selection: once the OS text selection is
  // dismissed (e.g. the AI dock opens), keep the chosen blocks visibly marked. Only
  // for multi-select, and NOT while a proposal is showing (the cards ARE the focus
  // then, and the range node has replaced those blocks). Primitive subscriptions.
  // In SELECT mode the checkbox + row tint already mark the chosen blocks, so this
  // second (OS-selection-mimicking) highlight would just double-paint them.
  const highlightIndices = useMemo(
    () =>
      multiSelect && !selectMode && selectedBlocks.length > 1 && !range && Object.keys(byIndex).length === 0
        ? selectedBlocks.map((b) => b.index)
        : [],
    [multiSelect, selectMode, selectedBlocks, range, byIndex],
  );
  // Which blocks the editor draws CHECKED. Unlike the highlight this includes a
  // single selected block — one checked box is a legitimate state here.
  const checkedIndices = useMemo(
    () => (selectMode ? selectedBlocks.map((b) => b.index) : []),
    [selectMode, selectedBlocks],
  );

  // A tapped equation → the native equation sheet, opened on THAT equation. An
  // equation is not text, so this is the only gesture that reaches one; the payload
  // is JSON because DOM component props are serializable only.
  //
  // The sheet then does the right thing either way: it UPDATES the equation it was
  // opened on, and if the block turns out to hold none it inserts one instead.
  const onEquationTap = useCallback((payload: string) => {
    try {
      const { index, math } = JSON.parse(payload) as { index: number; math: InlineMathDTO };
      const store = useEquationSheetStore.getState();
      if (math?.latex) {
        // The paragraph's own text on an equation line is its number, "(I.1)".
        const block = useThesisDocStore.getState().byId[thesisId];
        const line = block?.available ? block.blocks.find((b) => b.index === index) : undefined;
        store.openEdit({
          thesisId,
          index,
          latex: math.latex,
          number: line?.kind === "paragraph" ? line.text.trim() : "",
        });
      } else {
        // A legacy OLE equation has no readable LaTeX — nothing to open for editing,
        // so offer to write a real one after it rather than doing nothing.
        store.openInsert({ thesisId, index });
      }
    } catch {
      // A malformed payload must never take the writer down.
    }
  }, [thesisId]);

  // Approve/reject from the in-editor suggestion node → the native store (its
  // approve dispatches an editText op that flows back through the sync layer).
  const onSuggestAction = useCallback((action: string, text?: string) => {
    const store = useSuggestionStore.getState();
    const keys = Object.keys(store.byIndex);
    if (!keys.length) return;
    const idx = Number(keys[0]);
    if (action === "approve") {
      // Both text and table settle the node IN PLACE (skip the full reseed) so the
      // apply is INSTANT: the SuggestionPlugin clear path swaps the node for the
      // proposed text, or inserts the real table node + keeps the empty paragraph.
      // The op (editText / insertTable) syncs in the background; skipReseed updates
      // the save baseline to the optimistic doc so no spurious diff is sent.
      // ⚠️ NOT for a chart: text/table proposals settle the node in place, so the
      // editor already shows the applied result and a reseed would only churn. A
      // chart's new rendering exists only on the server (the SVG is produced there),
      // so it arrives via setDoc — skipping the reseed would leave the OLD chart on
      // screen after approving.
      if (store.byIndex[idx]?.action !== "setChart") {
        useLexicalEditorStore.getState().requestSkipReseed();
      }
      store.approve(thesisId, idx);
    }
    else if (action === "again") void store.again(thesisId, idx);
    else if (action === "edit") { if (text) store.setProposed(idx, text); }
    else store.reject(idx);
  }, [thesisId]);

  // Inline AI autocomplete: the editor asks for a completion (debounced, on a pause);
  // we forward it to the completion store, which streams the continuation back as the
  // `completion` prop. Accept merges the ghost text into the block already, so we just
  // consume the resulting doc change silently (mirrors the suggestion approve path).
  const onRequestCompletion = useCallback(
    (ctx: { index: number; text: string }) => {
      // Boundary log: if this fires, the in-editor CompletionPlugin (WebView) reached
      // native across the DOM bridge. If typing never logs this, the trigger/bridge
      // is the issue (not the server). See [autocomplete] in the Metro console.
      console.log(`[autocomplete] onRequestCompletion (DOM→native) index=${ctx.index} textLen=${ctx.text.length}`);
      void useCompletionStore.getState().request(thesisId, ctx.index, ctx.text);
    },
    [thesisId],
  );
  const onCommitCompletion = useCallback(
    (index: number, fullText: string) => {
      // The editor already merged the ghost into the block in place — consume the
      // resulting doc change silently (no reseed / rebuild), mirroring suggestion approve.
      useLexicalEditorStore.getState().requestSkipReseed();
      useCompletionStore.getState().accept(thesisId, index, fullText);
    },
    [thesisId],
  );
  const onCancelCompletion = useCallback(() => { useCompletionStore.getState().cancel(); }, []);

  // One-time probe: proves the NEW autocomplete-wired Writer code is running in THIS
  // build. If you open the Writer and never see this line in Metro, the app is stale
  // (rebuild/reinstall the dev build, or fully quit + restart Metro and reload).
  useEffect(() => {
    console.log(`[autocomplete] Writer mounted — completionEnabled=${completionEnabled} thesis=${thesisId} active=${active}`);
  }, [completionEnabled, thesisId, active]);

  // Force-reseed the editor from the current (unchanged) stored doc — used when a
  // range proposal is REJECTED: the server never changed, so restore the editor to
  // the doc (the originals WITH their runs/alignment/direction), which the in-editor
  // plugin can't reconstruct from its plain-text capture.
  const reseedFromCurrentDoc = useCallback(() => {
    const cur = useThesisDocStore.getState().byId[thesisId];
    if (!cur?.available) return;
    const latest = stripMedia(cur.blocks);
    baselineRef.current = latest;
    syncedDocRef.current = cur;
    setReseed({ blocks: latest, chrome: useWorkspaceStore.getState().showChrome ? buildChrome(cur.sections, latest, rtl, t, !!pageSetup) : [], nonce: ++reseedNonce.current });
  }, [thesisId, rtl, t, pageSetup]);

  // Toggling the structure indicators reseeds the editor so the bands appear/disappear
  // in place (no remount → scroll + undo preserved). Skips the initial mount.
  //
  // ⚠️ Keyed on `showChrome` ALONE, and `reseedFromCurrentDoc` is read through a ref.
  // Listing the callback as a dependency looked harmless but leaked an identity chain
  // straight into this effect: it closes over `pageSetup`, `pageSetup` is a useMemo on
  // `doc`, and every auto-save ends in setDoc — so each sync minted a new doc, a new
  // pageSetup, a new callback, and this effect fired a FULL reseed the student never
  // asked for. They saw it as the document jumping back to the top a second after they
  // stopped typing (only with page view on: with it off `pageSetup` is a stable null,
  // which is why this survived until pages shipped). Rebuilding every node on every
  // pause was the cost even when the scroll happened to survive.
  const chromeToggleMount = useRef(true);
  const reseedRef = useRef(reseedFromCurrentDoc);
  reseedRef.current = reseedFromCurrentDoc;
  useEffect(() => {
    if (chromeToggleMount.current) { chromeToggleMount.current = false; return; }
    reseedRef.current();
  }, [showChrome]);

  // Approve/reject/again/edit from the in-editor RANGE node → the native store.
  // Approve applies the replace-range (server echoes the doc → the sync layer reseeds
  // it in); reject restores the originals via a reseed from the unchanged doc.
  const onRangeAction = useCallback((action: string, text?: string) => {
    const store = useSuggestionStore.getState();
    if (!store.range) return;
    if (action === "approve") void store.approveRange(thesisId, text);
    else if (action === "again") void store.againRange(thesisId);
    else if (action === "edit") { if (text) store.setRangeProposed(text); }
    else { store.rejectRange(); reseedFromCurrentDoc(); }
  }, [thesisId, reseedFromCurrentDoc]);

  const send = useCallback((type: string, value?: string) => {
    useLexicalEditorStore.getState().dispatch(type, value);
  }, []);
  const flushNow = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    pendingSave.current = true;
    send("serialize");
  }, [send]);

  // Waitable flush for callers about to act on the SERVER doc (the AI turn flushes
  // here BEFORE the op queue): serialize now and resolve when onBlocks finishes
  // (its save landed or turned out to be a no-op). The timeout is a bridge safety
  // net — a dead WebView must never hang an AI turn.
  const saveWaiters = useRef<(() => void)[]>([]);
  const flushEdits = useCallback((): Promise<void> => {
    if (!activeRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      saveWaiters.current.push(resolve);
      setTimeout(resolve, 4000);
      flushNow();
    });
  }, [flushNow]);
  useEffect(() => {
    useLexicalEditorStore.getState().registerFlushEdits(flushEdits);
    return () => useLexicalEditorStore.getState().registerFlushEdits(null);
  }, [flushEdits]);

  // Leaving the SCREEN (→ thesis details, export, back) — not just the Writer
  // layer — must sync too: the workspace stays mounted in the stack, so `active`
  // (previewMode-based) never flips and the leave-flush above doesn't fire.
  useFocusEffect(
    useCallback(() => {
      // Entering the screen (incl. fresh mount) → restore the last reading position.
      triggerRestore();
      return () => {
        if (activeRef.current) { flushNow(); captureRestoreTarget(); }
      };
    }, [flushNow, triggerRestore, captureRestoreTarget]),
  );

  // Re-seed from the latest server truth when the user ENTERS the Lexical view (so
  // it reflects edits made elsewhere), but never mid-session (that would clobber the
  // user's in-progress edits).
  useEffect(() => {
    if (active && !wasActive.current) {
      const cur = useThesisDocStore.getState().byId[thesisId];
      const latest = cur?.available ? stripMedia(cur.blocks) : stripMedia(blocks);
      baselineRef.current = latest;
      setSeed(latest);
      setSeedNonce((n) => n + 1);
      syncedDocRef.current = cur;
      // Re-keying the editor resets the WebView to the top → re-anchor to the
      // position saved before we left the Writer (e.g. to open a Preview).
      triggerRestore();
    } else if (!active && wasActive.current) {
      // Leaving the Writer for a Preview ends the deep link's claim: coming back
      // should land where the student was reading, not back at the linked block.
      deepLinkRef.current = null;
      captureRestoreTarget(); // remember where we were before the preview round-trip
      flushNow(); // leaving the Writer (e.g. opening a preview) → flush edits
      useCompletionStore.getState().cancel(); // don't leave a pending/showing completion behind
      useInsertMenuStore.getState().close(); // don't leave a stale /insert menu across a Preview round-trip
    }
    wasActive.current = active;
  }, [active, thesisId, blocks, flushNow, triggerRestore, captureRestoreTarget]);

  // Turning the autocomplete setting OFF mid-session should clear any showing/loading
  // completion immediately (not just gate future requests).
  useEffect(() => {
    if (!completionEnabled) useCompletionStore.getState().cancel();
  }, [completionEnabled]);

  // App going to background = the user stopped composing → flush (no local
  // durability for Lexical edits, so this matters).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st !== "active" && activeRef.current) flushNow();
    });
    return () => sub.remove();
  }, [flushNow]);

  // Tell the shared editor store whether the Lexical Writer is the active surface,
  // so the native pill routes formatting to Lexical (vs the legacy op queue).
  useEffect(() => {
    useLexicalEditorStore.getState().setActive(active);
    return () => useLexicalEditorStore.getState().setActive(false);
  }, [active]);

  // Reflect external edits (native pill/BlockContextBar, AI dock, undo/redo) into
  // Lexical by re-seeding — but never over the user's unsaved typing, and never
  // from our own save (guarded by syncedDocRef).
  useEffect(() => {
    if (!inited.current) { inited.current = true; syncedDocRef.current = doc; return; }
    if (!active || doc === syncedDocRef.current) return;
    // Single-block pill/approve applied the edit IN PLACE — consume the doc change
    // silently (sync baseline/synced) without re-seeding, so it doesn't rebuild every
    // node + scroll away. Checked FIRST so an ordering race can't leave it stuck.
    if (useLexicalEditorStore.getState().consumeSkipReseed()) {
      if (doc?.available) baselineRef.current = stripMedia(doc.blocks);
      syncedDocRef.current = doc;
      return;
    }
    // A DELIBERATE authoritative apply (range-rewrite approve) forces the reseed:
    // bypass the pending-save + proposal guards and CANCEL any stale debounced save,
    // so the applied doc always lands (the pending save would otherwise fire against a
    // stale baseline and revert it). Normal external changes still yield to a pending
    // save / an on-screen proposal.
    const forced = useLexicalEditorStore.getState().consumeForceReseed();
    if (forced) {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; pendingSave.current = false; }
    } else {
      if (saveTimer.current) return;
      if (suggestionActiveRef.current) return;
    }
    if (doc?.available) {
      const latest = stripMedia(doc.blocks);
      // Restyle-only change (a table's fills/borders, a re-rendered chart, a swapped
      // figure)? Swap those blocks' DTOs in the live tree instead of rebuilding it.
      // This is the whole difference between a tap that lands now and one the
      // student waits seconds for — and the tapped block keeps its selection, so the
      // bubble toolbar they are still holding open doesn't close under them.
      //
      // Requires the chrome to be unchanged too: the bands are interleaved into the
      // tree at seed time, so a section edit has to go the long way round.
      const prev = syncedDocRef.current;
      const sameSections =
        !!prev?.available && JSON.stringify(prev.sections) === JSON.stringify(doc.sections);
      const patch = forced || !sameSections ? null : inPlacePatch(baselineRef.current, latest);
      if (patch) {
        baselineRef.current = latest;
        syncedDocRef.current = doc;
        if (patch.length > 0) send("patchBlocks", JSON.stringify(patch));
        return;
      }
      baselineRef.current = latest;
      syncedDocRef.current = doc;
      // in-place, no remount — rebuild the chrome bands from this same reseeded doc.
      setReseed({ blocks: latest, chrome: useWorkspaceStore.getState().showChrome ? buildChrome(doc.sections, latest, rtl, t, !!pageSetup) : [], nonce: ++reseedNonce.current });
    }
  }, [doc, active, rtl, t, pageSetup, send]);

  // Auto-sync (no manual Save): the Writer ALWAYS saves to the server shortly
  // after the user pauses. (Debounced, because Lexical edits — unlike the durable
  // op-queue — aren't in SQLite, so this pause-save is the only thing that stops
  // work being lost if the app is backgrounded/killed. There is no local-first
  // path here: skipping the save left edits nowhere, so they died on restart.)
  const scheduleSave = useCallback(() => {
    if (suggestionActiveRef.current) return; // a pending AI proposal is in the editor — don't serialize it
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; pendingSave.current = true; send("serialize"); }, 1500);
  }, [send]);

  // Bridge Lexical's selection to the NATIVE tools + report the block's live format
  // (so the pill's Bold/H2/RTL/centered highlights match the caret) + schedule sync.
  const onState = useCallback((s: LexicalState) => {
    // In-editor history availability rides every report (incl. index:-1 ones from
    // the CAN_UNDO/CAN_REDO transition pings) — feed the dock/header buttons.
    if (s.canUndo !== undefined || s.canRedo !== undefined) {
      useLexicalEditorStore.getState().setHistoryAvail(!!s.canUndo, !!s.canRedo);
    }
    scheduleSave();
    if (s.index < 0) return;
    // A Word chrome band (section header / footer / section-break marker) reports with
    // blockType "chrome:*" and index = the section's START block index. Park it in the
    // dedicated chrome slot and CLEAR the normal block selection — otherwise the
    // block-selection path below would wrongly select the paragraph at that index.
    if (s.blockType && s.blockType.startsWith("chrome:")) {
      const kind = s.blockType.slice("chrome:".length) as ChromeKind;
      const ws = useWorkspaceStore.getState();
      // Enrich from doc.sections so the bubble's tools get the ACTUAL header/footer
      // text (not the "page number" display placeholder) + the footer's page-number
      // state. The band's index is a block INSIDE its section (a footer band anchors
      // to the section's LAST block), so find the containing section by range.
      const curDoc = useThesisDocStore.getState().byId[thesisId];
      const sec = sectionAt(curDoc?.available ? curDoc.sections : undefined, s.index);
      const text =
        kind === "top" ? sec?.header?.text ?? s.text : kind === "bottom" ? sec?.footer?.text ?? "" : s.text;
      const pageNumbers = kind === "bottom" ? !!sec?.footer?.pageNumbers : undefined;
      // Section-break band carries the Link-to-Previous + starts-on-new-page state
      // so the bubble's section toolset can render the toggles.
      const linkedToPrevious = kind === "section" ? sec?.linkedToPrevious ?? null : undefined;
      const startsOnNewPage = kind === "section" ? sec?.startsOnNewPage : undefined;
      // Top band: the header's positioned segments so Edit-text shows the parts apart.
      const segments = kind === "top" ? sec?.header?.segments : undefined;
      // Section band only: does this section already show a header / footer band?
      // The same rule the bands themselves draw by, so "Add" appears exactly when
      // nothing is printed on that edge — an inherited header counts as present, an
      // emptied one (a removal) does not.
      const hasHeader = kind === "section" ? sectionPrints(sec, "top") : undefined;
      const hasFooter = kind === "section" ? sectionPrints(sec, "bottom") : undefined;
      // A running header / footer band opens the BOTTOM SHEET, not the floating bubble:
      // its whole toolset is the ✦ flow (instruction, compiled preview, template cards),
      // which never fitted in a pill hovering over the page. The bubble still owns the
      // section-break band, whose actions are all one-tap.
      if (kind === "top" || kind === "bottom") {
        ws.setChromeSelection(null);
        ws.clearSelection();
        // The tap may have landed on a page's BARE margin — in the page view every
        // page edge is tappable, including the ones with nothing printed on them
        // (that is the only way in for a section that has no header/footer at all).
        // There is no band to edit in that case, so offer to CREATE that one part
        // instead: openAdd scoped to the side that was touched, whose row lands
        // straight back in this editor once the part exists. An emptied part counts
        // as nothing to edit — see sectionPrints.
        if (!sectionPrints(sec, kind)) {
          useHfSheetStore.getState().openAdd({
            thesisId,
            index: s.index,
            hasHeader: kind !== "top",
            hasFooter: kind !== "bottom",
          });
          return;
        }
        useHfSheetStore.getState().openBand({
          thesisId,
          index: s.index,
          region: kind === "top" ? "header" : "footer",
          text,
        });
        return;
      }
      ws.setChromeSelection({ kind, index: s.index, text, pageNumbers, linkedToPrevious, startsOnNewPage, segments, hasHeader, hasFooter });
      ws.clearSelection();
      useLexicalEditorStore.getState().setFormat({
        bold: false, italic: false, underline: false,
        blockType: s.blockType, isRTL: s.isRTL, alignment: s.alignment,
      });
      if (typeof s.y === "number" && s.y >= 0) {
        useFloatingPillStore.getState().setAnchorY(editorTopRef.current + s.y);
      }
      return;
    }
    // ── SELECT MODE OWNS THE SELECTION ──
    // While checkbox select is on, the store is the ONLY writer of the pick and
    // this report must not touch it. A tap on a row still reaches the browser: the
    // editor is read-only and the rows are user-select:none, but the tap collapses
    // the DOM selection anyway, Lexical turns that into an update, and EditorBridge
    // faithfully reports the tapped block. The sync below would then REPLACE the
    // whole pick with that one block — so every checkbox landed, and was instantly
    // undone. That is the reported "I cannot select more than 1 paragraph": tap A
    // gives [A], tap B toggles to [A,B] and the report immediately cuts it to [B].
    // Always exactly one, always the last one touched.
    //
    // The phantom-collapse guard below cannot cover this. It only fires when the
    // report is NOT user-driven, and a checkbox tap is as user-driven as it gets —
    // the tap itself stamps `drivenAt` through EditorBridge's capture listeners, so
    // that guard is disarmed at precisely the moment this needs one.
    if (useWorkspaceStore.getState().selectMode) {
      // Forget the last reported key too. Leaving select mode KEEPS the pick (see
      // toggleSelectMode), so without this a first tap that happened to match the
      // key from before the mode was entered would be skipped as a repeat and the
      // stale checkbox pick would survive into normal editing.
      lastSelKeyRef.current = "";
      return;
    }

    // ── PHANTOM COLLAPSE GUARD ──
    // Focus leaving the WebView costs the page its text selection, and tapping
    // ✦ Ask AI is precisely that: the dock's input takes focus and the keyboard
    // comes up. Lexical rebuilds its selection from the caret the browser leaves
    // behind and reports a SINGLE block. Acting on that report tore down the very
    // scope the student had just built: the selection shrank to one paragraph, so
    // FloatingPill closed the ask input (it closes on any selection change), the
    // bubble fell back to that paragraph's formatting tools, and the half-typed
    // prompt went with the unmounted dock — the reported "I can't send an AI
    // prompt with more than two blocks selected". A shrink only counts when the
    // report came from a student actually working in the editor.
    if (
      s.userDriven === false &&
      (s.blocks?.length ?? 1) <= 1 &&
      useWorkspaceStore.getState().selectedBlocks.length > 1
    ) {
      return;
    }
    // Any non-chrome selection clears a stale chrome selection.
    useWorkspaceStore.getState().setChromeSelection(null);
    useLexicalEditorStore.getState().setFormat({
      bold: s.bold, italic: s.italic, underline: s.underline,
      blockType: s.blockType, isRTL: s.isRTL, alignment: s.alignment,
    });
    focusRef.current = { index: s.index, y: typeof s.y === "number" ? s.y : 0 };
    // Sync Lexical's selection to the native multi-block model. A cross-paragraph
    // drag reports EVERY spanned block (s.blocks) so the pill + AI dock target the
    // whole set (Summarize/Improve/… then act on all of them); a caret or in-block
    // selection reports one → single-select (keeps the inline-suggestion path).
    const spanned = s.blocks && s.blocks.length ? s.blocks : [{ index: s.index, text: s.text }];
    const selKey = spanned.map((b) => b.index).join(",");
    if (selKey !== lastSelKeyRef.current) {
      lastSelKeyRef.current = selKey;
      const ws = useWorkspaceStore.getState();
      if (spanned.length > 1) ws.setSelection(spanned, true);
      else ws.selectBlock(spanned[0].index, spanned[0].text);
    }
    if (typeof s.y === "number" && s.y >= 0) {
      useFloatingPillStore.getState().setAnchorY(editorTopRef.current + s.y);
    }
  }, [scheduleSave]);

  // Bridge the SlashPlugin's "/command" detection to the native insert-menu store.
  // The trigger fires from an editor update (not onState), so reuse the last known
  // focus Y — the same anchor math onState uses for the floating pill.
  const onInsertTrigger = useCallback((tr: { active: boolean; index: number; query: string }) => {
    const store = useInsertMenuStore.getState();
    if (!tr.active) {
      if (store.open) store.close();
      return;
    }
    const y = focusRef.current?.y != null ? editorTopRef.current + focusRef.current.y : 200;
    if (!store.open) store.openAt({ index: tr.index, y }, { query: tr.query });
    else {
      store.setAnchor({ index: tr.index, y });
      store.setQuery(tr.query);
    }
  }, []);

  // An image pasted with the OS Paste menu (or ⌘V) inside the Writer. The plugin has
  // already swallowed the paste and told us the caret's block; native reads the
  // clipboard itself. Flush pending text first — insertImage is structural, and the
  // reseed it triggers would otherwise drop whatever hasn't synced yet, exactly as
  // the Insert menu does before its own structural ops.
  const onPasteImage = useCallback(
    (index: number) => {
      void (async () => {
        await flushEdits();
        await pasteImageFromClipboard(thesisId, index);
      })();
    },
    [thesisId, flushEdits],
  );

  const runSave = useCallback(async (serialized: DocBlockDTO[]) => {
    try {
      if (!pendingSave.current) return;
      pendingSave.current = false;
      const { ops } = planOps(baselineRef.current, serialized);
      if (ops.length === 0) return; // nothing changed — stay silent (auto-save runs on every pause)
      setSaving(true);
      setBanner("Syncing…");
      try {
        const res = await applyThesisOps(thesisId, ops); // ONE batch call
        if (res.document) {
          useThesisDocStore.getState().setDoc(thesisId, res.document);
          syncedDocRef.current = res.document; // our own change — don't reseed from it
          if (res.document.available) baselineRef.current = stripMedia(res.document.blocks);
        }
        setBanner(`Saved · ${tally(ops)}${res.skipped?.length ? ` (${res.skipped.length} skipped)` : ""}`);
      } catch {
        setBanner("Save failed");
      } finally {
        setSaving(false);
        setTimeout(() => setBanner(null), 2600);
      }
    } finally {
      // Settle every waiting flushEdits() on ALL exits (saved, no-op, failed) —
      // callers only need to know the pending state has been dealt with.
      saveWaiters.current.splice(0).forEach((resolve) => resolve());
    }
  }, [thesisId]);

  // Saves are CHAINED, never concurrent: a serialize landing while a save is
  // still in flight (pause-save + forced flush overlapping) would otherwise diff
  // against the not-yet-updated baseline and re-apply the same ops — inserts/
  // deletes are positional, so that duplicates content. The later run waits,
  // then plans against the reconciled baseline (usually a no-op).
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const onBlocks = useCallback((serialized: DocBlockDTO[]) => {
    const run = saveChain.current.then(() => runSave(serialized));
    saveChain.current = run.catch(() => {});
    return run;
  }, [runSave]);

  // ── AI table proposal (in-place diff) ──
  // The ✦ dock put a proposal in the table-suggestion store; mirror it into the
  // DOM editor as serializable props and route the pill's actions back. Approve
  // converts the SAME precomputed diff into a tableOp batch (ONE /ops call) and
  // reconciles via plain setDoc — the reseed re-renders the approved table
  // (scroll is pinned by the reseed path). Reject/dismiss just clears the store.
  // Spec: docs/superpowers/specs/2026-07-23-ai-table-proposals-design.md
  const tblProposal = useTableSuggestionStore((s) => s.proposal);
  const tblLoadingIndex = useTableSuggestionStore((s) => s.loadingIndex);
  const tblThinking = useTableSuggestionStore((s) => s.thinking);
  const tblErrorIndex = useTableSuggestionStore((s) => s.errorIndex);
  const tableProposal = useMemo(
    () =>
      tblProposal && tblProposal.thesisId === thesisId
        ? {
            index: tblProposal.index,
            originalRows: tblProposal.originalRows,
            newRows: tblProposal.newRows,
            diff: tblProposal.diff,
            thoughtMs: tblProposal.thoughtMs,
            layout: tblProposal.layout
              ? {
                  headerFill: tblProposal.layout.headerFill,
                  borders: tblProposal.layout.borders,
                  borderStyle: tblProposal.layout.borderStyle,
                  borderSizePt: tblProposal.layout.borderSizePt,
                  borderColor: tblProposal.layout.borderColor,
                }
              : null,
            fills: tblProposal.fills ?? null,
            textColors: tblProposal.textColors ?? null,
          }
        : null,
    [tblProposal, thesisId],
  );
  // Proposal UI strings resolved HERE (the DOM bundle has no i18n instance) —
  // the app is trilingual ar/fr/en, so every visible label rides this prop.
  const tableLabels = useMemo(
    () => ({
      proposal: t("tableAI.proposal", { defaultValue: "AI suggestion" }),
      original: t("tableAI.original", { defaultValue: "Original — before changes" }),
      thought: t("tableAI.thought", { defaultValue: "Thought for {s}s" }),
      thinking: t("tableAI.thinking", { defaultValue: "Thinking…" }),
      approve: t("tableAI.approve", { defaultValue: "Approve" }),
      compare: t("tableAI.compare", { defaultValue: "Compare" }),
      showProposal: t("tableAI.showProposal", { defaultValue: "Proposal" }),
      again: t("tableAI.again", { defaultValue: "Again" }),
      reject: t("tableAI.reject", { defaultValue: "Reject" }),
      send: t("tableAI.send", { defaultValue: "Send" }),
      notePlaceholder: t("tableAI.notePlaceholder", { defaultValue: "Note for the retry…" }),
      failed: t("tableAI.failed", { defaultValue: "Suggestion failed" }),
      retry: t("tableAI.retry", { defaultValue: "Retry" }),
    }),
    [t],
  );
  // The "still working" wait lines every inline AI surface shares. No Stop
  // control on an inline edit — the only thing to do is wait — so the longest
  // line says exactly that (unlike the chat's, which points at its Stop button).
  const workingLabels = useMemo(
    () => ({
      short: t("working.short", { defaultValue: "Working on it…" }),
      long: t("working.long", { defaultValue: "Still working — this can take a while. Please wait." }),
      veryLong: t("working.veryLong", { defaultValue: "Still working on a long task — please keep waiting." }),
    }),
    [t],
  );
  const onTableProposalAction = useCallback(
    (action: string, note?: string) => {
      const store = useTableSuggestionStore.getState();
      const p = store.proposal;
      if (action === "again") { void store.again(note); return; }
      if (action === "retry") { void store.retry(); return; }
      if (action === "reject" || !p || p.thesisId !== thesisId) { store.clear(); return; }
      if (action !== "approve") return;
      void (async () => {
        const docStore = useThesisDocStore.getState();
        // Positional ops must land after any queued durable ops — refuse instead
        // of interleaving (same rule as the bubble's silent table sync).
        if ((docStore.pending[thesisId] ?? 0) > 0) {
          setBanner("Syncing — try again in a moment");
          setTimeout(() => setBanner(null), 2600);
          return;
        }
        const delta = layoutDelta(
          { align: p.originalLayout.align, direction: p.originalLayout.direction, header: p.originalLayout.header },
          p.layout,
        );
        const ops = diffToOps(p.index, p.originalRows, p.newRows, p.diff, delta, p.fills, p.textColors);
        store.clear(); // leave diff mode before the reseed repaints the table
        if (!ops) {
          setBanner("Proposal too large to apply");
          setTimeout(() => setBanner(null), 2600);
          return;
        }
        if (ops.length === 0) return; // nothing to change
        // Optimistic: apply the diff LOCALLY first so the edited table repaints
        // instantly (was: awaited the server, so the un-edited table lingered). Then
        // sync — the server echo reconciles the exact result (borders/layout are
        // resolved server-side).
        const cur = docStore.byId[thesisId];
        if (cur?.available) {
          let optimistic = cur;
          for (const op of ops) optimistic = applyOpToDoc(optimistic, op);
          docStore.setDoc(thesisId, optimistic);
        }
        try {
          const res = await applyThesisOps(thesisId, ops);
          if (res.document) docStore.setDoc(thesisId, res.document); // reconcile to server truth
          void docStore.refreshHistoryState(thesisId);
        } catch {
          void docStore.revalidate(thesisId);
        }
      })();
    },
    [thesisId],
  );
  // A failed suggest shows INLINE on the table (error strip + retry via
  // tableErrorIndex) — no transient banner needed.
  // Invalidation: any doc change that alters the target table (an outside edit,
  // undo, AI turn) silently drops the proposal — its diff no longer applies.
  useEffect(() => {
    const p = useTableSuggestionStore.getState().proposal;
    if (!p || p.thesisId !== thesisId || !doc?.available) return;
    const b = doc.blocks[p.index];
    const same =
      b?.kind === "table" &&
      JSON.stringify(b.rows.map((r) => r.map((c) => c.trim()))) ===
        JSON.stringify(p.originalRows.map((r) => r.map((c) => c.trim())));
    if (!same) useTableSuggestionStore.getState().clear();
  }, [doc, thesisId]);

  // In-cell table edit (double-tap a cell in the WebView) → the block-model
  // editCell op. The WebView cell already painted the new value from its local
  // overlay, so we must NOT full-reseed here — that would rebuild the whole doc
  // and scroll to the top (and trip Lexical's flushSync warning). Send the op,
  // then reconcile the store/baseline with skipReseed set so the setDoc updates
  // state WITHOUT rebuilding the editor. No optimistic setDoc for the same reason.
  const onEditCell = useCallback(
    (blockIndex: number, row: number, col: number, text: string) => {
      void (async () => {
        const store = useThesisDocStore.getState();
        try {
          const res = await applyThesisOps(thesisId, [
            { type: "tableOp", index: blockIndex, action: "editCell", row, col, text },
          ]);
          if (res.document) {
            useLexicalEditorStore.getState().requestSkipReseed();
            store.setDoc(thesisId, res.document);
          }
          void store.refreshHistoryState(thesisId);
        } catch {
          void store.revalidate(thesisId);
        }
      })();
    },
    [thesisId],
  );

  // Reorder (one-finger gutter drag) → the existing durable `move` op. The store
  // applies the optimistic patchMove, persists + flushes, and the sync layer reseeds
  // Lexical to the new order. hMedium on the drop, hLight on the lift (the DOM
  // bundle can't call expo-haptics, so the native side fires the real haptics).
  const onReorder = useCallback((from: number, to: number) => {
    if (from === to) return;
    hMedium();
    void useThesisDocStore.getState().mutate(thesisId, { type: "move", from, to });
  }, [thesisId]);
  const onLift = useCallback(() => { hLight(); }, []);

  // Checkbox select mode: a tap on a block toggles it in/out of the native
  // selection (the store is the single source of truth — the editor only paints
  // the checked marks back from it). hSelection gives the tap a physical tick,
  // which the pure-web checkbox can't.
  const onToggleSelect = useCallback((index: number, text: string) => {
    hSelection();
    useWorkspaceStore.getState().toggleBlock(index, text);
  }, []);

  return (
    <View
      style={styles.container}
      ref={wrapRef}
      onLayout={() => wrapRef.current?.measureInWindow((_x, y) => { editorTopRef.current = y; })}
    >
      <View style={styles.editorWrap}>
        <LexicalDomEditor
          key={`ws:${thesisId}:${seedNonce}`}
          initialBlocks={seed}
          chrome={chrome}
          pageSetup={pageSetup}
          anchorGeometry={anchorGeometry}
          command={command}
          keyboardActive={keyboardActive}
          onSwipeOpenDrawer={() => useNavDrawerStore.getState().openDrawer()}
          appRtl={I18nManager.isRTL}
          onState={onState}
          onInsertTrigger={onInsertTrigger}
          onPasteImage={onPasteImage}
          onBlocks={onBlocks}
          reseed={reseed}
          scrollRestore={scrollRestore}
          onScroll={onScroll}
          onScrollRestored={onScrollRestored}
          scrollToIndex={scrollTarget ? { index: scrollTarget.index, nonce: scrollTarget.nonce } : undefined}
          chromePreview={
            hfRegion && hfPreview
              ? { kind: hfRegion === "footer" ? "bottom" : "top", index: hfIndex, segments: hfPreview.segments, text: hfPreview.text, nonce: hfPreview.nonce }
              : null
          }
          scrollToChrome={
            hfRegion && hfRevealNonce > 0
              ? { kind: hfRegion === "footer" ? "bottom" : "top", index: hfIndex, nonce: hfRevealNonce, offset: hfRevealOffset }
              : undefined
          }
          suggestion={suggestion ?? undefined}
          onSuggestAction={onSuggestAction}
          onEquationTap={onEquationTap}
          completionEnabled={completionEnabled}
          completion={completion}
          onRequestCompletion={onRequestCompletion}
          onCommitCompletion={onCommitCompletion}
          onCancelCompletion={onCancelCompletion}
          rangeSuggestion={rangeSuggestion}
          onRangeAction={onRangeAction}
          selectedIndices={highlightIndices}
          media={media}
          search={search}
          onEditCell={onEditCell}
          reorderActive={reorderMode}
          onReorder={onReorder}
          onLift={onLift}
          selectActive={selectMode}
          selectedForCheck={checkedIndices}
          onToggleSelect={onToggleSelect}
          tableProposal={tableProposal}
          tableLoadingIndex={tblLoadingIndex}
          tableThinking={tblThinking}
          tableErrorIndex={tblErrorIndex}
          tableLabels={tableLabels}
          workingLabels={workingLabels}
          onTableProposalAction={onTableProposalAction}
          dom={{ style: { flex: 1 }, scrollEnabled: true, keyboardDisplayRequiresUserAction: false, hideKeyboardAccessoryView: true }}
        />
        {/* Auto-save status (no manual button — background sync on pause / exit). */}
        {banner ? (
          <View style={styles.saveRow} pointerEvents="none">
            <View style={[styles.banner, { backgroundColor: colors.bgPrimary, borderColor: colors.borderSubtle }]}>
              <Text style={[styles.bannerText, { color: colors.textSecondary }]}>{banner}</Text>
            </View>
          </View>
        ) : null}
        {/* Cover the reload + scroll-to-saved-block on a large doc so the user
            doesn't watch it load at the top and jump down. */}
        {restoring ? (
          <View style={[styles.restoreOverlay, { backgroundColor: colors.bgPrimary }]}>
            <ActivityIndicator size="large" color={colors.brandPrimary} />
            <Text style={[styles.restoreText, { color: colors.textSecondary }]}>
              {t("workspace.restoringPosition", { defaultValue: "Restoring your place…" })}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  editorWrap: { flex: 1, position: "relative" },
  saveRow: { position: "absolute", top: 8, right: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  banner: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, maxWidth: 220 },
  bannerText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  restoreOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 14, zIndex: 20 },
  restoreText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  saveBtn: { minWidth: 64, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 4 },
  saveText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
