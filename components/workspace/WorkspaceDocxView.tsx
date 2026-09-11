import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import DocxEditorDom from "@/components/workspace/docx-editor/DocxEditorDom";
import type { LexicalState } from "@/components/workspace/lexical/editor-components/types";
import type { SaveState } from "@/components/workspace/docx-editor/bridge/save-loop";
import type { DocBlockDTO } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFloatingPillStore } from "@/stores/floating-pill-store";
import { useLexicalEditorStore } from "@/stores/lexical-editor-store";

// The docx-editor as the Writer (spec D12, behind settings.writerEngine). Phase 1
// host: token, command/state bridge, flush + reload registration, doc-tick → reload,
// outline/deep-link scroll, pill anchoring, the save banner. Everything index-based
// on the native side keeps working because the DOM reports the same LexicalState
// Lexical did.

const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");

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
  const reloadWaiters = useRef<(() => void)[]>([]);

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
    const n = Date.now();
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
  const onReloaded = useCallback(async (h: string | null) => {
    editorHashRef.current = h;
    reloadWaiters.current.splice(0).forEach((r) => r());
  }, []);

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
      // outline drawer, block links. revalidate no-ops while ops are queued —
      // there are none on this surface.
      void useThesisDocStore.getState().revalidate(thesisId);
    } else if (s.kind === "stale") {
      // Phase 1: reload the server's version and say so. Phase 4 (Task 28) keeps
      // the refused bytes as a recovery copy and offers Restore.
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
  const onServerFormat = useCallback(async (index: number, changes: { direction: "rtl" | "ltr" }) => {
    await flushEdits();
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
    if (useWorkspaceStore.getState().selectMode) { lastSelKeyRef.current = ""; return; }
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
  }, []);

  if (!token) return <View style={styles.fill} />;

  return (
    <View
      style={styles.fill}
      ref={wrapRef}
      onLayout={() => wrapRef.current?.measureInWindow((_x, y) => { editorTopRef.current = y; })}
    >
      <DocxEditorDom
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
        onError={async (m) => setBanner(m)}
        dom={{ style: { flex: 1 }, scrollEnabled: true }}
      />
      {banner ? (
        <View style={[styles.banner, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{banner}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  banner: { position: "absolute", bottom: 12, alignSelf: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
});
