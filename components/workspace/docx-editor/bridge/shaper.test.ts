// The text shaper under Metro. What this pins down (spec: Phase 1 findings, Task 29):
//  1. harfbuzzjs initialises with a top-level await, which Metro wraps in a
//     plain function → `ReferenceError: await is not defined` in the WebView.
//     patches/harfbuzzjs+1.6.1.patch replaces it with an exported lazy load().
//  2. The CommonJS engine build refuses setHarfBuzzWasmUrl; the wasm location
//     is handed to the Emscripten factory through locateFile instead.
//  3. That location is the require()d asset, made absolute against the page.
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

// assets.ts require()s the .wasm, which only Metro can evaluate.
vi.mock("./assets", () => ({ HARFBUZZ_WASM: "85bc9865c6f12977df5388d08a271f76.wasm", FONT_FILES: {} }));

import { ensureShaper, wasmUrl } from "./shaper";

const require = createRequire(import.meta.url);
const indexMjs = readFileSync(require.resolve("harfbuzzjs"), "utf8");

describe("harfbuzzjs patch", () => {
  it("has no top-level await and exports load()", () => {
    expect(indexMjs).not.toMatch(/^init\(await createHarfBuzz\(\)\);/m);
    expect(indexMjs).toMatch(/\bload\b/);
  });
  it("initialises lazily and reports the HarfBuzz version the bundled engine demands", async () => {
    const hb = await import("harfbuzzjs");
    expect(typeof hb.load).toBe("function");
    await hb.load();
    // Read from the engine build Metro bundles rather than pinned here: the engine
    // refuses any other version (`shapingLibraryMismatch`), so the two packages
    // must move together — this caught 1.6.1 (14.4.0) against a test still
    // expecting 1.6.0's 14.3.0.
    const engine = readdirSync(dirname(require.resolve("@docx-editor.dev/core/package.json")) + "/dist")
      .filter((f) => f.endsWith(".cjs"))
      .map((f) => readFileSync(dirname(require.resolve("@docx-editor.dev/core/package.json")) + "/dist/" + f, "utf8"))
      .map((src) => /name:"HarfBuzz",version:"([^"]+)"/.exec(src)?.[1])
      .find(Boolean);
    expect(engine).toMatch(/^\d+\.\d+\.\d+$/);
    expect(hb.versionString()).toBe(engine);
  });
  it("the package ships the binary the assets module requires, beside the glue it matches", () => {
    // require.resolve honours the package's "./dist/*.wasm" export — the same
    // resolution Metro does for bridge/assets.ts.
    const wasm = require.resolve("harfbuzzjs/dist/harfbuzz.wasm");
    expect(wasm.endsWith("harfbuzzjs/dist/harfbuzz.wasm")).toBe(true);
    const bytes = readFileSync(wasm);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d])); // \0asm
  });
});

describe("wasmUrl", () => {
  it("resolves each build's asset string against the page into an absolute URL", () => {
    // dev: Metro serves it from its own root
    expect(wasmUrl("/assets?unstable_path=.%2Fnode_modules%2Fharfbuzzjs%2Fdist/harfbuzz.wasm", "http://192.168.1.2:8081/_expo/@dom/abc.html"))
      .toBe("http://192.168.1.2:8081/assets?unstable_path=.%2Fnode_modules%2Fharfbuzzjs%2Fdist/harfbuzz.wasm");
    // export:embed: inside www.bundle, next to the page
    expect(wasmUrl("assets/node_modules/harfbuzzjs/dist/harfbuzz.85bc.wasm", "file:///android_asset/www.bundle/abc.html"))
      .toBe("file:///android_asset/www.bundle/assets/node_modules/harfbuzzjs/dist/harfbuzz.85bc.wasm");
    // EAS Update: flat, beside the page
    expect(wasmUrl("85bc.wasm", "file:///data/user/0/com.kwill.app/files/.expo-internal/def.html"))
      .toBe("file:///data/user/0/com.kwill.app/files/.expo-internal/85bc.wasm");
  });
  it("is absolute on a file:// page, so Emscripten takes its XHR path rather than fetch", () => {
    expect(wasmUrl("85bc.wasm", "file:///x/y.html").startsWith("file://")).toBe(true);
  });
  it("defaults to the required asset (no page under vitest → left as is)", () => {
    expect(wasmUrl()).toBe("85bc9865c6f12977df5388d08a271f76.wasm");
  });
});

describe("ensureShaper", () => {
  it("forgets a failed load so the next call retries, then memoises the success", async () => {
    const failing = vi.fn(async () => { throw new Error("404"); });
    await expect(ensureShaper({ load: failing, url: "http://x/a.wasm" })).rejects.toThrow("404");
    const load = vi.fn(async () => {});
    const p1 = ensureShaper({ load, url: "http://x/a.wasm" });
    const p2 = ensureShaper({ load, url: "http://x/a.wasm" });
    await p1; await p2;
    expect(failing).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    const arg = (load.mock.calls[0] as unknown as [{ locateFile: (p: string) => string }])[0];
    expect(arg.locateFile("harfbuzz.wasm")).toBe("http://x/a.wasm");
  });
});
