# Rescue v2 M2b — the rest of Regenerate

**Goal:** every remaining thing a print shop does to the file: covers, dividers and frames, sorted references, real footnotes from typed notes, French typography, caption position, font policy, the deposit pack, plus a page map that tells the truth.

**How it runs:** one implementer per module, in parallel, on disjoint files, each followed by two adversarial reviews and a fix round. A single integrator then wires them into `regenerate/index.ts`, `prove/prove.ts` and `scripts/rescue-lab/cli.ts`.

**Spec:** `docs/superpowers/specs/2026-11-02-rescue-v2-design.md`, decisions D-8, D-14, D-22 to D-26, §3 invariants, §5 Regenerate.

---

## Shared rules (every module)

**Repos.** `~/kwill-server` (Hono server, vitest, tsconfig `strict:false`, relative imports without `.js`, branch `master`). `~/mdocxengine` (`@kwill/docx-engine`, branch `main`, a `file:` dep of the server; leave `dist/` and `index.d.ts`/`index.d.cts` unstaged).

**Parallel work in one tree.**
- Commit only with `git commit -m "..." -- <exact paths>`, only files you alone edited. Never `git add .`. If `index.lock` is busy, wait a few seconds and retry.
- The server tree holds unrelated uncommitted edits from another session (`package.json`, `src/lib/render/page-markers.ts` import line, engine-rename edits, many others). Leave them. If you must edit a file that has someone else's hunk, stage only your hunk: `git diff > /tmp/x`, build the wanted blob, `git hash-object -w`, `git update-index --cacheinfo`, then commit without paths.
- Do NOT edit `regenerate/index.ts`, `prove/prove.ts`, `scripts/rescue-lab/cli.ts`, `brain/tasks.ts` or `rules/rules.ts`. They belong to the integrator. Export what the integrator needs and say so in your report. If you need a new rules field, declare it locally as an optional input and name it in your report.
- Judge `npx tsc --noEmit` only on your own files (`| grep <yourpath>`); other agents have half-written files.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Hard limits.**
- `src/lib/rescue/` must not import, even transitively, `lib/ai/`, `lib/format/`, `db/`, `lib/supabase.ts`, `lib/document-storage.ts`, `lib/thesis-render.ts`, `lib/thesis-classify.ts`, `lib/thesis-structure.ts`, `lib/thesis-plan.ts`, `lib/chat-memory.ts`, embedding/stt/tts, model packages or URLs, `createRequire`, `require(`, non-literal `import()`. `src/lib/rescue/__tests__/no-model-client.test.ts` enforces it (esbuild transitive). All of `src/mcp/tools/*` reach the DB. Pure `src/mcp/doc-*.ts` are fine. Run that guard.
- **Byte-safe:** never use the engine's xml2js-backed paths on a thesis: `PageLayoutManager` setters, `Doc.setMargins/setPageSize/setOrientation`, `SectionManager.setSectionLayout`, `formatPageNumbers`, `setDifferentFirstPage`, `set*Distance`, `Mdocxengine.applyFrontMatterNumbering`, `ShapeManager`, `CitationManager.insertBibliography`, `CrossReferenceManager.addBookmark`, `FootnoteManager.addFootnote`, `StylesManager.addStyle/removeStyle`, `DocumentManager.setBlock*`/`clearBlockFormatting`, `Doc.setHeadingLevel`. Safe: `getBlocks`/`saveBlocks`, `insertBlockAt`/`deleteBlockAt`, `updateParagraphProps`, `engine.styles.ensureStyle/setStyleParagraphProps/setDocDefaults`, `engine.settings.setSetting`, `Doc.setSectionGeometry`, string surgery on block XML and on `engine.zip`.
- `w:pPr`, `w:rPr`, `w:sectPr`, `w:tblPr` are ORDERED sequences; a schema-valid file can still make Word refuse. New XML structures must be proven in real Word: render a small synthetic .docx through `src/lib/word-converter.ts` with `WORD_CONVERTER_URL=http://localhost:8093` (a private instance is running; Word conversions are queued, so they can be slow; do not start or stop it; a conversion that fails means Word refused the file).
- **Privacy:** corpus files in `lab/` belong to real students. Never print their text in tests, logs, commits or your report; report counts and positions. Test fixtures use invented text.
- No backticks problem here, but `src/lib/ai/types.ts` must not be touched.

