# Rescue v2 — M2a: Reset, Regenerate core, Prove, preview (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first corpus thesis (t03: Arabic, print-shop template, 34 pages) comes out fully rescued. Its presentation layer is wiped inside the student's own file, every layer is rebuilt from the rules and the map, every Prove check passes on the real PDF, and a watermarked two-page preview is produced.

**Architecture:**
- **Engine:** four byte-safe operations. They work only on the block strings or by string surgery, because the xml2js-based managers regroup `<w:body>` and must never touch a real thesis.
- **Server:** `src/lib/rescue/` gains `reset/`, `regenerate/` (one module per step), `prove/` and `preview/`. Every module is a pure function from a docx buffer, inventory, roles and rules to a docx buffer plus a report.
- **Lab CLI:** a `rescue` command chains the stages and renders through Word. The brain (Claude) reviews the pages by hand. Review as an automated brain stage is M3.

**Tech stack:** TypeScript, vitest, `@kwill/docx-engine`, the server's pure helpers:
- `mcp/doc-page-numbering.ts` `applyFrontMatterNumbering`;
- `lib/hf-template-ooxml.ts` `compileTemplateForApply`;
- `mcp/doc-section-link.ts`;
- `lib/docx-empty-blocks.ts`;
- `lib/thesis-house-norms.ts`.

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md` §3 (invariants), §5 (Regenerate), §11 and §12 M2.

**Fact sheet:** the M2 explorer report, 2026-11-02 (summarised under "Constraints").

**Scope:**
- **In M2a:** Regenerate steps 1, 2, 3, 4, 5, 6, 9, 10 and 12, plus Reset, Prove and the preview.
- **Moved to M2b:**
  - step 7, generated covers (D-4/D-5); M2a keeps the student's cover untouched;
  - step 8, divider pages and frames; M2a keeps existing divider pages as styled pages;
  - step 11, sorted references, which needs the student's confirmation;
  - typed notes converted into real footnotes;
  - production font files;
  - the deposit pack.

---

## Constraints (from the fact sheet; read before any task)

- **Never use the xml2js-backed managers on a thesis.** They regroup `<w:body>` children, so every table moves to the end. These are:
  - `PageLayoutManager.setMargins/setPageSize*/setOrientation/insertBreak` and `Doc.setMargins/setPageSize/setOrientation`;
  - `SectionManager.setSectionLayout`;
  - `Header/FooterManager.formatPageNumbers/setDifferentFirstPage/set*Distance`;
  - `Mdocxengine.applyFrontMatterNumbering` (use the server's `mcp/doc-page-numbering.ts` instead);
  - `ShapeManager.*`, `CitationManager.insertBibliography`, `CrossReferenceManager.addBookmark`;
  - `FootnoteManager.addFootnote`;
  - `StylesManager.addStyle/removeStyle`;
  - `DocumentManager.setBlockStyle/setBlockAlignment/setBlockDirection/clearBlockFormatting`;
  - `Doc.setHeadingLevel`, which also rebuilds the paragraph from plain text and destroys footnote references.
- **Safe write path:**
  - `engine.document.getBlocks()`, then edit the XML strings, then `saveBlocks(blocks)`;
  - `insertBlockAt` / `deleteBlockAt`;
  - `updateParagraphProps` (exported);
  - `StylesManager.setStyleRunProps` (string surgery);
  - `SectionManager.addSectionBreak/removeSectionBreak/setSectionFooter/setSectionPageNumbering`;
  - `Doc.applySectionChrome`, `Doc.setSectionFooter`, `Doc.startOnNewPage`;
  - the `CaptionManager` and `TableOfContentsManager` insert APIs (block path).
- **Server modules that are off limits** (they reach the DB or supabase): every `src/mcp/tools/*` file, `lib/hf-template-apply.ts`, `lib/divider-*`, `lib/page-ornament-render.ts`, `lib/docx.ts`, plus everything the guard already forbids. The guard test enforces this.
- **Run the doctor after every write stage.** Use `checkDocxBuffer` from the engine. Copy the ~20-line `doctorBuffer` from `thesis-structure.ts:619` into `rescue/prove/doctor.ts`; do not import it.

## Ground rules

- **Repos:**
  - The server is `~/kwill-server` on branch `master`.
  - The engine is `~/mdocxengine` on branch `main`. Run `npm run build` after any engine change; the server consumes `dist/` through a file dependency.
  - Engine gate: new code at 100% coverage, and no new failing spec.
- **Git:**
  - **Commit with `git commit -m "…" -- <paths>`.** Parallel agents share the index.
  - Never stage, revert or touch other sessions' edits. If a file has foreign hunks, use the index trick (HEAD version + your change → `git hash-object -w` → `git update-index --cacheinfo`).
  - End commit messages with your model's `Co-Authored-By:` line. Fixes are new commits; never amend.
  - Do not stage `dist/` in the engine.
- **TypeScript:** tsconfig is `strict: false`. Use flat result interfaces, relative imports with no `.js` extension, and `\u` escapes for Arabic in regexes and constants.
- **Privacy:** `lab/` holds students' theses. Never print thesis text in reports, commits or test output. Tests use `assets/thesis-base.docx`, `~/mdocxengine/samples/*` read by path, or inline XML.
- **Checks:** `npx vitest run src/lib/rescue src/lib/render`, `npx tsc --noEmit`, and the scripts type-check: `npx tsc --noEmit --ignoreConfig --strict false --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --skipLibCheck scripts/rescue-lab/*.ts`.
- **The invariants (§3) hold at every stage:**
  - words never change, except the listed D-8 typographic fixes and the blocks Kwill replaces by fields (typed TOC and lists);
  - nothing is lost;
  - junk deletes only empty paragraphs;
  - the original is never touched;
  - never half-finished.

---

## File structure

| File | Responsibility |
|---|---|
| `~/mdocxengine/src/core/ooxml/presentation.ts` (new) | `wipePresentation` pure string ops: run rPr whitelist, paragraph pPr removals, page-break removal |
| `~/mdocxengine/src/core/PartsManagers/StylesManager.ts` (modify) | `setStyleParagraphProps`, the separate cs font/size in `setStyleRunProps`, `setDocDefaults`, `ensureStyle` |
| `~/mdocxengine/src/core/PartsManagers/SectionManager.ts` (modify) | byte-safe `setSectionGeometry`; `addSectionBreak` copies the body geometry |
| `~/mdocxengine/src/core/PartsManagers/SettingsManager.ts` (new or existing) | byte-safe `setSetting(name, attrs \| null)` |
| `scripts/word-convert-service.mjs` (modify) | an opt-in `updateFields`: Word updates every field (TOC page numbers) twice before saving the PDF |
| `src/lib/word-converter.ts` (modify) | passes `updateFields` through |
| `src/lib/rescue/reset/reset.ts` | Reset: wipe presentation (cover excluded), delete deletable junk, remove headers, footers, section breaks and page breaks |
| `src/lib/rescue/regenerate/styles.ts` | Step 1: docDefaults and every style from `RescueRules` |
| `src/lib/rescue/regenerate/roles.ts` | Step 2: each block's style from its role; headings real; direction from content |
| `src/lib/rescue/regenerate/typography.ts` | Step 3: run-aware D-8 fixes with a change log |
| `src/lib/rescue/regenerate/layout.ts` | Steps 4–6: sections, geometry, page numbers, running headers |
| `src/lib/rescue/regenerate/apparatus.ts` | Steps 9–10: TOC and lists as real fields, real captions |
| `src/lib/rescue/regenerate/fonts.ts` | Step 12: embed fonts whose licence allows, from a fonts directory |
| `src/lib/rescue/regenerate/index.ts` | `regenerate(input) → {docx, report}`, running the steps in order with the doctor after each |
| `src/lib/rescue/prove/prove.ts` | Prove checks on the docx and on the rendered PDF |
| `src/lib/rescue/prove/doctor.ts` | local `doctorBuffer` |
| `src/lib/rescue/preview/preview.ts` | pick the cover and first-chapter pages, rasterise them, watermark them |
| `scripts/rescue-lab/cli.ts` (modify) | `rescue <id>`, `preview <id>` |

---

## Task 1 (engine): `wipePresentation`

**Files:** create `src/core/ooxml/presentation.ts`, export it from `src/index.ts`, and add the spec `src/integration/presentation.spec.ts`.

```ts
export interface WipeOptions { removePageBreaks?: boolean /* default true */; removeParagraphSectPr?: boolean /* default false */ }
export interface WipeResult { xml: string; runsStripped: number; paragraphsStripped: number; pageBreaksRemoved: number; sectPrRemoved: number }
/** Wipe the presentation layer of ONE body block's XML. Byte-faithful outside the edited elements. */
export function wipeBlockPresentation(blockXml: string, opts?: WipeOptions): WipeResult;
export const KEPT_RUN_PROPS: readonly string[];   // b, bCs, i, iCs, u, strike, dstrike, vertAlign, rtl, cs, lang, rStyle, vanish, specVanish, noProof
export const REMOVED_PARA_PROPS: readonly string[]; // spacing, jc, ind, keepNext, keepLines, pageBreakBefore, widowControl, framePr, shd, pBdr, contextualSpacing, textAlignment, snapToGrid, adjustRightInd, mirrorIndents
```

**Rules:**
- **Runs:** in every `<w:r>…<w:rPr>…</w:rPr>`, remove every child not in `KEPT_RUN_PROPS`: rFonts, sz, szCs, color, highlight, spacing, w, kern, position, shd, caps, smallCaps, effect, emboss, imprint, outline, shadow, bdr, fitText, eastAsianLayout, em. Drop a `<w:rPr>` left empty.
- **Paragraphs:** remove `REMOVED_PARA_PROPS` from each `<w:p>`'s OWN `<w:pPr>`, anchored to the opening tag as `updateParagraphProps` does. Keep pStyle, numPr, bidi, outlineLvl, sectPr and rPr (the paragraph-mark rPr, whose children are filtered like a run's), and canonicalise the order.
- **Page breaks:** remove `<w:br w:type="page"/>` (only `type="page"`, never line or column breaks) and `<w:lastRenderedPageBreak/>`. A run left empty by this is removed.
- **Section breaks:** with `removeParagraphSectPr`, remove the paragraph's `w:sectPr`.
- **Never edit inside** `w:txbxContent`, `mc:AlternateContent`, `w:fldSimple`'s instruction, `w:instrText`, `w:bookmarkStart/End`, `m:oMath` (math run properties are math, not presentation), or `w:drawing`. Tables: recurse into the cell paragraphs with the same rules, and leave `w:tblPr`/`w:trPr`/`w:tcPr` untouched.

**Specs:**
- fonts, sizes and colour are removed while bold, italic, underline, vertAlign, rtl and cs are kept;
- `pPr` spacing/jc/ind/keepNext are removed while pStyle, numPr, bidi and outlineLvl are kept, and the order is canonical;
- a page break is removed, while a line break and a column break are kept;
- text-box content is unchanged byte for byte;
- `instrText` and `fldSimple` are unchanged;
- a math paragraph's `m:rPr` is unchanged;
- table cell paragraphs are cleaned and table properties kept;
- the visible text (`paragraphText`) is identical before and after on every block of `samples/2.docx`.

Commit: `feat(ooxml): wipeBlockPresentation — strip direct formatting byte-safely`.

## Task 2 (engine): style writers, `setDocDefaults`, `ensureStyle`

**Files:** modify `StylesManager.ts` and `runProps.ts`; add the spec `src/integration/styles-writers.spec.ts`.

- **`RunProps` gains `fontCs?: string`, `sizeCsPt?: number` and `fontLatin?: string`.**
  - When set, `fontLatin` writes ascii/hAnsi and `fontCs` writes cs.
  - When set, `sizeCsPt` writes szCs and `sizePt` writes sz. When only `sizePt` is given, keep today's behaviour: both are written.
  - Keep every existing behaviour unchanged.
- **`setStyleParagraphProps(styleId, props: ParaStyleProps, ensure?)` → `{created, updated}`**, by string surgery. Its pure form is `applyStyleParagraphPropsToXml`.

  ```ts
  export interface ParaStyleProps { lineSpacing?: number /* multiple → w:spacing w:line=240*n w:lineRule="auto" */; beforePt?: number; afterPt?: number; jc?: "left" | "right" | "center" | "both" | "start" | "end"; firstLineCm?: number; hangingCm?: number; startCm?: number; keepNext?: boolean; keepLines?: boolean; outlineLvl?: number | null; bidi?: boolean; pageBreakBefore?: boolean }
  ```

  Write `pPr` children in schema order (reuse `canonicalizeParagraphProps`). `null`/`false` removes the element.
- **`setDocDefaults({ fontLatin?, fontCs?, sizePt?, sizeCsPt?, lang?: {val?, bidi?}, lineSpacing?, afterPt? })`**, by string surgery on `w:docDefaults` (`rPrDefault`/`pPrDefault`), creating them when absent.
- **`ensureStyle(styleId, {name, type: "paragraph" | "character", basedOn?, next?, uiPriority?, qFormat?})`**: creates a minimal style when missing, never modifies an existing one, and inserts it by string surgery before `</w:styles>`.

**Specs:**
- each property round-trips;
- the cs and latin fonts and sizes are written separately;
- an existing style's other properties are untouched;
- creating a style on `samples/2.docx` keeps every other byte of `styles.xml`;
- `pPr` order is valid (the doctor is clean).

Commit: `feat(styles): paragraph-props, cs font/size, docDefaults and ensureStyle writers (byte-safe)`.

## Task 3 (engine): section geometry and settings

**Files:** modify `SectionManager.ts`; create or modify `SettingsManager.ts` (add one if absent; check `src/core/PartsManagers`); add the spec `src/integration/section-geometry.spec.ts`.

- **`setSectionGeometry(sectionIndex, {widthTw?, heightTw?, orient?, topTw?, bottomTw?, leftTw?, rightTw?, gutterTw?, headerTw?, footerTw?})`**, byte-safe, using `editSectionSectPr`/`editBodySectPr` with `pgSz`/`pgMar` upsert. Also add the `Doc` passthrough `setSectionGeometry(blockIndex, …)`.
- **`addSectionBreak(paraIndex, type, {copyBodyGeometry = true})`**: the inserted `w:sectPr` carries `pgSz` + `pgMar` copied from the body `sectPr`, instead of a bare `w:type` (which falls back to Letter).
- **`setSetting(name, attrs: Record<string,string> | null)`** in `word/settings.xml`, by string surgery and schema-order aware. Use cases: `w:updateFields`, `w:mirrorMargins`, `w:evenAndOddHeaders`. Remove the element when `null`.
- Also add `removeTitlePg(sectionIndex)`, and remove every header/footer reference from a section (byte-safe).

**Specs:** geometry round-trips; a section break inserted on `samples/2.docx` has A4 `pgSz`; a setting is added, changed and removed; other bytes are unchanged; the doctor is clean.

Commit: `feat(sections): byte-safe section geometry, section breaks keep page size, settings writer`.

After Tasks 1–3: run `npm run build` and the server require check.

## Task 4 (converter): opt-in field update

**Files:** `scripts/word-convert-service.mjs`, `src/lib/word-converter.ts`.

- **`POST /convert` accepts `{url, updateFields?: boolean}`.** When true, the AppleScript, after `open` and before `save as`:
  - updates every table of contents (`update` on each `table of contents` of the document) and every field (`update` on the fields of the document's text object, the main story);
  - does this TWICE, because TOC page numbers move once the TOC itself grows;
  - checks the exact commands against `/Applications/Microsoft Word.app/Contents/Resources/Word.sdef` and `osacompile`s the script.

  The document is closed without saving, as today; only the PDF is produced.
- **Client:** `convertDocxToPdf({srcUrl, title, sizeBytes?, updateFields?})` passes it through. The default `false` leaves production unchanged.
- **Lab:** `scripts/rescue-lab/render.ts` `renderForLab(…, {updateFields})` passes it through.
- **Verify** (controller) on a seed copy with a TOC inserted by `insertTOC`: without the flag, the PDF's TOC page numbers read "1"; with it, they read real numbers. Use `extractPdfText` and print only digits.

Commit: `feat(converter): opt-in field update before export (TOC page numbers)`.

## Task 5: Reset

**Files:** `src/lib/rescue/reset/reset.ts`, `src/lib/rescue/__tests__/reset.test.ts`.

```ts
export interface ResetReport { blocksIn: number; blocksOut: number; junkDeleted: number; junkKept: number; runsStripped: number; paragraphsStripped: number; pageBreaksRemoved: number; sectionBreaksRemoved: number; headersFootersRemoved: number; coverBlocks: number }
export async function reset(input: { docx: Buffer; inv: Inventory; roles: Record<string, {i: number; role: string}> }): Promise<{ docx: Buffer; report: ResetReport; indexMap: number[] /* old block i → new block i, -1 when deleted */ }>;
```

1. Blocks with role `cover` (and the section that holds them) are NOT wiped (M2a keeps the student's cover).
2. Every other block gets `wipeBlockPresentation(xml, {removePageBreaks: true, removeParagraphSectPr: true})`. Keep the `sectPr` of the LAST cover block, so the cover stays its own section.
3. **Delete junk only when:** the role is `junk`, AND the block is a paragraph, AND `findEmptyBlocks` classifies it deletable (`holdsOf` empty, `isBlankText`). Otherwise keep it, and count it in `junkKept`.
4. **Remove every header/footer** (parts, relationships and references) except the cover section's. Also remove `titlePg`, and `evenAndOddHeaders` from settings.
5. **Body `sectPr`:** A4 (11906 × 16838) via `setSectionGeometry`. Margins come later, in layout.
6. **`indexMap`** maps every old block to its new index. Later steps use the roles re-indexed through it.

**Tests** (seed copies, synthetic roles):
- the junk-empty paragraph is deleted, while a junk-labelled paragraph that holds a drawing is kept;
- the cover's run fonts are unchanged, and another block's fonts are removed;
- page breaks are removed;
- headers are removed;
- `indexMap` is consistent;
- `proveWords` over the non-junk blocks are identical before and after;
- `readInventory` counts are equal, apart from the deleted junk.

Commit: `feat(rescue): reset — wipe presentation outside the cover, delete only deletable junk`.

## Task 6: Regenerate steps 1 and 2 (styles, roles)

**Files:** `src/lib/rescue/regenerate/styles.ts`, `roles.ts`, and their tests.

- **Step 1, `applyRules(engine, rules)`:**
  - **docDefaults:** `fontLatin` = `rules.body.font` when fr/en, else "Times New Roman"; `fontCs` = `rules.body.font` when ar, else "Simplified Arabic"; sizes from the rules.
  - **Styles**, each via `ensureStyle` plus the run/paragraph writers:

    | Style | Settings |
    |---|---|
    | Normal | body size, line spacing, jc both/start, firstLine; bidi when ar |
    | Heading1–4 | sizes h1/h2/h3 (h4 = h3), bold per rules, keepNext + keepLines, outlineLvl 0–3; jc center for h1, start for the others |
    | Caption | 10 pt (ar 12 pt), center, keepNext false |
    | FootnoteText | `rules.footnotes.sizePt` |
    | ListParagraph | indent start 0.63 cm |
    | Quote | italic in fr/en, indent 1 cm |
    | Source | size −2, italic |
    | Bibliography | hanging 1 cm |
    | Abstract | justified |
    | FrontMatter | center, for dedication and thanks |
    | DividerTitle | center, h1 size + 8, bold |
    | Basmala | center |
    | Equation | center |
    | Figure | center, keepNext |
    | TOC1–3 | default |
    | TOCHeading | — |
    | TypedNote | footnote size |
- **Step 2, `applyRoles(engine, inv, roles)`.** For each block, by role:
  - **Style:**

    | Role | Style |
    |---|---|
    | h1–h4 | Heading1–4 + outlineLvl |
    | body | Normal (no pStyle) |
    | list-item | ListParagraph |
    | quote | Quote |
    | caption-figure/table | Caption (before Task 8 converts them) |
    | figure-source | Source |
    | figure | Figure |
    | equation | Equation |
    | bibliography-heading | Heading1, **without** a chapter section |
    | bibliography-entry | Bibliography |
    | abstract-* | Abstract |
    | dedication/thanks | FrontMatter |
    | divider-page | DividerTitle |
    | basmala | Basmala |
    | part | Heading1 + DividerTitle look |
    | annex-heading | Heading1 |
    | annex-body | Normal |
    | typed-note | TypedNote |
    | table | none (cell paragraphs → Normal) |

  - **Cover:** untouched.
  - **Headings:** a non-heading role REMOVES any heading pStyle and `outlineLvl` (`stripHeadingFromParagraph`).
  - **Direction:** `bidi` is set when the block's text is Arabic-dominant (> 50% Arabic letters) and removed when Latin-dominant (content-driven, CLAUDE.md).
  - **How:** use `updateParagraphProps` on the block strings, then `saveBlocks`. Never `setHeadingLevel`.

**Tests:**
- styles carry the rule values, with the cs/latin split;
- a role h2 block gets Heading2 + `outlineLvl` 1;
- a former Titre1 paragraph with role body loses its heading;
- Arabic text gets bidi and Latin text doesn't;
- the doctor is clean;
- visible text is unchanged.

Commit: `feat(rescue): regenerate styles from rules and styles from roles`.

## Task 7: Regenerate step 3 (typography, D-8)

**File:** `src/lib/rescue/regenerate/typography.ts`.

```ts
export interface TypoChange { i: number; kind: "space-before-punct" | "space-after-comma" | "tatweel"; before: string; after: string /* ≤ 30 chars of context, stored only in the lab report */ }
export function fixTypography(blockXml: string, i: number, lang: "ar" | "fr" | "en"): { xml: string; changes: TypoChange[] };
```

- Edit inside `<w:t>` values only, and work across run boundaries: build the paragraph's text with a map from each character to its (run, offset), apply the fixes on the text, and write each run's new text back. Never merge runs.
- **Arabic-text paragraphs:**
  - remove spaces before `؟ ؛ ، :`. Keep the scope to the four Diagnose kinds; do not invent others;
  - insert one space after `، ؛` when a letter follows;
  - remove tatweel between two Arabic letters.
- **French paragraphs:** none in M2a (French spacing rules differ; a carry-over).
- Never touch text inside fields (`instrText`, or field result runs between `separate` and `end`), hyperlinks' targets, or math.

**Tests:** each fix (including one across a run boundary); field results untouched; the change log is correct; the fixed text equals `applyTypographyToText(before)`, a pure function that Prove reuses (see Task 10).

Commit: `feat(rescue): typography fixes (D-8), run-aware, logged`.

## Task 8: Regenerate steps 4–6 and 9–10 (layout, apparatus)

**Files:** `src/lib/rescue/regenerate/layout.ts`, `apparatus.ts`, and tests.

- **Sections (step 4):**
  - Find the body start: the first block whose role is h1/part/divider-page AFTER the last front-matter block. Front matter means cover, dedication, thanks, basmala, abstract, toc and the lists.
  - Insert a `nextPage` section break before every h1 and divider-page in the body, and before the body start, with `addSectionBreak` copying the geometry.
  - Leave the cover section as it is.
  - Set every section's margins from the rules (cm → twips) with `setSectionGeometry`:
    - binding side right (ar) puts `marginBindingCm` on the right;
    - binding side left (fr/en) puts it on the left;
    - header/footer distance 1.25 cm.
- **Page numbers (step 5):** call `applyFrontMatterNumbering(doc, bodyStartBlockIndex, {frontMatterFormat, bodyFormat: "decimal", alignment: "center", hideBeforeIndex: firstBlockAfterCover})`, imported from `../../../mcp/doc-page-numbering`. Before using it, check that its import chain passes the guard.
  - `frontMatterFormat` follows the rules: roman → lowerRoman; letters → arabicAbjad (ar) or lowerLetter (fr/en).
  - Divider sections show no number.
  - Add `w:bidi` to the page-number paragraph in Arabic theses.
- **Headers (step 6):** per body section, the section's h1 text as a header. Build it with `compileTemplateForApply` on a small `HfModel`: the chapter title aligned to the outside, 10 pt, and a 0.5 pt bottom rule; `rtl` when the thesis is Arabic. Apply it with `doc.applySectionChrome(sectionStartBlock, {header})` after `guardLinkedSections`. Front matter and divider sections get no header. The footer comes from step 5; do not overwrite it. Use `styleRef` only if it renders correctly in Word, else static text.
- **TOC (step 9):**
  - Remove typed-toc blocks (role `typed-toc`) and old toc-field blocks; this is allowed by the invariants exception.
  - Insert `insertTOC({headingDepth: 3, title: localized, useHyperlinks: true, rtl: ar}, at)`. `at` is where the first removed TOC block was, else right after the front matter, before the body start.
  - Then `isolateTocPage`.
  - Lists: when figures ≥ `rules.captions.listOfFiguresFrom` (resp. tables), `insertListOfFigures`/`insertListOfTables` after the TOC, replacing `typed-list`/`list-field` blocks the same way.
  - `setSetting("w:updateFields", null)`: don't make Word prompt; the converter updates the fields instead (Task 4).
- **Captions (step 10):** `convertTextCaptions({kind: "all", rtl})` restricted to blocks whose role is `caption-figure`/`caption-table`. Pass `fromIndex`/`toIndex` per block, or extend the engine call with an index set if needed. Record converted and skipped.

**Tests** (seed-based, synthetic roles; a seed copy with a few h1 blocks, a typed TOC and typed captions):
- a section starts at each h1 with A4 and the rule margins;
- the binding side is right for ar;
- the front matter is numbered lowerRoman and the body decimal, restarting at 1;
- each body section has its own header with its h1 text;
- a TOC field exists and the typed TOC is gone;
- captions are SEQ;
- the doctor is clean.

Commit: `feat(rescue): regenerate layout (sections, numbers, headers) and apparatus (TOC, lists, captions)`.

## Task 9: Regenerate step 12 (fonts) and the orchestrator

**Files:** `src/lib/rescue/regenerate/fonts.ts`, `index.ts`, and tests.

- **`embedFonts(engine, fontsDir)`:**
  1. For each font the document uses (style fonts + docDefaults), look for files in `fontsDir`, matched by family name read from each font file's name table. Write a minimal name-table reader, or use filename conventions documented in a README.
  2. Call `engine.fontTable.embedFont`.
  3. Report `{embedded: [], refused: [{name, reason}], missing: []}`.
  - Restricted fonts (fsType 0x0002) are refused by the engine, which is expected (D-14).
  - **Lab `fontsDir`:** a gitignored `~/kwill-server/lab/fonts/`, filled by the controller with copies of the embeddable files listed in the fact sheet: Amiri/Noto/Scheherazade from `kwill/assets/fonts/docx`, plus the system Times New Roman. Never commit font files.
- **`regenerate(input: {docx, inv, roles, rules, lang, fontsDir?}) → {docx, report}`** runs the steps in this order:
  1. `applyRules`
  2. `applyRoles`
  3. typography
  4. layout
  5. apparatus
  6. fonts

  After each step it runs the local doctor (Prove's `doctor.ts`). Any error-severity finding stops the run and returns which step broke it. `report` collects every step's report.

**Tests:** the orchestrator on a seed with synthetic roles runs end to end with the doctor clean; a failure in a step is surfaced and nothing is half-written (the returned docx is the input on failure).

Commit: `feat(rescue): regenerate orchestrator and font embedding within licences`.

## Task 10: Prove

**Files:** `src/lib/rescue/prove/prove.ts`, `doctor.ts`, and tests.

```ts
export interface ProveCheck { id: string; ok: boolean; detail: string /* counts only */ }
export interface ProveResult { ok: boolean; checks: ProveCheck[] }
export async function proveDocx(input: { before: Buffer; after: Buffer; beforeInv: Inventory; roles: Record<string, {i:number; role:string}>; typo: TypoChange[] }): Promise<ProveResult>;
export function provePdf(input: { pageMap: PageMap; pdfText: PageText[]; expect: { bodyStartPage?: number; h1Blocks: number[] } }): ProveResult;
```

**`proveDocx`:**

| Check | Passes when |
|---|---|
| `words` | the student-content token stream is equal before and after. **Before:** `proveWords` over the blocks whose role is not in {junk, typed-toc, typed-list, toc-field, list-field}, with `applyTypographyToText` applied (the same D-8 fixes, so only the listed fixes differ). **After:** `proveWords` over the blocks that are not generated (TOC/list field blocks, generated styles TOCHeading/TOC1–9/TableofFigures, page-number paragraphs live in footers anyway). Captions compare on visible text, field results included. |
| `notes` | the footnote text stream is equal |
| `counts` | footnotes, endnotes, drawings, ole, equations and tables are equal; figures are equal |
| `junk-only-empty` | every deleted block was empty (from Reset's report and `indexMap`) |
| `doctor` | `checkDocxBuffer(after)` has no error findings |
| `cover-untouched` | the cover blocks' XML is byte-equal before and after (M2a policy) |

**`provePdf`:**

| Check | Passes when |
|---|---|
| `opens` | the render succeeded, which is implied by having a page map |
| `h1-new-page` | every h1 block starts at the top of a page: it is the first mapped block on its page, ignoring headers |
| `no-heading-at-page-end` | the page map has no `heading-at-page-end` warnings |
| `no-blank-pages` | there are no `blank-page` warnings, except pages whose blocks hold drawings |
| `toc-filled` | the PDF's TOC page lines end with numbers that are not all "1" |
| `page-numbers` | on body pages, the bottom text line of the page contains a decimal number, which equals the page's position in the body sequence |

**Tests:** synthetic before/after pairs (one word changed → `words` fails; a typography fix → `words` passes; a lost footnote → `counts` fails) and synthetic page maps (h1 not first → fails).

Commit: `feat(rescue): prove — words/notes/counts/junk/doctor/cover on the docx, layout checks on the PDF`.

## Task 11: Lab CLI `rescue` and preview

**Files:** `scripts/rescue-lab/cli.ts`, `README.md`, `src/lib/rescue/preview/preview.ts` and its test.

- **`rescue <id> [--profile <slug>] [--run <rescueRunId>]`:**
  1. Load the source docx, the inventory, the gold map (or `--map-run`) and the rules (same resolution as `diagnose`).
  2. `reset` → re-key the roles through `indexMap` → `regenerate` → `proveDocx`.
  3. Render through Word with `updateFields: true` and the right-document guard, then build the page map with markers → `provePdf`.
  4. Write `corpus/<id>/rescue/<runId>/`:
     - `rescued.docx`, `rescued.pdf`;
     - `pages/`, `overview/`;
     - `prove.json`;
     - `report.json`: the Reset + Regenerate reports with counts, and the typography log (lab only);
     - `report.md`: a readable sheet for the brain's page review.
  5. Exit 1 if any Prove check fails, but still write everything for the review.
  - Nothing is written outside `rescue/<runId>/`; the original is never touched.
- **`preview <id> [--run <rescueRunId>]`:**
  1. From a rescue run, take the cover page (page 1) and the first chapter's opening page (the page of the first h1 that is not the introduction, conclusion or bibliography).
  2. Rasterise them with `pdftoppm -f N -l N -r 110`, then watermark with sharp: composite a semi-transparent diagonal SVG text "KWILL — APERÇU" (ar: "كويل — معاينة"), at 20% opacity, repeated twice.
  3. Write `rescue/<runId>/preview/page-cover.png` and `page-chapter.png`.
  - `preview.ts` exports `watermarkPng(png: Buffer, text: string): Promise<Buffer>` plus page selection. Test it on a generated PNG: the output differs from the input, and the dimensions are equal.

**Smoke:** a `zz-` id from the seed with a hand-written gold map, using the private `:8093` converter or the closed port as appropriate. Clean up afterwards.

Commit: `feat(rescue-lab): rescue and preview commands`.

## Task 12: First thesis rescued (controller and brain, main session)

1. Fill `lab/fonts/` (embeddable files only).
2. `rescue t03` with the default rules (ar). Use the private converter if the tunnel watchdog still loops (see memory `word-converter-watchdog-loop`).
3. Read `prove.json`. For each failing check, find the root cause, fix it (a new commit with a regression test) and re-run.
4. **Page review by the brain:** look at every page of `rescued.pdf` (overview sheets, then zoom). List each defect in `corpus/t03/rescue/<runId>/review.md`, which is gitignored.
   - Each defect becomes exactly one of: a code fix with a test, a rule change, or a new Prove check. Then re-run.
   - Repeat until Prove is all green and the review lists no defect.
5. `preview t03`, then look at both PNGs.
6. Repeat 2–5 on **t01** (French), to show the pipeline is not Arabic-only. It's a stretch goal for M2a; record what fails if time runs out.

## Done when

- The engine ops are merged with specs green and the full engine suite green.
- t03 is rescued: every Prove check passes, the brain's page review is clean, and the preview PNGs exist and are watermarked.
- The server's rescue/render tests, tsc and the scripts type-check are green, and the guard passes.

## Carry-overs to M2b

- Step 7: generated covers (D-4/D-5).
- Step 8: divider pages for numbered chapters, and frames on dedication/thanks (page borders first; image frames need the ornament render ported off the DB).
- Step 11: references grouped and sorted (after the student confirms).
- Typed notes converted into real footnotes.
- French typography rules.
- Production font files.
- The deposit pack.
- Re-assemble t18 in the right order and re-map it before its rescue.
