# Rescue v2 — M1b: Assemble, Rules, Diagnose (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close milestone M1's remaining stages: merge a thesis split into several files without adding anything (Assemble, D-20), resolve the formatting rules (D-6), and produce the free diagnosis, which is correct on every corpus thesis that has an answer key.

**Architecture:**
- **Engine:** one fix. The merge carries VML pictures and OLE objects (and, if found, images inside footnotes), which today lose their links.
- **Server, `src/lib/rescue/`:** four model-free modules, each a pure function over the docx, the inventory, the roles and the page map:
  - `assemble/` (order heuristic, verbatim merge, the checks against the parts);
  - `rules/` (rules model, Algerian default, catalogue mapping, resolution);
  - `diagnose/facts.ts` (what the document's formatting is now);
  - `diagnose/diagnose.ts` (problems versus rules, plus question candidates).
- **Brain:** one new brain task, `order_parts`.
- **Lab CLI:** three new commands, `assemble`, `diagnose` and `approve-diagnosis`.

**Tech stack:** TypeScript, vitest, zod 4, `@kwill/docx-engine` (`MergeManager`, `SectionManager.getSections`, `TableOfContentsManager`, `CaptionManager`), the server's `para-format.ts` (`buildFormatResolver`).

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md`, sections 3 (Assemble, Invariants), 4, 8, 9.2 (screens 2, 6, 7) and 10.

**Previous plan:** `2026-11-02-rescue-v2-m1a-foundations.md`. Its carry-overs stay open unless a task here names them.

**Scope (changes to the spec's M1 row):**
- The **two-page preview moves to M2**, because it needs Regenerate.
- **Question phrasing** (the brain's `ask` task) moves to M4 (Confirm). M1b only *selects* the question candidates.
- **Answer keys:** M1b adds keys for the four split theses after assembly (t17–t20), as the brain's budget allows. Done means at least two of them, plus t21.
- **Done:** "Free diagnosis correct on every corpus thesis that has an answer key".

---

## Ground rules (read before any task)

- **Repos:**
  - The server is `~/kwill-server` on branch `master`.
  - The engine is `~/mdocxengine` on branch `main`. After any engine change, run `npm run build` there; the server imports `dist/` through `file:../mdocxengine`.
  - **Engine gate:** new code at 100% coverage (`npx vitest run --coverage <spec>` scoped to the file), and no new failing spec compared with the commit before. `npm run test:ci` already fails on `main` on global coverage; that is known.
- **Git:**
  - Commit after every task, staging exact paths only.
  - The server has another session's uncommitted edits (an engine package rename across many files, and `package.json`). Never stage, revert or touch them.
  - If a file you must change already has foreign hunks, commit only your hunks with the index trick: build the HEAD version plus your change, `git hash-object -w`, then `git update-index --cacheinfo`. Check `git diff --cached` and `git diff`.
  - End commit messages with your model's `Co-Authored-By:` line.
  - Fixes are new commits; never amend.
- **Checks:**
  - `npx vitest run src/lib/rescue` and `npx tsc --noEmit` on the server.
  - Scripts are type-checked with `npx tsc --noEmit --ignoreConfig --strict false --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --skipLibCheck scripts/rescue-lab/*.ts`.
- **TypeScript conventions:** tsconfig is `strict: false`. Use flat result interfaces with `x.ok === false`, never union narrowing. Imports are relative with no `.js` extension. Write Unicode ranges as `\u` escapes.
- **The guard:** `src/lib/rescue/__tests__/no-model-client.test.ts` checks transitively that nothing reaches model clients, `src/lib/format/*`, `thesis-classify`, `thesis-structure`, `thesis-combine` is not listed but must not be imported either, supabase, `src/db/`, document-storage or thesis-render.
  - `src/lib/norm-profiles-seed.ts` imports only `import type` from `../db/norm-profiles`, which esbuild erases. If the guard still flags it, copy the needed type into `rules/` instead.
  - `src/lib/para-format.ts` has no imports.
- **Privacy:**
  - `lab/` is gitignored and holds students' theses. Corpus ids are neutral.
  - Never print thesis text in reports, commits or test output; counts, hashes and page numbers only.
  - Tests use `assets/thesis-base.docx`, `~/mdocxengine/samples/*` that the engine already ships (do NOT add new samples to any repo), or inline XML.
- **Content is never added** (D-20). Assemble inserts no heading, no page break, no section break and no normalisation.

---

## File structure

| File | Responsibility |
|---|---|
| `~/mdocxengine/src/core/PartsManagers/MergeManager.ts` (modify) | Remap VML `v:imagedata r:id` and OLE `o:OLEObject r:id` (with the embedding part) |
| `~/mdocxengine/src/integration/merge-vml-ole.spec.ts` (new) | Engine tests for the above |
| `src/lib/rescue/assemble/part-roles.ts` (new) | Rescue part roles, cover/front-matter detection, heuristic order |
| `src/lib/rescue/assemble/merge.ts` (new) | Verbatim merge (`appendDocument` with no options), refusal of unsupported content |
| `src/lib/rescue/assemble/check.ts` (new) | Invariants 1–2 against the parts, plus rels integrity |
| `src/lib/rescue/read/tokens.ts` (new) | Body, footnote and endnote token lists of a docx (for invariant 1) |
| `src/lib/rescue/brain/tasks.ts` (modify) | `order_parts` task, answer schema and validator; roles `basmala`, `typed-note` |
| `src/lib/rescue/rules/rules.ts` (new) | `RescueRules`, `ALGERIAN_DEFAULT`, `rulesFromNormProfile`, `resolveRules` |
| `src/lib/rescue/diagnose/styles.ts` (new) | Style-chain resolution of alignment and outline level (missing from both repos) |
| `src/lib/rescue/diagnose/facts.ts` (new) | `readFacts(docx, inv)`: sections, effective formatting per paragraph, TOC/captions/lists facts |
| `src/lib/rescue/diagnose/diagnose.ts` (new) | `diagnose({inv, roles, facts, pageMap, rules})` → problems + question candidates + summary |
| `scripts/rescue-lab/cli.ts` (modify) | `assemble`, `diagnose`, `approve-diagnosis`; `read` uses the assembled file for split theses |
| `src/lib/rescue/__tests__/*.test.ts` | One test file per module |

---

## Task 1: The engine merge keeps VML pictures and OLE objects

**Files:**
- Modify: `~/mdocxengine/src/core/PartsManagers/MergeManager.ts`
- Create: `~/mdocxengine/src/integration/merge-vml-ole.spec.ts`

`appendDocument` copies DrawingML images (`r:embed`/`r:link`), charts and hyperlinks, but never remaps:
- `v:imagedata r:id`: VML pictures, and the preview image of every OLE object;
- `o:OLEObject r:id`: the embedded object itself, e.g. `word/embeddings/oleObject3.bin`, an equation-editor object.

A corpus thesis split into 7 parts carries 26 of each, and today every one comes out with a dangling relationship.

- [ ] **Step 1: Read** `MergeManager.ts` fully, especially:
  - `buildMediaMap` (~242–264), the `r:embed`/`r:link` rewrite (~184);
  - `buildChartMap` / `copyPartClosure` / `freePartPath` (~304–417);
  - how content types are added (~363–370).
- [ ] **Step 2: Write the failing spec** `merge-vml-ole.spec.ts`. Build a source docx in memory: start from an engine sample the existing specs already use, then add:
  - a paragraph holding a VML picture: `<w:pict><v:shape …><v:imagedata r:id="rIdV" o:title=""/></v:shape></w:pict>`, with `rIdV` an image relationship to `media/vml1.png`, a few real PNG bytes;
  - a paragraph holding an OLE object: `<w:object w:dxaOrig="…" w:dyaOrig="…"><v:shape …><v:imagedata r:id="rIdP"/></v:shape><o:OLEObject Type="Embed" ProgID="Equation.DSMT4" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1234" r:id="rIdO"/></w:object>`, with `rIdP` an image relationship (`media/ole1.wmf`, or `.png` for the test) and `rIdO` an `…/relationships/oleObject` relationship to `embeddings/oleObject1.bin`;
  - the content type `Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"` if missing.

  Merge it into a target with `appendDocument(src, {})`. Assert:
  - every `r:id` on `v:imagedata` and `o:OLEObject` in the merged `document.xml` resolves in `document.xml.rels` to a relationship of the right type whose target part exists in the zip with the **same bytes** as the source part;
  - two sources whose parts share names (`media/vml1.png`, `embeddings/oleObject1.bin`) don't overwrite each other;
  - the `bin` content type is declared;
  - the result reloads with `Mdocxengine.loadFromBuffer`, and `getBlocks()` returns the same block count;
  - **no regression** in the existing `merge-manager.spec.ts` and `merge-charts.spec.ts`.

  Run it; expect it to fail.
- [ ] **Step 3: Implement.**
  - Extend the media map so that `v:imagedata r:id` (and `r:href`, `o:relid` if present) are treated like `r:embed`: copy the image through the same path as DrawingML images and rewrite the attribute.
  - For `o:OLEObject r:id`, copy the target part with a collision-free name (reuse `freePartPath` and `copyPartClosure`; an embedding can itself have rels, rarely), add the relationship, rewrite the attribute, and declare the content type (Default by extension, or an Override copied from the source).
  - Keep the "a drawing whose chart could not be copied is deleted" behaviour scoped to charts. For VML and OLE, a missing source part must **throw** a clear error (`merge: source part "<path>" referenced by <attr> is missing`), never silently drop. Rescue would rather refuse than lose.
- [ ] **Step 4: Footnote images.** `FootnoteManager.copyFootnotesVerbatim` does not remap images inside footnotes. Add a case to the new spec: a footnote containing a DrawingML image. If it fails, fix it with the same media remap, applied to the copied footnote XML and `footnotes.xml.rels`. If the change is larger than about 40 lines, stop and report NEEDS_CONTEXT instead.
- [ ] **Step 5: Verify:**
  - `npx vitest run src/integration/merge-vml-ole.spec.ts src/integration/merge-manager.spec.ts src/integration/merge-charts.spec.ts`;
  - coverage for the changed lines;
  - `npm run build`;
  - from `~/kwill-server`, `node -e "require('@kwill/docx-engine')"` succeeds.
- [ ] **Step 6: Commit** in the engine repo, the two files only: `fix(merge): carry VML pictures and OLE objects (and footnote images) across a merge`.

---

## Task 2: Token lists and the assembly check

**Files:**
- Create: `src/lib/rescue/read/tokens.ts`, `src/lib/rescue/assemble/check.ts`
- Test: `src/lib/rescue/__tests__/tokens.test.ts`, `src/lib/rescue/__tests__/assemble-check.test.ts`

Invariant 1 for a split thesis: the merged document's words equal the parts' words concatenated in the confirmed order, for the body and for the notes. Invariant 2: the counts equal the sum over the parts. Plus integrity: no relationship may dangle.

- [ ] **Step 1: `tokens.ts`.**

```ts
// Word sequences used by the "words never change" invariant, kept per stream so
// a merge can be checked part by part. Uses content.ts (visible text, NFC, bidi
// stripped, diacritics kept); never the matching key.
export interface DocTokens { body: string[]; footnotes: string[]; endnotes: string[] }
export async function readTokens(docx: Buffer): Promise<DocTokens>;
```

Implementation:
- `body` = `proveWords` over `xmlText(visibleXml(block.xml))` for every block from `engine.document.getBlocks()`, in order.
- Notes: `notesText` on `word/footnotes.xml` and `word/endnotes.xml`, read from `engine.zip`, flattened through `proveWords`.

Tests on `assets/thesis-base.docx`:
- `body` length equals the inventory's `bodyWords`;
- the footnote copy built the same way as in `inventory.test.ts` gives `footnotes.length > 0`.
- [ ] **Step 2: `check.ts`.**

```ts
export interface AssemblyCheck {
  ok: boolean;
  problems: string[];            // human-readable, counts only, never text
  counts: { parts: Record<string, number>; merged: Record<string, number> };
}
export async function checkAssembly(partsInOrder: Buffer[], merged: Buffer): Promise<AssemblyCheck>;
export function danglingRels(docx: Buffer): string[];   // "<part>: <attr>=<rId>" for each unresolved or missing target
```

`checkAssembly` checks:
- **(a) Body words:** `tokens(merged).body` deep-equals the concatenation of each part's `body`. On mismatch, report the first differing position as `body word #N differs (part k)`, with no words.
- **(b) Footnotes and endnotes:** the same, per stream.
- **(c) Counts:** sum over the parts versus merged, using `readInventory(...).counts`, for footnotes, endnotes, footnoteTexts, endnoteTexts, drawings, ole, equations, tables and figures. Every key must match.
- **(d) `danglingRels(merged)`** is empty. It scans `word/document.xml`, `word/footnotes.xml` and `word/endnotes.xml` for `r:(id|embed|link|pict|href)="…"` and `o:relid`. Each must resolve in that part's `_rels` file. Internal targets must exist in the zip; `TargetMode="External"` counts as resolved.

`ok` is true when there are no problems.

Tests:
- merging a part with itself through the real merge (Task 3's `mergeVerbatim`, or `engine.merge.appendDocument` directly in the test) gives `ok: true`;
- a hand-corrupted merged buffer (one word changed in `document.xml`) gives a body problem;
- deleting a media entry from the merged zip gives a `danglingRels` hit.
- [ ] **Step 3: Run, verify, commit** the four paths: `feat(rescue): token streams and the assembly check (words, counts, rels)`.

---

## Task 3: Part roles, order heuristic, verbatim merge

**Files:**
- Create: `src/lib/rescue/assemble/part-roles.ts`, `src/lib/rescue/assemble/merge.ts`
- Test: `src/lib/rescue/__tests__/assemble.test.ts`

- [ ] **Step 1: `part-roles.ts`.** Rescue's own part roles, following D-20's order:

```ts
export const PART_ROLES = ["cover", "front-matter", "introduction", "chapter", "conclusion", "bibliography", "annex", "other"] as const;
export type RescuePartRole = (typeof PART_ROLES)[number];
export interface PartSummary {
  index: number;            // position as uploaded (filename order)
  filename: string;
  openingText: string;      // first 600 chars of visible body text, NFC, single-spaced
  outline: string[];        // up to 30 heading texts (real headings by style/outline, else bold short lines)
  wordCount: number;
}
export function summarizePart(index: number, filename: string, docx: Buffer): Promise<PartSummary>;
export function heuristicPartRole(p: PartSummary): RescuePartRole;
export function heuristicOrder(parts: PartSummary[]): { order: number[]; roles: RescuePartRole[] };
```

`heuristicPartRole`:
1. **cover:** the opening's first 300 characters contain an institution marker: `الجمهورية الجزائرية`, `République algérienne`, `People's Democratic Republic`, `وزارة التعليم`, `Ministère de l'enseignement`, `Université`/`جامعة` together with `مذكرة`/`Mémoire`/`thesis`. Write these as `\u` escapes where they are Arabic.
2. **front-matter:** the outline or opening starts with dedication, thanks, abstract, summary or list markers: `إهداء`, `الإهداء`, `شكر`, `Dédicace`, `Remerciements`, `ملخص`, `Résumé`, `Abstract`, `فهرس`, `Sommaire`, `Table des matières`, `قائمة`.
3. **Otherwise** map `heuristicRole` from `../../thesis-parts` (pass `{filename, snippet: openingText, headings: outline}`):
   - `introduction` → introduction;
   - `revue_litterature`, `partie_theorique`, `methodologie`, `partie_pratique`, `resultats` and `discussion` → chapter;
   - `conclusion` → conclusion;
   - `bibliographie` → bibliography;
   - `annexe` → annex;
   - `autre` → other.

`heuristicOrder` sorts stably by `PART_ROLES` order. Ties keep the numeric order from the filename: use `titleFromFilename` / `stripManualNumber` from `../../thesis-parts` to extract a leading number, then fall back to the upload index.
- [ ] **Step 2: `merge.ts`.**

```ts
export interface MergeResult { ok: boolean; merged?: Buffer; refused?: string }
/** Merge parts in the given order, adding NOTHING (D-20): no heading, no break, no styles map. */
export async function mergeVerbatim(partsInOrder: Buffer[]): Promise<MergeResult>;
```

Behaviour:
1. **Refuse** (`ok: false`, `refused: "part N has endnotes"` or `"part N has comments"`) when any part has `w:endnoteReference` or `w:commentReference` in its visible body. The engine merge does not carry them yet, and rescue refuses rather than lose content.
2. **Target:** load part 1 with `Mdocxengine.loadFromBuffer`.
3. **Append:** for each later part, `await engine.merge.appendDocument(buf, {})`. Pass the options object empty, with no `styleMap`.
4. **Result:** `merged = clearFalseDataDescriptors(engine.zip.toBuffer())`.
5. A single part returns its own bytes unchanged.
- [ ] **Step 3: Tests.**
  - `heuristicPartRole` on synthetic summaries: Arabic cover, French cover, a dedication, an introduction, a chapter, a bibliography.
  - `heuristicOrder` puts cover, then front matter, then introduction, then chapters (by filename number), then conclusion, then bibliography, then annex.
  - `mergeVerbatim` on two engine sample parts:
    - the merged body equals the concatenation (via `checkAssembly`, which must return `ok: true`);
    - no new paragraph appears: block count equals the sum of the parts' block counts;
    - no `w:br w:type="page"` is added beyond those already in the parts (count them);
    - `w:sectPr` count is at most the sum (a trailing sectPr may drop; none is added).
  - The endnote and comment refusals.
- [ ] **Step 4: Verify; commit** the three paths: `feat(rescue): assemble — part roles, heuristic order, verbatim merge`.

---

## Task 4: Brain task `order_parts`, roles `basmala` and `typed-note`

**Files:**
- Modify: `src/lib/rescue/brain/tasks.ts`, `src/lib/rescue/__tests__/tasks.test.ts`

The answer keys written after M1a found two vocabulary gaps:
- a **basmala page**, the بسم الله image page in front matter, found in 3 of 5 keys;
- **footnotes typed by hand** as plain paragraphs at a section's end.

- [ ] **Step 1: Tests first:**
  - `ROLES` contains `"basmala"` (placed after `"thanks"`) and `"typed-note"` (after `"figure-source"`);
  - `MAP_INSTRUCTIONS` mentions both, and still has no backticks;
  - `validateOrderPartsAnswer`:
    - accepts a permutation with roles for every part;
    - rejects a missing or duplicate index;
    - rejects an unknown role;
    - rejects `continuesPrevious` containing the first part of the order.
- [ ] **Step 2: Implement.**

```ts
export interface OrderPartsTask {
  id: string;                    // order-<runId>
  kind: "order_parts";
  corpusId: string;
  runId: string;
  parts: Array<PartSummary & { heuristicRole: RescuePartRole }>;
  heuristicOrder: number[];
  instructions: string;
}
export interface OrderPartsAnswer {
  taskId: string;
  order: number[];                                   // permutation of part indices
  roles: Array<{ index: number; role: RescuePartRole }>;
  continuesPrevious: number[];                       // part indices that continue the part before them in `order`
  notes?: string;
}
export function validateOrderPartsAnswer(task: OrderPartsTask, raw: unknown): Validation<OrderPartsAnswer>;
export const ORDER_PARTS_INSTRUCTIONS: string;       // no backticks
```

The instructions say:
- order the parts as a deposited thesis reads: cover, front matter, introduction, chapters in their own numbering, conclusion, bibliography, annexes;
- give a role to every part;
- list a part in `continuesPrevious` when it carries on the chapter of the part before it (no new chapter title at its start);
- write the answer to `<taskId>.answer.json.tmp` and then rename it.

For the roles, add `"basmala"` (a page holding only the basmala, usually an image) and `"typed-note"` (a footnote or source note typed as a plain paragraph instead of a real footnote) to `ROLES`, and add a line for each to `MAP_INSTRUCTIONS`.

**Do not** import `PartSummary` from `assemble/` into `brain/` if that creates a cycle. Put the shared types in `assemble/part-roles.ts` and import them into `tasks.ts` as types only.
- [ ] **Step 3: Verify; commit** `feat(rescue): order_parts brain task; roles basmala and typed-note`.

---

## Task 5: Rules

**Files:**
- Create: `src/lib/rescue/rules/rules.ts`
- Test: `src/lib/rescue/__tests__/rules.test.ts`

Rules resolve in priority order: the department guide, then the catalogue profile, then the Algerian default (D-6). Student edits sit on top of all three. The guide reader (brain `read_guide`) is M4. M1b builds the model, the default, the catalogue mapping and the resolver, so Diagnose has rules to measure against.

- [ ] **Step 1: The model.** Write units in the field names: cm, pt, and lines for spacing.

```ts
export type RuleSource = "default" | "catalogue" | "guide" | "student";
export type DocLanguage = "ar" | "fr" | "en";
export interface RescueRules {
  language: DocLanguage;
  format: "classic" | "imrad" | "1275";
  page: { size: "A4"; marginTopCm: number; marginBottomCm: number; marginBindingCm: number; marginOppositeCm: number; bindingSide: "left" | "right" };
  body: { font: string; sizePt: number; lineSpacing: number; alignment: "justify" | "start"; firstLineIndentCm: number };
  headings: { h1SizePt: number; h2SizePt: number; h3SizePt: number; bold: boolean; real: boolean /* Word heading styles required (TOC) */ };
  footnotes: { sizePt: number; real: boolean /* real Word footnotes required */ };
  captions: { real: boolean /* SEQ captions */; figureCaptionBelow: boolean; tableCaptionAbove: boolean; listOfFiguresFrom: number; listOfTablesFrom: number };
  toc: { required: boolean; real: boolean; leader: "dots" | "none" };
  pagination: { frontMatter: "roman" | "arabic" | "none"; body: "arabic"; position: "bottom-center" | "bottom-outside" | "top-outside" };
  structure: { required: string[]; recommended: string[] };  // section ids, see SECTION_IDS
}
export const SECTION_IDS = ["cover", "dedication", "thanks", "abstract", "toc", "list-of-figures", "list-of-tables", "abbreviations", "introduction", "conclusion", "bibliography", "annexes"] as const;
```

- [ ] **Step 2: `ALGERIAN_DEFAULT(language, format)`.** Values come from the existing seed profiles and house norms (`src/lib/norm-profiles-seed.ts`, `src/lib/thesis-house-norms.ts`):
  - **Arabic:**
    - body Simplified Arabic 14 pt;
    - headings 18 / 16 / 14, bold;
    - footnotes 12 pt;
    - margins top 2.5, bottom 2.5, binding 3, opposite 2;
    - binding on the right.
  - **French and English:**
    - body Times New Roman 12 pt;
    - headings 16 / 14 / 13, bold;
    - footnotes 10 pt;
    - margins top 2.5, bottom 2.5, binding 3, opposite 2;
    - binding on the left.
  - **All languages:**
    - line spacing 1.5, alignment justify, first-line indent 0;
    - headings `real: true`, footnotes `real: true`;
    - captions real; figure caption below, table caption above; a list of figures from 5 figures, a list of tables from 5 tables;
    - TOC required and real, with dot leaders;
    - pagination: front matter roman, body arabic, bottom-center.
  - **Structure by format:**
    - classic: required `cover`, `toc`, `introduction`, `conclusion`, `bibliography`; recommended `thanks`, `dedication`, `abstract`, `list-of-figures`, `list-of-tables`;
    - imrad: the same;
    - 1275: the same as classic for now (carry-over: a real 1275 profile).
- [ ] **Step 3: `rulesFromNormProfile(p)`.** It maps the seed or DB shape (`NormFormatting` plus `bindingSide` and `language`) onto a partial `RescueRules`:

| Profile field | Rules field |
|---|---|
| `font` | `body.font` |
| `fontSize` | `body.sizePt` |
| `headingSizes.h1/h2/h3` | `headings.h1SizePt` / `h2SizePt` / `h3SizePt` |
| `headingBold` | `headings.bold` |
| `margins.binding` / `opposite` / `top` / `bottom` | `page.marginBindingCm` / `marginOppositeCm` / `marginTopCm` / `marginBottomCm` |
| `spacing` | `body.lineSpacing` |
| `footnoteFontSize` | `footnotes.sizePt` |
| `alignment` `"justified"` | `body.alignment` `"justify"` (anything else → `"start"`) |
| `pagination.frontMatter` / `body` / `position` | `pagination.*`; map `"center-bottom"` to `"bottom-center"`, and keep the default for unknown values |
| `tocStyle` `"dots"` / other | `toc.leader` `"dots"` / `"none"` |
| `bindingSide` | `page.bindingSide` |

Declare the input type locally (`NormProfileLike`) so `rules/` imports nothing from `src/db`.
- [ ] **Step 4: `resolveRules`.**

```ts
export interface ResolvedRules { rules: RescueRules; sources: Record<string, RuleSource> }   // key = dotted path, e.g. "page.marginTopCm"
export function resolveRules(input: { language: DocLanguage; format: RescueRules["format"]; catalogue?: Partial<RescueRules>; guide?: Partial<RescueRules>; edits?: Partial<RescueRules> }): ResolvedRules;
```

Layers merge deeply in the order default, catalogue, guide, edits. `sources` records the winning layer for every leaf. Arrays (`structure.required`, `structure.recommended`) are replaced whole, not merged.
- [ ] **Step 5: Tests.**
  - The default for `ar` has right binding and Simplified Arabic.
  - Mapping the `arabicLawHumanities` seed gives 16 pt body and headings 26/22/18. Import `NORM_PROFILE_SEEDS` in the test only; if the guard objects, inline the values.
  - The source of a catalogue-set field is `"catalogue"`, and an untouched field stays `"default"`.
  - Edits win over the guide.
  - A partial guide (margins only) keeps the catalogue's fonts.
- [ ] **Step 6: Verify; commit** `feat(rescue): rules — model, Algerian default, catalogue mapping, resolution`.

---

## Task 6: Facts — what the formatting is now

**Files:**
- Create: `src/lib/rescue/diagnose/styles.ts`, `src/lib/rescue/diagnose/facts.ts`
- Test: `src/lib/rescue/__tests__/facts.test.ts`

Both repos lack a style-chain reader for alignment (`w:jc`) and outline level. The server's `buildFormatResolver` (`src/lib/para-format.ts`) resolves size, line spacing, before/after spacing, font and indent through the style chain. It skips the default paragraph style when a paragraph has no `pStyle`; rescue works around that locally by injecting the default style id, and does not change `para-format.ts`.

- [ ] **Step 1: `styles.ts`.**

```ts
export interface StyleIndex { defaultParagraphStyleId: string | null; jcOf(styleId: string | null): string | null; outlineLevelOf(styleId: string | null): number | null; isHeadingStyle(styleId: string | null): boolean }
export function buildStyleIndex(stylesXml: string): StyleIndex;
```

- Parse each `w:style w:type="paragraph"`: `w:styleId`, `w:basedOn`, `w:pPr/w:jc`, `w:pPr/w:outlineLvl`, `w:name`, and the `w:default="1"` flag.
- `jcOf` and `outlineLevelOf` walk `basedOn`, guarding against cycles. A null style id means the default paragraph style.
- `isHeadingStyle`:
  - true when the outline level resolves to 0–8;
  - or the style id or name matches `/^(heading|titre|title|berschrift)\s*[1-9]$/i`;
  - or the name is `heading N` in any case.

Tests use inline `styles.xml` covering: inherited `jc`, an outline level on a custom-named style, a basedOn cycle, and the default style.
- [ ] **Step 2: `facts.ts`.**

```ts
export interface SectionFact { index: number; startBlock: number; pageSize: { widthCm: number; heightCm: number }; margins: { topCm: number; bottomCm: number; leftCm: number; rightCm: number; gutterCm: number }; pageNumberFormat: string | null; footerHasPage: boolean; breakType: string }
export interface ParaFact { i: number; font: { latin?: string; cs?: string }; sizePt: number; sizeCsPt?: number; line: { rule: string; value: number }; beforePt: number; afterPt: number; jc: string | null; rtl: boolean; realHeading: boolean; headingLevel: number; inList: boolean; firstLineCm: number }
export interface DocFacts {
  sections: SectionFact[];
  paras: Map<number, ParaFact>;            // paragraph blocks only, by block index
  toc: { realToc: boolean; tocBlock: number | null };
  lists: { listOfFigures: boolean; listOfTables: boolean };   // "TOC \c" fields
  captions: { realCaptionBlocks: number[] };                 // blocks that are SEQ captions
  fonts: string[];                                           // fontTable names
}
export async function readFacts(docx: Buffer, inv: Inventory): Promise<DocFacts>;
```

Sources:
- **Sections:** `engine.sections.getSections()` for break type and `pgNumType`, and `Doc.sections()` for `startBlockIndex`, resolved geometry and `footerHasPageNumbers`. Load both through `@kwill/docx-engine`; check the public API, and if `Doc` is not reachable from the engine object, use `getSections()` only, then compute `startBlock` by mapping `paragraphIndex` to a block index with `paragraphIndexOf`'s logic. Convert twips to cm with `/ 567.0`.
- **Paragraphs:** `buildFormatResolver(stylesXml, themeXml)` from `../../para-format`, with the default-style injection, plus `buildStyleIndex` for `jc` and heading facts. Direct `w:jc` wins over the style's. `rtl` means `w:bidi` is set, directly or through the style; reuse `paragraphIsRtl` from `../../thesis-rtl` if it is model-free (check its imports), else read `w:bidi` here. `inList` means a `w:numPr` is present.
- **TOC:** `isTocField`-equivalent detection on `w:instrText` and `w:fldSimple`, excluding `\c` (copy the engine's regex: `/(?:^|\s)TOC\s+\\/` and not `/\\c\s*"/`). Search every block including `w:sdt`, because the engine's `hasTOC` only checks top-level blocks.
- **Lists:** `TOC \c "Figure…"` / `TOC \c "Table…"`, or any `\c` label, decided by the label's text: `Figure`, `Fig`, `شكل` and `الشكل` count as figures; `Table`, `Tableau`, `جدول` and `الجدول` count as tables.
- **Captions:** `engine.captions.getCaptions()` gives `blockIndex`.
- **Fonts:** names from `word/fontTable.xml`.

Tests on `assets/thesis-base.docx`:
- one or more sections, margins within 0.05 cm of the values in its sectPr;
- every paragraph block has a `ParaFact`;
- a copy with an inserted real TOC field, then a `TOC \c "Figure"` field, flips `realToc` and `listOfFigures`;
- a copy where the first paragraph is styled with a custom heading style (outline level 0) gets `realHeading: true`.
- [ ] **Step 3: Verify;** the guard must pass, since `para-format.ts` and `thesis-rtl.ts` are now reachable. Commit `feat(rescue): facts — sections, effective paragraph formatting, TOC/lists/captions`.

---

## Task 7: Diagnose

**Files:**
- Create: `src/lib/rescue/diagnose/diagnose.ts`
- Test: `src/lib/rescue/__tests__/diagnose.test.ts`

A pure function, with no docx. Every check is driven by the **roles** (the map), the **facts** and the **rules**. Every problem names its blocks and the pages they're on (from the page map), so screen 7 can draw dots on real pages.

- [ ] **Step 1: Types.**

```ts
export type ProblemCategory = "page" | "text" | "headings" | "toc" | "captions" | "lists" | "notes" | "numbering" | "pages" | "cover" | "structure" | "typography";
export interface Problem {
  code: string;                 // stable, e.g. "margins", "body-font", "headings-not-real"
  category: ProblemCategory;
  severity: "must" | "should";
  fixedBy: "kwill" | "student"; // student = content Kwill may not write (e.g. a missing conclusion text)
  blocks: number[];             // block indices (machinery; never shown)
  pages: number[];              // sorted, unique, from the page map
  params: Record<string, string | number>;  // for the sentence: expected/found values, counts
}
export interface QuestionCandidate { i: number; key: string; role: string; confidence: number; page: number | null }
export interface Diagnosis { problems: Problem[]; questions: QuestionCandidate[]; summary: { pages: number; words: number; chapters: number; figures: number; tables: number; equations: number; footnotes: number; format: string; language: string } }
export function diagnose(input: { inv: Inventory; roles: Record<string, { i: number; role: string; confidence: number }>; facts: DocFacts; pageMap: PageMap | null; rules: RescueRules; format: string }): Diagnosis;
```

- [ ] **Step 2: The checks.** One function each. All produce at most one `Problem` per code, with the blocks aggregated, except where noted. "Body blocks" means blocks whose role is `body`, `list-item` or `quote`.

| code | category | when | severity / fixedBy |
|---|---|---|---|
| `margins` | page | any section's margins differ from the rules by more than 0.2 cm; mirror binding for `bindingSide` (left binding means the left margin is the binding margin; right binding means the right margin is) | must / kwill |
| `page-size` | page | not A4 within 0.3 cm | must / kwill |
| `body-font` | text | more than 10% of body blocks' effective font differs from `rules.body.font`: use `cs` when the paragraph is RTL or its text is mostly Arabic, else `latin`. Compare case-insensitively, ignoring spaces | must / kwill |
| `body-size` | text | more than 10% of body blocks differ from `rules.body.sizePt` by more than 0.5 pt: use `sizeCsPt` for RTL/Arabic, else `sizePt` | must / kwill |
| `line-spacing` | text | more than 10% of body blocks have `line.rule = auto` with `value / 240` off from `rules.body.lineSpacing` by more than 0.1, or any other rule | should / kwill |
| `alignment` | text | more than 10% of body blocks are not justified (`both`/`distribute`) when the rules say justify | should / kwill |
| `headings-not-real` | headings | blocks with role h1–h4 whose `realHeading` is false, which the TOC cannot see | must / kwill |
| `heading-skip` | headings | a heading level jumps by more than 1 (h1 → h3) | should / kwill |
| `heading-size` | headings | more than 20% of h1 (and h2, h3) differ from the rule size by more than 1 pt | should / kwill |
| `toc-missing` | toc | rules require a TOC, and there is no `toc-field` role and no `realToc` | must / kwill |
| `toc-typed` | toc | blocks with role `typed-toc` exist, meaning a typed contents list to replace | must / kwill |
| `captions-typed` | captions | blocks with role `caption-figure` or `caption-table` that are not in `realCaptionBlocks` | must / kwill |
| `figure-no-caption` | captions | a `figure` block with no `caption-figure` within 2 blocks after it (or before, when the rules say so) | should / student |
| `table-no-caption` | captions | a `table` with no `caption-table` within 2 blocks before it | should / student |
| `list-of-figures-missing` | lists | figures ≥ `listOfFiguresFrom`, no `list-field` role and no `listOfFigures` fact | should / kwill |
| `list-of-tables-missing` | lists | the same for tables | should / kwill |
| `typed-notes` | notes | blocks with role `typed-note` | should / kwill |
| `page-numbers` | numbering | no section after the cover has `footerHasPage`, or the body numbering format differs from the rules | must / kwill |
| `blank-pages` | pages | page map warnings `blank-page`; list the pages | should / kwill |
| `heading-at-page-end` | pages | page map warnings `heading-at-page-end` | should / kwill |
| `spacing-by-empty-lines` | pages | more than 10 `junk` blocks; params carry the count | should / kwill |
| `cover-missing` | cover | no block with role `cover` (D-4: Kwill creates one) | must / kwill |
| `section-missing:<id>` | structure | one problem per required section absent. Presence is decided as follows: `cover` from the `cover` role; `toc` from `toc-field`/`typed-toc`/`realToc`; `introduction`, `conclusion` and `bibliography` from an h1 (or `bibliography-heading`) whose text matches each section's patterns in ar/fr/en (write `\u` escapes for Arabic, for example `مقدمة`, `خاتمة`, `قائمة المراجع`/`المصادر`, `Introduction`, `Conclusion`, `Bibliographie`/`Références`/`References`); `abstract` from the `abstract-*` roles | must / student for introduction, conclusion and bibliography (Kwill may not write them); must / kwill for cover and toc |
| `section-empty:<id>` | structure | a required section's heading exists, but no body block follows it before the next h1 or divider | should / student |
| `typography` | typography | in body text, count: a space before `؟ ؛ ، :` in Arabic runs; a missing space after `، ؛ .` before a letter; mixed digit systems inside one paragraph (both `٠-٩` and `0-9`); tatweel `ـ` used for justification. One problem with per-kind counts in `params`, plus the blocks | should / kwill |

`pages` for every problem are the start pages of its blocks (`pageMap.blocks`); page-level problems use their own pages. With no page map, `pages` is `[]`.
- [ ] **Step 3: Question candidates.** These are the blocks whose role confidence is below 0.7, sorted by confidence ascending, with consecutive blocks of the same role collapsed into one. Keep at most 5, and attach each one's page.
- [ ] **Step 4: Summary.** It counts pages, words, chapters (h1s that are not intro/conclusion/bibliography), figures, tables, equations and footnotes, plus the format and language.
- [ ] **Step 5: Tests.** These are synthetic, with no docx: build a tiny `Inventory`, `roles`, `DocFacts`, `PageMap` and `RescueRules` per case, so that each check fires exactly once, then does not fire when fixed. At least one test per code. Also test that question candidates collapse consecutive blocks and cap at 5.
- [ ] **Step 6: Verify; commit** `feat(rescue): diagnose — problems vs rules with real pages, question candidates`.

---

## Task 8: Lab CLI — assemble, diagnose, approve-diagnosis

**Files:**
- Modify: `scripts/rescue-lab/cli.ts`, `scripts/rescue-lab/README.md`

- [ ] **Step 1: `assemble <id> [--run <runId>]`.**
  - Requires `meta.parts`. Parts are `original/*.docx` sorted by filename; the upload order index is that sorted order.
  - `summarizePart` for each part, then `heuristicOrder`.
  - Write an `OrderPartsTask` through `SessionBrain` under `lab/tasks/<runId>/`, and validate the answer with `validateOrderPartsAnswer`. `--run` resumes, like `map`.
  - Then `mergeVerbatim` in the confirmed order.
  - Then `checkAssembly`. On `ok: false`, write `assembled/assembly.json` with `ok: false` and the problems, and exit 1. Never write `assembled.docx` from a failed check.
  - On success, write atomically:
    - `corpus/<id>/assembled/assembled.docx`;
    - `assembled/assembly.json` = `{ ok, order, roles, continuesPrevious, partSha256: {filename: sha}, counts, at }`.

    Then remove `read/`, since the source changed.
  - `continuesPrevious` is recorded only; it changes nothing in the merge (nothing is added either way). Regenerate uses it.
- [ ] **Step 2: `read` for a split thesis** uses `assembled/assembled.docx`. It refuses with "run assemble first" when that file is missing, or when any part's sha differs from `assembly.json`. `originalSha256` in `status.json` is then the assembled file's sha. Centralise this in one `sourceDocx(id)` helper, used by `read`, `map`, `approve-map` and `diagnose`.
- [ ] **Step 3: `diagnose <id> [--run <mapRunId>] [--profile <seedSlug>]`.**
  - **Roles** come from `gold/map.json`, or from the given run's `map.json`. Require a matching `inventoryHash` and the current `KEY_VERSION`.
  - **Facts:** `readFacts(sourceDocx, inventory)`. **Page map:** `read/page-map.json` when the render is ok.
  - **Rules:** `resolveRules`. The language is the dominant script of the body text; the format comes from the map. The catalogue layer is `rulesFromNormProfile(seed)` when `--profile` names a seed in `NORM_PROFILE_SEEDS`.
  - **Output:** `corpus/<id>/diagnose/diagnosis.json` (the `Diagnosis` plus the resolved rules and sources), and `diagnose/diagnosis.md`, a readable list for the brain's review: one line per problem with code, severity, page list and params.
    - The `.md` may include at most 60 characters of excerpt per problem. It lives only in the gitignored lab; never print it to stdout.
    - Stdout gets counts only: problems by category.
- [ ] **Step 4: `approve-diagnosis <id>`.** It copies `diagnose/diagnosis.json` to `gold/diagnosis.json` atomically, after checking that the inventory hash matches the current read.
- [ ] **Step 5: README:** the three commands, the `assembled/` folder, and the rule that a split thesis reads its assembled file.
- [ ] **Step 6: Smoke test** without Word: point the converter at a closed port with `WORD_CONVERTER_URL=http://127.0.0.1:9`, so `read` saves the inventory with a failed render.
  - Assemble a `zz-` id built from two engine samples (`~/mdocxengine/samples/*.docx`). Answer its `order_parts` task with a hand-written valid answer file from the shell.
  - Read it (render fails, inventory saved).
  - Write a minimal valid gold map with a scratch script: every block body, format classic.
  - Run `diagnose`.
  - Delete the `zz-` id everywhere afterwards.
- [ ] **Step 7: Commit** `feat(rescue-lab): assemble, diagnose, approve-diagnosis; split theses read their assembled file`.

---

## Task 9: Corpus pass (controller and brain, main session)

- [ ] **Step 1: Relabel the existing answer keys for the new roles.** By index, in the gitignored gold:
  - t02 33, t03 30 and t06 19 → `basmala`;
  - the section-break carriers that close those pages (t02 36, t03 36, t06 27) → `basmala`;
  - t03 128–130 → `typed-note`.

  Re-validate every window, as in the M1a gold-check script.
- [ ] **Step 2: Assemble t17–t20.** Answer each `order_parts` task from the parts' openings and outlines; open page images only if the order is ambiguous. Then `read` each one through Word, using the private `:8093` converter if the tunnel watchdog is still looping (see memory `word-converter-watchdog-loop`). Record each `assembly.json` check: counts only.
- [ ] **Step 3: Answer keys** for at least two assembled theses, plus t21: `map`, the brain answers, `approve-map`.
- [ ] **Step 4: Diagnose every thesis with an answer key** (t01, t02, t03, t05, t06, t21, plus the assembled ones), using the default rules, and with `--profile` where the thesis's university has a seed. For each one, read `diagnosis.md` against the page images:
  - **true positive:** keep it;
  - **false positive or false negative:** fix the check (a new commit plus a regression test in `diagnose.test.ts` with synthetic data), then re-run every thesis.

  When a thesis's diagnosis is right, run `approve-diagnosis`. Keep a short review note per thesis in `corpus/<id>/gold/diagnosis-review.md` (gitignored): problems confirmed, false positives fixed.
- [ ] **Step 5: Final checks:** `npx vitest run src/lib/rescue src/lib/render`, `npx tsc --noEmit`, the scripts type-check, and the engine specs touched in Task 1.

---

## Done when

- Engine: VML pictures and OLE objects survive a merge with identical bytes, and no relationship dangles.
- t17–t20 assemble with `checkAssembly` ok (words, notes and counts equal to the parts, no dangling relationship) and read through Word.
- Every thesis with an answer key has an approved `gold/diagnosis.json` whose problems the brain confirmed against the pages.
- Tests and tsc are green, and the guard passes with `para-format.ts` / `thesis-rtl.ts` reachable.

## Carry-overs (not in M1b)

- The two-page preview (M2), and the brain's `ask` phrasing of questions (M4).
- Endnotes and comments across a merge: they are refused today; supporting them is an engine `MergeManager` change.
- A real 1275 (business-model) format profile with its own required sections.
- The guide reader (brain `read_guide`) and the student's rules screen (M4).
- Fonts that are neither standard on Windows nor embeddable (D-14): a Diagnose check once font files are available to the server.
