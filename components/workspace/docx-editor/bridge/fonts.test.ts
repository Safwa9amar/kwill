import { describe, it, expect, vi } from "vitest";

// assets.ts require()s the font files, which only Metro can evaluate.
vi.mock("./assets", () => ({ HARFBUZZ_WASM: "h.wasm", FONT_FILES: {} }));

import type { FontResolutionRequest } from "@docx-editor.dev/react";
import { makeFontResolver } from "./fonts";
import type { BundledFace } from "./fonts-manifest";

const bytesFor = (f: BundledFace) => new Uint8Array(f.byteLength);
const req = (families: string[]): FontResolutionRequest => ({ families, defaultFamily: "Calibri" });

describe("makeFontResolver", () => {
  it("serves the bundled faces and withholds the families they cover from the catalogue", async () => {
    const google = vi.fn(async () => ({ sources: [], substitutions: [], failures: [] }));
    const fonts = makeFontResolver({ loadFace: async (f) => bytesFor(f), google });
    const out = await fonts(req(["Traditional Arabic", "Calibri"]));
    const frag = out as unknown as { sources: { id: string; hash: string; faceIndex: number }[]; substitutions: unknown[] };
    expect(frag.sources.map((s) => s.id)).toEqual([
      "kwill-bundled:Scheherazade New#400#normal",
      "kwill-bundled:Scheherazade New#700#normal",
    ]);
    expect(frag.sources[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(frag.sources[0].faceIndex).toBe(0);
    expect(frag.substitutions).toHaveLength(4);
    const asked = (google.mock.calls[0] as unknown as [FontResolutionRequest])[0];
    expect(asked.families).toEqual(["Calibri"]);
    // Told what is already paintable, so it cannot fetch Amiri for Traditional Arabic.
    expect(asked.resolvedFaces).toContainEqual({ family: "Traditional Arabic", weight: 400, style: "normal" });
  });
  it("falls back to the catalogue for a family whose bundled faces did not load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = vi.fn(async () => ({ sources: [], substitutions: [], failures: [] }));
    const fonts = makeFontResolver({ loadFace: async () => { throw new Error("gone"); }, google });
    const out = await fonts(req(["Sakkal Majalla"])) as unknown as { sources: unknown[]; substitutions: unknown[] };
    expect(out.sources).toEqual([]);
    expect(out.substitutions).toEqual([]);
    expect((google.mock.calls[0] as unknown as [FontResolutionRequest])[0].families).toEqual(["Sakkal Majalla"]);
    warn.mockRestore();
  });
  it("keeps the bundled faces when the catalogue is unreachable (offline open)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fonts = makeFontResolver({ loadFace: async (f) => bytesFor(f), google: async () => { throw new Error("offline"); } });
    const out = await fonts(req(["Simplified Arabic", "Calibri"])) as unknown as { sources: unknown[] };
    expect(out.sources).toHaveLength(4);
    warn.mockRestore();
  });
});
