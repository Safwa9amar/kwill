// Bundled Arabic faces (spec D9) and the Word families they stand in for. Pure:
// no engine, no DOM — fonts.ts does the loading, this decides WHAT to load.
//
// Why bundle at all: the engine cannot shape, paginate or fit a page until every
// face the document names has bytes, and the only Arabic family in the Google
// catalogue is Amiri, ~825KB fetched from jsdelivr on a cold cache — a slow
// first open, and an offline open with no Arabic metrics at all. These ship in
// the app (bridge/assets.ts) and resolve with no network.
//
// Sources (all SIL OFL 1.1; licence beside each file in assets/fonts/docx/):
//  • Amiri — google/fonts@ea14f3c4c462af1d847b1abe96fcb3c3a8a66f97 ofl/amiri, the
//    SAME commit the engine's Google catalogue pins, so the hashes below equal
//    the catalogue's (fonts-manifest.test.ts checks both).
//  • Scheherazade New — google/fonts@ea14f3c4… ofl/scheherazadenew (static faces).
//  • Noto Naskh Arabic — notofonts/arabic release NotoNaskhArabic-v2.021,
//    unhinted/ttf. NOT google/fonts: it ships that family variable-only, and the
//    shaper refuses variation axes (bold would render at regular weight).
//
// byteLength/hash are what `node scripts/measure-docx-fonts.mjs` prints; the
// engine re-derives the sha256 at admission and refuses a mismatch, so a file
// swapped without updating this table fails loudly rather than silently.

export type FaceStyle = "normal" | "italic";
export type FaceRequest = { readonly family: string; readonly weight: number; readonly style: FaceStyle };
export type LineMetrics = { readonly heightEm: number; readonly baselineEm: number };
export type Substitution = { readonly from: FaceRequest; readonly to: FaceRequest; readonly lineMetrics?: LineMetrics };

export type BundledFamily = "Scheherazade New" | "Noto Naskh Arabic" | "Amiri";

export type BundledFace = {
  readonly family: BundledFamily;
  readonly weight: 400 | 700;
  readonly style: FaceStyle;
  /** Key into bridge/assets.ts FONT_FILES — the file name under assets/fonts/docx/. */
  readonly file: string;
  readonly byteLength: number;
  readonly hash: string;
};

export const BUNDLED_FACES: readonly BundledFace[] = [
  { family: "Scheherazade New", weight: 400, style: "normal", file: "ScheherazadeNew-Regular.ttf", byteLength: 331504, hash: "sha256:794bac8dc9e83d1d620bc471ea694f5f31d0965ce8006490a79dfc51a2d283b3" },
  { family: "Scheherazade New", weight: 700, style: "normal", file: "ScheherazadeNew-Bold.ttf", byteLength: 593472, hash: "sha256:91363517a63dbc7448b5814226d33d845b26b32a461cd159ea0b3f23c7effd2d" },
  { family: "Noto Naskh Arabic", weight: 400, style: "normal", file: "NotoNaskhArabic-Regular.ttf", byteLength: 158580, hash: "sha256:c34fdbd98af4dbc45ca192a23d2eeb77032add83086f5fe32957d23b3f36b221" },
  { family: "Noto Naskh Arabic", weight: 700, style: "normal", file: "NotoNaskhArabic-Bold.ttf", byteLength: 158172, hash: "sha256:380ac34b249d336e1a43c21053df440594e1e3db8f75fabd4d85b649ca1ea4c6" },
  { family: "Amiri", weight: 400, style: "normal", file: "Amiri-Regular.ttf", byteLength: 431116, hash: "sha256:ab391c4147d054c48976e98322ad0eefe1427aa0e0502a12a4c75d80a70cfcd7" },
  { family: "Amiri", weight: 700, style: "normal", file: "Amiri-Bold.ttf", byteLength: 413480, hash: "sha256:cfccb794268e7d573d857e6d6a67f89cf8a053e8ffd85dfa0c8ec1bb36fc4827" },
  { family: "Amiri", weight: 400, style: "italic", file: "Amiri-Italic.ttf", byteLength: 428532, hash: "sha256:770e4da44d0459c0ddd6484483d475b95f2d088dd27ce472427624081eb68c70" },
  { family: "Amiri", weight: 700, style: "italic", file: "Amiri-BoldItalic.ttf", byteLength: 409692, hash: "sha256:241300e2dcb2c541ac3617872960d99683d261e4f526dc4691d0727e7bef130b" },
];

/**
 * The proprietary Word families → the bundled face that paints them, with the
 * WORD face's line box.
 *
 * `lineMetrics` is the REQUESTED face's, not the substitute's — the engine's
 * contract says "Word line-box metrics for the requested face", and the fonts
 * package's own Century Gothic entry carries Century Gothic's numbers (measured:
 * 1.19140625 / 0.97119140625, identical). Word sizes a single-spaced line from
 * the face's Windows metrics: heightEm = (usWinAscent + usWinDescent) / UPM,
 * baselineEm = usWinAscent / UPM. These are what keep pagination near Word's:
 * without them a Traditional Arabic line would take Scheherazade New's own box
 * (2.0–2.4em, depending on which of its metrics the engine reads) instead of
 * 1.49em, and a page of body text would run far longer than Word's.
 *
 * Measured 2026-10-31 with scripts/measure-docx-fonts.mjs from Microsoft's
 * REGULAR faces (the files are not in the repo):
 *   Traditional Arabic  UPM 2048, win 2036/1025 → 1.49462890625 / 0.994140625
 *   Sakkal Majalla      UPM 2048, win 1810/1050 → 1.396484375   / 0.8837890625
 *   Simplified Arabic   UPM 2048, win 2416/979  → 1.65771484375 / 1.1796875
 * ⚠️ Applied to the bold/italic requests too: the bold Word files were not at hand
 * to measure, and the regular's box is a far closer guess than the substitute's.
 * ⚠️ Arabic Typesetting has none — no copy of the face was available to measure —
 * so its lines take Amiri's own box and run tall.
 *
 * The pairings are by design (Naskh for Naskh) and NOT metric-compatible: line
 * breaks inside a paragraph still differ from Word, only the line box matches.
 */
