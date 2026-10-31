import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Platform, I18nManager } from "react-native";
import * as Device from "expo-device";
import { useThemeColors } from "@/hooks/useThemeColors";
import { typography } from "@/constants/typography";
import DocxEditorDom from "@/components/workspace/docx-editor/DocxEditorDom";
import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import type { SaveState } from "@/components/workspace/docx-editor/bridge/save-loop";
import { useDocxRecovery } from "@/components/workspace/docx-editor/host/useDocxRecovery";
import { RecoveryBanner } from "@/components/workspace/docx-editor/host/RecoveryBanner";
import { useDocxScrollRestore } from "@/components/workspace/docx-editor/host/useDocxScrollRestore";
import type { DocBlockDTO } from "@/lib/api";
import { resolveBlockIndexStrict } from "@/lib/block-links";
import { supabase } from "@/lib/supabase";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";
import { isChromeReport, reportChrome } from "@/components/workspace/docx-editor/host/chrome-report";
import { useDocxStructure } from "@/components/workspace/docx-editor/host/use-docx-structure";
import { useSuggestionOverlays } from "@/components/workspace/docx-editor/host/useSuggestionOverlays";
import { useDocxSelectMode } from "@/components/workspace/docx-editor/host/useDocxSelectMode";
import { useNavDrawerStore } from "@/stores/nav-drawer-store";

// The docx-editor as the Writer (spec D12, behind settings.writerEngine). Phase 1
// host: token, command/state bridge, flush + reload registration, doc-tick → reload,
// outline/deep-link scroll, pill anchoring, the save banner. Everything index-based
// on the native side keeps working because the DOM reports the same LexicalState
// Lexical did.

const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");

// The iOS Simulator's WebKit segfaults inside JavaScriptCore's WebAssembly fault
// handler (EXC_BAD_ACCESS at 0x8, reproduced 09-11 and 09-22 on an x86-64 runtime)
// the moment the shaper instantiates its module — a WebContent-process crash, not
// a JS error, and nothing this side can catch. HarfBuzz is the only wasm the engine
// loads, so the simulator opens the document without it: pagination is then wrong,
// but the surface is there to develop against. Real devices keep the shaper.
// `EXPO_PUBLIC_DOCX_SHAPING=on|off` overrides that verdict, which is how the
// simulator gets tested against a JSC that was told not to use its wasm fast
// memory (`simctl spawn booted launchctl setenv JSC_useWebAssemblyFastMemory 0`,
// then relaunch — the WebContent process reads it at launch). Unset = auto.
const SHAPING_OVERRIDE = process.env.EXPO_PUBLIC_DOCX_SHAPING;
const WASM_HOSTILE_WEBKIT = Platform.OS === "ios" && !Device.isDevice;
const SHAPING_DEFAULT = SHAPING_OVERRIDE === "on" ? true
  : SHAPING_OVERRIDE === "off" ? false
  : !WASM_HOSTILE_WEBKIT;

/** The text to search for when navigating to `index`: the block's own text for a
 *  paragraph, else the nearest paragraph ABOVE it (a table or figure has no
 *  searchable text; landing just above it is the right place to look). */
function anchorTextFor(blocks: DocBlockDTO[], index: number): { index: number; text: string } {
  for (let i = index; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === "paragraph" && b.text.trim()) return { index: i, text: b.text };
  }
  return { index, text: "" };
}