**Step contract.** A step that adds, removes or moves body blocks returns `indexMap: number[]` (before-step index → after-step index, `-1` when gone) so the integrator can compose them. It takes `roles` keyed to the CURRENT indices (see `remapRoles`, `roleIndex` in `regenerate/layout.ts`) and an engine. Blocks it generates (words that are not the student's) use the paragraph style `KwillGenerated`, created through `engine.styles.ensureStyle`, based on `Normal`, never collected by a TOC. Its report states every change in counts so the change report can list it. It must be idempotent where the module says so, leave the cover alone unless it is the cover module, and pass the docx doctor (`prove/doctor.ts`).

**Tests.** TDD; vitest in `src/lib/rescue/__tests__/<module>.test.ts`; round-trip through the doctor; a mutation check on the key tests (break the code, see the test fail, restore). Report the commit hashes, test counts, decisions, and what the integrator must do.

---

## Module A — covers (D-3, D-4, D-5, D-23)

New folder `src/lib/rescue/cover/`.

`fields.ts`:
```ts
export interface CoverFields {
  university?: string; faculty?: string; department?: string;
  degree?: string; field?: string; specialty?: string;
  title: string; subtitle?: string;
  students: string[]; supervisor?: string; coSupervisor?: string;
  jury?: { name: string; rank?: string; role?: string }[];
  academicYear?: string;
}
export type CoverPolicy = "keep" | "clean" | "generated";
```

`read-cover-task.ts`: the `read_cover` brain task in the shape of `brain/tasks.ts` (`buildReadCoverTask({corpusId, runId, coverText, thanksText, coverPng?})`, `validateReadCoverAnswer(task, raw)`, `READ_COVER_INSTRUCTIONS`). The validator rejects any value that does not occur in the supplied text after `lettersOnly` folding (`read/content.ts`). A field not found is simply absent; `missingCoverFields(fields)` lists what to ask.

`generate.ts`: `buildCoverXml(fields, lang, opts: { logoRelId?: string; logoSizeEmu?: [number, number] }) → string[]`, one paragraph or table XML per block. The standard Algerian cover, one page:
- the country and ministry lines by language (ar: `الجمهورية الجزائرية الديمقراطية الشعبية`, `وزارة التعليم العالي والبحث العلمي`; fr: `République Algérienne Démocratique et Populaire`, `Ministère de l'Enseignement Supérieur et de la Recherche Scientifique`; en: `People's Democratic Republic of Algeria`, `Ministry of Higher Education and Scientific Research`);
- logo if any; university, faculty, department;
- degree line; field and specialty;
- the title, large and centred, sized down as it gets longer;
- students and supervisor in a borderless two-column table (ar: `إعداد الطالب(ة):`, `إشراف الأستاذ(ة):`; fr: `Présenté par :`, `Encadré par :`; en: `Presented by:`, `Supervised by:`);
- jury table when known (ar: `لجنة المناقشة`; fr: `Membres du jury`; en: `Jury members`);
- academic year last (ar: `السنة الجامعية`; fr: `Année universitaire`; en: `Academic year`).
Absent optional fields omit their whole line. No title throws. RTL paragraphs get `w:bidi` and runs `w:rtl`, Arabic size in `w:szCs`, font in `w:cs`. It must fit on ONE page in real Word with 4 students, 5 jury members and a 300-character title: prove it with the converter and read the page count.

`apply.ts`: `applyCover(engine, { policy, fields, lang, roleAt, logo?: { bytes: Buffer; ext: "png"|"jpeg" }, rules }) → { report: CoverReport; indexMap: number[]; coverBlocks: { start: number; end: number } | null }`.
- `keep`: nothing, `indexMap` identity.
- `generated`: the old cover region (`cover.ts` `coverRegion`), if any, is removed and the new blocks inserted at the document's start. A section break the old cover carried is not kept; the integrator's layout step ends the cover section. A logo is added byte-safely (media part, relationship, content type). Report: `{ policy, removedBlocks, insertedBlocks, fieldsUsed, fieldsMissing }`.
- `clean`: in place. Words unchanged and in order. Empty paragraphs removed, their vertical space converted to `w:spacing w:before` on the next paragraph so the page keeps its rhythm. Text paragraphs not in a table are centred, with one consistent font from the rules, title block largest. Drawings, frames and tables stay. Report `{ policy, emptiesRemoved, paragraphsRestyled }`.
`proveCover(afterCoverText, fields)` lists confirmed fields not found on the new cover.

---

## Module B — divider pages and frames (D-24, spec §5 step 8)

First free the renderers from the DB: extract `applySvgColor` and `validateOrnamentSvg` from `src/lib/divider-templates.ts` to a new pure `src/lib/ornament-svg.ts`, re-exported from the old place so nothing else changes; `src/lib/divider-render.ts` and `src/lib/page-ornament-render.ts` import from the new one. Check `src/mcp/divider-pages.ts` and its imports against the guard.

`src/lib/rescue/regenerate/dividers.ts`:
- `chapterDividerTargets(roleAt, texts, lang)`: `h1` blocks that are numbered chapters (`الفصل الأول`…`الفصل العاشر`, `الفصل 1`, `الباب`, `Chapitre 1|I|premier`, `Chapter 1|one`, `Partie`, `المبحث` is not a chapter) with `{index, label, title}`. Introduction, conclusion, bibliography and annexes never. When the heading has only the label and the next block is its title (role `h1`/`h2`), use both. None at all when the thesis already has a `divider-page` role.
- `applyDividers(engine, roles, lang, spec?) → { report, indexMap }` reuses `applyDividerPages`/`renderDivider` if they pass the guard. Generated text in `KwillGenerated`. A default spec constant (a plain typographic divider with no external asset) lives here. The catalogue is injected by the caller later. Blank header, no page number shown, the page still counts. The heading after the divider stays the TOC target. Sections keep the body's numbering and running heads.
- `applyFrames(engine, roles, lang) → { report, indexMap }`: a page border (`w:pgBorders`, in schema order within `w:sectPr`) on the dedication and the thanks units, each in its own section, only when the unit has no drawing. Numbering of the front matter continues (no `w:start` on the copies).
- `pagesToExempt` helpers for Prove: which final block indices open a generated divider.
Inputs after layout: run on the engine that layout already sectioned. Prove in real Word on a synthetic thesis with 3 numbered chapters: page count, no blank page, page numbers continuous.

---

## Module C — references grouped and sorted (spec §5 step 11)

`src/lib/rescue/regenerate/references.ts`:
- `classifyReference(text, lang) → "book"|"article"|"thesis"|"website"|"other"`. Heuristics by code, Arabic + French + English: URL or "site" → website; `مذكرة|رسالة|أطروحة|thèse|mémoire|thesis|dissertation` → thesis; `مجلة|دورية|revue|journal|vol\.|n°|pp\.` → article; else book. Leans to `other` when weak signals conflict.
- `sortKey(text, lang)`: `Intl.Collator` for the language; ignores leading typed numbers, punctuation, Arabic `ال` for the sort only, tatweel and diacritics.
- `applyReferences(engine, roles, lang, { group: boolean }) → { report, indexMap, moved: number[] }`. Only when `group` is true; identity otherwise. Runs only over contiguous `bibliography-entry` blocks under their heading; a bibliography already sub-headed (role `h2`/`h3` inside) is sorted within each sub-head and gains no new groups. Group headings are generated (`KwillGenerated`, keep-with-next, labels by language: `الكتب`/`المقالات`/`المذكرات والأطروحات`/`المواقع الإلكترونية`/`مراجع أخرى`; `Ouvrages`/`Articles`/`Thèses et mémoires`/`Sites web`/`Autres références`; `Books`/`Articles`/`Theses and dissertations`/`Websites`/`Other references`). No empty groups.
- **Amended by d5676a8.** Typed numbers: digits are a list number only in a narrow form (`1.`, `1-`, `1)`, `1/`, `[1]`, `(1)`), on every entry of a scope, counting exactly from one, in any order. Only such a count is rewritten, in the entry's own run, and every digit written is declared to Prove (`numbers`).
- Digits in any other form (`3°`, `7 :`, bare `3`) are the student's words: they stay as typed, the entry files under them, and the report warns `digits-kept:n/total`. Bare or ordinal digits that themselves count from one refuse the list (`typed-labels`). A numbering in the narrow form that does not count (a hole, a repeat, only some numbered, not from one) refuses it too (`numbers-not-a-count`): nothing is mended and nothing partial is renumbered.
- A numbered list, typed or Word-numbered with digits, moves only when the student asked (`group`) and no number in the text outside the bibliography falls inside the list's range (`may-be-cited-by-number`). Citation shapes are not enumerated: any such number is doubt. A stray digit in a list of names (fewer than half the entries, no count from one) is no numbering. Equations, the cover and a typed contents are not read for this.
- Word lists keep their numbering naturally when they do move. Numbered in letters: refused (`word-list-labels`). Multi-level (list level, typed `1.1`, or an indent that is not hanging): refused (`multi-level-list`).
Export `stripReferenceNumber(text)`, `withoutDeclaredNumber` and `numberValue` for Prove, which compares each sorted entry with its own block through `finalIndex` and lets differ only the numbers declared: not a multiset, because two entries swapping words pass a multiset.

---

## Module D — typed notes become real footnotes (D-8, Diagnose `typed-notes`)

Role `typed-note` is a paragraph the student typed at the foot of a page (`(1) Author, title, p. 12`).

`src/lib/rescue/regenerate/typed-notes.ts`:
- `splitTypedNote(text)`: one paragraph may hold several notes (`(1) ... (2) ...`); markers `(1)`, `[1]`, `1-`, `1.`, `¹`, Arabic-Indic digits, `*`. No marker → unconvertible.
- `findMarker(blocks, from, marker)`: looks BACK from the note to the previous note cluster (or 40 blocks at most), for the marker in the body text, preferring a superscript run. Exactly one candidate in that window or it is left alone with a reason: `marker-not-found`, `marker-ambiguous`.
- `applyTypedNotes(engine, roles, lang) → { report: { converted, skipped: {reason,count}[] }, indexMap, ledger: {noteIndex, markerIndex, footnoteId, markerText}[] }`. Converted: the marker's text is removed from its run with run-level surgery, in its place a `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="N"/></w:r>`; a real footnote holds the note's text without its marker, footnote text XML-escaped; the paragraph is deleted once all its notes are converted. If any note of a paragraph can't convert, the whole paragraph stays.
- A new byte-safe `addFootnoteXml(engine, text, opts)` (string surgery on `word/footnotes.xml`, creating the part, separators with ids -1 and 0, relationship and content type when absent; next id above the current maximum; `FootnoteText` and `FootnoteReference` styles via `ensureStyle`). Never `FootnoteManager.addFootnote`.
- Footnote body RTL when the text is Arabic.
Export what Prove needs: note text tokens moved, marker tokens removed. Prove in real Word on a synthetic file both with and without an existing `footnotes.xml`.

---

## Module E — French/English typography and caption position (D-8, D-26)

`regenerate/typography.ts` today is Arabic-only (`if (lang !== "ar") return ...`).
- French: no-break space (U+00A0) before `: ; ! ?` and `»`, after `«`; none before `, .`; one space after them. Never inside a URL, an email, a time (`10:30`), a ratio (`1:2`), a decimal, a Latin abbreviation with dots, or code-like tokens. Collapse runs of spaces. French-language paragraphs only; an Arabic passage in a French thesis keeps the Arabic rules. Mirror for Arabic in French... the language of the paragraph decides.
- English: no space before `, . ; : ! ?`; one after; never in the protected tokens above.
- `applyTypographyToText` and `fixTypography` stay exact mirrors, because Prove replays the first over the second's result. Every fix recorded as a `TypoChange`. Add a property-style test: over many invented strings, `fixTypography` on runs equals `applyTypographyToText` on text, whichever way the runs split.

`regenerate/caption-position.ts`: `applyCaptionPosition(engine, roles, rules) → { report: { moved, notAdjacent }, indexMap, moved: number[] }`. A table caption goes directly above its table when `rules.captions.tableCaptionAbove`, a figure caption directly below when `figureCaptionBelow` (and the reverse when false). Moves only when the caption is the block right next to its object with nothing but empty paragraphs between. Keep-with-next on a caption above, and on the figure's paragraph when its caption is below. Runs before apparatus, so numbers and lists come out in reading order. Remove `caption-position` from the integrator's deferred list when green: say so.

---

## Module F — font policy and production fonts (D-14, D-25)

- `src/lib/rescue/regenerate/windows-fonts.ts`: the data list of Windows-standard families (Latin and Arabic), each with a comment-free name; include Times New Roman, Arial, Calibri, Cambria, Tahoma, Simplified Arabic, Traditional Arabic, Arabic Typesetting, Sakkal Majalla, Andalus, Microsoft Sans Serif, Segoe UI, Courier New, Symbol, Wingdings, Cambria Math. Name-compare case-insensitively.
- `regenerate/font-policy.ts`: `fontsUsed(engine)` walks `word/document.xml`, styles, headers, footers, footnotes: `w:rFonts` ascii/hAnsi/cs/eastAsia and theme references. `classify(name, availableFiles)` → `embed` (we hold the file and fsType allows it), `standard`, or `swap`. `applyFontPolicy(engine, fontsDir, { arabicFallback, latinFallback }) → { embedded, standard, swapped: {from,to,count}[], warnings }` builds on `embedFonts` in `regenerate/fonts.ts`, rewrites `w:rFonts` attributes for swapped names everywhere including the cover, and never embeds a restricted font. Theme fonts resolve through `theme1.xml` when a swap is needed. A swap must not change a symbol font's characters: symbol-like fonts stay and warn.
- Assets: `assets/rescue-fonts/` holds only open-licensed files copied from `lab/fonts/` (Amiri, Noto Naskh Arabic, Scheherazade, Liberation Serif), each with its OFL/licence text beside it. Times New Roman is NOT copied. `defaultFontsDir()` resolves the assets folder in dev and in the deployed layout (check `deploy.mjs` and how `assets/` deploys; if assets are not deployed by default, say what the integrator must do).
- Report for the change list. Prove by re-reading a file: nothing non-standard and unembedded remains.

---

## Module G — deposit pack (D-12, spec §5 "Deposit pack")

New folder `src/lib/rescue/deposit/`. No DB, no engine xml2js. Forms are built from a small in-memory docx writer (`deposit/mini-docx.ts`: content types, rels, document, styles; RTL aware), not from `assets/thesis-base.docx`.

- `abstract-sheet.ts`: `buildAbstractSheet({ rescued: Buffer, abstractBlocks: {lang, indices}, lang })` one page with ملخص · résumé · abstract, the student's own text copied word for word, each in its language and direction. Sizes come down until it fits on one page when rendered. If it can't fit at 10 pt, it uses two pages and reports it. No abstracts → not produced, with a reason.
- `forms.ts`: `buildIntegrityDeclaration(fields, lang)` and `buildDepositAuthorisation(fields, lang)`, prefilled, with dotted lines for what is unknown, a signature line, and a small footer note that the department's own form takes precedence. Wording is original and generic. Do not claim to reproduce an official text or to cite an article number.
- `pack.ts`: `buildDepositPack({ docx, pdf, fields, abstracts, rules, lang }) → { files: {name, bytes, kind}[], omitted: {kind, reason}[] }`. File names use neutral words by language with no student name. `rules.deposit?: { pdfOnly?: boolean; cd?: boolean }` decides whether a Word file and a CD note are included.
- `zip` helper for one download.
Prove each generated file in real Word through the converter.

---

## Module H — carry-overs

Engine (`~/mdocxengine`), specs in its existing style; do not run `npm run build` while another agent is mid-test if you can avoid it, and do not touch `CaptionManager.ts`:
1. Doctor rule: flag a false data descriptor and CRC-0 entries in a package (`clearFalseDataDescriptors` exists; the doctor should report what it clears).
2. `MergeManager`: endnotes survive a merge the way footnotes do. Comments are stripped from merged parts with a count returned, since a deposit never carries them.
Server:
3. `src/lib/docx-shapes.ts:100`: the self-closing `<mc:Fallback/>` bug. Reproduce it first.
4. `assemble/merge.ts`: lift the refusal on endnotes; report comments stripped. `assemble/check.ts` keeps verifying.
5. `assemble/part-roles.ts` `summarizePart`: richer summary for `order_parts`: headings detected by size as well as style, the opening text longer, the closing 300 characters.
6. Merged parts 2..n lose their own style definitions: confirm whether engine commit ed85367 (import missing referenced styles) has closed it, and add a test if so.

---

## Module I — one page truth

The page map must come from the same pagination as the delivered PDF. Today the marked copy's marker runs add width: t03 41 vs 42 pages from page 16 on; t14 114 vs 112; t01 agrees in count but drifts from page 34.

1. Read `src/lib/render/page-markers.ts`, `src/lib/render/page-map.ts`. Make the marker take no width: a tiny run with a large negative character spacing (`w:spacing` condensed) or another means, tested empirically in real Word. It must still come out in the PDF's text layer, and must not change line height or breaks. `thesis-render.ts` also uses these markers in production, so it stays compatible. Measure plain vs marked page counts and first drift on t03, t01 and t14 before and after, numbers only.
2. Then use the same technique to fix what remains from these runs:
   - t03: `pdf page-numbers` 27/31 (pages 34, 36, 38, 41). After step 1, re-run and find out if they're gone.
   - t01: `toc-docx-numbers` 58 PAGEREF vs 57 numbers read, so the file was left unfilled (`regenerate/toc-numbers.ts`). Find the missed entry by position, make the reader handle it.
   - t01: `diagnosis-cleared` margins x2 and page-numbers x2 remain after regenerate. Find out which sections and why; fix in `regenerate/layout.ts` or in Diagnose, whichever is wrong.
3. t01 takes over 15 minutes per rescue. Profile it (each step, each conversion) and report where the time goes. Fix anything silly in our own code (doctor passes, repeated parses); do not sacrifice a check.
Commands: `WORD_CONVERTER_URL=http://localhost:8093 npx tsx scripts/rescue-lab/cli.ts rescue <tNN> ...` (read `cli.ts`). You may edit `layout.ts`, `toc-numbers.ts`, `render/page-map.ts`, `render/page-markers.ts` (mind the foreign hunk), `scripts/rescue-lab/render.ts`; the integrator rule on `cli.ts` is lifted for you only if a CLI line must change, one small commit.

## Integrator notes from the t03 page-review fixes

These fixes landed outside the modules (engine f84294f; server dc52f4c, 99e0729, 7ddfc24, 44772ec, 2fe6528). The integrator must:

- Add the `tables` step between `layout` and `apparatus` in `regenerate/index.ts`, and add `tables?: TablePaginationReport` to `RegenerateResult.report`:
  ```ts
  import { applyTablePagination, type TablePaginationReport } from "./tables";
  ["tables", () => applyTablePagination(engine, remapRoles(roles, layout!.indexMap)), (r) => (report.tables = r)],
  ```
  The step adds and removes no blocks, so it returns no `indexMap`. If `caption-position` runs first, compose its map into the roles too.
- Pass `captionNumbersAdded: rules.captions.addNumbers !== false` at the `proveDocx` call in `scripts/rescue-lab/cli.ts` (about line 441).
- Show `report.apparatus.captionsWordAsLabel` in the change report.
- Rebuild the engine: the server needs f84294f or later.

Still open:

- `SEPARATORS.fr` in `apparatus.ts` uses a plain space before `:`; the French typography rule wants U+00A0. This is a one-line fix.
- The engine's `paragraphPropsXml` truncates a `w:pPr` holding `w:pPrChange`, so `addGeneratedCaption` on such a paragraph writes a broken `w:pPr`. Only the leading-word cut refuses these paragraphs today.
- t02 did not load through raw ADM-ZIP in the table sweep. Confirm how the rescue path behaves on it when t02 runs.
