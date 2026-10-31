// The native half of Phase 3 on the docx surface: everything WorkspaceDocxView hands
// DocxEditorDom for equations, header/footer, charts, pictures, search, the slash
// trigger and image paste — and the callbacks that come back. The host stays a
// wiring site (spread `props`, call `onReloadSettled` from onReloaded, route a
// `chrome:*` report to `reportChrome`).
//
// Visual first: what the engine can do happens in the engine (picture transforms,
// search replace); what only the server can do is marked PENDING on the page — from
// the tap (stores/docx-surface-store `beginPending`) or, generically, from the server
// echo (the blocks the echoed DTO changed) — until the reload that shows it lands.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Alert } from "react-native";
import type { DocumentDTO } from "@/lib/api";
import i18n from "@/lib/i18n";
import { pasteImageFromClipboard } from "@/lib/paste-image";
import { blockSearchText } from "@/lib/search-match";
import { normalize } from "@/lib/text-normalize";
import { useDocxSurfaceStore } from "@/stores/docx-surface-store";
import { useEquationSheetStore } from "@/stores/equation-sheet-store";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useInsertMenuStore } from "@/stores/insert-menu-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { useSearchStore } from "@/stores/search-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { editsFor, engineStart, liveEdits, targetFor, type ReplaceEdit } from "../bridge/search-resolve";
import type {
  ChartOverlayInput,
  ImageCommandInput,
  ImageTransformAction,
  InsertTrigger,
  SearchFocusInput,
  SearchReplaceInput,
  SearchReplaceResult,
  SearchTarget,
} from "../bridge/surface-types";
import { docChanges } from "./doc-diff";

/** FNV-1a — a chart recolour keeps the SVG's length, so length alone can't key it. */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function liveDoc(thesisId: string): Extract<DocumentDTO, { available: true }> | null {
  const d = useThesisDocStore.getState().byId[thesisId];
  return d?.available ? d : null;
}

