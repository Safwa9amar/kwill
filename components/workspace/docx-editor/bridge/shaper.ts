// The text shaper (HarfBuzz via harfbuzzjs) under Metro.
//
// Two facts, both learned on the first device run (Phase 1 findings):
//  • The CommonJS engine build that Metro bundles (metro.config.js) REFUSES
//    `setHarfBuzzWasmUrl` — it loads the shaper with `import('harfbuzzjs')` and
//    expects that package to find its own binary.
//  • harfbuzzjs initialises with a top-level await, which Metro wraps in a plain
//    function → `ReferenceError: await is not defined` → the engine reports
//    `wasmUnavailable` and paginates with fixed-width metrics.
//  patches/harfbuzzjs+1.6.1.patch replaces that await with an exported, memoised
//  `load(moduleArg)`. The engine's own loader runs when a document opens and
//  calls `versionString()` right after the import resolves, so the host must
//  have awaited `load()` BEFORE creating the editor — that is ensureShaper().
//
// The binary is `require("harfbuzzjs/dist/harfbuzz.wasm")` (bridge/assets.ts),
// which travels with an EAS Update; it used to be public/harfbuzz.wasm, which
// only a binary build carries.
//
// ⚠️ The patched `load()` memoises its FIRST promise, rejected ones included, so
// within one WebView a failed load is final whatever ensureShaper does — only a
// remount of the surface (a new page) gets a second attempt.

import { load } from "harfbuzzjs";
import { absoluteUrl, assetUrl, pageBase } from "./asset-url";
import { HARFBUZZ_WASM } from "./assets";

/** Where the wasm is served, ABSOLUTE — see asset-url.ts for why a relative path
 *  breaks a release (file://) page. `base` is undefined only under vitest. */
export function wasmUrl(asset: unknown = HARFBUZZ_WASM, base: string | undefined = pageBase()): string {
  return absoluteUrl(assetUrl(asset), base);
}

let pending: Promise<void> | null = null;
let logged = false;

/** Resolves once the shaper is initialised; memoised on success, forgotten on
 *  failure. `locateFile` is the ONLY working path: the factory's own fallback is
 *  `new URL(…, import.meta.url)`, and Expo's import.meta registry answers null
 *  in a DOM bundle. */
export function ensureShaper(o: { load?: typeof load; url?: string } = {}): Promise<void> {
  if (!pending) {
    const url = o.url ?? wasmUrl();
    // Development only: the one place to see what the asset resolved to on a
    // device (the plan's "log it on first run").
    if (!logged && process.env.NODE_ENV !== "production") { logged = true; console.info("[docx] harfbuzz.wasm →", url); }
    pending = (o.load ?? load)({ locateFile: () => url }).catch((e) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}