export const WORD_ARABIC_SUBSTITUTES: Readonly<Record<string, { to: BundledFamily; lineMetrics: LineMetrics | null }>> = {
  "Traditional Arabic": { to: "Scheherazade New", lineMetrics: { heightEm: 1.49462890625, baselineEm: 0.994140625 } },
  "Sakkal Majalla": { to: "Noto Naskh Arabic", lineMetrics: { heightEm: 1.396484375, baselineEm: 0.8837890625 } },
  "Simplified Arabic": { to: "Amiri", lineMetrics: { heightEm: 1.65771484375, baselineEm: 1.1796875 } },
  "Arabic Typesetting": { to: "Amiri", lineMetrics: null },
};

const WORD_FACES: readonly { weight: 400 | 700; style: FaceStyle }[] = [
  { weight: 400, style: "normal" },
  { weight: 700, style: "normal" },
  { weight: 400, style: "italic" },
  { weight: 700, style: "italic" },
];

const lower = (s: string) => s.trim().toLowerCase();
const faceKey = (f: FaceRequest) => `${lower(f.family)} ${f.weight} ${f.style}`;

/** The bundled face that best paints `want`: exact, else the upright face of the
 *  same weight (Arabic has no true italic; Word slants it), else regular. */
export function bestFace(family: BundledFamily, want: { weight: number; style: FaceStyle }): BundledFace {
  const faces = BUNDLED_FACES.filter((f) => f.family === family);
  return faces.find((f) => f.weight === want.weight && f.style === want.style)
    ?? faces.find((f) => f.weight === want.weight && f.style === "normal")
    ?? faces.find((f) => f.weight === 400 && f.style === "normal")
    ?? faces[0];
}

export type BundledPlan = {
  /** Faces to load, deduped, in table order. */
  faces: BundledFace[];
  /** Word face → bundled face redirects. */
  substitutions: Substitution[];
  /** Requested families (as the document spelled them) this plan answers, and
   *  which bundled family each one needs. */
  families: { requested: string; via: BundledFamily; direct: boolean }[];
};

/**
 * What to load for one resolver call: every bundled face of each requested
 * family we can answer (a bundled family named directly, or a Word family we
 * substitute), plus the substitutions. Families are matched case-insensitively,
 * as Word and both shipped resolvers do. A family whose every face an earlier
 * origin already paints (`resolvedFaces`) is left alone.
 */
export function planBundledFonts(
  families: readonly string[],
  defaultFamily?: string,
  resolvedFaces: readonly FaceRequest[] = [],
): BundledPlan {
  const resolved = new Set(resolvedFaces.map(faceKey));
  const subByName = new Map(Object.entries(WORD_ARABIC_SUBSTITUTES).map(([k, v]) => [lower(k), v]));
  const bundledByName = new Map(BUNDLED_FACES.map((f) => [lower(f.family), f.family]));
  const faces = new Set<BundledFace>();
  const substitutions: Substitution[] = [];
  const answered: BundledPlan["families"] = [];
  const seen = new Set<string>();
  for (const requested of [defaultFamily, ...families]) {
    if (!requested || seen.has(lower(requested))) continue;
    seen.add(lower(requested));
    const direct = bundledByName.get(lower(requested));
    if (direct) {
      const own = BUNDLED_FACES.filter((f) => f.family === direct);
      if (own.every((f) => resolved.has(faceKey(f)))) continue;
      own.forEach((f) => faces.add(f));
      answered.push({ requested, via: direct, direct: true });
      continue;
    }
    const sub = subByName.get(lower(requested));
    if (!sub) continue;
    if (WORD_FACES.every((w) => resolved.has(faceKey({ family: requested, ...w })))) continue;
    for (const w of WORD_FACES) {
      const to = bestFace(sub.to, w);
      faces.add(to);
      substitutions.push({
        from: { family: requested, weight: w.weight, style: w.style },
        to: { family: to.family, weight: to.weight, style: to.style },
        ...(sub.lineMetrics ? { lineMetrics: sub.lineMetrics } : {}),
      });
    }
    answered.push({ requested, via: sub.to, direct: false });
  }
  return { faces: BUNDLED_FACES.filter((f) => faces.has(f)), substitutions, families: answered };
}

/** The id a bundled face's FontSource carries — stable, so the engine's byte cache
 *  recognises the same face across reloads. */
export const bundledSourceId = (f: BundledFace) => `kwill-bundled:${f.family}#${f.weight}#${f.style}`;