export function WorkspaceDocxView({ thesisId, active, deepLinkBlock }: {
  thesisId: string;
  active: boolean;
  deepLinkBlock?: number | null;
}) {
  const colors = useThemeColors();
  const [token, setToken] = useState<string | null>(null);
  const command = useLexicalEditorStore((s) => s.command);
  const docTick = useThesisDocStore((s) => s.tick[thesisId] ?? 0);
  const scrollTarget = useWorkspaceStore((s) => s.scrollTarget);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [flushNonce, setFlushNonce] = useState<number | undefined>(undefined);
  const [scrollTo, setScrollTo] = useState<{ index: number; text: string; nonce: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // The AI cards (inline suggestion, range rewrite, table proposal, completion) —
  // store state in, actions out; drawn by docx-editor/overlays/ (Phase 2).
  const overlays = useSuggestionOverlays({ thesisId, active, onNotice: setBanner });
  // Survives the auto-clear below, because a dead editor is not a transient event.
  const [crashNote, setCrashNote] = useState<string | null>(null);
  const [shaping, setShaping] = useState(SHAPING_DEFAULT);
  // Bumping this remounts the WebView. `shaping` is read once per mount (the shaper
  // is initialised before the first document opens), so a new value needs a new one.
  const [surfaceKey, setSurfaceKey] = useState(0);
  const scroll = useDocxScrollRestore({ thesisId, deepLinkBlock, surfaceKey });
  const keyboardActive = useWorkspaceStore((s) => s.keyboardActive);
  const onSwipeOpenDrawer = useCallback(async () => { useNavDrawerStore.getState().openDrawer(); }, []);
  const crashedRef = useRef(false);
  const editorHashRef = useRef<string | null>(null);
  // For anchoring the native pill/AI-dock over the WebView, exactly as
  // WorkspaceLexicalView does it: the editor's ABSOLUTE SCREEN top (measureInWindow,
  // not onLayout's parent-relative y — on Android the status-bar strip sits above
  // the workspace and a parent-relative offset lands the pill short) + the block's
  // reported in-WebView Y = the block's screen Y.
  const wrapRef = useRef<View>(null);
  const editorTopRef = useRef(0);
  const lastSelKeyRef = useRef("");
  const flushWaiters = useRef(new Map<number, () => void>());
  // Monotonic, NOT Date.now(): two flushes inside the same millisecond would collide
  // on the key (the first resolver overwritten and never settled) and, worse,
  // setFlushNonce would be handed an identical value — React bails, the prop never
  // changes, and the Bridge's effect never fires for the second one either.
  const flushSeq = useRef(0);
  const reloadWaiters = useRef<(() => void)[]>([]);
  // Phase 3: equations, header/footer, charts, pictures, search, slash, paste.
  const structure = useDocxStructure(thesisId, editorHashRef);
  const recovery = useDocxRecovery();
  // Task 24: checkbox select mode (engine read-only, a checkbox per block).
  const select = useDocxSelectMode(lastSelKeyRef);
  const { swallowsReport } = select;

  // A fresh token on mount; the DOM side holds it for its own fetches. (A session
  // outliving the hour re-mounts on the next workspace open; Phase 4 refreshes it
  // in place on AppState "active".)
  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setToken(data.session?.access_token ?? null); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    useLexicalEditorStore.getState().setActive(active);
    return () => useLexicalEditorStore.getState().setActive(false);
  }, [active]);

  // flushEdits: bump a nonce the DOM watches; resolve when it reports back (8s cap).
  const flushEdits = useCallback((): Promise<void> => new Promise((resolve) => {
    const n = ++flushSeq.current;
    flushWaiters.current.set(n, resolve);
    setFlushNonce(n);
    setTimeout(() => { if (flushWaiters.current.delete(n)) resolve(); }, 8000);
  }), []);
  const onFlushed = useCallback(async (n: number) => { flushWaiters.current.get(n)?.(); flushWaiters.current.delete(n); }, []);
  useEffect(() => {
    useLexicalEditorStore.getState().registerFlushEdits(flushEdits);
    return () => useLexicalEditorStore.getState().registerFlushEdits(null);
  }, [flushEdits]);

  // reload: same nonce pattern, awaited by sheets/history after a server mutation.
  const reload = useCallback((): Promise<void> => new Promise((resolve) => {
    reloadWaiters.current.push(resolve);
    setReloadNonce((n) => n + 1);
    setTimeout(resolve, 8000);
  }), []);
  useEffect(() => {
    useLexicalEditorStore.getState().registerReload(reload);
    return () => useLexicalEditorStore.getState().registerReload(null);
  }, [reload]);
  const { onReloadSettled } = structure;
  const onReloaded = useCallback(async (h: string | null) => {
    editorHashRef.current = h;
    reloadWaiters.current.splice(0).forEach((r) => r());
    onReloadSettled();
  }, [onReloadSettled]);

  // The doc changed on the server by something other than our save (an AI turn's
  // MODK_DOCCHANGES → revalidate, a sheet, history) → the DTO's hash moves away
  // from the one the editor holds → reload. A conditional GET, so a false alarm
  // is one 304.
  useEffect(() => {
    const d = useThesisDocStore.getState().byId[thesisId];
    const h = d?.available ? d.docHash ?? null : null;
    if (h && editorHashRef.current && h !== editorHashRef.current) setReloadNonce((n) => n + 1);
  }, [docTick, thesisId]);

  const onReady = useCallback(async (info: { pages: number; docHash: string | null }) => {
    editorHashRef.current = info.docHash;
  }, []);

  const onSave = useCallback(async (s: SaveState) => {
    if (s.kind === "saved") {
      editorHashRef.current = s.docHash;
      setBanner("Saved");
      // The block model must catch up with the bytes: indices for the AI, the
      // outline drawer, block links. Nothing is lost when an op IS queued (this
      // surface enqueues one — see onServerFormat): revalidate returns early rather
      // than clobbering the unflushed optimistic edit, and that op's own server echo
      // reconciles the doc when it lands.
      void useThesisDocStore.getState().revalidate(thesisId);
    } else if (s.kind === "stale") {
      // Reload the server's version and say so; the refused bytes were kept as a
      // recovered copy, which the DOM offers through onRecovered (Task 28).
      setBanner("Changed elsewhere — reloaded");
      setReloadNonce((n) => n + 1);
    } else if (s.kind === "error") {
      setBanner(`Save failed: ${s.message}`);
    } else if (s.kind === "saving") {
      setBanner("Saving…");
    } else {
      setBanner(null);
    }
  }, [thesisId]);
  useEffect(() => {
    if (!banner || banner === "Saving…") return;
    const t = setTimeout(() => setBanner(null), 2600);
    return () => clearTimeout(t);
  }, [banner]);

  // Direction has no engine command: the server's `format` op, whose echo bumps
  // the tick → the hash moves → the effect above reloads the surface.
  //
  // The index the surface reported can be stale by the time the op is built — a
  // local structural edit mints node ids the DTO knows nothing about until the
  // save that follows re-parses them (spec D7) — so the block is re-found by its
  // TEXT first, against the model `flushEdits` has just brought up to date. Same
  // rule as a block link: trust the index while its text still agrees, else the
  // one unambiguous paragraph that carries it. A miss leaves the reported index
  // standing, which is what this did before.
  const onServerFormat = useCallback(async (target: { index: number; text: string }, changes: { direction: "rtl" | "ltr" }) => {
    await flushEdits();
    const d = useThesisDocStore.getState().byId[thesisId];
    const blocks = d?.available ? d.blocks : undefined;
    const index = resolveBlockIndexStrict(blocks, target.index, target.text) ?? target.index;
    await useThesisDocStore.getState().mutate(thesisId, { type: "format", indices: [index], changes });
  }, [thesisId, flushEdits]);

  // Outline drawer / modk:// link / deep link → scroll by index (+ its text).
  useEffect(() => {
    const target = scrollTarget?.index ?? deepLinkBlock ?? null;
    if (target == null) return;
    const d = useThesisDocStore.getState().byId[thesisId];
    const blocks = d?.available ? d.blocks : [];
    setScrollTo({ ...anchorTextFor(blocks, target), nonce: (scrollTarget?.nonce ?? 0) + 1 });
  }, [scrollTarget?.nonce, deepLinkBlock, thesisId]); // eslint-disable-line react-hooks/exhaustive-deps

  // engine → native, copied from WorkspaceLexicalView.onState (non-chrome path).
  const onState = useCallback(async (s: LexicalState) => {
    useLexicalEditorStore.getState().setHistoryAvail(!!s.canUndo, !!s.canRedo);
    // History availability rides EVERY report, so it is read before this guard.
    // Nothing below it should act on a report with no focused block: tapping ✦ takes
    // focus out of the WebView and the engine reports index -1, which would otherwise
    // reset the pill's Bold/H2/RTL indicators out from under the student.
    if (s.index < 0) return;
    // A running header/footer story (Task 18) — the chrome selection, not a block.
    if (isChromeReport(s)) { lastSelKeyRef.current = ""; reportChrome(thesisId, s, editorTopRef.current); return; }
    if (swallowsReport()) { lastSelKeyRef.current = ""; return; }
    if (s.userDriven === false && (s.blocks?.length ?? 1) <= 1 && useWorkspaceStore.getState().selectedBlocks.length > 1) return;
    useWorkspaceStore.getState().setChromeSelection(null);
    useLexicalEditorStore.getState().setFormat({
      bold: s.bold, italic: s.italic, underline: s.underline,
      blockType: s.blockType, isRTL: s.isRTL, alignment: s.alignment,
    });
    const spanned = s.blocks && s.blocks.length ? s.blocks : [{ index: s.index, text: s.text }];
    const selKey = spanned.map((b) => b.index).join(",");
    if (selKey !== lastSelKeyRef.current) {
      lastSelKeyRef.current = selKey;
      const ws = useWorkspaceStore.getState();
      if (spanned.length > 1) ws.setSelection(spanned, true);
      else if (spanned[0].index >= 0) ws.selectBlock(spanned[0].index, spanned[0].text);
    }
    if (typeof s.y === "number" && s.y >= 0) useFloatingPillStore.getState().setAnchorY(editorTopRef.current + s.y);
  }, [thesisId, swallowsReport]);

  // Expo's DOM wrapper answers a dead content process by silently reloading the
  // WebView, which turns a reproducible crash into an invisible reload loop — a
  // blank page and no error, which is exactly what a student would report. Taking
  // the handler (it is spread after the wrapper's own) means we own the recovery:
  // drop the wasm once, then stop and say so rather than loop.
  const onWebContentCrash = useCallback(() => {
    if (!crashedRef.current) {
      crashedRef.current = true;
      setShaping(false);
      setCrashNote("The editor crashed — reopened without text shaping, so page layout will differ from Word");
      setSurfaceKey((k) => k + 1);
      return;
    }
    setCrashNote("The editor keeps crashing — close and reopen the thesis to try again");
  }, []);

  if (!token) return <View style={styles.fill} />;

  return (
    <View
      style={styles.fill}
      ref={wrapRef}
      onLayout={() => wrapRef.current?.measureInWindow((_x, y) => { editorTopRef.current = y; })}
    >
      <DocxEditorDom
        key={surfaceKey}
        apiBase={API_BASE}
        thesisId={thesisId}
        token={token}
        command={command}
        scrollToIndex={scrollTo}
        reloadNonce={reloadNonce}
        flushNonce={flushNonce}
        onState={onState}
        onSave={onSave}
        onReady={onReady}
        onFlushed={onFlushed}
        onReloaded={onReloaded}
        onServerFormat={onServerFormat}
        shaping={shaping}
        {...structure.props}
        onError={async (m) => setBanner(m)}
        {...overlays}
        recoveryAction={recovery.action}
        onRecovered={recovery.onRecovered}
        scrollRestore={scroll.scrollRestore}
        onScroll={scroll.onScroll}
        onScrollRestored={scroll.onScrollRestored}
        keyboardActive={keyboardActive}
        onSwipeOpenDrawer={onSwipeOpenDrawer}
        appRtl={I18nManager.isRTL}
        {...select.props}
        dom={{
          style: { flex: 1 },
          scrollEnabled: true,
          onContentProcessDidTerminate: onWebContentCrash,
          onRenderProcessGone: onWebContentCrash,
        }}
      />
      {recovery.offer ? <RecoveryBanner onRestore={recovery.restore} onDiscard={recovery.discard} /> : null}
      {(crashNote ?? banner) ? (
        <View style={[styles.banner, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
          <Text style={[styles.bannerText, { color: colors.textSecondary }]}>{crashNote ?? banner}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Matches WorkspaceLexicalView's own banner: the caption size from the shared
  // scale, and the weight carried by the Inter face (a fontWeight would be inert
  // against a pre-weighted family).
  bannerText: { fontSize: typography.caption.fontSize, fontFamily: "Inter_500Medium" },
  banner: { position: "absolute", bottom: 12, alignSelf: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
});
