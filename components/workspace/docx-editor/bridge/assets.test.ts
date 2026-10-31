// Every require() in assets.ts must resolve — a wrong one is a module-init throw
// that renders the editor white, and nothing else checks a bare (package) path.
// The file is read as TEXT: vitest cannot evaluate a require of a .wasm/.ttf.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_FACES } from "./fonts-manifest";

const FILE = fileURLToPath(new URL("./assets.ts", import.meta.url));
const SRC = readFileSync(FILE, "utf8");
const specs = [...SRC.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
const req = createRequire(FILE);

describe("bridge/assets.ts", () => {
  it("every required asset exists", () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      const path = s.startsWith(".") ? resolve(dirname(FILE), s) : req.resolve(s);
      expect(existsSync(path), s).toBe(true);
    }
  });
  it("requires the wasm from the package, never a copy", () => {
    expect(specs).toContain("harfbuzzjs/dist/harfbuzz.wasm");
  });
  it("has a FONT_FILES entry for every face in the manifest, with the same file name", () => {
    for (const f of BUNDLED_FACES) {
      expect(SRC, f.file).toContain(`"${f.file}": require("../../../../assets/fonts/docx/${f.file}")`);
    }
  });
});