export function useDocxStructure(thesisId: string, editorHashRef: MutableRefObject<string | null>) {
  const doc = useThesisDocStore((s) => s.byId[thesisId]);
  const docTick = useThesisDocStore((s) => s.tick[thesisId] ?? 0);
  const blocks = doc?.available ? doc.blocks : undefined;
  const sections = doc?.available ? doc.sections : undefined;

  // ── Section starts (Task 18): a header/footer report names its section by them.
  // Keyed by content: the DTO object changes on every revalidate, the starts rarely.
  const startsSig = (sections ?? []).map((s) => s.startBlockIndex).join(",");
  const sectionStarts = useMemo(() => (startsSig ? startsSig.split(",").map(Number) : []), [startsSig]);

  // ── Charts (Task 19): the server's SVG per native chart, for the overlay layer.
  const chartList = useMemo(
    () => (blocks ?? []).flatMap((b) => (b.kind === "image" && b.svg ? [{ index: b.index, svg: b.svg }] : [])),
    [blocks],
  );
  const chartsSig = chartList.map((c) => `${c.index}:${hash32(c.svg)}`).join("|");
  // Identity changes only when a chart does: every prop is re-sent over the bridge on
  // each host render, and the SVGs are the bulk of it.
  const charts = useMemo<ChartOverlayInput[]>(() => chartList, [chartsSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const soleSelected = useWorkspaceStore((s) => (s.selectedBlocks.length === 1 ? s.selectedBlocks[0].index : -1));
  const selectedChart = useMemo(
    () => (charts.some((c) => c.index === soleSelected) ? soleSelected : -1),
    [charts, soleSelected],
  );

  // ── Pending marks: explicit (from the tap) + generic (from the server echo).
  const pending = useDocxSurfaceStore((s) => s.pending);
  const pendingChrome = useDocxSurfaceStore((s) => s.pendingChrome);
  const prevDocRef = useRef<Extract<DocumentDTO, { available: true }> | null>(null);
  useEffect(() => {
    const cur = liveDoc(thesisId);
    const prev = prevDocRef.current;
    prevDocRef.current = cur;
    if (!cur || !prev || cur === prev) return;
    // Only a change the editor does NOT hold yet — the same test that decides to
    // reload. The student's own save moves both hashes together and never lights up.
    const h = cur.docHash ?? null;
    if (!h || !editorHashRef.current || h === editorHashRef.current) return;
    const { blocks: changed, sides } = docChanges(prev, cur);
    useDocxSurfaceStore.getState().markChanged(changed, sides);
  }, [docTick, thesisId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onReloadSettled = useCallback(() => useDocxSurfaceStore.getState().settle(), []);

  // ── Pictures (Task 20): rotate/flip run in the engine.
  const [imageCommand, setImageCommand] = useState<ImageCommandInput | null>(null);
  const imageSeq = useRef(0);
  useEffect(() => {
    const transform = (index: number, action: ImageTransformAction) => {
      setImageCommand({ index, action, nonce: ++imageSeq.current });
      return true;
    };
    useDocxSurfaceStore.getState().registerImageTransform(transform);
    return () => useDocxSurfaceStore.getState().registerImageTransform(null);
  }, []);
  // The engine would not (a locked or unpainted drawing): say so, as the old path did.
  const onImageRefused = useCallback(async (_index: number) => {
    Alert.alert(i18n.t("workspace.imageError", { defaultValue: "Couldn't update the image." }));
  }, []);

  // ── Search (Task 21) ──
  const searchOpen = useSearchStore((s) => s.open);
  const query = useSearchStore((s) => s.query);
  const current = useSearchStore((s) => s.current);
  // Stable ref: the array element itself, not a fresh object.
  const cur = useSearchStore((s) => s.matches[s.current] ?? null);
  const [searchFocus, setSearchFocus] = useState<SearchFocusInput | null>(null);
  const [searchReplace, setSearchReplace] = useState<SearchReplaceInput | null>(null);
  const focusSeq = useRef(0);
  const replaceSeq = useRef(0);
  const [replaceEpoch, setReplaceEpoch] = useState(0);
  const lastFocusKey = useRef("");
  // Local replaces the DTO doesn't show yet (bridge/search-resolve.ts): targets keep
  // DTO offsets, the engine has shifted — this says by how much.
  const editsRef = useRef<ReplaceEdit[]>([]);
  const toEngine = useCallback((t: SearchTarget): SearchTarget => {
    const live = liveDoc(thesisId);
    editsRef.current = liveEdits(editsRef.current, (i) => {
      const b = live?.blocks.find((x) => x.index === i);
      return b ? blockSearchText(b) : undefined;
    });
    return { ...t, start: engineStart(t, editsRef.current) };
  }, [thesisId]);
  useEffect(() => { editsRef.current = []; }, [searchOpen, query]);
  useEffect(() => {
    if (!searchOpen || !cur) { lastFocusKey.current = ""; return; }
    const b = liveDoc(thesisId)?.blocks.find((x) => x.index === cur.blockIndex);
    const t = b ? targetFor(cur.blockIndex, blockSearchText(b), cur.start, cur.end) : null;
    // The list lags the query by the panel's debounce: a hit that doesn't fold to
    // the query is from the PREVIOUS query — wait for the recompute.
    if (!t || normalize(t.literal) !== normalize(query)) return;
    // Navigate on a new query, a new current hit, or a replace — NOT when the list is
    // merely recomputed because the student typed elsewhere (every save revalidates
    // the DTO): that would yank the caret out from under them.
    const key = `${query}|${current}|${t.blockIndex}|${replaceEpoch}`;
    if (key === lastFocusKey.current) return;
    lastFocusKey.current = key;
    setSearchFocus({ ...toEngine(t), nonce: ++focusSeq.current });
  }, [searchOpen, query, current, cur, replaceEpoch, thesisId, toEngine]);

  useEffect(() => {
    const replace = (targets: SearchTarget[], text: string) => {
      if (!targets.length) return false;
      const items = targets.map(toEngine);
      editsRef.current = [...editsRef.current, ...editsFor(targets, text)];
      setSearchReplace({ items, text, nonce: ++replaceSeq.current });
      // The engine shows the replacement now; the panel must not wait ~2s for the DTO
      // to say so. Drop the replaced hits (spans stay DTO-relative — the panel's own
      // guard and the next target read them against the DTO text until it refreshes)
      // and navigate to whatever is now current, as a find/replace dialog does.
      const s = useSearchStore.getState();
      const gone = new Set(targets.map((i) => `${i.blockIndex}:${i.start}`));
      s.setMatches(s.matches.filter((m) => !gone.has(`${m.blockIndex}:${m.start}`)), s.capped);
      setReplaceEpoch((e) => e + 1);
      return true;
    };
    useDocxSurfaceStore.getState().registerSearchReplace(replace);
    return () => useDocxSurfaceStore.getState().registerSearchReplace(null);
  }, [toEngine]);
  const onSearchReplaced = useCallback(async (r: SearchReplaceResult) => {
    if (r.missed > 0) console.warn(`[docx] search replace: ${r.replaced} replaced, ${r.missed} not found in the engine`);
  }, []);

  // ── Equation tap (Task 17) — WorkspaceLexicalView.onEquationTap, with the math
  // looked up here rather than shipped across the bridge.
  const onEquationTap = useCallback(async (payload: string) => {
    try {
      const { index, ordinal } = JSON.parse(payload) as { index: number; ordinal: number };
      const live = liveDoc(thesisId);
      // A local structural edit not yet saved can leave the painted index a block or
      // two off the DTO (spec D7): take the nearest paragraph that HAS math rather
      // than offering to insert a second equation next to the one tapped.
      let line = live?.blocks.find((b) => b.index === index);
      if (live && !(line?.kind === "paragraph" && line.math?.length)) {
        for (let d = 1; d <= 3 && !(line?.kind === "paragraph" && line.math?.length); d++) {
          const near = [index - d, index + d].map((i) => live.blocks.find((b) => b.index === i))
            .find((b) => b?.kind === "paragraph" && !!b.math?.length);
          if (near) line = near;
        }
      }
      const at = line?.index ?? index;
      const math = line?.kind === "paragraph" ? (line.math?.[ordinal] ?? line.math?.[0]) : undefined;
      const store = useEquationSheetStore.getState();
      if (math?.latex) {
        // The paragraph's own text on an equation line is its number, "(I.1)".
        store.openEdit({ thesisId, index: at, latex: math.latex, number: line?.kind === "paragraph" ? line.text.trim() : "" });
      } else {
        // A legacy OLE equation has no readable LaTeX — offer to write a real one after it.
        store.openInsert({ thesisId, index: at });
      }
    } catch {
      // A malformed payload must never take the writer down.
    }
  }, [thesisId]);

  // ── Slash trigger (Task 22, detection) — WorkspaceLexicalView.onInsertTrigger. The
  // bloom height is the line the pill is anchored on (same editorTop + y math).
  const onInsertTrigger = useCallback(async (tr: InsertTrigger) => {
    const store = useInsertMenuStore.getState();
    if (!tr.active) {
      if (store.open) store.close();
      return;
    }
    const y = useFloatingPillStore.getState().anchorY ?? 200;
    if (!store.open) store.openAt({ index: tr.index, y }, { query: tr.query });
    else {
      store.setAnchor({ index: tr.index, y });
      store.setQuery(tr.query);
    }
  }, []);

  // ── Paste image (Task 23) — WorkspaceLexicalView.onPasteImage: flush first, then
  // native reads the clipboard and inserts through the durable insertImage op.
  const onPasteImage = useCallback(async (index: number) => {
    await useLexicalEditorStore.getState().flushEdits?.();
    await pasteImageFromClipboard(thesisId, index);
  }, [thesisId]);

  const props = {
    sectionStarts, charts, selectedChart, pending, pendingChrome, imageCommand, searchFocus, searchReplace,
    onEquationTap, onInsertTrigger, onPasteImage, onSearchReplaced, onImageRefused,
  };
  return { props, onReloadSettled };
}
