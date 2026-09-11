// The text shaper under Metro. Two facts this pins down (spec: Phase 1 findings):
//  1. harfbuzzjs initialises with a top-level await, which Metro wraps in a
//     plain function → `ReferenceError: await is not defined` in the WebView.
//     patches/harfbuzzjs+1.6.0.patch replaces it with an exported lazy load().
//  2. The CommonJS engine build refuses setHarfBuzzWasmUrl; the wasm location
//     is handed to the Emscripten factory through locateFile instead.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ensureShaper, wasmUrl } from "./shaper";

const require = createRequire(import.meta.url);
const indexMjs = readFileSync(require.resolve("harfbuzzjs"), "utf8");

describe("harfbuzzjs patch", () => {
  it("has no top-level await and exports load()", () => {
    expect(indexMjs).not.toMatch(/^init\(await createHarfBuzz\(\)\);/m);
    expect(indexMjs).toMatch(/\bload\b/);
  });
  it("initialises lazily and reports the engine's expected HarfBuzz version", async () => {
    const hb = await import("harfbuzzjs");
    expect(typeof hb.load).toBe("function");
    await hb.load();
    expect(hb.versionString()).toBe("14.3.0");
  });
});

describe("wasmUrl", () => {
  it("prefixes the public asset with EXPO_BASE_URL (Expo's documented DOM-component form)", () => {
    expect(wasmUrl("http://192.168.1.2:8081/")).toBe("http://192.168.1.2:8081/harfbuzz.wasm");
    expect(wasmUrl("")).toBe("harfbuzz.wasm");
    expect(wasmUrl(undefined)).toBe("harfbuzz.wasm");
  });
});

describe("ensureShaper", () => {
  it("loads once with a locateFile that answers the wasm URL, and memoises", async () => {
    const load = vi.fn(async () => {});
    const p1 = ensureShaper({ load, baseUrl: "http://x/" });
    const p2 = ensureShaper({ load, baseUrl: "http://x/" });
    await p1; await p2;
    expect(load).toHaveBeenCalledTimes(1);
    const arg = (load.mock.calls[0] as unknown as [{ locateFile: (p: string) => string }])[0];
    expect(arg.locateFile("harfbuzz.wasm")).toBe("http://x/harfbuzz.wasm");
  });
});
