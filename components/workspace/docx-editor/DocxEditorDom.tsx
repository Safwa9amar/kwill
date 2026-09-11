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
// OTA-updatable — Task 29 moves it to require()). Without it the shaper reports
// `wasmUnavailable` and silently falls back to fixed-width measurement, which
// would make nothing about pagination trustworthy. Fonts come from the package's
// Google resolver until Task 27 bundles Arabic faces; loadDefaultFonts() is never
// used because its `new URL(…, import.meta.url)` cannot resolve under Metro.

import { useEffect, useMemo, useRef, useState } from "react";
import { DocxEditor } from "@docx-editor.dev/react";
import type { DocxEditorRef, Editor, FontConfigurationFragment, FontResolver } from "@docx-editor.dev/react";
import { setHarfBuzzWasmUrl } from "@docx-editor.dev/core/layout";
import { googleFonts } from "@docx-editor.dev/fonts/google";
import "@docx-editor.dev/core/styles/editor.css";
import type { LexicalCommand, LexicalState } from "@/components/workspace/lexical/editor-components/types";
import { Bridge } from "./bridge/Bridge";
import { fetchDocument } from "./bridge/load-document";
import { createSaveLoop, type SaveState } from "./bridge/save-loop";

let wasmConfigured = false;
function ensureWasm(): void {
  if (wasmConfigured) return;
  setHarfBuzzWasmUrl(`${process.env.EXPO_BASE_URL ?? "/"}harfbuzz.wasm`);
  wasmConfigured = true;
}

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
const PAGE_CSS = "html,body,#root{height:100%;margin:0;overflow:hidden;background:#f0f0f5}.h-full{height:100%}";

export default function DocxEditorDom({
  apiBase, thesisId, token, command, scrollToIndex, reloadNonce, flushNonce,
  onState, onSave, onReady, onFlushed, onReloaded, onServerFormat, onError,
  dom: _dom,
}: {
  apiBase: string;
  thesisId: string;
  token: string;
  command?: LexicalCommand | null;
  scrollToIndex?: { index: number; text: string; nonce: number } | null;
  reloadNonce?: number;
  flushNonce?: number;
  onState: (s: LexicalState) => Promise<void>;
  onSave?: (s: SaveState) => Promise<void>;
  onReady?: (info: { pages: number; docHash: string | null }) => Promise<void>;
  onFlushed?: (nonce: number) => Promise<void>;
  onReloaded?: (docHash: string | null) => Promise<void>;
  onServerFormat?: (index: number, changes: { direction: "rtl" | "ltr" }) => Promise<void>;
  onError?: (message: string) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}) {
  const ref = useRef<DocxEditorRef>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const fonts = useMemo(() => makeFontResolver(), []);

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
  useEffect(() => () => saveLoop.dispose(), [saveLoop]);

  useEffect(() => {
    ensureWasm();
    let alive = true;
    void (async () => {
      try {
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
    void onReady?.({ pages: editor.snapshot().page.total, docHash: saveLoop.getHash() });
  };

  if (!bytes) return <style>{PAGE_CSS}</style>;

  return (
    <div style={{ height: "100%" }}>
      <style>{PAGE_CSS}</style>
      <DocxEditor
        ref={ref}
        document={bytes}
        mode="edit"
        fonts={fonts}
        colorMode="light"
        zoomMode="auto"
        chrome={false}
        onReady={handleReady}
        onFontError={(e) => console.warn("[docx] font error", e.code)}
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
          onServerFormat={(i, c) => void onServerFormat?.(i, c)}
        />
      </DocxEditor>
    </div>
  );
}
