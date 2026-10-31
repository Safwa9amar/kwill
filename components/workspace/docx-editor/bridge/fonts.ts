// The font resolver the DOM surface hands the engine: bundled Arabic faces first
// (spec D9, no network — see fonts-manifest.ts), the Google catalogue for the
// rest (Calibri → Carlito, Cambria → Caladea, Times New Roman → Tinos, Arial →
// Arimo …). loadDefaultFonts() is never used: its `new URL(…, import.meta.url)`
// cannot resolve under Metro.
//
// The engine waits for this whole answer before it can shape, paginate and fit a
// page, so its latency IS the time the student looks at the placeholder. The
// bundled half is a local read; a family it covers is withheld from Google, so a
// thesis set in Traditional Arabic no longer waits on ~825KB of Amiri from a CDN
// — nor opens offline with no Arabic metrics at all.

import { googleFonts } from "@docx-editor.dev/fonts/google";
import type { FontConfigurationFragment, FontResolutionRequest, FontResolver } from "@docx-editor.dev/react";
import { absoluteUrl, assetUrl, loadAssetBytes, pageBase } from "./asset-url";
import { FONT_FILES } from "./assets";
import { bundledSourceId, planBundledFonts, type BundledFace, type FaceRequest } from "./fonts-manifest";

// Only reached for a family the bundle could not serve (a face failed to load —
// a packaging fault, logged): the old behaviour, Amiri from the catalogue.
const ARABIC_VIA_GOOGLE: Readonly<Record<string, string>> = {
  "Traditional Arabic": "Amiri",
  "Simplified Arabic": "Amiri",
  "Arabic Typesetting": "Amiri",
  "Sakkal Majalla": "Amiri",
};

// Per page, not per editor: a reload or a crash-free remount inside the same
// WebView asks for the same faces, and a local read is still a few MB to copy.
const bytesCache = new Map<string, Promise<Uint8Array>>();

function loadFaceBytes(face: BundledFace): Promise<Uint8Array> {
  let p = bytesCache.get(face.file);
  if (!p) {
    p = Promise.resolve()
      .then(() => loadAssetBytes(absoluteUrl(assetUrl(FONT_FILES[face.file]), pageBase())))
      .then((bytes) => {
        // Cheap and specific; the engine still re-derives the hash at admission.
        if (bytes.byteLength !== face.byteLength) throw new Error(`${face.file}: ${bytes.byteLength} bytes, expected ${face.byteLength}`);
        return bytes;
      });
    p.catch(() => bytesCache.delete(face.file));
    bytesCache.set(face.file, p);
  }
  return p;
}

type GoogleLike = (request: FontResolutionRequest) => Promise<{
  sources: FontConfigurationFragment["sources"];
  substitutions: FontConfigurationFragment["substitutions"];
  failures: readonly unknown[];
}>;

export function makeFontResolver(o: {
  loadFace?: (face: BundledFace) => Promise<Uint8Array>;
  google?: GoogleLike;
} = {}): FontResolver {
  const loadFace = o.loadFace ?? loadFaceBytes;
  const google: GoogleLike = o.google ?? (googleFonts({ substitute: ARABIC_VIA_GOOGLE }) as unknown as GoogleLike);
  return async (request): Promise<FontConfigurationFragment> => {
    const plan = planBundledFonts(request.families, request.defaultFamily, request.resolvedFaces);
    const loaded = await Promise.all(plan.faces.map(async (face) => {
      try {
        return { face, bytes: await loadFace(face) };
      } catch (e) {
        console.warn("[docx] bundled font face failed to load:", face.file, String((e as Error)?.message ?? e));
        return { face, bytes: null };
      }
    }));
    const ok = new Map(loaded.filter((l) => l.bytes).map((l) => [`${l.face.family} ${l.face.weight} ${l.face.style}`, l]));
    const has = (f: FaceRequest) => ok.has(`${f.family} ${f.weight} ${f.style}`);
    const sources = [...ok.values()].map(({ face, bytes }) => ({
      request: { family: face.family, weight: face.weight, style: face.style },
      id: bundledSourceId(face),
      bytes: bytes as Uint8Array,
      hash: face.hash,
      faceIndex: 0,
    }));
    const substitutions = plan.substitutions.filter((s) => has(s.to));
    // A requested family counts as covered only if the faces it needs arrived;
    // otherwise it falls through to the catalogue rather than to nothing.
    const covered = new Set(
      plan.families
        .filter(({ requested, via, direct }) => direct
          ? sources.some((s) => s.request.family === via)
          : substitutions.some((s) => s.from.family === requested))
        .map(({ requested }) => requested.trim().toLowerCase()),
    );
    const paintable: FaceRequest[] = [
      ...(request.resolvedFaces ?? []),
      ...sources.map((s) => s.request),
      ...substitutions.map((s) => s.from),
    ];
    const rest = await google({
      ...request,
      families: request.families.filter((f) => !covered.has(f.trim().toLowerCase())),
      resolvedFaces: paintable,
    }).catch((e) => {
      console.warn("[docx] font catalogue unavailable:", String((e as Error)?.message ?? e));
      return { sources: [], substitutions: [], failures: [] };
    });
    if (rest.failures.length) console.warn("[docx] font faces that failed to load:", rest.failures);
    return {
      sources: [...sources, ...(rest.sources ?? [])],
      substitutions: [...substitutions, ...(rest.substitutions ?? [])],
    };
  };
}
