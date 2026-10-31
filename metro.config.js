const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// The docx surface require()s harfbuzz.wasm (components/workspace/docx-editor/
// bridge/assets.ts) so the shaper's binary travels with an EAS Update; Metro only
// treats a require as an asset when its extension is listed here. `ttf` is a
// default already.
if (!config.resolver.assetExts.includes("wasm")) config.resolver.assetExts.push("wasm");

// @docx-editor.dev/core: resolve its CommonJS build, not its ESM one.
//
// Metro wraps every module in a NON-ASYNC function, so it cannot bundle a
// top-level await — and this package's ESM build ends with one
// (`Tr(await It())`, the inlined harfbuzzjs wasm init). That is a hard syntax
// error in the wrapper, which is why `expo export` failed identically with
// minification ON and OFF: the minifier was never involved.
//
// The CJS build of the same version has no top-level await — it defers the
// same init behind a lazy `import('harfbuzzjs')`. The subpaths are rewritten to
// `.cjs` BY PATH rather than through `unstable_conditionNames`, because Metro
// derives the import/require condition from the IMPORTING module's type: our
// DOM component is an ES module, so "import" is always in the active set and a
// condition override can never win.
//
// Scoped to this one package. Its .cjs chunks require each other relatively, so
// the CJS graph stays self-consistent and nothing else resolves differently.
const CORE = "@docx-editor.dev/core";
const coreDist = path.join(__dirname, "node_modules", CORE, "dist");
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  if (moduleName === CORE || moduleName.startsWith(CORE + "/")) {
    const sub = moduleName === CORE ? "index" : moduleName.slice(CORE.length + 1);
    // Leave non-JS subpaths (the stylesheet, the wasm) to the normal resolver.
    if (!/\.(css|wasm)$/.test(sub)) {
      const cjs = path.join(coreDist, sub + ".cjs");
      if (fs.existsSync(cjs)) return { type: "sourceFile", filePath: cjs };
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
