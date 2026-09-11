// The text shaper (HarfBuzz via harfbuzzjs) under Metro.
//
// Two facts, both learned on the first device run (Phase 1 findings):
//  • The CommonJS engine build that Metro bundles (metro.config.js) REFUSES
//    `setHarfBuzzWasmUrl` — it loads the shaper with `import('harfbuzzjs')` and
//    expects that package to find its own binary.
//  • harfbuzzjs initialises with a top-level await, which Metro wraps in a plain
//    function → `ReferenceError: await is not defined` → the engine reports
//    `wasmUnavailable` and paginates with fixed-width metrics.
//  patches/harfbuzzjs+1.6.0.patch replaces that await with an exported, memoised
//  `load(moduleArg)`. The engine's own loader runs when a document opens and
//  calls `versionString()` right after the import resolves, so the host must
//  have awaited `load()` BEFORE creating the editor — that is ensureShaper().
//
// The binary is a public asset. Expo copies `public/` into the binary for DOM
// components and documents `${process.env.EXPO_BASE_URL}file` as the reference
// form (docs.expo.dev/guides/dom-components). Not EAS-Update-safe — Task 29
// moves it to require().

import { load } from "harfbuzzjs";

export function wasmUrl(baseUrl: string | undefined = process.env.EXPO_BASE_URL): string {
  return `${baseUrl ?? ""}harfbuzz.wasm`;
}

let pending: Promise<void> | null = null;

export function ensureShaper(o: { load?: typeof load; baseUrl?: string } = {}): Promise<void> {
  if (!pending) {
    const url = wasmUrl(o.baseUrl);
    pending = (o.load ?? load)({ locateFile: () => url });
  }
  return pending;
}
