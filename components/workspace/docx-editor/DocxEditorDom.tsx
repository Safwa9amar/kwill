'use dom';

// The eigenpal docx-editor, bundled INTO the app as an Expo DOM component.
//
// This is the native counterpart of the web trial at /app/<id>/word: the same
// @docx-editor.dev packages, but resolved by Metro and shipped in the binary,
// so the editor works with no Next.js server in front of it.
//
// ⚠️ babel-preset-expo's use-dom-directive plugin allows this module exactly ONE
// export and it must be the default. A named non-type export is a BUNDLE-time
// failure that renders the host screen blank, and `npx tsc --noEmit` cannot see
// it. The gate is `node scripts/verify-use-dom.mjs`.
//
// TWO ASSET PROBLEMS, because the packages resolve their own bytes with
// `new URL(..., import.meta.url)` — a form Webpack/Vite turn into emitted
// assets and Metro does NOT:
//
//   1. harfbuzz.wasm. Without it the shaper reports `wasmUnavailable` and
//      silently falls back to fixed-width measurement — which would make this
//      render nothing trustworthy about pagination. Fixed by pointing
//      setHarfBuzzWasmUrl at a copy served from public/, which Expo copies into
//      the binary for DOM components. ⚠️ public assets do NOT travel over EAS
//      Update; a package upgrade that changes the wasm needs a REBUILD, and the
//      runtime refuses a version mismatch rather than shaping with unverified
//      metrics.
//
//   2. The bundled font bytes. `loadDefaultFonts()` from @docx-editor.dev/fonts
//      resolves every .ttf the same unsupported way, so it is NOT used here.
//      Fonts come from the package's Google resolver instead, over the network.
//      That is the deliberate trade: no offline fonts yet, in exchange for an
//      editor that loads at all. See makeFontResolver below.

import { useCallback, useEffect, useRef, useState } from "react";
import { DocxEditor } from "@docx-editor.dev/react";
import type { DocxEditorRef, FontConfigurationFragment, FontResolver } from "@docx-editor.dev/react";
import { setHarfBuzzWasmUrl } from "@docx-editor.dev/core/layout";
import { googleFonts } from "@docx-editor.dev/fonts/google";
import "@docx-editor.dev/core/styles/editor.css";

// Expo copies public/ into the binary and serves it to DOM components under
// this base. In dev it is Metro's origin; in a release build, the file:// root.
let wasmConfigured = false;
function ensureWasm(): void {
  if (wasmConfigured) return;
  setHarfBuzzWasmUrl(`${process.env.EXPO_BASE_URL ?? "/"}harfbuzz.wasm`);
  wasmConfigured = true;
}

/**
 * Arabic is the whole point of this app, and Amiri is the only Arabic family in
 * the package's Google catalogue — it is NOT metric-compatible with Traditional
 * Arabic or Sakkal Majalla, so an Arabic thesis paginates like Amiri rather
 * than like Word. Same known limit as the web trial; not a bug to chase here.
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
    if (fragment.failures.length) {
      console.warn("[docx-dom] font faces that failed to load:", fragment.failures);
    }
    return { sources: fragment.sources, substitutions: fragment.substitutions };
  };
}

/**
 * Props cross the DOM-component JSON bridge, so every one is serializable and
 * every callback is async.
 *
 * The document arrives as a URL, NOT as bytes. An ArrayBuffer cannot cross the
 * bridge at all, and base64 could — but a thesis runs to megabytes, and pushing
 * that through a JSON transport would stall the bridge on every open. The
 * WebView has its own network stack, so it fetches the signed URL itself and
 * the bytes never touch the native side.
 */
export default function DocxEditorDom({
  docxUrl,
  onReady,
  onError,
  onDirty,
  dom: _dom,
}: {
  docxUrl: string;
  onReady?: () => Promise<void>;
  onError?: (message: string) => Promise<void>;
  onDirty?: () => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}) {
  const ref = useRef<DocxEditorRef>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);

  useEffect(() => {
    ensureWasm();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(docxUrl);
        if (!res.ok) throw new Error(`${res.status} fetching the document`);
        const buf = await res.arrayBuffer();
        if (!cancelled) setBytes(new Uint8Array(buf));
      } catch (e) {
        if (!cancelled) void onError?.(`could not load the document: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docxUrl, onError]);

  const handleReady = useCallback(() => {
    void onReady?.();
  }, [onReady]);

  const handleChange = useCallback(() => {
    void onDirty?.();
  }, [onDirty]);

  if (!bytes) return null;

  return (
    <DocxEditor
      ref={ref}
      document={bytes}
      fonts={makeFontResolver()}
      onReady={handleReady}
      onChange={handleChange}
    />
  );
}
