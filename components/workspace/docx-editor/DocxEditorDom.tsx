'use dom';

// The docx-editor as THE Writer surface, bundled into the app as an Expo DOM
// component. Speaks the native chrome's existing contract (LexicalCommand in,
// LexicalState out — see bridge/Bridge.tsx), loads and saves the document itself
// (bytes never cross the JSON bridge), and reloads on request.
//
// ⚠️ babel-preset-expo allows this module ONE export, the default. Everything
// else lives in ./bridge/. Gate: node scripts/verify-use-dom.mjs.
//
// Assets: harfbuzz.wasm is served from public/ (copied into the binary; not
// OTA-updatable — Task 29 moves it to require()) and handed to the shaper by
// bridge/shaper.ts, because the CommonJS engine build refuses
// setHarfBuzzWasmUrl. Without the shaper the engine reports `wasmUnavailable`
// and falls back to fixed-width measurement, which would make nothing about
// pagination trustworthy. Fonts come from the package's
// Google resolver until Task 27 bundles Arabic faces; loadDefaultFonts() is never
// used because its `new URL(…, import.meta.url)` cannot resolve under Metro.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocxEditor } from "@docx-editor.dev/react";
import type { DocxEditorRef, Editor, FontConfigurationFragment, FontResolver } from "@docx-editor.dev/react";
import { googleFonts } from "@docx-editor.dev/fonts/google";
import "@docx-editor.dev/core/styles/editor.css";
import type { LexicalCommand, LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { Bridge, type BlockRef } from "./bridge/Bridge";
import { fetchDocument } from "./bridge/load-document";
import { createSaveLoop, type SaveState } from "./bridge/save-loop";
import { ensureShaper } from "./bridge/shaper";
import { OverlayLayer } from "./overlays/OverlayLayer";
import type { OverlayProps } from "./overlays/types";

/**
 * Amiri is the only Arabic family in the package's Google catalogue, and it is
 * NOT metric-compatible with Traditional Arabic or Sakkal Majalla — so an Arabic
 * thesis paginates like Amiri rather than like Word. Same known limit as the web
 * trial; not a bug to chase here.
 */
function makeFontResolver(): FontResolver {
  const google = googleFonts({
    substitute: {
      "Traditional Arabic": "Amiri",
      "Simplified Arabic": "Amiri",
      "Arabic Typesetting": "Amiri",
      "Sakkal Majalla": "Amiri",
    },
  });
  return async (request): Promise<FontConfigurationFragment> => {
    const fragment = await google(request);
    if (fragment.failures.length) console.warn("[docx] font faces that failed to load:", fragment.failures);
    return { sources: fragment.sources, substitutions: fragment.substitutions };
  };
}

// The WebView gives the page no height of its own; the engine needs one. `.h-full`
// is spelled out here rather than left to Tailwind — nativewind does not process
// this document, so the class would otherwise be inert.
const PAGE_CSS = [
  "html,body,#root{height:100%;margin:0;overflow:hidden;background:#f0f0f5}",
  ".h-full{height:100%}",
  // The placeholder stands in for the sheet while the engine settles: A4's ratio at
  // the width the fit will land on, so the reveal is a fill rather than a jump.
  ".sheet-wait{position:absolute;inset:0;display:flex;justify-content:center;padding-top:24px}",
  ".sheet-wait>div{width:86%;aspect-ratio:1/1.414;background:#fff;border-radius:2px;",
  "box-shadow:0 1px 4px rgba(0,0,0,.12);animation:sheet-pulse 1.4s ease-in-out infinite}",
  "@keyframes sheet-pulse{0%,100%{opacity:1}50%{opacity:.6}}",
].join("");

export default function DocxEditorDom({
  apiBase, thesisId, token, command, scrollToIndex, reloadNonce, flushNonce, shaping = true,
  onState, onSave, onReady, onFlushed, onReloaded, onServerFormat, onError,
  dom: _dom,
  // The AI cards (suggestion / range / table / completion) — forwarded whole to
  // the overlay layer; see overlays/types.ts.
  ...overlay
}: OverlayProps & {
  apiBase: string;
  thesisId: string;
  token: string;
  command?: LexicalCommand | null;
  scrollToIndex?: { index: number; text: string; nonce: number } | null;
  reloadNonce?: number;
  flushNonce?: number;
  /** Read once, at mount: the host remounts this component (key) rather than
   *  flipping it, because the shaper is initialised before the first document
   *  opens and cannot be withdrawn from a live engine. */
  shaping?: boolean;
  onState: (s: LexicalState) => Promise<void>;
  onSave?: (s: SaveState) => Promise<void>;
  onReady?: (info: { pages: number; docHash: string | null }) => Promise<void>;
  onFlushed?: (nonce: number) => Promise<void>;
  onReloaded?: (docHash: string | null) => Promise<void>;
  // { index, text } rather than a bare index: the host re-resolves the block by
  // its text before it mutates, because a local structural edit can move it
  // between the report and the op. See bridge/Bridge.tsx.
  onServerFormat?: (target: BlockRef, changes: { direction: "rtl" | "ltr" }) => Promise<void>;
  onError?: (message: string) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}) {
  const ref = useRef<DocxEditorRef>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Every face the document asks for is fetched from a CDN (the Google catalogue is
  // a URL list, ~825KB for Amiri regular+bold alone), and the page cannot be shaped,
  // paginated or FITTED until they land — so `zoomMode="auto"` visibly rescales the
  // sheet two or three times on a cold cache. The student should not watch that
  // happen: the surface stays laid out but hidden behind a page-shaped placeholder
  // until the engine has mounted AND no face is still in flight. Task 27 (bundled
  // Arabic bytes, D9) is what actually makes it fast; this only stops it looking broken.
  const [settled, setSettled] = useState(false);
  const readyRef = useRef(false);
  const inFlightRef = useRef(0);
  const settle = useCallback(() => {
    if (readyRef.current && inFlightRef.current === 0) {
      // Two frames: the last face resolving is not the same tick as the relayout it
      // causes, and revealing between them would show the jump we are hiding.
      requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    }
  }, []);

  const fonts = useMemo<FontResolver>(() => {
    const resolve = makeFontResolver();
    return async (request) => {
      inFlightRef.current += 1;
      try {
        return await resolve(request);
      } finally {
        inFlightRef.current -= 1;
        settle();
      }
    };
  }, [settle]);

  // One save loop per mount; getBytes is bound to the ref so it always saves the
  // editor that is on screen.
  const saveLoop = useMemo(
    () => createSaveLoop({
      apiBase, thesisId,
      token: () => tokenRef.current,
      getBytes: async () => (await ref.current?.save()) ?? null,
      onState: (s) => void onSave?.(s),
    }),
    [apiBase, thesisId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Navigating away must not drop the debounce window: dispose() makes every
  // queued save bail, so the pending bytes are flushed FIRST and the loop is torn
  // down only once that PUT has settled.
  useEffect(() => () => { void saveLoop.flush().catch(() => {}).finally(() => saveLoop.dispose()); }, [saveLoop]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // The shaper must be ready BEFORE the editor opens the bytes (see
        // bridge/shaper.ts). A failure is REPORTED, not fatal: the document
        // still opens with fixed-width metrics (pagination then differs from
        // Word) rather than leaving the student a blank screen — the case an
        // OTA update hits today, since public/ does not travel with updates.
        if (shaping) {
          await ensureShaper().catch((e) => {
            void onError?.(`text shaping is unavailable, so page layout will differ from Word: ${String((e as Error)?.message ?? e)}`);
          });
        } else {
          // Never awaited → the patched harfbuzzjs never instantiates its module,
          // so this WebView runs no WebAssembly at all. The engine's own loader
          // then reports `wasmUnavailable` and measures fixed-width.
          void onError?.("text shaping is off on this host, so page layout will differ from Word");
        }
        const r = await fetchDocument({ apiBase, thesisId, token });
        if (!alive || r.status !== 200) return;
        saveLoop.setHash(r.docHash);
        setBytes(r.bytes);
      } catch (e) {
        if (alive) void onError?.(`could not load the document: ${String(e)}`);
      }
    })();
    return () => { alive = false; };
  }, [apiBase, thesisId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReady = (editor: Editor) => {
    readyRef.current = true;
    settle();
    void onReady?.({ pages: editor.snapshot().page.total, docHash: saveLoop.getHash() });
  };

  // A face the CDN never answers must not leave the student on a placeholder forever;
  // whatever the engine has managed by then is better than nothing.
  useEffect(() => {
    if (!bytes || settled) return;
    const t = setTimeout(() => setSettled(true), 8000);
    return () => clearTimeout(t);
  }, [bytes, settled]);

  const waiting = (
    <div className="sheet-wait"><div /></div>
  );

  if (!bytes) return <div style={{ height: "100%", position: "relative" }}><style>{PAGE_CSS}</style>{waiting}</div>;

  return (
    // `visibility`, never `display:none` — a surface with no layout box cannot be
    // measured, and measurement is exactly what it is busy doing back there.
    <div style={{ height: "100%", position: "relative" }}>
      <style>{PAGE_CSS}</style>
      <div style={{ height: "100%", visibility: settled ? "visible" : "hidden" }}>
        <DocxEditor
          ref={ref}
          document={bytes}
          mode="edit"
          fonts={fonts}
          colorMode="light"
          zoomMode="auto"
          chrome={false}
          onReady={handleReady}
          onFontError={(e) => {
            // Only `wasmUnavailable` is a HOST fault (the engine's own words): no
            // shaper means untrustworthy pagination, so the student must see it.
            // Every other code is a font that failed to load — expected offline
            // (Amiri comes from Google) and already logged by the resolver.
            console.warn("[docx] font error", e.code);
            // When shaping was switched off deliberately this code is the expected
            // consequence, and the host has already been told once.
            if (e.code === "wasmUnavailable" && shaping) void onError?.("font/shaping error: wasmUnavailable");
          }}
          className="h-full"
        >
          <Bridge
            editorRef={ref}
            saveLoop={saveLoop}
            apiBase={apiBase}
            thesisId={thesisId}
            token={token}
            command={command}
            scrollToIndex={scrollToIndex}
            reloadNonce={reloadNonce}
            flushNonce={flushNonce}
            onState={(s) => void onState(s)}
            onFlushed={(n) => void onFlushed?.(n)}
            onReloaded={(h) => void onReloaded?.(h)}
            onServerFormat={(t, c) => void onServerFormat?.(t, c)}
          />
          <OverlayLayer editorRef={ref} {...overlay} />
          </DocxEditor>
      </div>
      {settled ? null : waiting}
    </div>
  );
}
