// The DOM surface's binary assets, and the ONLY module that require()s them.
//
// require() — not public/ — because it is the form Expo carries in an EAS Update:
// the asset ships with the update and lands beside the page (see asset-url.ts for
// what each require evaluates to). public/ is copied into the binary only, so an
// OTA that needed a new file there would open with the file missing.
//
// Kept apart so the pure modules around it (shaper.ts, fonts.ts) can be tested
// under node with this file mocked: vitest cannot evaluate a require of a .wasm.
//
// ⚠️ Relative paths, not "@/": a wrong count of ../ is a module-init throw that
// renders the whole editor white, and scripts/verify-use-dom.mjs only follows
// relative specifiers. assets.test.ts resolves every one of these.
// ⚠️ This module must stay out of the NATIVE graph (import it only from the DOM
// side), or the native bundle carries every face a second time.
/* eslint-disable @typescript-eslint/no-require-imports */

/** HarfBuzz from the package itself — never a copy: the patched glue in
 *  harfbuzzjs/dist/index.mjs and this binary must be the same release. */
export const HARFBUZZ_WASM: unknown = require("harfbuzzjs/dist/harfbuzz.wasm");

/** Bundled Arabic faces (spec D9), keyed by file name — fonts-manifest.ts says
 *  what each one is. */
export const FONT_FILES: Readonly<Record<string, unknown>> = {
  "ScheherazadeNew-Regular.ttf": require("../../../../assets/fonts/docx/ScheherazadeNew-Regular.ttf"),
  "ScheherazadeNew-Bold.ttf": require("../../../../assets/fonts/docx/ScheherazadeNew-Bold.ttf"),
  "NotoNaskhArabic-Regular.ttf": require("../../../../assets/fonts/docx/NotoNaskhArabic-Regular.ttf"),
  "NotoNaskhArabic-Bold.ttf": require("../../../../assets/fonts/docx/NotoNaskhArabic-Bold.ttf"),
  "Amiri-Regular.ttf": require("../../../../assets/fonts/docx/Amiri-Regular.ttf"),
  "Amiri-Bold.ttf": require("../../../../assets/fonts/docx/Amiri-Bold.ttf"),
  "Amiri-Italic.ttf": require("../../../../assets/fonts/docx/Amiri-Italic.ttf"),
  "Amiri-BoldItalic.ttf": require("../../../../assets/fonts/docx/Amiri-BoldItalic.ttf"),
};
